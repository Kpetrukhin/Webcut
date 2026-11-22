package com.cutsync.webcut

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.text.BreakIterator
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * Renders styled text layers onto transparent ARGB_8888 Android Bitmaps using
 * android.graphics.Canvas + Paint so Media3 BitmapOverlay and live preview
 * share identical typography, stroke-under-fill, shadows, 3 background modes,
 * spacing, and curved text geometry (arc / wave / zigzag).
 */
object TextBitmapRenderer {

    private val typefaceCache = ConcurrentHashMap<String, Typeface>()

    data class CurvePoint(
        val id: String,
        val x: Float,
        val y: Float
    )

    private data class SplineSample(
        val x: Float,
        val y: Float,
        val dist: Float
    )

    private data class SplineLut(
        val samples: List<SplineSample>,
        val totalLen: Float
    )

    private data class SplineEval(
        val x: Float,
        val y: Float,
        val angle: Float
    )

    data class TextStyleSpec(
        val fontSize: Float = 48f,
        val fontFamily: String = "Plus Jakarta Sans",
        val fontSrc: String? = null,
        val fontWeight: String = "bold",
        val fontStyle: String = "normal",
        val underline: Boolean = false,
        val color: Int = Color.WHITE,
        val bgColor: Int = Color.parseColor("#09090b"),
        val bgMode: String = "none", // "none" | "chars" | "lines" | "block"
        val bgOpacity: Float = 0.72f,
        val shadow: Boolean = false,
        val shadowColor: Int = Color.BLACK,
        val shadowOffsetX: Float = 0f,
        val shadowOffsetY: Float = 4f,
        val shadowBlur: Float = 10f,
        val strokeColor: Int = Color.parseColor("#09090b"),
        val strokeWidth: Float = 0f,
        val letterSpacing: Float = 0f,
        val lineHeight: Float = 1.25f,
        val spaceWidth: Float = 1.0f,
        val curveMode: String = "none", // "none" | "arc" | "wave" | "zigzag" | "custom"
        val curveAmplitude: Float = 0f,
        val curveFrequency: Float = 2f,
        val curvePoints: List<CurvePoint> = emptyList(),
        val curveSmoothness: Float = 100f,
        val align: String = "center"
    )

    private data class GlyphPlacement(
        val ch: String,
        val isSpace: Boolean,
        val width: Float,
        val advance: Float,
        val x: Float,
        val y: Float,
        val angleRad: Float
    )

    private data class LinePlacement(
        val glyphs: List<GlyphPlacement>,
        val lineW: Float,
        val lineStartX: Float,
        val minX: Float,
        val maxX: Float,
        val minY: Float,
        val maxY: Float
    )

    fun parseColorString(raw: String?, fallback: Int): Int {
        if (raw.isNullOrBlank()) return fallback
        val trimmed = raw.trim()
        if (trimmed.equals("transparent", ignoreCase = true)) {
            return Color.TRANSPARENT
        }
        val rgbaMatch = Regex(
            """rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([0-9.]+))?\s*\)""",
            RegexOption.IGNORE_CASE
        ).find(trimmed)
        if (rgbaMatch != null) {
            val r = rgbaMatch.groupValues[1].toIntOrNull()?.coerceIn(0, 255) ?: 0
            val g = rgbaMatch.groupValues[2].toIntOrNull()?.coerceIn(0, 255) ?: 0
            val b = rgbaMatch.groupValues[3].toIntOrNull()?.coerceIn(0, 255) ?: 0
            val a = rgbaMatch.groupValues[4].toFloatOrNull()?.coerceIn(0f, 1f) ?: 1f
            return Color.argb((a * 255f).toInt().coerceIn(0, 255), r, g, b)
        }
        return try {
            Color.parseColor(trimmed)
        } catch (_: Throwable) {
            fallback
        }
    }

