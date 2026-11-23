package com.cutsync.webcut.ai

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import ai.onnxruntime.TensorInfo
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.media.Image
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.FloatBuffer
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * Offline VitTrack (object_tracking_vittrack_2023sep.onnx) visual object tracker.
 *
 * Inputs:
 *  - template: [1, 3, 128, 128] RGB float32 NCHW, ImageNet mean/std normalized
 *  - search:   [1, 3, 256, 256] RGB float32 NCHW, ImageNet mean/std normalized
 * Outputs:
 *  - score:    [1, 1, 16, 16] confidence map
 *  - bbox:     [1, 4, 16, 16] (or [1, 4]) normalized target prediction
 */
class VitTrackEngine(private val appContext: Context) {

    companion object {
        private const val TAG = "VitTrackEngine"
        private const val TEMPLATE_SIZE = 128
        private const val SEARCH_SIZE = 256
        private const val DEFAULT_SCORE_GRID = 16
        private const val PENALTY_WINDOW_WEIGHT = 0.28f

        // Standard ImageNet normalization used by OpenCV VitTrack
        private val MEAN = floatArrayOf(0.485f, 0.456f, 0.406f)
        private val STD = floatArrayOf(0.229f, 0.224f, 0.225f)
    }

    data class TrackPoint(
        val timeMs: Long,
        val x: Float,      // Normalized center X [0..1]
        val y: Float,      // Normalized center Y [0..1]
        val scale: Float,  // Relative scale vs initial bbox (1.0f at start)
        val w: Float,      // Normalized width [0..1]
        val h: Float,      // Normalized height [0..1]
        val score: Float
    ) {
        fun toJson(): JSONObject = JSONObject().apply {
            put("timeMs", timeMs)
            put("x", x.toDouble())
            put("y", y.toDouble())
            put("scale", scale.toDouble())
            put("w", w.toDouble())
            put("h", h.toDouble())
            put("score", score.toDouble())
        }
    }

    data class TrackResult(
        val points: List<TrackPoint>,
        val frameCount: Int,
        val durationMs: Long,
        val videoWidth: Int,
        val videoHeight: Int
    ) {
        fun toJson(): JSONObject = JSONObject().apply {
            put("ok", true)
            put("frameCount", frameCount)
            put("durationMs", durationMs)
            put("videoWidth", videoWidth)
            put("videoHeight", videoHeight)
            put("points", JSONArray().apply {
                for (pt in points) put(pt.toJson())
            })
        }
    }

    private data class BoxPx(
        val x: Float, // top-left X in display pixels
        val y: Float, // top-left Y in display pixels
        val w: Float,
        val h: Float
    ) {
        val cx: Float get() = x + w * 0.5f
        val cy: Float get() = y + h * 0.5f
    }

    private interface FrameSampler {
        val displayWidth: Int
        val displayHeight: Int
        fun computeChannelMeanRgb(): FloatArray
        fun fillNchwCrop(
            cx: Float,
            cy: Float,
            cropSide: Float,
            outSize: Int,
            padRgb: FloatArray,
            dstNchw: FloatArray
        )
    }

    private val cancelRequested = AtomicBoolean(false)

    fun cancel() {
        cancelRequested.set(true)
    }

    private fun checkCancelled() {
        if (cancelRequested.get()) {
            throw CancellationException("Трекинг объекта остановлен пользователем")
        }
    }

