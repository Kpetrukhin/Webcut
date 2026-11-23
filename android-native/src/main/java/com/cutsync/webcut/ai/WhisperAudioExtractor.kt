package com.cutsync.webcut.ai

import android.content.Context
import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.sin

/**
 * Extracts audio track from any video/audio source using Android MediaExtractor + MediaCodec,
 * converts multi-channel PCM to mono, and resamples to 16 kHz FloatArray for Whisper.
 */
object WhisperAudioExtractor {
    private const val TAG = "WhisperAudioExtractor"
    const val TARGET_SAMPLE_RATE = 16_000

    suspend fun extractMono16kHz(
        context: Context,
        sourceUrl: String,
        fileName: String? = null,
        trimStartMs: Long = 0L,
        durationMs: Long = -1L,
        onProgress: ((Int) -> Unit)? = null
    ): FloatArray {
        var tempDownloadedFile: File? = null
        val extractor = MediaExtractor()
        var codec: MediaCodec? = null

        try {
            tempDownloadedFile = MediaSourceResolver.prepareExtractorDataSource(
                context = context,
                extractor = extractor,
                sourceUrl = sourceUrl,
                fileName = fileName,
                tempPrefix = "whisper-src"
            )

            var audioTrackIdx = -1
            var audioFormat: MediaFormat? = null
            for (i in 0 until extractor.trackCount) {
                val fmt = extractor.getTrackFormat(i)
                val mime = fmt.getString(MediaFormat.KEY_MIME) ?: ""
                if (mime.startsWith("audio/")) {
                    audioTrackIdx = i
                    audioFormat = fmt
                    break
                }
            }

            if (audioTrackIdx < 0 || audioFormat == null) {
                throw IllegalStateException("В выбранном видео нет аудиодорожки")
            }

            val mime = audioFormat.getString(MediaFormat.KEY_MIME)!!
            var sampleRate = if (audioFormat.containsKey(MediaFormat.KEY_SAMPLE_RATE)) {
                audioFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
            } else {
                44_100
            }
            var channelCount = if (audioFormat.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) {
                audioFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT).coerceAtLeast(1)
            } else {
                1
            }
            var pcmEncoding = if (audioFormat.containsKey(MediaFormat.KEY_PCM_ENCODING)) {
                audioFormat.getInteger(MediaFormat.KEY_PCM_ENCODING)
            } else {
                AudioFormat.ENCODING_PCM_16BIT
            }

            val trackDurationUs = if (audioFormat.containsKey(MediaFormat.KEY_DURATION)) {
                audioFormat.getLong(MediaFormat.KEY_DURATION)
            } else {
                0L
            }

            extractor.selectTrack(audioTrackIdx)
            val startUs = (trimStartMs * 1000L).coerceAtLeast(0L)
            if (startUs > 0L) {
                extractor.seekTo(startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
            }
            val endUs = if (durationMs > 0L) startUs + durationMs * 1000L else Long.MAX_VALUE
            val expectedSpanUs = when {
                durationMs > 0L -> durationMs * 1000L
                trackDurationUs > startUs -> trackDurationUs - startUs
                else -> 0L
            }

            codec = MediaCodec.createDecoderByType(mime).apply {
                configure(audioFormat, null, null, 0)
                start()
            }

            val initialCapacity = if (expectedSpanUs > 0L) {
                ((expectedSpanUs / 1_000_000.0) * sampleRate).toInt().coerceIn(4096, 20_000_000)
            } else {
                sampleRate * 10
            }
            val monoSamples = FloatList(initialCapacity)
            val bufferInfo = MediaCodec.BufferInfo()

            var inputDone = false
            var outputDone = false
            var lastReportedPct = -1

            while (!outputDone) {
                currentCoroutineContext().ensureActive()

                if (!inputDone) {
                    val inIdx = codec.dequeueInputBuffer(10_000L)
                    if (inIdx >= 0) {
                        val inBuf = codec.getInputBuffer(inIdx)
                        if (inBuf != null) {
                            val sampleSize = extractor.readSampleData(inBuf, 0)
                            val sampleTimeUs = extractor.sampleTime
                            if (sampleSize < 0 || (endUs != Long.MAX_VALUE && sampleTimeUs > endUs)) {
                                codec.queueInputBuffer(
                                    inIdx,
                                    0,
                                    0,
                                    0L,
                                    MediaCodec.BUFFER_FLAG_END_OF_STREAM
                                )
                                inputDone = true
                            } else {
                                codec.queueInputBuffer(inIdx, 0, sampleSize, sampleTimeUs, 0)
                                extractor.advance()
                            }
                        }
                    }
                }

                val outIdx = codec.dequeueOutputBuffer(bufferInfo, 10_000L)
                when {
                    outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                        val outFmt = codec.outputFormat
                        if (outFmt.containsKey(MediaFormat.KEY_SAMPLE_RATE)) {
                            sampleRate = outFmt.getInteger(MediaFormat.KEY_SAMPLE_RATE)
                        }
                        if (outFmt.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) {
                            channelCount = outFmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT).coerceAtLeast(1)
                        }
                        if (outFmt.containsKey(MediaFormat.KEY_PCM_ENCODING)) {
                            pcmEncoding = outFmt.getInteger(MediaFormat.KEY_PCM_ENCODING)
                        }
                    }
                    outIdx >= 0 -> {
                        val outBuf = codec.getOutputBuffer(outIdx)
                        if (outBuf != null && bufferInfo.size > 0) {
                            val ptsUs = bufferInfo.presentationTimeUs
                            if (ptsUs >= startUs - 50_000L && (endUs == Long.MAX_VALUE || ptsUs <= endUs)) {
                                decodePcmBufferToMono(
                                    buf = outBuf,
                                    offset = bufferInfo.offset,
                                    size = bufferInfo.size,
                                    channelCount = channelCount,
                                    pcmEncoding = pcmEncoding,
                                    ptsUs = ptsUs,
                                    startUs = startUs,
                                    endUs = endUs,
                                    sampleRate = sampleRate,
                                    out = monoSamples
                                )
                            }
                            if (expectedSpanUs > 0L && onProgress != null) {
                                val pct = (((ptsUs - startUs).coerceAtLeast(0L) * 100L) / expectedSpanUs)
                                    .toInt()
                                    .coerceIn(0, 99)
                                if (pct != lastReportedPct) {
                                    lastReportedPct = pct
                                    onProgress(pct)
                                }
                            }
                        }
                        codec.releaseOutputBuffer(outIdx, false)
                        if ((bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                            outputDone = true
                        }
                    }
                }
            }

            onProgress?.invoke(100)
            val rawMono = monoSamples.toFloatArray()
            Log.i(
                TAG,
                "Decoded ${rawMono.size} mono samples @ ${sampleRate}Hz (channels=$channelCount)"
            )
            return if (sampleRate == TARGET_SAMPLE_RATE) {
                rawMono
            } else {
                resampleTo16kHz(rawMono, sampleRate)
            }
        } catch (err: Throwable) {
            if (err is CancellationException) throw err
            throw err
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
            try {
                tempDownloadedFile?.delete()
            } catch (_: Throwable) {
            }
        }
    }

    private fun decodePcmBufferToMono(
        buf: ByteBuffer,
        offset: Int,
        size: Int,
        channelCount: Int,
        pcmEncoding: Int,
        ptsUs: Long,
        startUs: Long,
        endUs: Long,
        sampleRate: Int,
        out: FloatList
    ) {
        val slice = buf.duplicate().apply {
            position(offset)
            limit(offset + size)
            order(ByteOrder.LITTLE_ENDIAN)
        }

        val bytesPerSample = when (pcmEncoding) {
            AudioFormat.ENCODING_PCM_FLOAT -> 4
            AudioFormat.ENCODING_PCM_8BIT -> 1
            else -> 2
        }
        val frameBytes = bytesPerSample * channelCount
        if (frameBytes <= 0) return

        val totalFrames = size / frameBytes
        if (totalFrames <= 0) return

        val skipFrames = if (ptsUs < startUs) {
            (((startUs - ptsUs) * sampleRate) / 1_000_000L).toInt().coerceIn(0, totalFrames)
        } else {
            0
        }
        val maxFramesByEnd = if (endUs != Long.MAX_VALUE && ptsUs < endUs) {
            (((endUs - ptsUs) * sampleRate) / 1_000_000L).toInt().coerceIn(0, totalFrames)
        } else {
            totalFrames
        }
        val endFrame = maxFramesByEnd.coerceAtLeast(skipFrames)

        if (skipFrames > 0) {
            slice.position(offset + skipFrames * frameBytes)
        }

        for (frame in skipFrames until endFrame) {
            var sum = 0f
            when (pcmEncoding) {
                AudioFormat.ENCODING_PCM_FLOAT -> {
                    for (ch in 0 until channelCount) {
                        sum += slice.float
                    }
                }
                AudioFormat.ENCODING_PCM_8BIT -> {
                    for (ch in 0 until channelCount) {
                        val unsigned = slice.get().toInt() and 0xFF
                        sum += (unsigned - 128) / 128f
                    }
                }
                else -> {
                    for (ch in 0 until channelCount) {
                        sum += slice.short / 32768f
                    }
                }
            }
            out.add((sum / channelCount).coerceIn(-1f, 1f))
        }
    }

    /**
     * Windowed-sinc anti-aliased resampler to 16 kHz.
     * Avoids high-frequency aliasing when downsampling from 44.1 / 48 kHz.
     */
    fun resampleTo16kHz(input: FloatArray, srcRate: Int): FloatArray {
        if (input.isEmpty() || srcRate <= 0 || srcRate == TARGET_SAMPLE_RATE) {
            return input
        }
        val ratio = srcRate.toDouble() / TARGET_SAMPLE_RATE.toDouble()
        val outLen = floor(input.size / ratio).toInt().coerceAtLeast(1)
        val output = FloatArray(outLen)

        if (srcRate < TARGET_SAMPLE_RATE) {
            // Linear interpolation for upsampling
            for (i in 0 until outLen) {
                val srcPos = i * ratio
                val idx0 = floor(srcPos).toInt().coerceIn(0, input.lastIndex)
                val idx1 = (idx0 + 1).coerceAtMost(input.lastIndex)
                val frac = (srcPos - idx0).toFloat()
                output[i] = input[idx0] * (1f - frac) + input[idx1] * frac
            }
            return output
        }

        // Hann-windowed sinc low-pass filter for downsampling (cutoff = 0.45 * targetRate / srcRate)
        val halfWidth = 8
        val cutoff = TARGET_SAMPLE_RATE.toDouble() / srcRate.toDouble()
        val filterRadius = ceil(halfWidth / cutoff).toInt().coerceAtMost(32)

        for (i in 0 until outLen) {
            val center = i * ratio
            val start = (floor(center).toInt() - filterRadius).coerceAtLeast(0)
            val end = (ceil(center).toInt() + filterRadius).coerceAtMost(input.lastIndex)
            var acc = 0.0
            var weightSum = 0.0
            for (j in start..end) {
                val dx = (j - center) * cutoff
                if (abs(dx) >= halfWidth) continue
                val sinc = if (abs(dx) < 1e-7) 1.0 else sin(PI * dx) / (PI * dx)
                val win = 0.5 * (1.0 + cos(PI * dx / halfWidth))
                val w = sinc * win
                acc += input[j] * w
                weightSum += w
            }
            output[i] = if (weightSum > 1e-9) (acc / weightSum).toFloat() else input[center.toInt().coerceIn(0, input.lastIndex)]
        }
        return output
    }

    private class FloatList(initialCapacity: Int) {
        private var data = FloatArray(initialCapacity.coerceAtLeast(1024))
        var size = 0
            private set

        fun add(value: Float) {
            if (size == data.size) {
                data = data.copyOf((data.size * 1.5).toInt().coerceAtLeast(size + 1024))
            }
            data[size++] = value
        }

        fun toFloatArray(): FloatArray = data.copyOf(size)
    }
}
