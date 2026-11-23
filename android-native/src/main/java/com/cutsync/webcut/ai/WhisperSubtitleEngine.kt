package com.cutsync.webcut.ai

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import ai.onnxruntime.TensorInfo
import android.content.Context
import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.FloatBuffer
import java.nio.LongBuffer
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

data class SubtitleSegment(
    val startMs: Long,
    val endMs: Long,
    val text: String
)

data class WhisperTranscriptionResult(
    val language: String,
    val durationMs: Long,
    val segments: List<SubtitleSegment>
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("ok", true)
        put("language", language)
        put("durationMs", durationMs)
        val arr = JSONArray()
        for (seg in segments) {
            arr.put(JSONObject().apply {
                put("startMs", seg.startMs)
                put("endMs", seg.endMs)
                put("text", seg.text)
            })
        }
        put("segments", arr)
    }
}

/**
 * Full offline Whisper Tiny ONNX subtitle pipeline:
 * 1. MediaExtractor + MediaCodec -> 16kHz Mono FloatArray
 * 2. 30s chunks -> 80-channel Log-Mel spectrogram [1, 80, 3000]
 * 3. encoder_model_quantized.onnx -> encoder_hidden_states
 * 4. decoder_model_merged_quantized.onnx autoregressive loop with KV-cache & <|0.00|> timestamps
 * 5. tokenizer.json ByteLevel BPE decoding -> [{ startMs, endMs, text }]
 */
