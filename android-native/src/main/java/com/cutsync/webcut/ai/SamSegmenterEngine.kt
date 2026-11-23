package com.cutsync.webcut.ai

import ai.onnxruntime.OnnxJavaType
import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import ai.onnxruntime.TensorInfo
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.net.Uri
import android.util.Base64
import android.util.Log
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.FloatBuffer
import java.nio.IntBuffer
import java.nio.LongBuffer
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Two-stage MobileSAM offline segmenter:
 *  1) encodeFrame(): mobile_sam_image_encoder.onnx -> caches image_embeddings in RAM
 *  2) decodePoints(): sam_mask_decoder_single.onnx -> interactive point prompts + padding point {0,0,-1}
 */
class SamSegmenterEngine(private val appContext: Context) {

    companion object {
        private const val TAG = "SamSegmenterEngine"
        const val ENCODER_FILE = "mobile_sam_image_encoder.onnx"
        const val DECODER_FILE = "sam_mask_decoder_single.onnx"
        private const val DEFAULT_ENCODER_SIZE = 1024
        private const val DEFAULT_LOW_RES_MASK_SIZE = 256

        // ImageNet normalization (pixel_mean / pixel_std for MobileSAM / SAM)
        private val MEAN = floatArrayOf(0.485f, 0.456f, 0.406f)
        private val STD = floatArrayOf(0.229f, 0.224f, 0.225f)
    }

    data class SamPoint(
        val x: Float,
        val y: Float,
        val label: Int // 1 = include, 0 = exclude
    )

    data class SamEncodeResult(
        val origWidth: Int,
        val origHeight: Int,
        val resizedWidth: Int,
        val resizedHeight: Int,
        val encoderSize: Int,
        val encodeTimeMs: Long
    ) {
        fun toJson(): JSONObject = JSONObject().apply {
            put("ok", true)
            put("cached", true)
            put("origWidth", origWidth)
            put("origHeight", origHeight)
            put("resizedWidth", resizedWidth)
            put("resizedHeight", resizedHeight)
            put("encoderSize", encoderSize)
            put("encodeTimeMs", encodeTimeMs)
        }
    }

    data class SamDecodeResult(
        val maskDataUrl: String,
        val width: Int,
        val height: Int,
        val iou: Float,
        val coverage: Float,
        val boundsX: Float,
        val boundsY: Float,
        val boundsW: Float,
        val boundsH: Float,
        val decodeTimeMs: Long
    ) {
        fun toJson(): JSONObject = JSONObject().apply {
            put("ok", true)
            put("maskDataUrl", maskDataUrl)
            put("width", width)
            put("height", height)
            put("iou", iou.toDouble())
            put("coverage", coverage.toDouble())
            put("bounds", JSONObject().apply {
                put("x", boundsX.toDouble())
                put("y", boundsY.toDouble())
                put("w", boundsW.toDouble())
                put("h", boundsH.toDouble())
            })
            put("decodeTimeMs", decodeTimeMs)
        }
    }

    private data class CachedSamFrame(
        val embeddings: FloatArray,
        val embeddingsShape: LongArray,
        val origWidth: Int,
        val origHeight: Int,
        val resizedWidth: Int,
        val resizedHeight: Int,
        val targetWidth: Int,
        val targetHeight: Int,
        val scale: Float
    )

    private val cacheLock = Any()

    @Volatile
    private var cachedFrame: CachedSamFrame? = null

    fun clearCache() {
        synchronized(cacheLock) {
            cachedFrame = null
        }
    }

    fun hasCachedEmbeddings(): Boolean = synchronized(cacheLock) { cachedFrame != null }

