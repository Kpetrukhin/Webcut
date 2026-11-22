package com.cutsync.webcut

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.AudioProcessor.AudioFormat
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.common.audio.SonicAudioProcessor
import androidx.media3.common.util.UnstableApi
import java.nio.ByteBuffer
import kotlin.math.PI
import kotlin.math.sin
import kotlin.math.tanh

/**
 * Custom Media3 / ExoPlayer BaseAudioProcessor implementing voice effects
 * ("original", "chipmunk", "monster", "robot", "hall", "radio") for both
 * live ExoPlayer playback and Media3 Transformer export.
 */
@OptIn(UnstableApi::class)
class VoiceEffectAudioProcessor(
    private val effect: String = "original"
) : BaseAudioProcessor() {

    private var sampleIndex = 0L
    private var prevIn = FloatArray(2)
    private var prevLp = FloatArray(2)
    private var prevHp = FloatArray(2)
    private val delayBufSize = 16384
    private var delayBuffer = Array(2) { FloatArray(delayBufSize) }
    private var delayPos = 0

    override fun onConfigure(inputAudioFormat: AudioFormat): AudioFormat {
        if (inputAudioFormat.encoding != C.ENCODING_PCM_16BIT) {
            return AudioFormat.NOT_SET
        }
        val ch = inputAudioFormat.channelCount.coerceAtLeast(1)
        prevIn = FloatArray(ch)
        prevLp = FloatArray(ch)
        prevHp = FloatArray(ch)
        delayBuffer = Array(ch) { FloatArray(delayBufSize) }
        delayPos = 0
        sampleIndex = 0L
        return if (effect == "original") AudioFormat.NOT_SET else inputAudioFormat
    }

    override fun onReset() {
        sampleIndex = 0L
        delayPos = 0
        for (arr in delayBuffer) arr.fill(0f)
        prevIn.fill(0f)
        prevLp.fill(0f)
        prevHp.fill(0f)
    }

    override fun queueInput(inputBuffer: ByteBuffer) {
        val remaining = inputBuffer.remaining()
        if (remaining == 0) return

        val outputBuffer = replaceOutputBuffer(remaining)
        val channels = inputAudioFormat.channelCount.coerceAtLeast(1)
        val sampleRate = inputAudioFormat.sampleRate.coerceAtLeast(8000).toFloat()

        while (inputBuffer.remaining() >= 2 * channels) {
            for (ch in 0 until channels) {
                val raw = inputBuffer.short.toFloat() / 32768f
                val processed = when (effect) {
                    "chipmunk" -> {
                        val hp = 0.92f * (prevHp[ch] + raw - prevIn[ch])
                        prevIn[ch] = raw
                        prevHp[ch] = hp
                        (raw * 0.45f + hp * 0.75f).coerceIn(-1f, 1f)
                    }
                    "monster" -> {
                        val alpha = 0.16f
                        val lp = prevLp[ch] + alpha * (raw - prevLp[ch])
                        prevLp[ch] = lp
                        (lp * 1.35f).coerceIn(-1f, 1f)
                    }
                    "robot" -> {
                        val carrier = sin(2.0 * PI * 54.0 * sampleIndex / sampleRate).toFloat()
                        val ring = raw * (0.5f + 0.5f * carrier)
                        val combDelaySamples = ((0.013f * sampleRate).toInt()).coerceIn(1, delayBufSize - 1)
                        val readIdx = (delayPos - combDelaySamples + delayBufSize) % delayBufSize
                        val comb = ring + 0.42f * delayBuffer[ch][readIdx]
                        delayBuffer[ch][delayPos] = comb
                        comb.coerceIn(-1f, 1f)
                    }
                    "hall" -> {
                        val echoSamples = ((0.16f * sampleRate).toInt()).coerceIn(1, delayBufSize - 1)
                        val echoIdx = (delayPos - echoSamples + delayBufSize) % delayBufSize
                        val delayed = delayBuffer[ch][echoIdx]
                        val wet = raw + 0.42f * delayed
                        delayBuffer[ch][delayPos] = wet
                        (raw * 0.72f + delayed * 0.48f).coerceIn(-1f, 1f)
                    }
                    "radio" -> {
                        val hp = 0.88f * (prevHp[ch] + raw - prevIn[ch])
                        prevIn[ch] = raw
                        prevHp[ch] = hp
                        val lp = prevLp[ch] + 0.34f * (hp - prevLp[ch])
                        prevLp[ch] = lp
                        tanh(lp * 2.2f).coerceIn(-1f, 1f)
                    }
                    else -> raw
                }

                val pcm = (processed * 32767f).toInt().coerceIn(-32768, 32767).toShort()
                outputBuffer.putShort(pcm)
            }
            sampleIndex++
            delayPos = (delayPos + 1) % delayBufSize
        }

        outputBuffer.flip()
    }

    companion object {
        fun buildAudioProcessors(
            speed: Float = 1f,
            pitch: Float = 1f,
            effect: String = "original"
        ): List<AudioProcessor> {
            val processors = mutableListOf<AudioProcessor>()
            val effectPitchMult = when (effect) {
                "chipmunk" -> 1.45f
                "monster" -> 0.68f
                else -> 1f
            }
            val effectivePitch = (pitch * effectPitchMult).coerceIn(0.01f, 100f)
            if (kotlin.math.abs(speed - 1f) > 0.01f || kotlin.math.abs(effectivePitch - 1f) > 0.01f) {
                val sonic = SonicAudioProcessor()
                sonic.setSpeed(speed.coerceIn(0.01f, 100f))
                sonic.setPitch(effectivePitch)
                processors.add(sonic)
            }
            if (effect != "original") {
                processors.add(VoiceEffectAudioProcessor(effect))
            }
            return processors
        }
    }
}
