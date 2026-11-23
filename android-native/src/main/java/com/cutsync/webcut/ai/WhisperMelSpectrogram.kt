package com.cutsync.webcut.ai

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * Computes Whisper-compatible 80-channel Log-Mel spectrograms of shape [1, 80, 3000]
 * from 16 kHz mono PCM FloatArray chunks (up to 30 seconds = 480,000 samples).
 *
 * Parameters match OpenAI Whisper / HuggingFace WhisperFeatureExtractor:
 * - sample_rate = 16000
 * - n_fft = 400
 * - hop_length = 160
 * - n_mels = 80
 * - chunk_length = 30s (3000 frames)
 */
object WhisperMelSpectrogram {
    const val SAMPLE_RATE = 16_000
    const val N_FFT = 400
    const val HOP_LENGTH = 160
    const val N_MELS = 80
    const val CHUNK_SAMPLES = 480_000 // 30s * 16000Hz
    const val N_FRAMES = 3_000        // 480000 / 160
    private const val N_FREQS = N_FFT / 2 + 1 // 201
    private const val FFT_PAD_SIZE = 1024     // >= 2 * N_FFT - 1 for Bluestein's exact 400-pt DFT

    // Periodic Hann window: w[n] = 0.5 * (1 - cos(2 * pi * n / N_FFT))
    private val hannWindow = DoubleArray(N_FFT) { n ->
        0.5 * (1.0 - cos(2.0 * PI * n / N_FFT))
    }

    // Slaney-scale 80x201 Mel filterbank (exact match to librosa / whisper mel_80)
    private val melFilters: Array<DoubleArray> by lazy { buildSlaneyMelFilterbank() }

    // Bluestein precomputed tables for exact N = 400 DFT
    private val chirpCos = DoubleArray(N_FFT)
    private val chirpSin = DoubleArray(N_FFT)
    private val bFftRe = DoubleArray(FFT_PAD_SIZE)
    private val bFftIm = DoubleArray(FFT_PAD_SIZE)
    private val fftCosTable = DoubleArray(FFT_PAD_SIZE / 2)
    private val fftSinTable = DoubleArray(FFT_PAD_SIZE / 2)
    private val bitRev = IntArray(FFT_PAD_SIZE)

    init {
        // Radix-2 bit-reversal & twiddle tables for size 1024
        val logN = 10
        for (i in 0 until FFT_PAD_SIZE) {
            var rev = 0
            var x = i
            for (b in 0 until logN) {
                rev = (rev shl 1) or (x and 1)
                x = x ushr 1
            }
            bitRev[i] = rev
        }
        for (k in 0 until FFT_PAD_SIZE / 2) {
            val angle = -2.0 * PI * k / FFT_PAD_SIZE
            fftCosTable[k] = cos(angle)
            fftSinTable[k] = sin(angle)
        }

        // Bluestein chirp: w[k] = exp(-i * pi * k^2 / N_FFT)
        for (k in 0 until N_FFT) {
            val angle = PI * (k.toLong() * k.toLong()).toDouble() / N_FFT
            chirpCos[k] = cos(angle)
            chirpSin[k] = -sin(angle)
        }
        bFftRe[0] = chirpCos[0]
        bFftIm[0] = -chirpSin[0]
        for (k in 1 until N_FFT) {
            val re = chirpCos[k]
            val im = -chirpSin[k] // conj(w[k])
            bFftRe[k] = re
            bFftIm[k] = im
            bFftRe[FFT_PAD_SIZE - k] = re
            bFftIm[FFT_PAD_SIZE - k] = im
        }
        fftInPlace(bFftRe, bFftIm, inverse = false)
    }

