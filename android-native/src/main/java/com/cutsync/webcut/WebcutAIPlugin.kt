package com.cutsync.webcut

import android.app.Activity
import android.content.Intent
import androidx.activity.result.ActivityResult
import com.cutsync.webcut.ai.AIModelManager
import com.cutsync.webcut.ai.SamSegmenterEngine
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/**
 * Capacitor Bridge exposing local ONNX Runtime Mobile AI Engine to TypeScript (window.WebcutAI).
 */
@CapacitorPlugin(name = "WebcutAI")
class WebcutAIPlugin : Plugin() {
    private lateinit var aiManager: AIModelManager
    private val pluginScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun load() {
        // Lazy initialization: does NOT load OrtEnvironment or any model weights at app startup.
        aiManager = AIModelManager.getInstance(context)

        aiManager.onDownloadProgress = { modelId, progress ->
            notifyListeners(
                "aiModelDownloadProgress",
                JSObject().apply {
                    put("modelId", modelId)
                    put("progress", progress)
                }
            )
        }

        aiManager.onDownloadComplete = { modelId, fileName, sizeBytes ->
            notifyListeners(
                "aiModelDownloadComplete",
                JSObject().apply {
                    put("modelId", modelId)
                    put("fileName", fileName)
                    put("sizeBytes", sizeBytes)
                }
            )
        }

        aiManager.onDownloadError = { modelId, message ->
            notifyListeners(
                "aiModelDownloadError",
                JSObject().apply {
                    put("modelId", modelId)
                    put("message", message)
                }
            )
        }
    }

    override fun handleOnDestroy() {
        pluginScope.launch {
            try {
                aiManager.releaseActiveModel()
            } catch (_: Throwable) {
            }
        }
        pluginScope.cancel()
        super.handleOnDestroy()
    }

    @PluginMethod
    fun getAvailableModelsStatus(call: PluginCall) {
        pluginScope.launch {
            try {
                val statusJson = aiManager.getAvailableModelsStatusJson()
                call.resolve(jsonObjectToJsObject(statusJson))
            } catch (err: Throwable) {
                call.reject(err.message ?: "Не удалось получить статус AI-моделей")
            }
        }
    }

    @PluginMethod
    fun downloadModel(call: PluginCall) {
        val modelId = call.getString("modelId") ?: run {
            call.reject("Missing modelId")
            return
        }
        val overrideUrl = call.getString("url")
        val overrideSize = call.getDouble("expectedSize")?.toLong()
        val overrideHash = call.getString("expectedHash")
        try {
            aiManager.startModelDownload(
                modelId = modelId,
                overrideUrl = overrideUrl,
                overrideSize = overrideSize,
                overrideHash = overrideHash
            )
            call.resolve(JSObject().apply {
                put("started", true)
                put("modelId", modelId)
            })
        } catch (err: Throwable) {
            call.reject(err.message ?: "Не удалось запустить загрузку модели")
        }
    }

    @PluginMethod
    fun cancelDownload(call: PluginCall) {
        val modelId = call.getString("modelId") ?: ""
        if (modelId.isNotEmpty()) {
            aiManager.cancelDownload(modelId)
        }
        call.resolve(JSObject().apply { put("ok", true) })
    }