    fun parseStyleJson(json: JSONObject?): TextStyleSpec {
        if (json == null) return TextStyleSpec()
        val rawBg = json.optString("bgColor", "")
        var bgMode = json.optString("bgMode", "").lowercase()
        var bgOpacity = json.optDouble("bgOpacity", -1.0).toFloat()

        if (bgMode.isEmpty()) {
            bgMode = if (rawBg.isEmpty() || rawBg.equals("transparent", ignoreCase = true)) {
                "none"
            } else {
                "block"
            }
        }
        if (bgOpacity < 0f) {
            val parsedAlpha = Color.alpha(parseColorString(rawBg, Color.BLACK)) / 255f
            bgOpacity = if (rawBg.isEmpty() || rawBg.equals("transparent", ignoreCase = true)) {
                0.72f
            } else {
                parsedAlpha.coerceIn(0f, 1f)
            }
        }

        val outlineFlag = json.optBoolean("outline", false)
        val rawStrokeWidth = json.optDouble("strokeWidth", if (outlineFlag) 4.0 else 0.0).toFloat()

        val parsedPoints = mutableListOf<CurvePoint>()
        val ptsArr = json.optJSONArray("curvePoints")
        if (ptsArr != null) {
            for (i in 0 until ptsArr.length()) {
                val obj = ptsArr.optJSONObject(i) ?: continue
                val px = obj.optDouble("x", Double.NaN).toFloat()
                val py = obj.optDouble("y", Double.NaN).toFloat()
                if (px.isFinite() && py.isFinite()) {
                    parsedPoints.add(
                        CurvePoint(
                            id = obj.optString("id", "pt-$i").ifEmpty { "pt-$i" },
                            x = px,
                            y = py
                        )
                    )
                }
            }
        }

        return TextStyleSpec(
            fontSize = json.optDouble("fontSize", 48.0).toFloat().coerceIn(10f, 360f),
            fontFamily = json.optString("fontFamily", "Plus Jakarta Sans"),
            fontSrc = json.optString("fontSrc", "").ifEmpty { null },
            fontWeight = json.optString("fontWeight", "bold"),
            fontStyle = json.optString("fontStyle", "normal"),
            underline = json.optBoolean("underline", false),
            color = parseColorString(json.optString("color", "#ffffff"), Color.WHITE),
            bgColor = parseColorString(rawBg.ifEmpty { "#09090b" }, Color.parseColor("#09090b")),
            bgMode = bgMode,
            bgOpacity = bgOpacity.coerceIn(0f, 1f),
            shadow = json.optBoolean("shadow", false),
            shadowColor = parseColorString(json.optString("shadowColor", "#000000"), Color.BLACK),
            shadowOffsetX = json.optDouble("shadowOffsetX", 0.0).toFloat(),
            shadowOffsetY = json.optDouble("shadowOffsetY", 4.0).toFloat(),
            shadowBlur = json.optDouble("shadowBlur", 10.0).toFloat().coerceAtLeast(0f),
            strokeColor = parseColorString(json.optString("strokeColor", "#09090b"), Color.parseColor("#09090b")),
            strokeWidth = rawStrokeWidth.coerceIn(0f, 40f),
            letterSpacing = json.optDouble("letterSpacing", 0.0).toFloat(),
            lineHeight = json.optDouble("lineHeight", 1.25).toFloat().coerceIn(0.6f, 3.5f),
            spaceWidth = json.optDouble("spaceWidth", 1.0).toFloat().coerceIn(0.2f, 4f),
            curveMode = json.optString("curveMode", "none").lowercase(),
            curveAmplitude = json.optDouble("curveAmplitude", 0.0).toFloat(),
            curveFrequency = json.optDouble("curveFrequency", 2.0).toFloat().coerceIn(0.25f, 10f),
            curvePoints = parsedPoints,
            curveSmoothness = json.optDouble("curveSmoothness", 100.0).toFloat().coerceIn(0f, 100f),
            align = json.optString("align", "center").lowercase()
        )
    }