    /**
     * Computes normalized [1, 80, 3000] Log-Mel spectrogram flattened in row-major order:
     * index = mel * N_FRAMES + frame
     */
    fun computeChunkLogMel(
        audio16k: FloatArray,
        offsetSamples: Int,
        lengthSamples: Int
    ): FloatArray {
        val paddedAudio = DoubleArray(CHUNK_SAMPLES)
        val copyLen = min(lengthSamples, min(CHUNK_SAMPLES, audio16k.size - offsetSamples))
        if (copyLen > 0) {
            for (i in 0 until copyLen) {
                paddedAudio[i] = audio16k[offsetSamples + i].toDouble()
            }
        }

        val halfNfft = N_FFT / 2
        val aRe = DoubleArray(FFT_PAD_SIZE)
        val aIm = DoubleArray(FFT_PAD_SIZE)
        val frameA = DoubleArray(N_FFT)
        val frameB = DoubleArray(N_FFT)
        val powerA = DoubleArray(N_FREQS)
        val powerB = DoubleArray(N_FREQS)

        val logMel = FloatArray(N_MELS * N_FRAMES)
        var globalMax = Float.NEGATIVE_INFINITY

        // Process 2 real STFT frames per complex Bluestein FFT: z[n] = frameA[n] + i * frameB[n]
        var frameIdx = 0
        while (frameIdx < N_FRAMES) {
            val hasSecond = frameIdx + 1 < N_FRAMES
            extractWindowedFrame(paddedAudio, frameIdx * HOP_LENGTH - halfNfft, frameA)
            if (hasSecond) {
                extractWindowedFrame(paddedAudio, (frameIdx + 1) * HOP_LENGTH - halfNfft, frameB)
            } else {
                frameB.fill(0.0)
            }

            // Bluestein forward multiplication: a[n] = z[n] * chirp[n]
            aRe.fill(0.0)
            aIm.fill(0.0)
            for (n in 0 until N_FFT) {
                val xr = frameA[n]
                val xi = frameB[n]
                val wr = chirpCos[n]
                val wi = chirpSin[n]
                aRe[n] = xr * wr - xi * wi
                aIm[n] = xr * wi + xi * wr
            }

            fftInPlace(aRe, aIm, inverse = false)

            // Pointwise multiply A(k) * B(k)
            for (k in 0 until FFT_PAD_SIZE) {
                val ar = aRe[k]
                val ai = aIm[k]
                val br = bFftRe[k]
                val bi = bFftIm[k]
                aRe[k] = ar * br - ai * bi
                aIm[k] = ar * bi + ai * br
            }

            fftInPlace(aRe, aIm, inverse = true)

            // Extract complex spectrum Z[k] = chirp[k] * conv[k] and unpack real spectra A[k] and B[k]
            val zRe = DoubleArray(N_FFT)
            val zIm = DoubleArray(N_FFT)
            for (k in 0 until N_FFT) {
                val cr = aRe[k]
                val ci = aIm[k]
                val wr = chirpCos[k]
                val wi = chirpSin[k]
                zRe[k] = cr * wr - ci * wi
                zIm[k] = cr * wi + ci * wr
            }

            // Unpack conjugate symmetry:
            // A[0] = zRe[0], B[0] = zIm[0]
            powerA[0] = zRe[0] * zRe[0]
            powerB[0] = zIm[0] * zIm[0]
            for (k in 1 until N_FREQS - 1) {
                val nk = N_FFT - k
                val aReK = 0.5 * (zRe[k] + zRe[nk])
                val aImK = 0.5 * (zIm[k] - zIm[nk])
                val bReK = 0.5 * (zIm[k] + zIm[nk])
                val bImK = 0.5 * (zRe[nk] - zRe[k])
                powerA[k] = aReK * aReK + aImK * aImK
                powerB[k] = bReK * bReK + bImK * bImK
            }
            // Nyquist k = N_FFT / 2 = 200
            val nyq = N_FREQS - 1
            powerA[nyq] = zRe[nyq] * zRe[nyq]
            powerB[nyq] = zIm[nyq] * zIm[nyq]

            // Apply 80 Mel filters & log10
            for (m in 0 until N_MELS) {
                val filter = melFilters[m]
                var melValA = 0.0
                var melValB = 0.0
                for (k in 0 until N_FREQS) {
                    val w = filter[k]
                    if (w != 0.0) {
                        melValA += w * powerA[k]
                        if (hasSecond) melValB += w * powerB[k]
                    }
                }
                val logA = log10(max(melValA, 1e-10)).toFloat()
                logMel[m * N_FRAMES + frameIdx] = logA
                if (logA > globalMax) globalMax = logA

                if (hasSecond) {
                    val logB = log10(max(melValB, 1e-10)).toFloat()
                    logMel[m * N_FRAMES + frameIdx + 1] = logB
                    if (logB > globalMax) globalMax = logB
                }
            }

            frameIdx += 2
        }

        // Dynamic range clamping & Whisper normalization: max(x, globalMax - 8.0), (x + 4.0) / 4.0
        val minAllowed = globalMax - 8.0f
        for (i in logMel.indices) {
            val clamped = max(logMel[i], minAllowed)
            logMel[i] = (clamped + 4.0f) / 4.0f
        }
        return logMel
    }