    suspend fun encodeFrame(
        env: OrtEnvironment,
        encoderSession: OrtSession,
        frameInput: String,
        createCpuFallbackEncoder: (() -> Pair<OrtSession, OrtSession.SessionOptions>)? = null
    ): SamEncodeResult {
        val startedNs = System.nanoTime()
        val srcBitmap = decodeBitmapFromInput(frameInput)
        var resizedBitmap: Bitmap? = null
        var fallbackPair: Pair<OrtSession, OrtSession.SessionOptions>? = null

        try {
            val origW = srcBitmap.width.coerceAtLeast(1)
            val origH = srcBitmap.height.coerceAtLeast(1)

            val inputEntry = encoderSession.inputInfo.entries.firstOrNull {
                val n = it.key.lowercase()
                n.contains("image") || n.contains("input") || n == "x"
            } ?: encoderSession.inputInfo.entries.firstOrNull()
                ?: throw IllegalStateException("Encoder ONNX не содержит входов")

            val inputName = inputEntry.key
            val inputTensorInfo = inputEntry.value.info as? TensorInfo
            val rawInShape = inputTensorInfo?.shape ?: longArrayOf(1, 3, 1024, 1024)
            val layout = resolveEncoderInputLayout(rawInShape)

            val scale = min(
                layout.targetW.toFloat() / origW.toFloat(),
                layout.targetH.toFloat() / origH.toFloat()
            )
            val resizedW = max(1, (origW * scale).roundToInt()).coerceAtMost(layout.targetW)
            val resizedH = max(1, (origH * scale).roundToInt()).coerceAtMost(layout.targetH)

            resizedBitmap = Bitmap.createScaledBitmap(srcBitmap, resizedW, resizedH, true)
            val pixels = IntArray(resizedW * resizedH)
            resizedBitmap.getPixels(pixels, 0, resizedW, 0, 0, resizedW, resizedH)

            val elemCount = layout.shape.fold(1L) { acc, dim -> acc * dim }.toInt()
            val inputBuffer = FloatArray(elemCount) // Zero-padded after normalization
            val planeSize = layout.targetH * layout.targetW

            for (y in 0 until resizedH) {
                val srcRow = y * resizedW
                val dstRow = y * layout.targetW
                for (x in 0 until resizedW) {
                    val px = pixels[srcRow + x]
                    val rn = (Color.red(px) / 255f - MEAN[0]) / STD[0]
                    val gn = (Color.green(px) / 255f - MEAN[1]) / STD[1]
                    val bn = (Color.blue(px) / 255f - MEAN[2]) / STD[2]
                    val spatialIdx = dstRow + x
                    if (layout.isNchw) {
                        inputBuffer[spatialIdx] = rn
                        inputBuffer[planeSize + spatialIdx] = gn
                        inputBuffer[2 * planeSize + spatialIdx] = bn
                    } else {
                        val base = spatialIdx * 3
                        inputBuffer[base] = rn
                        inputBuffer[base + 1] = gn
                        inputBuffer[base + 2] = bn
                    }
                }
            }

            val outputEntry = encoderSession.outputInfo.entries.firstOrNull {
                it.key.lowercase().contains("embedding")
            } ?: encoderSession.outputInfo.entries.firstOrNull()
                ?: throw IllegalStateException("Encoder ONNX не содержит выходов")
            val outputName = outputEntry.key

            var embeddings: FloatArray? = null
            var embeddingsShape: LongArray? = null

            val inputTensor = OnnxTensor.createTensor(
                env,
                FloatBuffer.wrap(inputBuffer),
                layout.shape
            )
            try {
                try {
                    encoderSession.run(mapOf(inputName to inputTensor)).use { result ->
                        val outTensor = (result.get(outputName).orElse(null) as? OnnxTensor)
                            ?: (result.firstOrNull()?.value as? OnnxTensor)
                            ?: throw IllegalStateException("Encoder не вернул тензор '$outputName'")
                        val extracted = extractFloatArrayAndShape(outTensor)
                        embeddings = extracted.first
                        embeddingsShape = extracted.second
                    }
                } catch (err: Throwable) {
                    if (createCpuFallbackEncoder == null) throw err
                    Log.w(TAG, "Encoder failed on accelerated delegate (${err.message}); retrying on CPU")
                    fallbackPair = createCpuFallbackEncoder()
                    fallbackPair!!.first.run(mapOf(inputName to inputTensor)).use { result ->
                        val outTensor = (result.get(outputName).orElse(null) as? OnnxTensor)
                            ?: (result.firstOrNull()?.value as? OnnxTensor)
                            ?: throw IllegalStateException("Encoder CPU не вернул тензор '$outputName'")
                        val extracted = extractFloatArrayAndShape(outTensor)
                        embeddings = extracted.first
                        embeddingsShape = extracted.second
                    }
                }
            } finally {
                inputTensor.close()
            }

            val finalEmbeddings = embeddings
                ?: throw IllegalStateException("Пустые image_embeddings после encoder")
            val finalShape = embeddingsShape ?: longArrayOf(1, 256, 64, 64)

            synchronized(cacheLock) {
                cachedFrame = CachedSamFrame(
                    embeddings = finalEmbeddings,
                    embeddingsShape = finalShape,
                    origWidth = origW,
                    origHeight = origH,
                    resizedWidth = resizedW,
                    resizedHeight = resizedH,
                    targetWidth = layout.targetW,
                    targetHeight = layout.targetH,
                    scale = scale
                )
            }

            val elapsedMs = (System.nanoTime() - startedNs) / 1_000_000L
            Log.i(
                TAG,
                "SAM encoded ${origW}x${origH} -> ${resizedW}x${resizedH} (shape=${finalShape.contentToString()}) in ${elapsedMs}ms"
            )
            return SamEncodeResult(
                origWidth = origW,
                origHeight = origH,
                resizedWidth = resizedW,
                resizedHeight = resizedH,
                encoderSize = max(layout.targetW, layout.targetH),
                encodeTimeMs = elapsedMs
            )
        } finally {
            try {
                resizedBitmap?.recycle()
            } catch (_: Throwable) {
            }
            try {
                srcBitmap.recycle()
            } catch (_: Throwable) {
            }
            try {
                fallbackPair?.first?.close()
            } catch (_: Throwable) {
            }
            try {
                fallbackPair?.second?.close()
            } catch (_: Throwable) {
            }
        }
    }