    private fun buildCustomSplineLut(
        points: List<CurvePoint>,
        scale: Float,
        smoothness01: Float,
        stepsPerSeg: Int = 26
    ): SplineLut? {
        if (points.size < 2) return null
        val s = smoothness01.coerceIn(0f, 1f)
        val scaled = points.map { Pair(it.x * scale, it.y * scale) }
        val samples = mutableListOf<SplineSample>()
        var totalDist = 0f

        for (i in 0 until scaled.size - 1) {
            val p1 = scaled[i]
            val p2 = scaled[i + 1]
            val p0 = if (i > 0) scaled[i - 1] else Pair(2f * p1.first - p2.first, 2f * p1.second - p2.second)
            val p3 = if (i + 2 < scaled.size) scaled[i + 2] else Pair(2f * p2.first - p1.first, 2f * p2.second - p1.second)

            val startStep = if (i == 0) 0 else 1
            for (step in startStep..stepsPerSeg) {
                val u = step.toFloat() / stepsPerSeg.toFloat()
                val u2 = u * u
                val u3 = u2 * u

                val cx = 0.5f * (
                    2f * p1.first +
                    (-p0.first + p2.first) * u +
                    (2f * p0.first - 5f * p1.first + 4f * p2.first - p3.first) * u2 +
                    (-p0.first + 3f * p1.first - 3f * p2.first + p3.first) * u3
                )
                val cy = 0.5f * (
                    2f * p1.second +
                    (-p0.second + p2.second) * u +
                    (2f * p0.second - 5f * p1.second + 4f * p2.second - p3.second) * u2 +
                    (-p0.second + 3f * p1.second - 3f * p2.second + p3.second) * u3
                )

                val lx = p1.first + (p2.first - p1.first) * u
                val ly = p1.second + (p2.second - p1.second) * u

                val x = lx + (cx - lx) * s
                val y = ly + (cy - ly) * s

                if (samples.isNotEmpty()) {
                    val prev = samples.last()
                    totalDist += hypot(x - prev.x, y - prev.y)
                }
                samples.add(SplineSample(x, y, totalDist))
            }
        }
        return SplineLut(samples, totalDist)
    }

    private fun sampleSplineAtArcDist(lut: SplineLut, dist: Float): SplineEval {
        val samples = lut.samples
        val totalLen = lut.totalLen
        if (samples.isEmpty()) return SplineEval(0f, 0f, 0f)
        if (samples.size == 1 || totalLen < 0.001f) {
            return SplineEval(samples[0].x, samples[0].y, 0f)
        }

        fun segAngle(idxA: Int, idxB: Int): Float {
            val a = samples[idxA]
            val b = samples[idxB]
            val dx = b.x - a.x
            val dy = b.y - a.y
            if (hypot(dx, dy) < 1e-4f) return 0f
            return atan2(dy, dx)
        }

        if (dist <= 0f) {
            var nextIdx = 1
            while (nextIdx < samples.size - 1 && samples[nextIdx].dist < 1f) {
                nextIdx++
            }
            val angle = segAngle(0, nextIdx)
            return SplineEval(
                x = samples[0].x + cos(angle) * dist,
                y = samples[0].y + sin(angle) * dist,
                angle = angle
            )
        }

        if (dist >= totalLen) {
            val last = samples.size - 1
            var prevIdx = last - 1
            while (prevIdx > 0 && totalLen - samples[prevIdx].dist < 1f) {
                prevIdx--
            }
            val angle = segAngle(prevIdx, last)
            val extra = dist - totalLen
            return SplineEval(
                x = samples[last].x + cos(angle) * extra,
                y = samples[last].y + sin(angle) * extra,
                angle = angle
            )
        }

        var lo = 0
        var hi = samples.size - 1
        while (lo + 1 < hi) {
            val mid = (lo + hi) ushr 1
            if (samples[mid].dist <= dist) lo = mid else hi = mid
        }

        val a = samples[lo]
        val b = samples[hi]
        val segDist = max(1e-5f, b.dist - a.dist)
        val t = (dist - a.dist) / segDist

        val tPrev = samples[max(0, lo - 1)]
        val tNext = samples[min(samples.size - 1, hi + 1)]
        val angle = atan2(tNext.y - tPrev.y, tNext.x - tPrev.x)

        return SplineEval(
            x = a.x + (b.x - a.x) * t,
            y = a.y + (b.y - a.y) * t,
            angle = angle
        )
    }

