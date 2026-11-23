package com.cutsync.webcut

import android.app.Activity
import android.content.Intent
import androidx.activity.result.ActivityResult
import com.cutsync.webcut.ai.AIModelManager
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