    fun decodePoints(
        env: OrtEnvironment,
        decoderSession: OrtSession,
        points: List<SamPoint>,
        normalizedCoords: Boolean = true
    ): SamDecodeResult {
        if (points.isEmpty()) {
            throw IllegalArgumentException("Добавьте хотя бы одну точку на объект")
        }
        val state = synchronized(cacheLock) { cachedFrame }
            ?: throw IllegalStateException("Сначала закодируйте кадр (encodeSamFrame)")

        val startedNs = System.nanoTime()
        val numPrompts = points.size + 1 // +1 trailing padding point {0, 0, -1}
        val coordsFlat = FloatArray(numPrompts * 2)
        val labelsFlat = FloatArray(numPrompts)

        for (i in points.indices) {
            val pt = points[i]
            val pxOrig = if (normalizedCoords) {
                pt.x.coerceIn(0f, 1f) * state.origWidth.toFloat()
            } else {
                pt.x.coerceIn(0f, state.origWidth.toFloat())
            }
            val pyOrig = if (normalizedCoords) {
                pt.y.coerceIn(0f, 1f) * state.origHeight.toFloat()
            } else {
                pt.y.coerceIn(0f, state.origHeight.toFloat())
            }
            coordsFlat[i * 2] = pxOrig * state.scale
            coordsFlat[i * 2 + 1] = pyOrig * state.scale
            labelsFlat[i] = if (pt.label == 0) 0f else 1f
        }
        // Mandatory MobileSAM ONNX padding point at end
        coordsFlat[points.size * 2] = 0f
        coordsFlat[points.size * 2 + 1] = 0f
        labelsFlat[points.size] = -1f

        val createdTensors = mutableListOf<OnnxTensor>()
        val inputs = LinkedHashMap<String, OnnxTensor>()

        try {
            for ((name, nodeInfo) in decoderSession.inputInfo) {
                val lower = name.lowercase()
                val tInfo = nodeInfo.info as? TensorInfo
                val rawShape = tInfo?.shape ?: longArrayOf()
                val javaType = tInfo?.type ?: OnnxJavaType.FLOAT

                val tensor: OnnxTensor = when {
                    lower.contains("embedding") -> {
                        val shape = resolveConcreteShape(rawShape, state.embeddingsShape)
                        OnnxTensor.createTensor(env, FloatBuffer.wrap(state.embeddings), shape)
                    }

                    lower.contains("point_coord") || lower.contains("coord") -> {
                        val shape = if (rawShape.size == 2) {
                            longArrayOf(numPrompts.toLong(), 2L)
                        } else {
                            longArrayOf(1L, numPrompts.toLong(), 2L)
                        }
                        OnnxTensor.createTensor(env, FloatBuffer.wrap(coordsFlat), shape)
                    }

                    lower.contains("point_label") || lower.contains("label") -> {
                        val shape = if (rawShape.size == 1) {
                            longArrayOf(numPrompts.toLong())
                        } else {
                            longArrayOf(1L, numPrompts.toLong())
                        }
                        createTypedNumericTensor(env, javaType, labelsFlat, shape)
                    }

                    lower.contains("has_mask") -> {
                        val shape = if (rawShape.size >= 2) {
                            LongArray(rawShape.size) { 1L }
                        } else {
                            longArrayOf(1L)
                        }
                        createTypedNumericTensor(env, javaType, floatArrayOf(0f), shape)
                    }

                    lower.contains("mask_input") || lower == "masks" -> {
                        val mH = rawShape.getOrNull(rawShape.size - 2)?.toInt()?.takeIf { it > 0 }
                            ?: DEFAULT_LOW_RES_MASK_SIZE
                        val mW = rawShape.getOrNull(rawShape.size - 1)?.toInt()?.takeIf { it > 0 }
                            ?: DEFAULT_LOW_RES_MASK_SIZE
                        val shape = when (rawShape.size) {
                            2 -> longArrayOf(mH.toLong(), mW.toLong())
                            3 -> longArrayOf(1L, mH.toLong(), mW.toLong())
                            else -> longArrayOf(1L, 1L, mH.toLong(), mW.toLong())
                        }
                        val zeros = FloatArray(mH * mW)
                        OnnxTensor.createTensor(env, FloatBuffer.wrap(zeros), shape)
                    }

                    lower.contains("orig_im_size") || lower.contains("orig_size") || lower.contains("im_size") -> {
                        val shape = if (rawShape.size == 2) longArrayOf(1L, 2L) else longArrayOf(2L)
                        val imSize = floatArrayOf(state.origHeight.toFloat(), state.origWidth.toFloat())
                        createTypedNumericTensor(env, javaType, imSize, shape)
                    }

                    else -> {
                        val safeShape = LongArray(rawShape.size.coerceAtLeast(1)) { idx ->
                            rawShape.getOrNull(idx)?.takeIf { it > 0 } ?: 1L
                        }
                        val count = safeShape.fold(1L) { a, d -> a * d }.toInt().coerceAtLeast(1)
                        createTypedNumericTensor(env, javaType, FloatArray(count), safeShape)
                    }
                }
                createdTensors += tensor
                inputs[name] = tensor
            }

            val outNames = decoderSession.outputInfo.keys
            val masksOutName = outNames.firstOrNull { it.lowercase().contains("mask") }
                ?: outNames.firstOrNull()
                ?: throw IllegalStateException("Decoder ONNX не содержит выходных масок")
            val iouOutName = outNames.firstOrNull { it.lowercase().contains("iou") }

            decoderSession.run(inputs).use { result ->
                val masksTensor = (result.get(masksOutName).orElse(null) as? OnnxTensor)
                    ?: throw IllegalStateException("Decoder не вернул тензор '$masksOutName'")
                val (masksData, masksShape) = extractFloatArrayAndShape(masksTensor)

                val (bestIdx, bestIou) = if (iouOutName != null) {
                    val iouTensor = result.get(iouOutName).orElse(null) as? OnnxTensor
                    pickBestIouIndex(iouTensor)
                } else {
                    0 to 0.9f
                }

                val parsedMask = parseMaskShapeAndRender(
                    masksData = masksData,
                    masksShape = masksShape,
                    bestChannelIdx = bestIdx,
                    state = state
                )

                val elapsedMs = (System.nanoTime() - startedNs) / 1_000_000L
                return SamDecodeResult(
                    maskDataUrl = parsedMask.dataUrl,
                    width = state.origWidth,
                    height = state.origHeight,
                    iou = bestIou,
                    coverage = parsedMask.coverage,
                    boundsX = parsedMask.boundsX,
                    boundsY = parsedMask.boundsY,
                    boundsW = parsedMask.boundsW,
                    boundsH = parsedMask.boundsH,
                    decodeTimeMs = elapsedMs
                )
            }
        } finally {
            for (t in createdTensors) {
                try {
                    t.close()
                } catch (_: Throwable) {
                }
            }
        }
    }