    private fun resolveTypeface(
        context: Context,
        spec: TextStyleSpec,
        engine: KtorLanEngine?
    ): Typeface {
        val isBold = spec.fontWeight.equals("bold", ignoreCase = true)
        val isItalic = spec.fontStyle.equals("italic", ignoreCase = true)
        val tfStyle = when {
            isBold && isItalic -> Typeface.BOLD_ITALIC
            isBold -> Typeface.BOLD
            isItalic -> Typeface.ITALIC
            else -> Typeface.NORMAL
        }

        if (!spec.fontSrc.isNullOrEmpty()) {
            val cacheKey = "${spec.fontSrc}#$tfStyle"
            typefaceCache[cacheKey]?.let { return it }

            var customFile: File? = engine?.resolveCachedMediaFile(spec.fontSrc, null)
            if (customFile == null && spec.fontSrc.startsWith("file://")) {
                val f = File(spec.fontSrc.removePrefix("file://"))
                if (f.exists()) customFile = f
            }
            if (customFile == null) {
                val candidate = File(File(context.cacheDir, "cutsync_media"), File(spec.fontSrc).name)
                if (candidate.exists()) customFile = candidate
            }

            if (customFile != null && customFile.exists()) {
                try {
                    val base = Typeface.createFromFile(customFile)
                    val styled = Typeface.create(base, tfStyle)
                    typefaceCache[cacheKey] = styled
                    return styled
                } catch (_: Throwable) {
                }
            }
        }

        val familyLower = spec.fontFamily.lowercase()
        val base = when {
            familyLower.contains("mono") -> Typeface.MONOSPACE
            familyLower.contains("serif") || familyLower.contains("georgia") || familyLower.contains("playfair") -> Typeface.SERIF
            else -> Typeface.SANS_SERIF
        }
        return Typeface.create(base, tfStyle)
    }

    private fun splitGraphemes(text: String): List<String> {
        if (text.isEmpty()) return emptyList()
        val result = mutableListOf<String>()
        val it = BreakIterator.getCharacterInstance()
        it.setText(text)
        var start = it.first()
        var end = it.next()
        while (end != BreakIterator.DONE) {
            result.add(text.substring(start, end))
            start = end
            end = it.next()
        }
        return result
    }

    fun renderToBitmap(
        context: Context,
        text: String,
        spec: TextStyleSpec,
        scaleFactor: Float = 1f,
        engine: KtorLanEngine? = null
    ): Bitmap {
        val safeScale = scaleFactor.coerceIn(0.2f, 4f)
        val fontSize = max(10f, spec.fontSize * safeScale)
        val strokeW = max(0f, spec.strokeWidth * safeScale)
        val letterSpacingPx = spec.letterSpacing * safeScale
        val lineStep = fontSize * spec.lineHeight
        val spaceScale = spec.spaceWidth
        val shadowBlur = if (spec.shadow) spec.shadowBlur * safeScale else 0f
        val shadowDx = if (spec.shadow) spec.shadowOffsetX * safeScale else 0f
        val shadowDy = if (spec.shadow) spec.shadowOffsetY * safeScale else 0f

        val typeface = resolveTypeface(context, spec, engine)
        val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.SUBPIXEL_TEXT_FLAG).apply {
            this.typeface = typeface
            textSize = fontSize
            textAlign = Paint.Align.CENTER
            color = spec.color
            style = Paint.Style.FILL
            isUnderlineText = false
        }

        val spaceAdvance = fillPaint.measureText(" ") * spaceScale
        val rawLines = text.ifEmpty { " " }.split("\n")
        val metrics = fillPaint.fontMetrics
        val ascent = -metrics.ascent
        val descent = metrics.descent
        val baselineOffsetFromCenter = (ascent - descent) * 0.5f
        val halfGlyphH = fontSize * 0.52f

        val measuredLines = rawLines.map { line ->
            val chars = splitGraphemes(line)
            var totalW = 0f
            val charMetrics = chars.mapIndexed { idx, ch ->
                val isSpace = ch == " " || ch == "\t"
                val w = if (isSpace) spaceAdvance * (if (ch == "\t") 2f else 1f) else fillPaint.measureText(ch)
                val adv = w + if (idx < chars.size - 1) letterSpacingPx else 0f
                totalW += adv
                Triple(ch, w, adv)
            }
            Triple(chars, charMetrics, totalW)
        }