    private fun extractWindowedFrame(
        audio: DoubleArray,
        startSample: Int,
        outFrame: DoubleArray
    ) {
        val len = audio.size
        for (n in 0 until N_FFT) {
            var idx = startSample + n
            // Reflect padding matching torch.stft(..., center=True, pad_mode="reflect")
            if (idx < 0) {
                idx = -idx
            } else if (idx >= len) {
                idx = 2 * len - 2 - idx
            }
            val sample = if (idx in 0 until len) audio[idx] else 0.0
            outFrame[n] = sample * hannWindow[n]
        }
    }

    private fun fftInPlace(re: DoubleArray, im: DoubleArray, inverse: Boolean) {
        val n = FFT_PAD_SIZE
        for (i in 0 until n) {
            val j = bitRev[i]
            if (i < j) {
                val tr = re[i]; re[i] = re[j]; re[j] = tr
                val ti = im[i]; im[i] = im[j]; im[j] = ti
            }
        }

        var halfSize = 1
        var step = n / 2
        while (halfSize < n) {
            val fullSize = halfSize shl 1
            for (start in 0 until n step fullSize) {
                var tableIdx = 0
                for (k in 0 until halfSize) {
                    val wr = fftCosTable[tableIdx]
                    val wi = if (inverse) -fftSinTable[tableIdx] else fftSinTable[tableIdx]
                    val i1 = start + k
                    val i2 = i1 + halfSize
                    val tr = wr * re[i2] - wi * im[i2]
                    val ti = wr * im[i2] + wi * re[i2]
                    re[i2] = re[i1] - tr
                    im[i2] = im[i1] - ti
                    re[i1] += tr
                    im[i1] += ti
                    tableIdx += step
                }
            }
            halfSize = fullSize
            step = step ushr 1
        }

        if (inverse) {
            val invN = 1.0 / n
            for (i in 0 until n) {
                re[i] *= invN
                im[i] *= invN
            }
        }
    }

    private fun buildSlaneyMelFilterbank(): Array<DoubleArray> {
        val fMin = 0.0
        val fMax = SAMPLE_RATE / 2.0
        val fSp = 200.0 / 3.0
        val minLogHz = 1000.0
        val minLogMel = minLogHz / fSp
        val logStep = ln(6.4) / 27.0

        fun hzToMel(f: Double): Double =
            if (f < minLogHz) f / fSp else minLogMel + ln(f / minLogHz) / logStep

        fun melToHz(m: Double): Double =
            if (m < minLogMel) fSp * m else minLogHz * exp(logStep * (m - minLogMel))

        val melMin = hzToMel(fMin)
        val melMax = hzToMel(fMax)
        val melPoints = DoubleArray(N_MELS + 2) { i ->
            melMin + (melMax - melMin) * i / (N_MELS + 1)
        }
        val hzPoints = DoubleArray(N_MELS + 2) { i -> melToHz(melPoints[i]) }
        val fftFreqs = DoubleArray(N_FREQS) { k -> k.toDouble() * SAMPLE_RATE / N_FFT }

        return Array(N_MELS) { m ->
            val fLeft = hzPoints[m]
            val fCenter = hzPoints[m + 1]
            val fRight = hzPoints[m + 2]
            val enorm = 2.0 / (fRight - fLeft)
            DoubleArray(N_FREQS) { k ->
                val f = fftFreqs[k]
                val lower = (f - fLeft) / (fCenter - fLeft)
                val upper = (fRight - f) / (fRight - fCenter)
                max(0.0, min(lower, upper)) * enorm
            }
        }
    }
}