    private data class RenderedMaskInfo(
        val dataUrl: String,
        val coverage: Float,
        val boundsX: Float,
        val boundsY: Float,
        val boundsW: Float,
        val boundsH: Float
    )

    private fun parseMaskShapeAndRender(
        masksData: FloatArray,
        masksShape: LongArray,
        bestChannelIdx: Int,
        state: CachedSamFrame
    ): RenderedMaskInfo {
        val numMasks: Int
        val maskH: Int
        val maskW: Int
        when (masksShape.size) {
            4 -> {
                numMasks = masksShape[1].toInt().coerceAtLeast(1)
                maskH = masksShape[2].toInt().coerceAtLeast(1)
                maskW = masksShape[3].toInt().coerceAtLeast(1)
            }
            3 -> {
                numMasks = masksShape[0].toInt().coerceAtLeast(1)
                maskH = masksShape[1].toInt().coerceAtLeast(1)
                maskW = masksShape[2].toInt().coerceAtLeast(1)
            }
            2 -> {
                numMasks = 1
                maskH = masksShape[0].toInt().coerceAtLeast(1)
                maskW = masksShape[1].toInt().coerceAtLeast(1)
            }
            else -> throw IllegalStateException(
                "Неожиданная форма выходной маски SAM: ${masksShape.contentToString()}"
            )
        }

        val chIdx = bestChannelIdx.coerceIn(0, numMasks - 1)
        val planeSize = maskH * maskW
        val planeOffset = (chIdx * planeSize).coerceIn(0, max(0, masksData.size - 1))

        // Determine whether decoder returned unpadded orig-size mask OR padded encoder-aligned mask
        val isAlreadyOrigSize = maskW == state.origWidth && maskH == state.origHeight
        val validMaskW = if (isAlreadyOrigSize) {
            maskW.toFloat()
        } else {
            (maskW.toFloat() * state.resizedWidth.toFloat() / state.targetWidth.toFloat())
                .coerceIn(1f, maskW.toFloat())
        }
        val validMaskH = if (isAlreadyOrigSize) {
            maskH.toFloat()
        } else {
            (maskH.toFloat() * state.resizedHeight.toFloat() / state.targetHeight.toFloat())
                .coerceIn(1f, maskH.toFloat())
        }

        val outW = state.origWidth
        val outH = state.origHeight
        val outPixels = IntArray(outW * outH)

        var fgCount = 0
        var minX = outW
        var minY = outH
        var maxX = -1
        var maxY = -1

        fun sampleLogitBilinear(fx: Float, fy: Float): Float {
            val cx = fx.coerceIn(0f, (maskW - 1).toFloat())
            val cy = fy.coerceIn(0f, (maskH - 1).toFloat())
            val x0 = cx.toInt().coerceIn(0, maskW - 1)
            val y0 = cy.toInt().coerceIn(0, maskH - 1)
            val x1 = (x0 + 1).coerceIn(0, maskW - 1)
            val y1 = (y0 + 1).coerceIn(0, maskH - 1)
            val dx = cx - x0
            val dy = cy - y0

            fun at(x: Int, y: Int): Float {
                val idx = planeOffset + y * maskW + x
                return if (idx in masksData.indices) masksData[idx] else -10f
            }

            val v00 = at(x0, y0)
            val v10 = at(x1, y0)
            val v01 = at(x0, y1)
            val v11 = at(x1, y1)
            val top = v00 + (v10 - v00) * dx
            val bot = v01 + (v11 - v01) * dx
            return top + (bot - top) * dy
        }

        for (y in 0 until outH) {
            val my = if (isAlreadyOrigSize) {
                y.toFloat()
            } else {
                ((y + 0.5f) / outH.toFloat()) * validMaskH - 0.5f
            }
            val rowOff = y * outW
            for (x in 0 until outW) {
                val mx = if (isAlreadyOrigSize) {
                    x.toFloat()
                } else {
                    ((x + 0.5f) / outW.toFloat()) * validMaskW - 0.5f
                }
                val logit = if (isAlreadyOrigSize) {
                    val idx = planeOffset + y * maskW + x
                    if (idx in masksData.indices) masksData[idx] else -10f
                } else {
                    sampleLogitBilinear(mx, my)
                }

                if (logit > 0f) {
                    outPixels[rowOff + x] = Color.WHITE
                    fgCount++
                    if (x < minX) minX = x
                    if (y < minY) minY = y
                    if (x > maxX) maxX = x
                    if (y > maxY) maxY = y
                } else {
                    outPixels[rowOff + x] = Color.TRANSPARENT
                }
            }
        }

        val maskBmp = Bitmap.createBitmap(outW, outH, Bitmap.Config.ARGB_8888)
        val pngBytes = try {
            maskBmp.setPixels(outPixels, 0, outW, 0, 0, outW, outH)
            ByteArrayOutputStream().use { baos ->
                maskBmp.compress(Bitmap.CompressFormat.PNG, 100, baos)
                baos.toByteArray()
            }
        } finally {
            try {
                maskBmp.recycle()
            } catch (_: Throwable) {
            }
        }

        val base64 = Base64.encodeToString(pngBytes, Base64.NO_WRAP)
        val dataUrl = "data:image/png;base64,$base64"

        val coverage = fgCount.toFloat() / max(1, outW * outH).toFloat()
        val bx = if (maxX >= minX) minX.toFloat() / outW.toFloat() else 0f
        val by = if (maxY >= minY) minY.toFloat() / outH.toFloat() else 0f
        val bw = if (maxX >= minX) (maxX - minX + 1).toFloat() / outW.toFloat() else 0f
        val bh = if (maxY >= minY) (maxY - minY + 1).toFloat() / outH.toFloat() else 0f

        return RenderedMaskInfo(
            dataUrl = dataUrl,
            coverage = coverage,
            boundsX = bx,
            boundsY = by,
            boundsW = bw,
            boundsH = bh
        )
    }