        val maxRawW = max(fontSize * 0.8f, measuredLines.maxOfOrNull { it.third } ?: fontSize)
        val totalHeight = rawLines.size * lineStep

        val linePlacements = mutableListOf<LinePlacement>()
        var globalMinX = Float.POSITIVE_INFINITY
        var globalMaxX = Float.NEGATIVE_INFINITY
        var globalMinY = Float.POSITIVE_INFINITY
        var globalMaxY = Float.NEGATIVE_INFINITY

        val curveMode = spec.curveMode
        val amp = spec.curveAmplitude
        val freq = max(0.25f, spec.curveFrequency)
        val customLut = if (curveMode == "custom" && spec.curvePoints.size >= 2) {
            buildCustomSplineLut(spec.curvePoints, safeScale, spec.curveSmoothness / 100f)
        } else {
            null
        }

        measuredLines.forEachIndexed { li, (chars, charMetrics, lineW) ->
            val baseY = -totalHeight / 2f + (li + 0.5f) * lineStep
            val lineStartX = when (spec.align) {
                "left" -> -maxRawW / 2f
                "right" -> maxRawW / 2f - lineW
                else -> -lineW / 2f
            }

            val effectiveLineW = max(lineW, fontSize * 0.4f)
            val midX = lineStartX + effectiveLineW / 2f

            var cursor = 0f
            val glyphs = mutableListOf<GlyphPlacement>()
            var lineMinX = Float.POSITIVE_INFINITY
            var lineMaxX = Float.NEGATIVE_INFINITY
            var lineMinY = Float.POSITIVE_INFINITY
            var lineMaxY = Float.NEGATIVE_INFINITY

            for ((ch, w, adv) in charMetrics) {
                val cx = cursor + w / 2f
                cursor += adv

                val gx = lineStartX + cx
                val s = cx - effectiveLineW / 2f
                var px = gx
                var py = baseY
                var angle = 0f

                if (customLut != null) {
                    val targetDist = when (spec.align) {
                        "left" -> cx
                        "right" -> customLut.totalLen - (lineW - cx)
                        else -> customLut.totalLen / 2f + (cx - lineW / 2f)
                    }
                    val sp = sampleSplineAtArcDist(customLut, targetDist)
                    px = sp.x - sin(sp.angle) * baseY
                    py = sp.y + cos(sp.angle) * baseY
                    angle = sp.angle
                } else if (curveMode != "none" && abs(amp) >= 0.05f) {
                    when (curveMode) {
                        "arc" -> {
                            val strength = (amp / 100f).coerceIn(-1f, 1f)
                            val arcLen = max(effectiveLineW, fontSize * 1.5f)
                            val maxAngle = max(0.08f, abs(strength) * PI.toFloat() * 1.15f)
                            val radius = arcLen / maxAngle
                            val theta = s / radius
                            if (strength > 0f) {
                                px = midX + radius * sin(theta)
                                py = baseY + radius * (1f - cos(theta))
                                angle = theta
                            } else {
                                px = midX + radius * sin(theta)
                                py = baseY - radius * (1f - cos(theta))
                                angle = -theta
                            }
                        }
                        "wave" -> {
                            val ampPx = (amp / 100f) * fontSize * 1.25f
                            val span = max(fontSize * 4.5f, effectiveLineW)
                            val k = (freq * PI.toFloat() * 2f) / span
                            val phase = s * k
                            px = gx
                            py = baseY - ampPx * sin(phase)
                            val slope = -ampPx * k * cos(phase)
                            angle = atan(slope).coerceIn(-1.25f, 1.25f)
                        }
                        "zigzag" -> {
                            val ampPx = (amp / 100f) * fontSize * 1.25f
                            val span = max(fontSize * 4.5f, effectiveLineW)
                            val t = (s / span) * freq + 0.25f
                            val frac = t - floor(t)
                            val tri = if (frac < 0.5f) 4f * frac - 1f else 3f - 4f * frac
                            val slopeDir = if (frac < 0.5f) 1f else -1f
                            px = gx
                            py = baseY - ampPx * tri
                            val slope = -ampPx * slopeDir * ((4f * freq) / span)
                            angle = atan(slope).coerceIn(-1.25f, 1.25f)
                        }
                    }
                }

                val cosA = abs(cos(angle))
                val sinA = abs(sin(angle))
                val rx = (w / 2f) * cosA + halfGlyphH * sinA
                val ry = (w / 2f) * sinA + halfGlyphH * cosA

                lineMinX = min(lineMinX, px - rx)
                lineMaxX = max(lineMaxX, px + rx)
                lineMinY = min(lineMinY, py - ry)
                lineMaxY = max(lineMaxY, py + ry)

                glyphs.add(
                    GlyphPlacement(
                        ch = ch,
                        isSpace = ch == " " || ch == "\t",
                        width = w,
                        advance = adv,
                        x = px,
                        y = py,
                        angleRad = angle
                    )
                )
            }

            if (chars.isEmpty()) {
                lineMinX = lineStartX - fontSize * 0.2f
                lineMaxX = lineStartX + fontSize * 0.2f
                lineMinY = baseY - halfGlyphH
                lineMaxY = baseY + halfGlyphH
            }

            globalMinX = min(globalMinX, lineMinX)
            globalMaxX = max(globalMaxX, lineMaxX)
            globalMinY = min(globalMinY, lineMinY)
            globalMaxY = max(globalMaxY, lineMaxY)

            linePlacements.add(
                LinePlacement(
                    glyphs = glyphs,
                    lineW = effectiveLineW,
                    lineStartX = lineStartX,
                    minX = lineMinX,
                    maxX = lineMaxX,
                    minY = lineMinY,
                    maxY = lineMaxY
                )
            )
        }