    suspend fun track(
        env: OrtEnvironment,
        session: OrtSession,
        sourceUrl: String,
        fileName: String? = null,
        startMs: Long,
        endMs: Long,
        initX: Float,
        initY: Float,
        initW: Float,
        initH: Float,
        sampleFps: Int = 24,
        onProgress: (progress: Int, timeMs: Long, point: TrackPoint?) -> Unit
    ): TrackResult {
        cancelRequested.set(false)
        val startedNs = System.nanoTime()

        val clampedW = initW.coerceIn(0.02f, 1.0f)
        val clampedH = initH.coerceIn(0.02f, 1.0f)
        val clampedX = initX.coerceIn(0f, (1f - clampedW).coerceAtLeast(0f))
        val clampedY = initY.coerceIn(0f, (1f - clampedH).coerceAtLeast(0f))

        val (resolvedSource, tempDownloaded) = MediaSourceResolver.resolveFileOrUri(
            context = appContext,
            sourceUrl = sourceUrl,
            fileName = fileName,
            tempPrefix = "vittrack-src"
        )
        val sourceTarget = resolvedSource ?: sourceUrl

        var retriever: MediaMetadataRetriever? = null
        try {
            retriever = MediaMetadataRetriever()
            setRetrieverDataSource(retriever, sourceTarget)

            val metaDurationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
                ?.toLongOrNull()?.coerceAtLeast(100L) ?: 10_000L
            val metaW = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)
                ?.toIntOrNull()?.coerceAtLeast(16) ?: 1280
            val metaH = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)
                ?.toIntOrNull()?.coerceAtLeast(16) ?: 720
            val metaRotation = ((retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)
                ?.toIntOrNull() ?: 0) % 360 + 360) % 360

            val safeStartMs = startMs.coerceIn(0L, (metaDurationMs - 40L).coerceAtLeast(0L))
            val safeEndMs = (if (endMs > safeStartMs) endMs else metaDurationMs)
                .coerceIn(safeStartMs + 40L, metaDurationMs)
            val spanMs = (safeEndMs - safeStartMs).coerceAtLeast(40L)
            val stepMs = (1000L / sampleFps.coerceIn(8, 60)).coerceAtLeast(16L)

            val (templateInputName, searchInputName) = resolveInputNames(session)
            val outputBinding = resolveOutputs(session)

            val templateBuf = FloatArray(3 * TEMPLATE_SIZE * TEMPLATE_SIZE)
            val searchBuf = FloatArray(3 * SEARCH_SIZE * SEARCH_SIZE)
            var padRgb = floatArrayOf(123.675f, 116.28f, 103.53f)

            var templateTensor: OnnxTensor? = null
            var curBox: BoxPx? = null
            var initialDiag = 1f
            var dispW = if (metaRotation == 90 || metaRotation == 270) metaH else metaW
            var dispH = if (metaRotation == 90 || metaRotation == 270) metaW else metaH

            val points = ArrayList<TrackPoint>(256)
            var lastEmittedPct = -1
            var hannCacheSize = -1
            var hannWindow = FloatArray(0)

            fun processFrame(ptsMs: Long, sampler: FrameSampler) {
                checkCancelled()
                dispW = sampler.displayWidth
                dispH = sampler.displayHeight

                if (templateTensor == null || curBox == null) {
                    val initBox = BoxPx(
                        x = clampedX * dispW,
                        y = clampedY * dispH,
                        w = max(8f, clampedW * dispW),
                        h = max(8f, clampedH * dispH)
                    )
                    curBox = initBox
                    initialDiag = max(1f, sqrt(initBox.w * initBox.w + initBox.h * initBox.h))
                    padRgb = sampler.computeChannelMeanRgb()

                    val templateSide = computeContextCropSide(initBox.w, initBox.h, 1.0f)
                    sampler.fillNchwCrop(
                        cx = initBox.cx,
                        cy = initBox.cy,
                        cropSide = templateSide,
                        outSize = TEMPLATE_SIZE,
                        padRgb = padRgb,
                        dstNchw = templateBuf
                    )
                    templateTensor = OnnxTensor.createTensor(
                        env,
                        FloatBuffer.wrap(templateBuf),
                        longArrayOf(1L, 3L, TEMPLATE_SIZE.toLong(), TEMPLATE_SIZE.toLong())
                    )

                    val firstPt = TrackPoint(
                        timeMs = safeStartMs,
                        x = (initBox.cx / dispW).coerceIn(0f, 1f),
                        y = (initBox.cy / dispH).coerceIn(0f, 1f),
                        scale = 1f,
                        w = (initBox.w / dispW).coerceIn(0.01f, 1f),
                        h = (initBox.h / dispH).coerceIn(0.01f, 1f),
                        score = 1f
                    )
                    points.add(firstPt)
                    onProgress(1, safeStartMs, firstPt)
                    lastEmittedPct = 1
                    return
                }

                val prev = curBox!!
                val searchSide = computeContextCropSide(prev.w, prev.h, SEARCH_SIZE.toFloat() / TEMPLATE_SIZE.toFloat())
                sampler.fillNchwCrop(
                    cx = prev.cx,
                    cy = prev.cy,
                    cropSide = searchSide,
                    outSize = SEARCH_SIZE,
                    padRgb = padRgb,
                    dstNchw = searchBuf
                )

                var searchTensor: OnnxTensor? = null
                var ortResult: OrtSession.Result? = null
                try {
                    searchTensor = OnnxTensor.createTensor(
                        env,
                        FloatBuffer.wrap(searchBuf),
                        longArrayOf(1L, 3L, SEARCH_SIZE.toLong(), SEARCH_SIZE.toLong())
                    )
                    val inputs = mapOf(
                        templateInputName to templateTensor!!,
                        searchInputName to searchTensor
                    )
                    ortResult = session.run(inputs)

                    val scoreTensor = (ortResult.get(outputBinding.scoreName).orElse(null) as? OnnxTensor)
                        ?: throw IllegalStateException("VitTrack: не найден выход '${outputBinding.scoreName}'")

                    val scoreShape = (scoreTensor.info as? TensorInfo)?.shape ?: longArrayOf()
                    val scoreFb = scoreTensor.floatBuffer
                    val scoreRemaining = scoreFb.remaining()
                    val scoreBasePos = scoreFb.position()
                    val (gridH, gridW) = resolveScoreGridDims(scoreShape, scoreRemaining)
                    val gridCount = gridH * gridW

                    if (hannCacheSize != gridCount) {
                        hannWindow = createHanning2d(gridH, gridW)
                        hannCacheSize = gridCount
                    }

                    var bestIdx = 0
                    var bestPenalized = Float.NEGATIVE_INFINITY
                    var rawBestScore = 0f
                    val availableScores = min(scoreRemaining, gridCount)
                    for (i in 0 until availableScores) {
                        val raw = scoreFb.get(scoreBasePos + i)
                        val prob = if (raw < 0f || raw > 1f) sigmoid(raw) else raw
                        val penalized = prob * ((1f - PENALTY_WINDOW_WEIGHT) + PENALTY_WINDOW_WEIGHT * hannWindow[i])
                        if (penalized > bestPenalized) {
                            bestPenalized = penalized
                            bestIdx = i
                            rawBestScore = prob
                        }
                    }

                    val bestRow = bestIdx / gridW
                    val bestCol = bestIdx % gridW

                    val (predCxNorm, predCyNorm, predWNorm, predHNorm) = decodeOutputs(
                        ortResult = ortResult,
                        binding = outputBinding,
                        bestCol = bestCol,
                        bestRow = bestRow,
                        gridW = gridW,
                        gridH = gridH
                    )

                    val predictedCx = (prev.cx - searchSide * 0.5f) + predCxNorm * searchSide
                    val predictedCy = (prev.cy - searchSide * 0.5f) + predCyNorm * searchSide
                    val rawW = max(6f, predWNorm * searchSide)
                    val rawH = max(6f, predHNorm * searchSide)

                    // Clamp rapid per-frame jumps/size spikes when confidence is low
                    val alphaSize = if (rawBestScore > 0.35f) 0.45f else 0.15f
                    val smoothedW = (prev.w * (1f - alphaSize) + rawW * alphaSize)
                        .coerceIn(prev.w * 0.72f, prev.w * 1.38f)
                        .coerceIn(6f, dispW.toFloat())
                    val smoothedH = (prev.h * (1f - alphaSize) + rawH * alphaSize)
                        .coerceIn(prev.h * 0.72f, prev.h * 1.38f)
                        .coerceIn(6f, dispH.toFloat())

                    val nextCx = if (rawBestScore >= 0.12f) {
                        predictedCx.coerceIn(smoothedW * 0.25f, dispW - smoothedW * 0.25f)
                    } else {
                        prev.cx
                    }
                    val nextCy = if (rawBestScore >= 0.12f) {
                        predictedCy.coerceIn(smoothedH * 0.25f, dispH - smoothedH * 0.25f)
                    } else {
                        prev.cy
                    }

                    val nextBox = BoxPx(
                        x = nextCx - smoothedW * 0.5f,
                        y = nextCy - smoothedH * 0.5f,
                        w = smoothedW,
                        h = smoothedH
                    )
                    curBox = nextBox

                    val diag = sqrt(nextBox.w * nextBox.w + nextBox.h * nextBox.h)
                    val relScale = (diag / initialDiag).coerceIn(0.2f, 5.0f)

                    val pt = TrackPoint(
                        timeMs = ptsMs.coerceIn(safeStartMs, safeEndMs),
                        x = (nextBox.cx / dispW).coerceIn(0f, 1f),
                        y = (nextBox.cy / dispH).coerceIn(0f, 1f),
                        scale = relScale,
                        w = (nextBox.w / dispW).coerceIn(0.01f, 1f),
                        h = (nextBox.h / dispH).coerceIn(0.01f, 1f),
                        score = rawBestScore
                    )
                    points.add(pt)

                    val pct = (((ptsMs - safeStartMs).coerceAtLeast(0L) * 98L) / spanMs).toInt().coerceIn(1, 99)
                    if (pct != lastEmittedPct) {
                        lastEmittedPct = pct
                        onProgress(pct, pt.timeMs, pt)
                    }
                } finally {
                    try {
                        ortResult?.close()
                    } catch (_: Throwable) {
                    }
                    try {
                        searchTensor?.close()
                    } catch (_: Throwable) {
                    }
                }
            }

            try {
                val codecSuccess = tryDecodeWithMediaCodec(
                    sourceTarget = sourceTarget,
                    startMs = safeStartMs,
                    endMs = safeEndMs,
                    stepMs = stepMs,
                    rotationHintDeg = metaRotation,
                    onFrame = ::processFrame
                )

                if (!codecSuccess || points.isEmpty()) {
                    points.clear()
                    templateTensor?.close()
                    templateTensor = null
                    curBox = null
                    decodeWithRetriever(
                        retriever = retriever,
                        startMs = safeStartMs,
                        endMs = safeEndMs,
                        stepMs = stepMs,
                        onFrame = ::processFrame
                    )
                }
            } finally {
                try {
                    templateTensor?.close()
                } catch (_: Throwable) {
                }
            }

            if (points.isEmpty()) {
                throw IllegalStateException("Не удалось декодировать видеокадры для трекинга")
            }

            onProgress(100, points.last().timeMs, points.last())
            val elapsedMs = (System.nanoTime() - startedNs) / 1_000_000L
            Log.i(TAG, "VitTrack completed ${points.size} pts in ${elapsedMs}ms (${dispW}x${dispH})")

            return TrackResult(
                points = points,
                frameCount = points.size,
                durationMs = elapsedMs,
                videoWidth = dispW,
                videoHeight = dispH
            )
        } finally {
            try {
                retriever?.release()
            } catch (_: Throwable) {
            }
            try {
                tempDownloaded?.delete()
            } catch (_: Throwable) {
            }
        }
    }

    private suspend fun tryDecodeWithMediaCodec(
        sourceTarget: String,
        startMs: Long,
        endMs: Long,
        stepMs: Long,
        rotationHintDeg: Int,
        onFrame: (ptsMs: Long, sampler: FrameSampler) -> Unit
    ): Boolean {
        val extractor = MediaExtractor()
        var codec: MediaCodec? = null
        try {
            when {
                sourceTarget.startsWith("content://", ignoreCase = true) ->
                    extractor.setDataSource(appContext, Uri.parse(sourceTarget), null)
                sourceTarget.startsWith("file://", ignoreCase = true) ->
                    extractor.setDataSource(Uri.parse(sourceTarget).path ?: sourceTarget)
                else -> extractor.setDataSource(sourceTarget)
            }

            var videoTrackIdx = -1
            var videoFormat: MediaFormat? = null
            for (i in 0 until extractor.trackCount) {
                val fmt = extractor.getTrackFormat(i)
                val mime = fmt.getString(MediaFormat.KEY_MIME) ?: ""
                if (mime.startsWith("video/")) {
                    videoTrackIdx = i
                    videoFormat = fmt
                    break
                }
            }
            if (videoTrackIdx < 0 || videoFormat == null) return false

            val mime = videoFormat.getString(MediaFormat.KEY_MIME) ?: return false
            val rotationDeg = if (videoFormat.containsKey(MediaFormat.KEY_ROTATION)) {
                ((videoFormat.getInteger(MediaFormat.KEY_ROTATION) % 360) + 360) % 360
            } else {
                rotationHintDeg
            }

            videoFormat.setInteger(
                MediaFormat.KEY_COLOR_FORMAT,
                MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible
            )

            extractor.selectTrack(videoTrackIdx)
            val startUs = startMs * 1000L
            val endUs = endMs * 1000L
            if (startUs > 0L) {
                extractor.seekTo(startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
            }

            codec = MediaCodec.createDecoderByType(mime).apply {
                configure(videoFormat, null, null, 0)
                start()
            }

            var codedW = if (videoFormat.containsKey(MediaFormat.KEY_WIDTH)) {
                videoFormat.getInteger(MediaFormat.KEY_WIDTH)
            } else {
                1280
            }
            var codedH = if (videoFormat.containsKey(MediaFormat.KEY_HEIGHT)) {
                videoFormat.getInteger(MediaFormat.KEY_HEIGHT)
            } else {
                720
            }

            val bufferInfo = MediaCodec.BufferInfo()
            var inputDone = false
            var outputDone = false
            var nextSampleMs = startMs
            var decodedCount = 0

            while (!outputDone) {
                currentCoroutineContext().ensureActive()
                checkCancelled()

                if (!inputDone) {
                    val inIdx = codec.dequeueInputBuffer(10_000L)
                    if (inIdx >= 0) {
                        val inBuf = codec.getInputBuffer(inIdx)
                        if (inBuf != null) {
                            val size = extractor.readSampleData(inBuf, 0)
                            val ptsUs = extractor.sampleTime
                            if (size < 0 || ptsUs > endUs + 250_000L) {
                                codec.queueInputBuffer(
                                    inIdx,
                                    0,
                                    0,
                                    0L,
                                    MediaCodec.BUFFER_FLAG_END_OF_STREAM
                                )
                                inputDone = true
                            } else {
                                codec.queueInputBuffer(inIdx, 0, size, ptsUs, 0)
                                extractor.advance()
                            }
                        }
                    }
                }

                val outIdx = codec.dequeueOutputBuffer(bufferInfo, 10_000L)
                when {
                    outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                        val outFmt = codec.outputFormat
                        if (outFmt.containsKey(MediaFormat.KEY_WIDTH)) {
                            codedW = outFmt.getInteger(MediaFormat.KEY_WIDTH)
                        }
                        if (outFmt.containsKey(MediaFormat.KEY_HEIGHT)) {
                            codedH = outFmt.getInteger(MediaFormat.KEY_HEIGHT)
                        }
                    }
                    outIdx >= 0 -> {
                        val ptsUs = bufferInfo.presentationTimeUs
                        val ptsMs = ptsUs / 1000L
                        val eos = (bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0
                        if (bufferInfo.size > 0 && ptsUs >= startUs - 20_000L && ptsUs <= endUs + 20_000L) {
                            if (decodedCount == 0 || ptsMs >= nextSampleMs || (ptsMs >= endMs - 15L && nextSampleMs <= endMs)) {
                                val image = try {
                                    codec.getOutputImage(outIdx)
                                } catch (_: Throwable) {
                                    null
                                }
                                if (image == null) {
                                    codec.releaseOutputBuffer(outIdx, false)
                                    return false
                                }
                                try {
                                    val sampler = YuvImageSampler(
                                        image = image,
                                        codedW = codedW,
                                        codedH = codedH,
                                        rotationDeg = rotationDeg
                                    )
                                    onFrame(ptsMs.coerceAtLeast(startMs), sampler)
                                    decodedCount++
                                    nextSampleMs = max(nextSampleMs + stepMs, ptsMs + stepMs / 2L)
                                } finally {
                                    image.close()
                                }
                            }
                        }
                        codec.releaseOutputBuffer(outIdx, false)
                        if (eos || ptsUs > endUs + 20_000L) {
                            outputDone = true
                        }
                    }
                }
            }
            return decodedCount > 0
        } catch (err: Throwable) {
            if (err is CancellationException) throw err
            Log.w(TAG, "MediaCodec YUV fast path failed, falling back to MediaMetadataRetriever: ${err.message}")
            return false
        } finally {
            try {
                codec?.stop()
            } catch (_: Throwable) {
            }
            try {
                codec?.release()
            } catch (_: Throwable) {
            }
            try {
                extractor.release()
            } catch (_: Throwable) {
            }
        }
    }

    private suspend fun decodeWithRetriever(
        retriever: MediaMetadataRetriever,
        startMs: Long,
        endMs: Long,
        stepMs: Long,
        onFrame: (ptsMs: Long, sampler: FrameSampler) -> Unit
    ) {
        var tMs = startMs
        while (tMs <= endMs) {
            currentCoroutineContext().ensureActive()
            checkCancelled()
            val bmp = retriever.getFrameAtTime(tMs * 1000L, MediaMetadataRetriever.OPTION_CLOSEST)
            if (bmp != null) {
                try {
                    val sampler = BitmapFrameSampler(bmp)
                    onFrame(tMs, sampler)
                } finally {
                    bmp.recycle()
                }
            }
            if (tMs >= endMs) break
            tMs = min(endMs, tMs + stepMs)
        }
    }

    private fun setRetrieverDataSource(retriever: MediaMetadataRetriever, sourceTarget: String) {
        when {
            sourceTarget.startsWith("content://", ignoreCase = true) ->
                retriever.setDataSource(appContext, Uri.parse(sourceTarget))
            sourceTarget.startsWith("file://", ignoreCase = true) ->
                retriever.setDataSource(Uri.parse(sourceTarget).path ?: sourceTarget)
            else -> retriever.setDataSource(sourceTarget)
        }
    }

    private fun resolveInputNames(session: OrtSession): Pair<String, String> {
        val names = session.inputNames.toList()
        if (names.size < 2) {
            throw IllegalStateException("VitTrack должен иметь 2 входа (template, search), найдено: $names")
        }
        var templateName: String? = names.firstOrNull { it.contains("template", ignoreCase = true) }
        var searchName: String? = names.firstOrNull { it.contains("search", ignoreCase = true) }

        if (templateName == null || searchName == null) {
            for ((name, info) in session.inputInfo) {
                val ti = info.info as? TensorInfo ?: continue
                val shape = ti.shape
                if (shape.size == 4 && shape[2] == TEMPLATE_SIZE.toLong()) {
                    templateName = name
                } else if (shape.size == 4 && shape[2] == SEARCH_SIZE.toLong()) {
                    searchName = name
                }
            }
        }
        return (templateName ?: names[0]) to (searchName ?: names[1])
    }

    private data class OutputBinding(
        val scoreName: String,
        val sizeName: String?,
        val offsetName: String?,
        val bboxName: String?
    )

    private fun resolveOutputs(session: OrtSession): OutputBinding {
        val names = session.outputNames.toList()
        if (names.size < 2) {
            throw IllegalStateException("VitTrack должен иметь минимум 2 выхода, найдено: $names")
        }

        fun shapeOf(name: String): LongArray {
            val ti = session.outputInfo[name]?.info as? TensorInfo ?: return longArrayOf()
            return ti.shape
        }

        fun channelCountOf(shape: LongArray): Int = when {
            shape.size == 4 && shape[1] in 1L..4L -> shape[1].toInt()
            shape.size == 4 && shape[3] in 1L..4L -> shape[3].toInt()
            shape.size == 2 -> shape[1].toInt()
            shape.size == 1 -> shape[0].toInt()
            else -> 0
        }

        val scoreName = names.firstOrNull {
            it.contains("score", ignoreCase = true) ||
                it.contains("conf", ignoreCase = true) ||
                it.equals("output1", ignoreCase = true)
        } ?: names.firstOrNull {
            channelCountOf(shapeOf(it)) == 1
        } ?: names[0]

        val remaining = names.filter { it != scoreName }
        val twoChannelNames = remaining.filter { channelCountOf(shapeOf(it)) == 2 }

        // OpenCV Zoo VitTrack (2023sep): 3 outputs -> conf [1,1,16,16], size [1,2,16,16], offset [1,2,16,16]
        if (remaining.size >= 2 && twoChannelNames.size >= 2) {
            val sizeName = twoChannelNames.firstOrNull {
                it.contains("size", ignoreCase = true) ||
                    it.contains("wh", ignoreCase = true) ||
                    it.equals("output2", ignoreCase = true)
            } ?: twoChannelNames[0]

            val offsetName = twoChannelNames.firstOrNull {
                it != sizeName && (
                    it.contains("offset", ignoreCase = true) ||
                        it.contains("reg", ignoreCase = true) ||
                        it.equals("output3", ignoreCase = true)
                    )
            } ?: twoChannelNames.firstOrNull { it != sizeName }

            if (offsetName != null) {
                return OutputBinding(
                    scoreName = scoreName,
                    sizeName = sizeName,
                    offsetName = offsetName,
                    bboxName = null
                )
            }
        }

        // Fallback 2-output model -> score [1,1,H,W] + bbox [1,4,H,W] / [1,H,W,4] / [1,4]
        val bboxName = remaining.firstOrNull {
            it.contains("box", ignoreCase = true) || it.contains("bbox", ignoreCase = true)
        } ?: remaining.firstOrNull {
            channelCountOf(shapeOf(it)) == 4
        } ?: remaining.first()

        return OutputBinding(
            scoreName = scoreName,
            sizeName = null,
            offsetName = null,
            bboxName = bboxName
        )
    }

    private fun resolveScoreGridDims(shape: LongArray, remaining: Int): Pair<Int, Int> {
        val rawDims = when {
            shape.size == 4 && shape[1] == 1L -> shape[2].toInt() to shape[3].toInt()
            shape.size == 4 && shape[3] == 1L -> shape[1].toInt() to shape[2].toInt()
            shape.size == 4 -> shape[2].toInt() to shape[3].toInt()
            shape.size == 3 -> shape[1].toInt() to shape[2].toInt()
            shape.size == 2 -> shape[0].toInt() to shape[1].toInt()
            else -> -1 to -1
        }
        val rawH = rawDims.first
        val rawW = rawDims.second
        if (rawH > 0 && rawW > 0 && (remaining <= 0 || rawH * rawW <= remaining)) {
            return rawH to rawW
        }
        if (remaining > 0) {
            val side = sqrt(remaining.toDouble()).roundToInt().coerceAtLeast(1)
            if (side * side == remaining) return side to side
            if (rawH > 0 && remaining % rawH == 0) return rawH to (remaining / rawH)
            if (rawW > 0 && remaining % rawW == 0) return (remaining / rawW) to rawW
            return if (side * side <= remaining) side to side else 1 to remaining
        }
        return DEFAULT_SCORE_GRID to DEFAULT_SCORE_GRID
    }

    private fun computeContextCropSide(w: Float, h: Float, factor: Float): Float {
        val wc = w + 0.5f * (w + h)
        val hc = h + 0.5f * (w + h)
        return max(8f, sqrt(wc * hc) * factor)
    }

    private fun decodeOutputs(
        ortResult: OrtSession.Result,
        binding: OutputBinding,
        bestCol: Int,
        bestRow: Int,
        gridW: Int,
        gridH: Int
    ): FloatArray {
        if (binding.sizeName != null && binding.offsetName != null) {
            val sizeTensor = (ortResult.get(binding.sizeName).orElse(null) as? OnnxTensor)
                ?: throw IllegalStateException("VitTrack: не найден выход '${binding.sizeName}'")
            val offsetTensor = (ortResult.get(binding.offsetName).orElse(null) as? OnnxTensor)
                ?: throw IllegalStateException("VitTrack: не найден выход '${binding.offsetName}'")

            val sizeVals = readTensorCellChannels(sizeTensor, bestRow, bestCol, gridH, gridW, defaultChannels = 2)
            val offsetVals = readTensorCellChannels(offsetTensor, bestRow, bestCol, gridH, gridW, defaultChannels = 2)

            val w = sizeVals.getOrElse(0) { 0.25f }
            val h = sizeVals.getOrElse(1) { 0.25f }
            val dx = offsetVals.getOrElse(0) { 0.5f }
            val dy = offsetVals.getOrElse(1) { 0.5f }
            return normalizeBboxCoords(
                v0 = dx,
                v1 = dy,
                v2 = w,
                v3 = h,
                bestCol = bestCol,
                bestRow = bestRow,
                gridW = gridW,
                gridH = gridH,
                isGridHead = true
            )
        }

        val bboxName = binding.bboxName
            ?: throw IllegalStateException("VitTrack: не найден выход bbox")
        val bboxTensor = (ortResult.get(bboxName).orElse(null) as? OnnxTensor)
            ?: throw IllegalStateException("VitTrack: не найден выход '$bboxName'")
        val shape = (bboxTensor.info as? TensorInfo)?.shape ?: longArrayOf()
        val isGridHead = !(shape.size <= 2 || (shape.size == 4 && shape[2] == 1L && shape[3] == 1L))
        val vals = readTensorCellChannels(bboxTensor, bestRow, bestCol, gridH, gridW, defaultChannels = 4)
        return normalizeBboxCoords(
            v0 = vals.getOrElse(0) { 0.5f },
            v1 = vals.getOrElse(1) { 0.5f },
            v2 = vals.getOrElse(2) { 0.25f },
            v3 = vals.getOrElse(3) { 0.25f },
            bestCol = bestCol,
            bestRow = bestRow,
            gridW = gridW,
            gridH = gridH,
            isGridHead = isGridHead
        )
    }

    private fun readTensorCellChannels(
        tensor: OnnxTensor,
        bestRow: Int,
        bestCol: Int,
        fallbackGridH: Int,
        fallbackGridW: Int,
        defaultChannels: Int
    ): FloatArray {
        val shape = (tensor.info as? TensorInfo)?.shape ?: longArrayOf()
        val fb = tensor.floatBuffer
        val remaining = fb.remaining()
        val basePos = fb.position()

        fun safeGet(relIdx: Int, fallback: Float = 0f): Float {
            return if (relIdx in 0 until remaining) fb.get(basePos + relIdx) else fallback
        }

        // Flat [C] or [1, C] or [1, C, 1, 1]
        if (shape.size <= 2 || (shape.size == 4 && shape[2] == 1L && shape[3] == 1L)) {
            val chCount = min(remaining, max(1, defaultChannels))
            return FloatArray(chCount) { ch -> safeGet(ch) }
        }

        if (shape.size == 4) {
            val raw1 = shape[1].toInt()
            val raw2 = shape[2].toInt()
            val raw3 = shape[3].toInt()
            val isNchw = raw1 in 1..8 && (raw2 != 1 || raw3 != 1)
            if (isNchw) {
                val cCount = raw1
                val perPlane = if (cCount > 0) remaining / cCount else remaining
                val tH = if (raw2 > 0) raw2 else fallbackGridH.coerceAtLeast(1)
                val tW = if (raw3 > 0) raw3 else if (tH > 0 && perPlane >= tH) perPlane / tH else fallbackGridW.coerceAtLeast(1)
                val r = bestRow.coerceIn(0, tH - 1)
                val c = bestCol.coerceIn(0, tW - 1)
                val planeSize = tH * tW
                return FloatArray(cCount) { ch ->
                    safeGet(ch * planeSize + r * tW + c)
                }
            } else {
                // NHWC [1, H, W, C]
                val cCount = if (raw3 > 0) raw3 else max(1, defaultChannels)
                val totalCells = if (cCount > 0) remaining / cCount else remaining
                val tH = if (raw1 > 0) raw1 else fallbackGridH.coerceAtLeast(1)
                val tW = if (raw2 > 0) raw2 else if (tH > 0 && totalCells >= tH) totalCells / tH else fallbackGridW.coerceAtLeast(1)
                val r = bestRow.coerceIn(0, tH - 1)
                val c = bestCol.coerceIn(0, tW - 1)
                val base = (r * tW + c) * cCount
                return FloatArray(cCount) { ch ->
                    safeGet(base + ch)
                }
            }
        }

        if (shape.size == 3) {
            val raw0 = shape[0].toInt()
            val raw1 = shape[1].toInt()
            val raw2 = shape[2].toInt()
            return if (raw0 in 1..8) {
                // [C, H, W]
                val tH = if (raw1 > 0) raw1 else fallbackGridH.coerceAtLeast(1)
                val tW = if (raw2 > 0) raw2 else fallbackGridW.coerceAtLeast(1)
                val r = bestRow.coerceIn(0, tH - 1)
                val c = bestCol.coerceIn(0, tW - 1)
                val planeSize = tH * tW
                FloatArray(raw0) { ch -> safeGet(ch * planeSize + r * tW + c) }
            } else {
                // [H, W, C]
                val cCount = if (raw2 > 0) raw2 else max(1, defaultChannels)
                val tH = if (raw0 > 0) raw0 else fallbackGridH.coerceAtLeast(1)
                val tW = if (raw1 > 0) raw1 else fallbackGridW.coerceAtLeast(1)
                val r = bestRow.coerceIn(0, tH - 1)
                val c = bestCol.coerceIn(0, tW - 1)
                val base = (r * tW + c) * cCount
                FloatArray(cCount) { ch -> safeGet(base + ch) }
            }
        }

        val fallbackCount = min(remaining, max(1, defaultChannels))
        return FloatArray(fallbackCount) { ch -> safeGet(ch) }
    }

    private fun normalizeBboxCoords(
        v0: Float,
        v1: Float,
        v2: Float,
        v3: Float,
        bestCol: Int,
        bestRow: Int,
        gridW: Int,
        gridH: Int,
        isGridHead: Boolean
    ): FloatArray {
        // OpenCV Zoo VitTrack (2023sep): v0, v1 are normalized center [0..1] OR cell offsets [0..1] around (bestCol, bestRow)
        // If any coordinate exceeds 1.5, assume search-pixel scale [0..256].
        if (v2 > 1.5f || v3 > 1.5f) {
            return floatArrayOf(
                (v0 / SEARCH_SIZE).coerceIn(0f, 1f),
                (v1 / SEARCH_SIZE).coerceIn(0f, 1f),
                (v2 / SEARCH_SIZE).coerceIn(0.01f, 1f),
                (v3 / SEARCH_SIZE).coerceIn(0.01f, 1f)
            )
        }
        val cx = if (isGridHead) {
            // In VitTrack CenterHead, bbox[0..1] holds sub-cell offset in [0..1] (or normalized full coord).
            // OpenCV tracker_vit.cpp calculates: cx = (maxX + offsetX) / gridW
            ((bestCol + v0) / gridW.toFloat()).coerceIn(0f, 1f)
        } else {
            v0.coerceIn(0f, 1f)
        }
        val cy = if (isGridHead) {
            ((bestRow + v1) / gridH.toFloat()).coerceIn(0f, 1f)
        } else {
            v1.coerceIn(0f, 1f)
        }
        return floatArrayOf(
            cx,
            cy,
            v2.coerceIn(0.01f, 1f),
            v3.coerceIn(0.01f, 1f)
        )
    }

    private fun createHanning2d(h: Int, w: Int): FloatArray {
        val hy = FloatArray(h) { i ->
            if (h <= 1) 1f else (0.5f * (1f - cos((2.0 * PI * i) / (h - 1)).toFloat()))
        }
        val hx = FloatArray(w) { j ->
            if (w <= 1) 1f else (0.5f * (1f - cos((2.0 * PI * j) / (w - 1)).toFloat()))
        }
        val out = FloatArray(h * w)
        for (y in 0 until h) {
            for (x in 0 until w) {
                out[y * w + x] = hy[y] * hx[x]
            }
        }
        return out
    }

    private fun sigmoid(x: Float): Float = (1.0f / (1.0f + exp(-x.toDouble()).toFloat()))

    private class YuvImageSampler(
        image: Image,
        private val codedW: Int,
        private val codedH: Int,
        private val rotationDeg: Int
    ) : FrameSampler {
        private val planes = image.planes
        private val yBuf = planes[0].buffer
        private val uBuf = planes[1].buffer
        private val vBuf = planes[2].buffer
        private val yRowStride = planes[0].rowStride
        private val yPixelStride = planes[0].pixelStride
        private val uRowStride = planes[1].rowStride
        private val uPixelStride = planes[1].pixelStride
        private val vRowStride = planes[2].rowStride
        private val vPixelStride = planes[2].pixelStride
        private val yLimit = yBuf.limit()
        private val uLimit = uBuf.limit()
        private val vLimit = vBuf.limit()

        private val imgW = min(codedW, image.width)
        private val imgH = min(codedH, image.height)

        override val displayWidth: Int = if (rotationDeg == 90 || rotationDeg == 270) imgH else imgW
        override val displayHeight: Int = if (rotationDeg == 90 || rotationDeg == 270) imgW else imgH

        private fun sampleRgbAtCoded(cx: Int, cy: Int, outRgb: FloatArray) {
            val sx = cx.coerceIn(0, imgW - 1)
            val sy = cy.coerceIn(0, imgH - 1)
            val yIdx = (sy * yRowStride + sx * yPixelStride).coerceIn(0, yLimit - 1)
            val uvX = sx ushr 1
            val uvY = sy ushr 1
            val uIdx = (uvY * uRowStride + uvX * uPixelStride).coerceIn(0, uLimit - 1)
            val vIdx = (uvY * vRowStride + uvX * vPixelStride).coerceIn(0, vLimit - 1)

            val y = (yBuf.get(yIdx).toInt() and 0xFF).toFloat()
            val u = ((uBuf.get(uIdx).toInt() and 0xFF) - 128).toFloat()
            val v = ((vBuf.get(vIdx).toInt() and 0xFF) - 128).toFloat()

            outRgb[0] = (y + 1.370705f * v).coerceIn(0f, 255f)
            outRgb[1] = (y - 0.337633f * u - 0.698001f * v).coerceIn(0f, 255f)
            outRgb[2] = (y + 1.732446f * u).coerceIn(0f, 255f)
        }

        private fun sampleRgbAtDisplay(dx: Int, dy: Int, outRgb: FloatArray) {
            val cx: Int
            val cy: Int
            when (rotationDeg) {
                90 -> {
                    cx = dy
                    cy = imgH - 1 - dx
                }
                180 -> {
                    cx = imgW - 1 - dx
                    cy = imgH - 1 - dy
                }
                270 -> {
                    cx = imgW - 1 - dy
                    cy = dx
                }
                else -> {
                    cx = dx
                    cy = dy
                }
            }
            sampleRgbAtCoded(cx, cy, outRgb)
        }

        override fun computeChannelMeanRgb(): FloatArray {
            val stepX = max(1, displayWidth / 24)
            val stepY = max(1, displayHeight / 24)
            var sumR = 0.0
            var sumG = 0.0
            var sumB = 0.0
            var count = 0
            val tmp = FloatArray(3)
            var y = 0
            while (y < displayHeight) {
                var x = 0
                while (x < displayWidth) {
                    sampleRgbAtDisplay(x, y, tmp)
                    sumR += tmp[0]
                    sumG += tmp[1]
                    sumB += tmp[2]
                    count++
                    x += stepX
                }
                y += stepY
            }
            if (count == 0) return floatArrayOf(123.675f, 116.28f, 103.53f)
            return floatArrayOf(
                (sumR / count).toFloat(),
                (sumG / count).toFloat(),
                (sumB / count).toFloat()
            )
        }

        override fun fillNchwCrop(
            cx: Float,
            cy: Float,
            cropSide: Float,
            outSize: Int,
            padRgb: FloatArray,
            dstNchw: FloatArray
        ) {
            val planeSize = outSize * outSize
            val halfCrop = cropSide * 0.5f
            val x0 = cx - halfCrop
            val y0 = cy - halfCrop
            val invOut = cropSide / outSize.toFloat()
            val rgb = FloatArray(3)

            for (oy in 0 until outSize) {
                val srcY = (y0 + (oy + 0.5f) * invOut).roundToInt()
                val rowBase = oy * outSize
                val outOfBoundsY = srcY < 0 || srcY >= displayHeight
                for (ox in 0 until outSize) {
                    val srcX = (x0 + (ox + 0.5f) * invOut).roundToInt()
                    val r: Float
                    val g: Float
                    val b: Float
                    if (outOfBoundsY || srcX < 0 || srcX >= displayWidth) {
                        r = padRgb[0]
                        g = padRgb[1]
                        b = padRgb[2]
                    } else {
                        sampleRgbAtDisplay(srcX, srcY, rgb)
                        r = rgb[0]
                        g = rgb[1]
                        b = rgb[2]
                    }
                    val idx = rowBase + ox
                    dstNchw[idx] = (r / 255f - MEAN[0]) / STD[0]
                    dstNchw[planeSize + idx] = (g / 255f - MEAN[1]) / STD[1]
                    dstNchw[2 * planeSize + idx] = (b / 255f - MEAN[2]) / STD[2]
                }
            }
        }
    }

    private class BitmapFrameSampler(bmp: Bitmap) : FrameSampler {
        override val displayWidth: Int = bmp.width
        override val displayHeight: Int = bmp.height
        private val pixels = IntArray(displayWidth * displayHeight).also {
            bmp.getPixels(it, 0, displayWidth, 0, 0, displayWidth, displayHeight)
        }

        override fun computeChannelMeanRgb(): FloatArray {
            val stepX = max(1, displayWidth / 24)
            val stepY = max(1, displayHeight / 24)
            var sumR = 0.0
            var sumG = 0.0
            var sumB = 0.0
            var count = 0
            var y = 0
            while (y < displayHeight) {
                var x = 0
                while (x < displayWidth) {
                    val c = pixels[y * displayWidth + x]
                    sumR += Color.red(c)
                    sumG += Color.green(c)
                    sumB += Color.blue(c)
                    count++
                    x += stepX
                }
                y += stepY
            }
            if (count == 0) return floatArrayOf(123.675f, 116.28f, 103.53f)
            return floatArrayOf(
                (sumR / count).toFloat(),
                (sumG / count).toFloat(),
                (sumB / count).toFloat()
            )
        }

        override fun fillNchwCrop(
            cx: Float,
            cy: Float,
            cropSide: Float,
            outSize: Int,
            padRgb: FloatArray,
            dstNchw: FloatArray
        ) {
            val planeSize = outSize * outSize
            val halfCrop = cropSide * 0.5f
            val x0 = cx - halfCrop
            val y0 = cy - halfCrop
            val invOut = cropSide / outSize.toFloat()

            for (oy in 0 until outSize) {
                val srcY = (y0 + (oy + 0.5f) * invOut).roundToInt()
                val rowBase = oy * outSize
                val outOfBoundsY = srcY < 0 || srcY >= displayHeight
                for (ox in 0 until outSize) {
                    val srcX = (x0 + (ox + 0.5f) * invOut).roundToInt()
                    val r: Float
                    val g: Float
                    val b: Float
                    if (outOfBoundsY || srcX < 0 || srcX >= displayWidth) {
                        r = padRgb[0]
                        g = padRgb[1]
                        b = padRgb[2]
                    } else {
                        val c = pixels[srcY * displayWidth + srcX]
                        r = Color.red(c).toFloat()
                        g = Color.green(c).toFloat()
                        b = Color.blue(c).toFloat()
                    }
                    val idx = rowBase + ox
                    dstNchw[idx] = (r / 255f - MEAN[0]) / STD[0]
                    dstNchw[planeSize + idx] = (g / 255f - MEAN[1]) / STD[1]
                    dstNchw[2 * planeSize + idx] = (b / 255f - MEAN[2]) / STD[2]
                }
            }
        }
    }
}