    private fun pickBestIouIndex(iouTensor: OnnxTensor?): Pair<Int, Float> {
        if (iouTensor == null) return 0 to 0.9f
        val fb = iouTensor.floatBuffer ?: return 0 to 0.9f
        val remaining = fb.remaining()
        if (remaining <= 0) return 0 to 0.9f
        val basePos = fb.position()
        var bestIdx = 0
        var bestScore = Float.NEGATIVE_INFINITY
        for (i in 0 until remaining) {
            val s = fb.get(basePos + i)
            if (s > bestScore) {
                bestScore = s
                bestIdx = i
            }
        }
        return bestIdx to (if (bestScore.isFinite()) bestScore else 0.9f)
    }

    private fun extractFloatArrayAndShape(tensor: OnnxTensor): Pair<FloatArray, LongArray> {
        val shape = (tensor.info as? TensorInfo)?.shape ?: longArrayOf()
        val fb = tensor.floatBuffer
            ?: throw IllegalStateException("Ожидался float32 выходной тензор SAM")
        val remaining = fb.remaining()
        val arr = FloatArray(remaining)
        fb.duplicate().get(arr)
        val concreteShape = if (shape.isNotEmpty()) {
            shape.copyOf()
        } else {
            longArrayOf(remaining.toLong())
        }
        return arr to concreteShape
    }