        if (!globalMinX.isFinite()) {
            globalMinX = -fontSize
            globalMaxX = fontSize
            globalMinY = -halfGlyphH
            globalMaxY = halfGlyphH
        }

        val blockPadX = fontSize * 0.36f + strokeW
        val blockPadY = fontSize * 0.24f + strokeW
        val extraBlurPad = shadowBlur * 1.6f + max(abs(shadowDx), abs(shadowDy)) + strokeW + 16f
        val padL = max(blockPadX, extraBlurPad)
        val padR = padL
        val padT = max(blockPadY, extraBlurPad)
        val padB = padT

        val outW = max(8, (globalMaxX - globalMinX + padL + padR).toInt() + 4)
        val outH = max(8, (globalMaxY - globalMinY + padT + padB).toInt() + 4)

        val bitmap = Bitmap.createBitmap(outW, outH, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val originX = -globalMinX + padL
        val originY = -globalMinY + padT

        canvas.save()
        canvas.translate(originX, originY)

        // 1. Background layer (none | chars | lines | block)
        if (spec.bgMode != "none" && spec.bgOpacity > 0.01f && Color.alpha(spec.bgColor) > 0) {
            val baseAlpha = (Color.alpha(spec.bgColor) / 255f) * spec.bgOpacity
            val bgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                style = Paint.Style.FILL
                color = Color.argb(
                    (baseAlpha * 255f).toInt().coerceIn(0, 255),
                    Color.red(spec.bgColor),
                    Color.green(spec.bgColor),
                    Color.blue(spec.bgColor)
                )
            }

            when (spec.bgMode) {
                "block" -> {
                    val rect = RectF(
                        globalMinX - blockPadX,
                        globalMinY - blockPadY,
                        globalMaxX + blockPadX,
                        globalMaxY + blockPadY
                    )
                    val radius = fontSize * 0.22f
                    canvas.drawRoundRect(rect, radius, radius, bgPaint)
                }
                "lines" -> {
                    val lPadX = fontSize * 0.3f + strokeW
                    val lPadY = fontSize * 0.14f + strokeW * 0.6f
                    val radius = fontSize * 0.22f
                    for (lp in linePlacements) {
                        val rect = RectF(
                            lp.minX - lPadX,
                            lp.minY - lPadY,
                            lp.maxX + lPadX,
                            lp.maxY + lPadY
                        )
                        canvas.drawRoundRect(rect, radius, radius, bgPaint)
                    }
                }
                "chars" -> {
                    val cPadX = fontSize * 0.14f + strokeW * 0.5f
                    val cPadY = fontSize * 0.12f + strokeW * 0.5f
                    val radius = fontSize * 0.18f
                    for (lp in linePlacements) {
                        for (g in lp.glyphs) {
                            if (g.isSpace) continue
                            canvas.save()
                            canvas.translate(g.x, g.y)
                            if (abs(g.angleRad) > 0.001f) {
                                canvas.rotate(Math.toDegrees(g.angleRad.toDouble()).toFloat())
                            }
                            val rect = RectF(
                                -g.width / 2f - cPadX,
                                -halfGlyphH - cPadY,
                                g.width / 2f + cPadX,
                                halfGlyphH + cPadY
                            )
                            canvas.drawRoundRect(rect, radius, radius, bgPaint)
                            canvas.restore()
                        }
                    }
                }
            }
        }