class WhisperSubtitleEngine(
    private val context: Context,
    private val modelsDir: File
) {
    companion object {
        private const val TAG = "WhisperSubtitleEngine"
        const val ENCODER_FILE = "encoder_model_quantized.onnx"
        const val DECODER_FILE = "decoder_model_merged_quantized.onnx"
        const val TOKENIZER_FILE = "tokenizer.json"

        private const val MAX_DECODE_TOKENS = 224
        private const val SILENCE_RMS_THRESHOLD = 1.2e-4f
        private const val NO_SPEECH_PROB_THRESHOLD = 0.65f
    }

    private val cancelledFlag = AtomicBoolean(false)

    fun cancel() {
        cancelledFlag.set(true)
    }

    fun resetCancellation() {
        cancelledFlag.set(false)
    }

    private fun checkCancelled() {
        if (cancelledFlag.get()) {
            throw CancellationException("Распознавание речи отменено пользователем")
        }
    }

    suspend fun transcribe(
        env: OrtEnvironment,
        encoderSession: OrtSession,
        decoderSession: OrtSession,
        sourceUrl: String,
        fileName: String?,
        language: String,
        trimStartMs: Long,
        durationMs: Long,
        onProgress: (progress: Int, stage: String) -> Unit,
        createCpuFallbackEncoder: () -> Pair<OrtSession, OrtSession.SessionOptions>
    ): WhisperTranscriptionResult {
        resetCancellation()

        val tokenizerFile = File(modelsDir, TOKENIZER_FILE)
        val tokenizer = WhisperTokenizer.loadFromFile(tokenizerFile)

        onProgress(2, "Извлечение аудиодорожки (16 кГц)...")
        val pcm16k = WhisperAudioExtractor.extractMono16kHz(
            context = context,
            sourceUrl = sourceUrl,
            fileName = fileName,
            trimStartMs = trimStartMs,
            durationMs = durationMs,
            onProgress = { pct ->
                checkCancelled()
                onProgress(2 + (pct * 10 / 100), "Извлечение аудиодорожки ($pct%)...")
            }
        )

        val totalSamples = pcm16k.size
        val totalAudioMs = (totalSamples.toLong() * 1000L) / WhisperMelSpectrogram.SAMPLE_RATE
        if (totalSamples < WhisperMelSpectrogram.SAMPLE_RATE / 4) {
            onProgress(100, "Готово")
            return WhisperTranscriptionResult(
                language = if (language == "auto") "ru" else language,
                durationMs = totalAudioMs,
                segments = emptyList()
            )
        }

        val decoderMeta = inspectDecoderMeta(decoderSession)
        var activeEncoder = encoderSession
        var fallbackEncoder: OrtSession? = null
        var fallbackEncoderOpts: OrtSession.SessionOptions? = null

        val normalizedLangReq = language.trim().lowercase()
        var resolvedLangCode = when (normalizedLangReq) {
            "ru", "en" -> normalizedLangReq
            else -> "auto"
        }

        val allSegments = mutableListOf<SubtitleSegment>()
        var sampleCursor = 0

        try {
            while (sampleCursor < totalSamples) {
                currentCoroutineContext().ensureActive()
                checkCancelled()

                val chunkStartMs = (sampleCursor.toLong() * 1000L) / WhisperMelSpectrogram.SAMPLE_RATE
                val remaining = totalSamples - sampleCursor
                val chunkSamples = min(WhisperMelSpectrogram.CHUNK_SAMPLES, remaining)
                val chunkDurMs = (chunkSamples.toLong() * 1000L) / WhisperMelSpectrogram.SAMPLE_RATE

                val basePct = 12 + ((sampleCursor.toLong() * 86L) / totalSamples).toInt()
                onProgress(basePct.coerceIn(12, 98), "Анализ речи (${formatSec(chunkStartMs)})...")

                if (computeRms(pcm16k, sampleCursor, chunkSamples) < SILENCE_RMS_THRESHOLD) {
                    sampleCursor += chunkSamples
                    continue
                }

                // 1) Compute [1, 80, 3000] Log-Mel spectrogram
                val melData = WhisperMelSpectrogram.computeChunkLogMel(
                    audio16k = pcm16k,
                    offsetSamples = sampleCursor,
                    lengthSamples = chunkSamples
                )

                // 2) Run Encoder (with transparent CPU fallback if NNAPI/GPU delegate rejects quantized ops)
                val encoderInputName = activeEncoder.inputNames.firstOrNull() ?: "input_features"
                val encoderHidden = try {
                    runEncoder(env, activeEncoder, encoderInputName, melData)
                } catch (err: Throwable) {
                    if (fallbackEncoder == null) {
                        Log.w(TAG, "Encoder failed on active delegate, falling back to CPU XNNPACK: ${err.message}")
                        val (cpuSess, cpuOpts) = createCpuFallbackEncoder()
                        fallbackEncoder = cpuSess
                        fallbackEncoderOpts = cpuOpts
                        activeEncoder = cpuSess
                        runEncoder(env, activeEncoder, activeEncoder.inputNames.firstOrNull() ?: "input_features", melData)
                    } else {
                        throw err
                    }
                }

                try {
                    // 3) Auto-detect language on first voiced chunk if requested ("auto")
                    val chunkLangCode = if (resolvedLangCode == "auto") {
                        val detected = detectLanguage(
                            env = env,
                            decoderSession = decoderSession,
                            meta = decoderMeta,
                            tokenizer = tokenizer,
                            encoderHidden = encoderHidden
                        )
                        resolvedLangCode = detected
                        detected
                    } else {
                        resolvedLangCode
                    }

                    val langTokenId = tokenizer.getLanguageTokenId(chunkLangCode)
                        ?: tokenizer.getLanguageTokenId("en")
                        ?: tokenizer.sotToken + 1

                    // 4) Run Autoregressive Decoder with KV-cache & Timestamps
                    val chunkResult = decodeChunkWithTimestamps(
                        env = env,
                        decoderSession = decoderSession,
                        meta = decoderMeta,
                        tokenizer = tokenizer,
                        encoderHidden = encoderHidden,
                        langTokenId = langTokenId,
                        chunkDurationMs = chunkDurMs,
                        onTokenStep = { stepPct ->
                            checkCancelled()
                            val chunkSpanPct = ((chunkSamples.toLong() * 86L) / totalSamples).toInt().coerceAtLeast(1)
                            val pct = (basePct + (chunkSpanPct * stepPct) / 100).coerceIn(12, 99)
                            onProgress(pct, "Распознавание (${chunkLangCode.uppercase()}) $pct%...")
                        }
                    )

                    for (seg in chunkResult.segments) {
                        val absStart = chunkStartMs + seg.startMs
                        val absEnd = min(totalAudioMs, chunkStartMs + seg.endMs)
                        if (absEnd > absStart && seg.text.isNotBlank()) {
                            allSegments += SubtitleSegment(absStart, absEnd, seg.text)
                        }
                    }

                    // Advance cursor cleanly at segment boundary if chunk ended mid-utterance
                    val advanceSamples = if (
                        chunkSamples == WhisperMelSpectrogram.CHUNK_SAMPLES &&
                        chunkResult.lastClosedLocalMs in 2_000L..29_400L &&
                        chunkResult.hadTrailingUnclosedText
                    ) {
                        ((chunkResult.lastClosedLocalMs * WhisperMelSpectrogram.SAMPLE_RATE) / 1000L)
                            .toInt()
                            .coerceIn(WhisperMelSpectrogram.SAMPLE_RATE, WhisperMelSpectrogram.CHUNK_SAMPLES)
                    } else {
                        chunkSamples
                    }
                    sampleCursor += advanceSamples
                } finally {
                    encoderHidden.close()
                }
            }

            val merged = postProcessSegments(allSegments)
            onProgress(100, "Готово (${merged.size})")
            return WhisperTranscriptionResult(
                language = if (resolvedLangCode == "auto") "ru" else resolvedLangCode,
                durationMs = totalAudioMs,
                segments = merged
            )
        } finally {
            try {
                fallbackEncoder?.close()
            } catch (_: Throwable) {
            }
            try {
                fallbackEncoderOpts?.close()
            } catch (_: Throwable) {
            }
        }
    }

    private fun runEncoder(
        env: OrtEnvironment,
        encoderSession: OrtSession,
        inputName: String,
        melData: FloatArray
    ): OnnxTensor {
        val inputTensor = OnnxTensor.createTensor(
            env,
            FloatBuffer.wrap(melData),
            longArrayOf(1L, WhisperMelSpectrogram.N_MELS.toLong(), WhisperMelSpectrogram.N_FRAMES.toLong())
        )
        try {
            val result = encoderSession.run(mapOf(inputName to inputTensor))
            try {
                val outOpt = result.get("last_hidden_state")
                val outTensor = if (outOpt.isPresent) {
                    outOpt.get() as OnnxTensor
                } else {
                    result[0] as OnnxTensor
                }
                val shape = (outTensor.info as TensorInfo).shape
                val buf = outTensor.floatBuffer
                val copy = FloatArray(buf.remaining())
                buf.get(copy)
                return OnnxTensor.createTensor(env, FloatBuffer.wrap(copy), shape)
            } finally {
                result.close()
            }
        } finally {
            inputTensor.close()
        }
    }

    private fun detectLanguage(
        env: OrtEnvironment,
        decoderSession: OrtSession,
        meta: DecoderMeta,
        tokenizer: WhisperTokenizer,
        encoderHidden: OnnxTensor
    ): String {
        val emptyKv = createEmptyPastKv(env, meta)
        val inputIds = OnnxTensor.createTensor(
            env,
            LongBuffer.wrap(longArrayOf(tokenizer.sotToken.toLong())),
            longArrayOf(1L, 1L)
        )
        val useCache = if (meta.hasUseCacheBranch) {
            OnnxTensor.createTensor(env, booleanArrayOf(false))
        } else null
        val cachePos = if (meta.hasCachePosition) {
            OnnxTensor.createTensor(env, LongBuffer.wrap(longArrayOf(0L)), longArrayOf(1L))
        } else null

        val inputs = HashMap<String, OnnxTensor>(meta.inputNames.size)
        inputs[meta.inputIdsName] = inputIds
        if (meta.hasEncoderHiddenStates) inputs[meta.encoderHiddenName] = encoderHidden
        if (useCache != null) inputs[meta.useCacheName] = useCache
        if (cachePos != null) inputs[meta.cachePositionName] = cachePos
        inputs.putAll(emptyKv)

        try {
            val result = decoderSession.run(inputs)
            try {
                val logits = extractLastTokenLogits(result, meta.logitsName)
                // Prefer RU / EN when auto-detecting for CutSync, while also checking top language tokens
                val ruId = tokenizer.getLanguageTokenId("ru")
                val enId = tokenizer.getLanguageTokenId("en")
                if (ruId != null && enId != null && ruId < logits.size && enId < logits.size) {
                    var bestCode = "en"
                    var bestLogit = Float.NEGATIVE_INFINITY
                    for ((code, tid) in tokenizer.languageTokens) {
                        if (tid in logits.indices && logits[tid] > bestLogit) {
                            bestLogit = logits[tid]
                            bestCode = code
                        }
                    }
                    // If detected language is supported or close to ru/en, return ru/en
                    return if (bestCode == "ru" || bestCode == "en") {
                        bestCode
                    } else if (logits[ruId] >= logits[enId]) {
                        "ru"
                    } else {
                        "en"
                    }
                }
                return "en"
            } finally {
                result.close()
            }
        } finally {
            inputIds.close()
            useCache?.close()
            cachePos?.close()
            emptyKv.values.forEach { it.close() }
        }
    }

    private data class ChunkDecodeOutput(
        val segments: List<SubtitleSegment>,
        val lastClosedLocalMs: Long,
        val hadTrailingUnclosedText: Boolean
    )

    private fun decodeChunkWithTimestamps(
        env: OrtEnvironment,
        decoderSession: OrtSession,
        meta: DecoderMeta,
        tokenizer: WhisperTokenizer,
        encoderHidden: OnnxTensor,
        langTokenId: Int,
        chunkDurationMs: Long,
        onTokenStep: (Int) -> Unit
    ): ChunkDecodeOutput {
        // Prompt: [<|startoftranscript|>, <|lang|>, <|transcribe|>] (timestamp mode enabled)
        val prompt = longArrayOf(
            tokenizer.sotToken.toLong(),
            langTokenId.toLong(),
            tokenizer.transcribeToken.toLong()
        )
        val generated = mutableListOf<Int>()
        val suppressIds = tokenizer.getControlTokenIdsToSuppress()

        var encoderKv: Map<String, OnnxTensor>? = null
        var decoderKv: Map<String, OnnxTensor>? = null
        var lastTimestampToken = tokenizer.timestampBegin

        try {
            for (step in 0 until MAX_DECODE_TOKENS) {
                checkCancelled()
                onTokenStep(((step * 100) / 80).coerceIn(0, 99))

                val isFirstStep = (step == 0)
                val stepTokens = if (isFirstStep) prompt else longArrayOf(generated.last().toLong())
                val inputIdsTensor = OnnxTensor.createTensor(
                    env,
                    LongBuffer.wrap(stepTokens),
                    longArrayOf(1L, stepTokens.size.toLong())
                )
                val useCacheTensor = if (meta.hasUseCacheBranch) {
                    OnnxTensor.createTensor(env, booleanArrayOf(!isFirstStep))
                } else null
                val cachePosTensor = if (meta.hasCachePosition) {
                    val posArr = if (isFirstStep) {
                        LongArray(prompt.size) { it.toLong() }
                    } else {
                        longArrayOf((prompt.size + step - 1).toLong())
                    }
                    OnnxTensor.createTensor(env, LongBuffer.wrap(posArr), longArrayOf(posArr.size.toLong()))
                } else null

                val stepPastDummy = if (isFirstStep) createEmptyPastKv(env, meta) else null

                val inputs = HashMap<String, OnnxTensor>(meta.inputNames.size)
                inputs[meta.inputIdsName] = inputIdsTensor
                if (meta.hasEncoderHiddenStates) inputs[meta.encoderHiddenName] = encoderHidden
                if (useCacheTensor != null) inputs[meta.useCacheName] = useCacheTensor
                if (cachePosTensor != null) inputs[meta.cachePositionName] = cachePosTensor
                if (stepPastDummy != null) {
                    inputs.putAll(stepPastDummy)
                } else {
                    encoderKv?.let { inputs.putAll(it) }
                    decoderKv?.let { inputs.putAll(it) }
                }

                val result = try {
                    decoderSession.run(inputs)
                } finally {
                    inputIdsTensor.close()
                    useCacheTensor?.close()
                    cachePosTensor?.close()
                    stepPastDummy?.values?.forEach { it.close() }
                }

                try {
                    val logits = extractLastTokenLogits(result, meta.logitsName)

                    // Check <|nospeech|> on first generated token
                    if (isFirstStep && checkNoSpeech(logits, tokenizer)) {
                        return ChunkDecodeOutput(emptyList(), 0L, false)
                    }

                    // Apply Whisper timestamp & suppression rules
                    applyWhisperLogitRules(
                        logits = logits,
                        generated = generated,
                        tokenizer = tokenizer,
                        suppressIds = suppressIds,
                        lastTimestampToken = lastTimestampToken,
                        chunkDurationMs = chunkDurationMs
                    )

                    val nextToken = argmax(logits)
                    if (nextToken == tokenizer.eotToken) {
                        break
                    }
                    if (tokenizer.isTimestampToken(nextToken)) {
                        lastTimestampToken = max(lastTimestampToken, nextToken)
                    }
                    generated += nextToken

                    if (hasRepetitionLoop(generated)) {
                        Log.w(TAG, "Detected repetition loop at step $step, stopping chunk early")
                        break
                    }

                    // Extract KV caches for next step
                    if (isFirstStep) {
                        encoderKv = cloneKvOutputs(env, result, meta.encoderPresentToPast)
                    }
                    val nextDecoderKv = cloneKvOutputs(env, result, meta.decoderPresentToPast)
                    decoderKv?.values?.forEach { it.close() }
                    decoderKv = nextDecoderKv
                } finally {
                    result.close()
                }
            }
        } finally {
            encoderKv?.values?.forEach { it.close() }
            decoderKv?.values?.forEach { it.close() }
        }

        return parseSegmentsFromTokens(generated, tokenizer, chunkDurationMs)
    }

    private fun checkNoSpeech(logits: FloatArray, tokenizer: WhisperTokenizer): Boolean {
        val nsId = tokenizer.noSpeechToken
        if (nsId !in logits.indices) return false
        // Softmax over all logits
        var maxLogit = Float.NEGATIVE_INFINITY
        for (v in logits) {
            if (v.isFinite() && v > maxLogit) maxLogit = v
        }
        var sumExp = 0.0
        for (v in logits) {
            if (v.isFinite()) sumExp += exp((v - maxLogit).toDouble())
        }
        if (sumExp <= 0.0) return false
        val noSpeechProb = exp((logits[nsId] - maxLogit).toDouble()) / sumExp
        return noSpeechProb > NO_SPEECH_PROB_THRESHOLD
    }

    private fun applyWhisperLogitRules(
        logits: FloatArray,
        generated: List<Int>,
        tokenizer: WhisperTokenizer,
        suppressIds: IntArray,
        lastTimestampToken: Int,
        chunkDurationMs: Long
    ) {
        val vocabSize = logits.size
        val tsBegin = tokenizer.timestampBegin
        val tsEnd = min(tokenizer.timestampEnd, vocabSize - 1)
        val eot = tokenizer.eotToken

        // 1. Suppress control tokens (<|sot|>, <|transcribe|>, <|notimestamps|>, language tokens, etc.)
        for (id in suppressIds) {
            if (id in logits.indices) {
                logits[id] = Float.NEGATIVE_INFINITY
            }
        }

        // Suppress timestamps beyond chunkDurationMs (+0.4s tolerance)
        val maxAllowedTsMs = chunkDurationMs + 400L
        for (tid in tsBegin..tsEnd) {
            val ms = tokenizer.timestampMs(tid)
            if (ms != null && ms > maxAllowedTsMs) {
                logits[tid] = Float.NEGATIVE_INFINITY
            }
        }

        // 2. Whisper ApplyTimestampRules
        if (generated.isEmpty()) {
            // First generated token MUST be a timestamp (usually <|0.00|>)
            for (i in 0 until min(tsBegin, vocabSize)) {
                logits[i] = Float.NEGATIVE_INFINITY
            }
            return
        }

        val lastWasTs = tokenizer.isTimestampToken(generated.last())
        val penultimateWasTs = generated.size < 2 || tokenizer.isTimestampToken(generated[generated.size - 2])

        if (lastWasTs) {
            if (penultimateWasTs) {
                // Just emitted opening timestamp (or two timestamps): next token must be text or EOT
                for (i in tsBegin until vocabSize) {
                    logits[i] = Float.NEGATIVE_INFINITY
                }
            } else {
                // Text followed by closing timestamp: next token must be EOT or another timestamp
                for (i in 0 until min(tsBegin, vocabSize)) {
                    if (i != eot) {
                        logits[i] = Float.NEGATIVE_INFINITY
                    }
                }
                // Monotonic: next opening timestamp cannot precede lastTimestampToken
                for (i in tsBegin until min(lastTimestampToken, vocabSize)) {
                    logits[i] = Float.NEGATIVE_INFINITY
                }
            }
        } else {
            // Currently inside text: timestamps cannot go backwards before lastTimestampToken
            for (i in tsBegin..min(lastTimestampToken, tsEnd)) {
                logits[i] = Float.NEGATIVE_INFINITY
            }

            // Whisper timestamp_probability > max_text_probability heuristic
            var maxLogit = Float.NEGATIVE_INFINITY
            for (v in logits) {
                if (v.isFinite() && v > maxLogit) maxLogit = v
            }
            if (maxLogit.isFinite()) {
                var tsExpSum = 0.0
                for (i in tsBegin..tsEnd) {
                    val v = logits[i]
                    if (v.isFinite()) tsExpSum += exp((v - maxLogit).toDouble())
                }
                var maxTextLogit = Float.NEGATIVE_INFINITY
                for (i in 0 until min(tsBegin, vocabSize)) {
                    if (logits[i] > maxTextLogit) maxTextLogit = logits[i]
                }
                val tsLogProb = if (tsExpSum > 0.0) maxLogit + ln(tsExpSum) else Double.NEGATIVE_INFINITY
                if (tsLogProb > maxTextLogit.toDouble()) {
                    for (i in 0 until min(tsBegin, vocabSize)) {
                        logits[i] = Float.NEGATIVE_INFINITY
                    }
                }
            }
        }
    }

    private fun parseSegmentsFromTokens(
        tokens: List<Int>,
        tokenizer: WhisperTokenizer,
        chunkDurationMs: Long
    ): ChunkDecodeOutput {
        if (tokens.isEmpty()) return ChunkDecodeOutput(emptyList(), 0L, false)

        val segments = mutableListOf<SubtitleSegment>()
        var currentStartMs: Long? = null
        val textTokenBuf = mutableListOf<Int>()
        var lastClosedMs = 0L

        for (id in tokens) {
            val tsMs = tokenizer.timestampMs(id)
            if (tsMs != null) {
                if (currentStartMs == null) {
                    currentStartMs = tsMs
                    textTokenBuf.clear()
                } else if (textTokenBuf.isEmpty()) {
                    // Two consecutive timestamps: update start timestamp
                    currentStartMs = tsMs
                } else {
                    val decoded = tokenizer.decodeTokens(textTokenBuf)
                    val sMs = currentStartMs
                    val eMs = max(sMs + 250L, tsMs)
                    if (decoded.isNotBlank()) {
                        segments += SubtitleSegment(sMs, eMs, decoded)
                    }
                    lastClosedMs = eMs
                    currentStartMs = null
                    textTokenBuf.clear()
                }
            } else {
                if (currentStartMs == null) {
                    currentStartMs = lastClosedMs
                }
                textTokenBuf += id
            }
        }

        val hadTrailingUnclosedText = textTokenBuf.isNotEmpty()
        if (hadTrailingUnclosedText && currentStartMs != null) {
            // Only emit trailing unclosed text if it's at the end of a short final chunk (< 29s)
            if (chunkDurationMs < 29_000L || segments.isEmpty()) {
                val decoded = tokenizer.decodeTokens(textTokenBuf)
                if (decoded.isNotBlank()) {
                    val eMs = max(currentStartMs + 400L, min(chunkDurationMs, currentStartMs + 4_000L))
                    segments += SubtitleSegment(currentStartMs, eMs, decoded)
                }
            }
        }

        return ChunkDecodeOutput(
            segments = segments,
            lastClosedLocalMs = lastClosedMs,
            hadTrailingUnclosedText = hadTrailingUnclosedText
        )
    }

    private fun postProcessSegments(raw: List<SubtitleSegment>): List<SubtitleSegment> {
        if (raw.isEmpty()) return emptyList()
        val cleaned = mutableListOf<SubtitleSegment>()
        for (seg in raw) {
            val text = seg.text.replace(Regex("\\s+"), " ").trim()
            if (text.isEmpty()) continue
            val prev = cleaned.lastOrNull()
            if (prev != null && prev.text == text && seg.startMs - prev.endMs < 350L) {
                cleaned[cleaned.lastIndex] = prev.copy(endMs = max(prev.endMs, seg.endMs))
            } else {
                cleaned += seg.copy(text = text)
            }
        }
        return cleaned
    }

    private fun hasRepetitionLoop(tokens: List<Int>): Boolean {
        val n = tokens.size
        if (n < 18) return false
        for (period in 1..6) {
            val window = period * 3
            if (n < window) continue
            var same = true
            for (i in 0 until period * 2) {
                if (tokens[n - 1 - i] != tokens[n - 1 - i - period]) {
                    same = false
                    break
                }
            }
            if (same) return true
        }
        return false
    }

    private data class DecoderMeta(
        val inputNames: Set<String>,
        val inputIdsName: String,
        val encoderHiddenName: String,
        val hasEncoderHiddenStates: Boolean,
        val useCacheName: String,
        val hasUseCacheBranch: Boolean,
        val cachePositionName: String,
        val hasCachePosition: Boolean,
        val logitsName: String,
        val numLayers: Int,
        val numHeads: Long,
        val headDim: Long,
        val pastInputNames: List<String>,
        val encoderPresentToPast: List<Pair<String, String>>,
        val decoderPresentToPast: List<Pair<String, String>>
    )

    private fun inspectDecoderMeta(session: OrtSession): DecoderMeta {
        val inputNames = session.inputNames
        val outputNames = session.outputNames
        val inputInfo = session.inputInfo

        val inputIdsName = inputNames.firstOrNull { it.contains("input_ids") } ?: "input_ids"
        val encoderHiddenName = inputNames.firstOrNull { it.contains("encoder_hidden_states") } ?: "encoder_hidden_states"
        val useCacheName = inputNames.firstOrNull { it.contains("use_cache_branch") } ?: "use_cache_branch"
        val cachePositionName = inputNames.firstOrNull { it == "cache_position" } ?: "cache_position"
        val logitsName = outputNames.firstOrNull { it.contains("logits") } ?: outputNames.first()

        val pastNames = inputNames.filter { it.startsWith("past_key_values.") }.sorted()
        var numHeads = 6L
        var headDim = 64L
        var maxLayer = -1

        for (pName in pastNames) {
            val layerIdx = pName.removePrefix("past_key_values.").substringBefore('.').toIntOrNull()
            if (layerIdx != null && layerIdx > maxLayer) maxLayer = layerIdx
            val tInfo = inputInfo[pName]?.info as? TensorInfo
            if (tInfo != null && tInfo.shape.size >= 4) {
                if (tInfo.shape[1] > 0) numHeads = tInfo.shape[1]
                if (tInfo.shape[3] > 0) headDim = tInfo.shape[3]
            }
        }

        val numLayers = if (maxLayer >= 0) maxLayer + 1 else 4
        val encoderPairs = mutableListOf<Pair<String, String>>()
        val decoderPairs = mutableListOf<Pair<String, String>>()

        for (pName in pastNames) {
            val suffix = pName.removePrefix("past_key_values.")
            val presentName = "present.$suffix"
            if (presentName !in outputNames) continue
            if (suffix.contains(".encoder.")) {
                encoderPairs += presentName to pName
            } else {
                decoderPairs += presentName to pName
            }
        }

        return DecoderMeta(
            inputNames = inputNames,
            inputIdsName = inputIdsName,
            encoderHiddenName = encoderHiddenName,
            hasEncoderHiddenStates = encoderHiddenName in inputNames,
            useCacheName = useCacheName,
            hasUseCacheBranch = useCacheName in inputNames,
            cachePositionName = cachePositionName,
            hasCachePosition = cachePositionName in inputNames,
            logitsName = logitsName,
            numLayers = numLayers,
            numHeads = numHeads,
            headDim = headDim,
            pastInputNames = pastNames,
            encoderPresentToPast = encoderPairs,
            decoderPresentToPast = decoderPairs
        )
    }

    private fun createEmptyPastKv(
        env: OrtEnvironment,
        meta: DecoderMeta
    ): Map<String, OnnxTensor> {
        val map = HashMap<String, OnnxTensor>(meta.pastInputNames.size)
        val shape = longArrayOf(1L, meta.numHeads, 0L, meta.headDim)
        for (name in meta.pastInputNames) {
            map[name] = OnnxTensor.createTensor(env, FloatBuffer.allocate(0), shape)
        }
        return map
    }

    private fun cloneKvOutputs(
        env: OrtEnvironment,
        result: OrtSession.Result,
        mapping: List<Pair<String, String>>
    ): Map<String, OnnxTensor> {
        val out = HashMap<String, OnnxTensor>(mapping.size)
        for ((presentName, pastName) in mapping) {
            val opt = result.get(presentName)
            if (!opt.isPresent) continue
            val src = opt.get() as OnnxTensor
            val shape = (src.info as TensorInfo).shape
            val buf = src.floatBuffer
            val copy = FloatArray(buf.remaining())
            buf.get(copy)
            out[pastName] = OnnxTensor.createTensor(env, FloatBuffer.wrap(copy), shape)
        }
        return out
    }

    private fun extractLastTokenLogits(
        result: OrtSession.Result,
        logitsName: String
    ): FloatArray {
        val opt = result.get(logitsName)
        val tensor = if (opt.isPresent) opt.get() as OnnxTensor else result[0] as OnnxTensor
        val shape = (tensor.info as TensorInfo).shape
        val seqLen = if (shape.size >= 3) shape[1].toInt() else 1
        val vocabSize = shape.last().toInt()
        val buf = tensor.floatBuffer
        if (seqLen > 1) {
            buf.position((seqLen - 1) * vocabSize)
        }
        val out = FloatArray(vocabSize)
        buf.get(out, 0, vocabSize)
        return out
    }

    private fun argmax(values: FloatArray): Int {
        var bestIdx = 0
        var bestVal = Float.NEGATIVE_INFINITY
        for (i in values.indices) {
            val v = values[i]
            if (v > bestVal) {
                bestVal = v
                bestIdx = i
            }
        }
        return bestIdx
    }

    private fun computeRms(data: FloatArray, offset: Int, len: Int): Float {
        if (len <= 0) return 0f
        var sumSq = 0.0
        val end = min(data.size, offset + len)
        for (i in offset until end) {
            val v = data[i].toDouble()
            sumSq += v * v
        }
        return sqrt(sumSq / (end - offset).coerceAtLeast(1)).toFloat()
    }

    private fun formatSec(ms: Long): String {
        val totalSec = (ms / 1000L).coerceAtLeast(0L)
        val m = totalSec / 60L
        val s = totalSec % 60L
        return "%02d:%02d".format(m, s)
    }
}