    private data class EncoderLayout(
        val shape: LongArray,
        val targetH: Int,
        val targetW: Int,
        val isNchw: Boolean
    )

    private fun resolveEncoderInputLayout(rawShape: LongArray): EncoderLayout {
        if (rawShape.size == 4) {
            val d1 = rawShape[1].toInt()
            val d2 = rawShape[2].toInt()
            val d3 = rawShape[3].toInt()
            return if (d1 == 3 || d3 != 3) {
                val h = if (d2 > 0) d2 else DEFAULT_ENCODER_SIZE
                val w = if (d3 > 0) d3 else DEFAULT_ENCODER_SIZE
                EncoderLayout(
                    shape = longArrayOf(1L, 3L, h.toLong(), w.toLong()),
                    targetH = h,
                    targetW = w,
                    isNchw = true
                )
            } else {
                val h = if (d1 > 0) d1 else DEFAULT_ENCODER_SIZE
                val w = if (d2 > 0) d2 else DEFAULT_ENCODER_SIZE
                EncoderLayout(
                    shape = longArrayOf(1L, h.toLong(), w.toLong(), 3L),
                    targetH = h,
                    targetW = w,
                    isNchw = false
                )
            }
        }
        if (rawShape.size == 3) {
            val d0 = rawShape[0].toInt()
            val d1 = rawShape[1].toInt()
            val d2 = rawShape[2].toInt()
            return if (d0 == 3 || d2 != 3) {
                val h = if (d1 > 0) d1 else DEFAULT_ENCODER_SIZE
                val w = if (d2 > 0) d2 else DEFAULT_ENCODER_SIZE
                EncoderLayout(
                    shape = longArrayOf(3L, h.toLong(), w.toLong()),
                    targetH = h,
                    targetW = w,
                    isNchw = true
                )
            } else {
                val h = if (d0 > 0) d0 else DEFAULT_ENCODER_SIZE
                val w = if (d1 > 0) d1 else DEFAULT_ENCODER_SIZE
                EncoderLayout(
                    shape = longArrayOf(h.toLong(), w.toLong(), 3L),
                    targetH = h,
                    targetW = w,
                    isNchw = false
                )
            }
        }
        return EncoderLayout(
            shape = longArrayOf(1L, 3L, DEFAULT_ENCODER_SIZE.toLong(), DEFAULT_ENCODER_SIZE.toLong()),
            targetH = DEFAULT_ENCODER_SIZE,
            targetW = DEFAULT_ENCODER_SIZE,
            isNchw = true
        )
    }