        val strokePaint = if (strokeW > 0.1f) {
            Paint(fillPaint).apply {
                style = Paint.Style.STROKE
                strokeWidth = strokeW * 2f
                strokeJoin = Paint.Join.ROUND
                strokeCap = Paint.Cap.ROUND
                color = spec.strokeColor
                if (spec.shadow) {
                    setShadowLayer(max(0.5f, shadowBlur), shadowDx, shadowDy, spec.shadowColor)
                }
            }
        } else {
            null
        }

        val mainFillPaint = Paint(fillPaint).apply {
            if (spec.shadow && strokePaint == null) {
                setShadowLayer(max(0.5f, shadowBlur), shadowDx, shadowDy, spec.shadowColor)
            }
        }

        val underlinePaint = if (spec.underline) {
            Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = spec.color
                strokeWidth = max(1.5f, fontSize * 0.065f)
                strokeCap = Paint.Cap.ROUND
            }
        } else {
            null
        }

        // 2. Render each glyph (stroke UNDER fill + optional underline)
        for (lp in linePlacements) {
            for (g in lp.glyphs) {
                if (g.isSpace) {
                    if (underlinePaint != null) {
                        canvas.save()
                        canvas.translate(g.x, g.y)
                        if (abs(g.angleRad) > 0.001f) {
                            canvas.rotate(Math.toDegrees(g.angleRad.toDouble()).toFloat())
                        }
                        val uY = baselineOffsetFromCenter + fontSize * 0.12f
                        canvas.drawLine(-g.advance / 2f, uY, g.advance / 2f, uY, underlinePaint)
                        canvas.restore()
                    }
                    continue
                }

                canvas.save()
                canvas.translate(g.x, g.y)
                if (abs(g.angleRad) > 0.001f) {
                    canvas.rotate(Math.toDegrees(g.angleRad.toDouble()).toFloat())
                }
                if (strokePaint != null) {
                    canvas.drawText(g.ch, 0f, baselineOffsetFromCenter, strokePaint)
                }
                canvas.drawText(g.ch, 0f, baselineOffsetFromCenter, mainFillPaint)
                if (underlinePaint != null) {
                    val uY = baselineOffsetFromCenter + fontSize * 0.12f
                    val hw = g.width / 2f + letterSpacingPx * 0.35f
                    canvas.drawLine(-hw, uY, hw, uY, underlinePaint)
                }
                canvas.restore()
            }
        }

        canvas.restore()
        return bitmap
    }

    fun renderToPngBase64(
        context: Context,
        text: String,
        styleJson: JSONObject?,
        scaleFactor: Float = 1f,
        engine: KtorLanEngine? = null
    ): Triple<Int, Int, String> {
        val spec = parseStyleJson(styleJson)
        val bmp = renderToBitmap(context, text, spec, scaleFactor, engine)
        val bos = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.PNG, 100, bos)
        val bytes = bos.toByteArray()
        val width = bmp.width
        val height = bmp.height
        bmp.recycle()
        val b64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
        return Triple(width, height, b64)
    }
}