    @PluginMethod
    fun importModelsZip(call: PluginCall) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "application/zip"
            putExtra(
                Intent.EXTRA_MIME_TYPES,
                arrayOf(
                    "application/zip",
                    "application/x-zip-compressed",
                    "application/octet-stream"
                )
            )
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        startActivityForResult(call, intent, "onZipPackPicked")
    }

    @ActivityCallback
    private fun onZipPackPicked(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            call.resolve(
                JSObject().apply {
                    put("ok", false)
                    put("canceled", true)
                    put("importedCount", 0)
                    put("importedFiles", JSArray())
                    put("matchedModelIds", JSArray())
                    put("skippedFiles", JSArray())
                    put("totalBytes", 0L)
                }
            )
            return
        }

        pluginScope.launch {
            try {
                val unpackRes = aiManager.importModelsFromZipUri(uri)
                call.resolve(jsonObjectToJsObject(unpackRes.toJson()))
            } catch (err: Throwable) {
                call.reject(err.message ?: "Ошибка распаковки AI-пака (.zip)")
            }
        }
    }

    @PluginMethod
    fun prepareModel(call: PluginCall) {
        val modelId = call.getString("modelId") ?: run {
            call.reject("Missing modelId")
            return
        }
        pluginScope.launch {
            try {
                val res = aiManager.prepareModel(modelId)
                call.resolve(jsonObjectToJsObject(res))
            } catch (err: Throwable) {
                call.reject(err.message ?: "Не удалось инициализировать AI-модель")
            }
        }
    }

    @PluginMethod
    fun releaseActiveModel(call: PluginCall) {
        pluginScope.launch {
            try {
                val res = aiManager.releaseActiveModel()
                call.resolve(jsonObjectToJsObject(res))
            } catch (err: Throwable) {
                call.reject(err.message ?: "Не удалось выгрузить модель")
            }
        }
    }

    @PluginMethod
    fun deleteModel(call: PluginCall) {
        val modelId = call.getString("modelId") ?: run {
            call.reject("Missing modelId")
            return
        }
        pluginScope.launch {
            try {
                val res = aiManager.deleteModel(modelId)
                call.resolve(jsonObjectToJsObject(res))
            } catch (err: Throwable) {
                call.reject(err.message ?: "Не удалось удалить модель")
            }
        }
    }

    @PluginMethod
    fun transcribeAudio(call: PluginCall) {
        val sourceUrl = call.getString("sourceUrl") ?: ""
        val fileName = call.getString("fileName")
        val clipId = call.getString("clipId") ?: ""
        if (sourceUrl.isBlank() && fileName.isNullOrBlank()) {
            call.reject("Missing sourceUrl or fileName")
            return
        }
        val language = call.getString("language") ?: "auto"
        val trimStartMs = call.getDouble("trimStartMs", 0.0)?.toLong() ?: 0L
        val durationMs = call.getDouble("durationMs", -1.0)?.toLong() ?: -1L

        pluginScope.launch {
            try {
                val res = aiManager.transcribeAudioWithWhisper(
                    sourceUrl = sourceUrl,
                    fileName = fileName,
                    language = language,
                    trimStartMs = trimStartMs,
                    durationMs = durationMs
                ) { progress, stage ->
                    notifyListeners(
                        "aiTranscribeProgress",
                        JSObject().apply {
                            put("progress", progress)
                            put("stage", stage)
                            if (clipId.isNotEmpty()) put("clipId", clipId)
                        }
                    )
                }
                call.resolve(jsonObjectToJsObject(res))
            } catch (err: Throwable) {
                call.reject(err.message ?: "Ошибка распознавания речи (Whisper)")
            }
        }
    }

    @PluginMethod
    fun cancelTranscribe(call: PluginCall) {
        aiManager.cancelWhisperTranscription()
        call.resolve(JSObject().apply { put("ok", true) })
    }

    @PluginMethod
    fun trackObject(call: PluginCall) {
        val sourceUrl = call.getString("sourceUrl") ?: ""
        val fileName = call.getString("fileName")
        val clipId = call.getString("clipId") ?: ""
        if (sourceUrl.isBlank() && fileName.isNullOrBlank()) {
            call.reject("Missing sourceUrl or fileName")
            return
        }

        val startMs = call.getDouble("startMs", 0.0)?.toLong() ?: 0L
        val endMs = call.getDouble("endMs", -1.0)?.toLong() ?: -1L
        val sampleFps = call.getInt("sampleFps", 24) ?: 24

        val bboxObj = call.getObject("bbox")
        val bboxX = (bboxObj?.optDouble("x", 0.35) ?: call.getDouble("x", 0.35) ?: 0.35).toFloat()
        val bboxY = (bboxObj?.optDouble("y", 0.35) ?: call.getDouble("y", 0.35) ?: 0.35).toFloat()
        val bboxW = (bboxObj?.optDouble("w", 0.25) ?: call.getDouble("w", 0.25) ?: 0.25).toFloat()
        val bboxH = (bboxObj?.optDouble("h", 0.25) ?: call.getDouble("h", 0.25) ?: 0.25).toFloat()

        pluginScope.launch {
            try {
                val res = aiManager.trackObjectWithVitTrack(
                    sourceUrl = sourceUrl,
                    fileName = fileName,
                    startMs = startMs,
                    endMs = endMs,
                    bboxX = bboxX,
                    bboxY = bboxY,
                    bboxW = bboxW,
                    bboxH = bboxH,
                    sampleFps = sampleFps
                ) { progress, timeMs, point ->
                    notifyListeners(
                        "aiTrackProgress",
                        JSObject().apply {
                            put("progress", progress)
                            put("timeMs", timeMs)
                            if (clipId.isNotEmpty()) put("clipId", clipId)
                            if (point != null) {
                                put("point", jsonObjectToJsObject(point.toJson()))
                            }
                        }
                    )
                }
                call.resolve(jsonObjectToJsObject(res))
            } catch (err: Throwable) {
                call.reject(err.message ?: "Ошибка трекинга объекта (VitTrack)")
            }
        }
    }

    @PluginMethod
    fun cancelTracking(call: PluginCall) {
        aiManager.cancelObjectTracking()
        call.resolve(JSObject().apply { put("ok", true) })
    }

    @PluginMethod
    fun encodeSamFrame(call: PluginCall) {
        val frameInput = call.getString("frame")
            ?: call.getString("imageBase64")
            ?: call.getString("sourceUrl")
            ?: ""
        if (frameInput.isBlank()) {
            call.reject("Missing frame (base64 or path)")
            return
        }
        pluginScope.launch {
            try {
                val res = aiManager.encodeSamFrame(frameInput)
                call.resolve(jsonObjectToJsObject(res))
            } catch (err: Throwable) {
                call.reject(err.message ?: "Ошибка кодирования кадра (MobileSAM)")
            }
        }
    }

    @PluginMethod
    fun decodeSamPoints(call: PluginCall) {
        val pointsArr = call.getArray("points")
        if (pointsArr == null || pointsArr.length() == 0) {
            call.reject("Missing points array")
            return
        }
        val normalizedCoords = call.getBoolean("normalized", true) ?: true
        val points = ArrayList<SamSegmenterEngine.SamPoint>(pointsArr.length())
        for (i in 0 until pointsArr.length()) {
            val obj = pointsArr.optJSONObject(i) ?: continue
            val x = obj.optDouble("x", 0.5).toFloat()
            val y = obj.optDouble("y", 0.5).toFloat()
            val label = obj.optInt("label", 1)
            points += SamSegmenterEngine.SamPoint(x = x, y = y, label = label)
        }
        if (points.isEmpty()) {
            call.reject("No valid points provided")
            return
        }

        pluginScope.launch {
            try {
                val res = aiManager.decodeSamPoints(
                    points = points,
                    normalizedCoords = normalizedCoords
                )
                call.resolve(jsonObjectToJsObject(res))
            } catch (err: Throwable) {
                call.reject(err.message ?: "Ошибка декодирования маски (MobileSAM)")
            }
        }
    }

    private fun jsonObjectToJsObject(obj: JSONObject): JSObject {
        val out = JSObject()
        val keys = obj.keys()
        while (keys.hasNext()) {
            val k = keys.next()
            val v = obj.opt(k)
            when (v) {
                null, JSONObject.NULL -> out.put(k, JSONObject.NULL)
                is JSONObject -> out.put(k, jsonObjectToJsObject(v))
                is JSONArray -> out.put(k, jsonArrayToJsArray(v))
                else -> out.put(k, v)
            }
        }
        return out
    }

    private fun jsonArrayToJsArray(arr: JSONArray): JSArray {
        val out = JSArray()
        for (i in 0 until arr.length()) {
            when (val v = arr.opt(i)) {
                null, JSONObject.NULL -> out.put(JSONObject.NULL)
                is JSONObject -> out.put(jsonObjectToJsObject(v))
                is JSONArray -> out.put(jsonArrayToJsArray(v))
                else -> out.put(v)
            }
        }
        return out
    }
}