    private fun resolveConcreteShape(rawShape: LongArray, fallback: LongArray): LongArray {
        if (rawShape.size != fallback.size) return fallback.copyOf()
        return LongArray(rawShape.size) { i ->
            if (rawShape[i] > 0L) rawShape[i] else fallback[i]
        }
    }

    private fun createTypedNumericTensor(
        env: OrtEnvironment,
        javaType: OnnxJavaType,
        values: FloatArray,
        shape: LongArray
    ): OnnxTensor {
        return when (javaType) {
            OnnxJavaType.INT64 -> {
                val longs = LongArray(values.size) { i -> values[i].roundToInt().toLong() }
                OnnxTensor.createTensor(env, LongBuffer.wrap(longs), shape)
            }
            OnnxJavaType.INT32 -> {
                val ints = IntArray(values.size) { i -> values[i].roundToInt() }
                OnnxTensor.createTensor(env, IntBuffer.wrap(ints), shape)
            }
            else -> OnnxTensor.createTensor(env, FloatBuffer.wrap(values), shape)
        }
    }

    private suspend fun decodeBitmapFromInput(frameInput: String): Bitmap {
        val trimmed = frameInput.trim()
        if (trimmed.isEmpty()) {
            throw IllegalArgumentException("Пустой входной кадр для SAM")
        }

        // 1) Base64 Data URL or raw base64 payload
        if (trimmed.startsWith("data:", ignoreCase = true) ||
            (!trimmed.startsWith("/") &&
                !trimmed.startsWith("file://", ignoreCase = true) &&
                !trimmed.startsWith("content://", ignoreCase = true) &&
                !trimmed.startsWith("http://", ignoreCase = true) &&
                !trimmed.startsWith("https://", ignoreCase = true))
        ) {
            val base64Part = if (trimmed.contains("base64,", ignoreCase = true)) {
                trimmed.substringAfter("base64,").trim()
            } else {
                trimmed
            }
            val bytes = try {
                Base64.decode(base64Part, Base64.DEFAULT)
            } catch (err: Throwable) {
                val f = File(trimmed)
                if (f.exists() && f.isFile) {
                    return ensureArgb8888(BitmapFactory.decodeFile(f.absolutePath)
                        ?: throw IllegalStateException("Не удалось декодировать файл изображения: $trimmed"))
                }
                throw IllegalArgumentException("Некорректный base64-кадр для SAM: ${err.message}")
            }
            val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                ?: throw IllegalStateException("Не удалось декодировать Bitmap из base64")
            return ensureArgb8888(bmp)
        }

        // 2) File / Content URI / HTTP URL via MediaSourceResolver
        val (resolved, tempDownloaded) = MediaSourceResolver.resolveFileOrUri(
            context = appContext,
            sourceUrl = trimmed,
            fileName = null,
            tempPrefix = "sam-frame"
        )
        val target = resolved ?: trimmed
        try {
            val bmp = when {
                target.startsWith("content://", ignoreCase = true) -> {
                    appContext.contentResolver.openInputStream(Uri.parse(target))?.use { stream ->
                        BitmapFactory.decodeStream(stream)
                    }
                }
                target.startsWith("file://", ignoreCase = true) -> {
                    val path = Uri.parse(target).path ?: target
                    BitmapFactory.decodeFile(path)
                }
                else -> BitmapFactory.decodeFile(target)
            } ?: throw IllegalStateException("Не удалось открыть изображение кадра: $target")
            return ensureArgb8888(bmp)
        } finally {
            try {
                tempDownloaded?.delete()
            } catch (_: Throwable) {
            }
        }
    }

    private fun ensureArgb8888(bmp: Bitmap): Bitmap {
        if (bmp.config == Bitmap.Config.ARGB_8888) return bmp
        val copy = bmp.copy(Bitmap.Config.ARGB_8888, false)
        bmp.recycle()
        return copy
    }
}
