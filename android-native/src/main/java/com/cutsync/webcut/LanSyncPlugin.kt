package com.cutsync.webcut

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.util.Base64
import androidx.activity.result.ActivityResult
import androidx.core.content.FileProvider
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

@CapacitorPlugin(
    name = "LanSync",
    permissions = [
        Permission(
            strings = [Manifest.permission.RECORD_AUDIO],
            alias = "microphone"
        )
    ]
)
class LanSyncPlugin : Plugin() {
    private lateinit var engine: KtorLanEngine

    override fun load() {
        engine = KtorLanEngine(context)

        engine.onUdpRoomsChanged = { roomsArr: JSONArray ->
            val payload = JSObject()
            val jsRooms = JSArray()
            for (i in 0 until roomsArr.length()) {
                jsRooms.put(roomsArr.optJSONObject(i))
            }
            payload.put("rooms", jsRooms)
            notifyListeners("udpRoomsUpdate", payload)
        }

        engine.onDownloadProgress = { layerId: String, progress: Int ->
            val payload = JSObject().apply {
                put("layerId", layerId)
                put("progress", progress)
            }
            notifyListeners("mediaDownloadProgress", payload)
        }

        engine.onDownloadComplete = { layerId: String, fileName: String, localUrl: String ->
            val payload = JSObject().apply {
                put("layerId", layerId)
                put("fileName", fileName)
                put("localUrl", localUrl)
            }
            notifyListeners("mediaDownloadComplete", payload)
        }

        engine.onDownloadError = { layerId: String, message: String ->
            val payload = JSObject().apply {
                put("layerId", layerId)
                put("message", message)
            }
            notifyListeners("mediaDownloadError", payload)
        }

        engine.onCompressProgress = { layerId: String, progress: Int ->
            val payload = JSObject().apply {
                put("layerId", layerId)
                put("progress", progress)
            }
            notifyListeners("mediaCompressProgress", payload)
        }

        engine.onCompressComplete = { layerId: String, fileName: String, localUrl: String, shareUrl: String, originalSizeBytes: Long, compressedSizeBytes: Long ->
            val payload = JSObject().apply {
                put("layerId", layerId)
                put("fileName", fileName)
                put("localUrl", localUrl)
                put("shareUrl", shareUrl)
                put("originalSizeBytes", originalSizeBytes)
                put("compressedSizeBytes", compressedSizeBytes)
            }
            notifyListeners("mediaCompressComplete", payload)
        }

        engine.onCompressError = { layerId: String, message: String ->
            val payload = JSObject().apply {
                put("layerId", layerId)
                put("message", message)
            }
            notifyListeners("mediaCompressError", payload)
        }
    }

    override fun handleOnDestroy() {
        engine.stopServer()
        engine.stopUdpDiscovery()
        super.handleOnDestroy()
    }

    private fun buildInterfacesPayload(): JSObject {
        val ifaces = engine.getLocalNetworkInterfaces()
        val arr = JSArray()
        for (item in ifaces) {
            arr.put(
                JSObject().apply {
                    put("name", item.name)
                    put("ip", item.ip)
                    put("type", item.type)
                    put("label", item.label)
                }
            )
        }
        return JSObject().apply {
            put("interfaces", arr)
            put("primaryIp", engine.getPrimaryIp())
            put("port", engine.getBoundPort())
            put("udpPort", 8081)
        }
    }

    @PluginMethod
    fun getNetworkInfo(call: PluginCall) {
        call.resolve(buildInterfacesPayload())
    }

    @PluginMethod
    fun getServerStatus(call: PluginCall) {
        val statusObj = engine.getServerStatusJson()
        val res = JSObject().apply {
            put("state", statusObj.optString("state", "stopped"))
            put("port", statusObj.optInt("port", 8080))
            put("preferredPort", statusObj.optInt("preferredPort", 8080))
            put("hosting", statusObj.optBoolean("hosting", false))
            if (statusObj.has("error")) {
                put("error", statusObj.optString("error"))
            }
        }
        call.resolve(res)
    }

    @PluginMethod
    fun ensureMediaServer(call: PluginCall) {
        val port = engine.ensureMediaServerStarted()
        val statusObj = engine.getServerStatusJson()
        val res = buildInterfacesPayload()
        res.put("port", port)
        res.put("localUploadUrl", "http://127.0.0.1:$port/media/upload")
        res.put("serverState", statusObj.optString("state", "running"))
        if (statusObj.has("error")) {
            res.put("serverError", statusObj.optString("error"))
        }
        call.resolve(res)
    }

    @PluginMethod
    fun startHostServer(call: PluginCall) {
        val snapshot = call.getString("snapshotJson")
        val port = engine.startHostServer(snapshot)
        val statusObj = engine.getServerStatusJson()
        val res = buildInterfacesPayload()
        res.put("ok", statusObj.optString("state", "running") == "running")
        res.put("port", port)
        res.put("wsUrl", "ws://127.0.0.1:$port/sync")
        res.put("localUploadUrl", "http://127.0.0.1:$port/media/upload")
        res.put("serverState", statusObj.optString("state", "running"))
        if (statusObj.has("error")) {
            res.put("serverError", statusObj.optString("error"))
        }
        call.resolve(res)
    }

    @PluginMethod
    fun syncHostSnapshot(call: PluginCall) {
        val snapshot = call.getString("snapshotJson")
        if (snapshot != null) {
            engine.syncHostSnapshot(snapshot)
        }
        call.resolve()
    }

    @PluginMethod
    fun stopHostServer(call: PluginCall) {
        engine.stopHostServer()
        call.resolve()
    }

    @PluginMethod
    fun startUdpDiscovery(call: PluginCall) {
        engine.startUdpDiscovery()
        call.resolve()
    }

    @PluginMethod
    fun stopUdpDiscovery(call: PluginCall) {
        engine.stopUdpDiscovery()
        call.resolve()
    }

    @PluginMethod
    fun downloadMedia(call: PluginCall) {
        val layerId = call.getString("layerId") ?: run {
            call.reject("Missing layerId")
            return
        }
        val url = call.getString("url") ?: run {
            call.reject("Missing url")
            return
        }
        val fileName = call.getString("fileName") ?: "media-${System.currentTimeMillis()}"
        val fallbackUrl = call.getString("fallbackUrl")
        val expectedSize = call.getDouble("expectedSize", -1.0)?.toLong() ?: -1L
        val expectedHash = call.getString("expectedHash")
        val maxRetries = call.getInt("maxRetries", 3) ?: 3
        engine.downloadMediaToCache(
            layerId = layerId,
            remoteUrl = url,
            fileName = fileName,
            fallbackUrl = fallbackUrl,
            expectedSize = expectedSize,
            expectedHash = expectedHash,
            maxRetries = maxRetries
        )
        call.resolve(JSObject().apply { put("started", true) })
    }

    @PluginMethod
    fun compressVideo(call: PluginCall) {
        val layerId = call.getString("layerId") ?: run {
            call.reject("Missing layerId")
            return
        }
        val sourceUrl = call.getString("sourceUrl") ?: run {
            call.reject("Missing sourceUrl")
            return
        }
        val fileName = call.getString("fileName") ?: "clip.mp4"
        val targetHeight = call.getInt("targetHeight", 720) ?: 720
        val targetBitrate = call.getInt("targetBitrate", 2_000_000) ?: 2_000_000
        engine.compressVideo(layerId, sourceUrl, fileName, targetHeight, targetBitrate)
        call.resolve(JSObject().apply { put("started", true) })
    }

    @PluginMethod
    fun cancelCompressVideo(call: PluginCall) {
        val layerId = call.getString("layerId") ?: ""
        if (layerId.isNotEmpty()) {
            engine.cancelCompressVideo(layerId)
        }
        call.resolve()
    }

    @PluginMethod
    fun requestAudioPermission(call: PluginCall) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            call.resolve(JSObject().apply { put("granted", true) })
            return
        }
        requestPermissionForAlias("microphone", call, "microphonePermsCallback")
    }

    @PermissionCallback
    private fun microphonePermsCallback(call: PluginCall) {
        val granted = getPermissionState("microphone") == PermissionState.GRANTED
        call.resolve(JSObject().apply { put("granted", granted) })
    }

    @PluginMethod
    fun extractAudio(call: PluginCall) {
        val sourceUrl = call.getString("sourceUrl") ?: run {
            call.reject("Missing sourceUrl")
            return
        }
        val fileName = call.getString("fileName") ?: "video.mp4"
        val trimStartMs = call.getDouble("trimStartMs", 0.0)?.toLong() ?: 0L
        val durationMs = call.getDouble("durationMs", -1.0)?.toLong() ?: -1L
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val (outName, localUrl, durSec) = engine.extractAudioFromVideo(
                    sourceUrl = sourceUrl,
                    fileName = fileName,
                    trimStartMs = trimStartMs,
                    durationMs = durationMs
                )
                val baseOnly = java.io.File(outName).name
                val shareUrl = "http://${engine.getPrimaryIp()}:${engine.getBoundPort()}/media/$baseOnly"
                val (fileSize, fileHash) = engine.getCachedFileMetadata(outName)
                call.resolve(
                    JSObject().apply {
                        put("fileName", outName)
                        put("localUrl", localUrl)
                        put("shareUrl", shareUrl)
                        put("durationSec", durSec)
                        if (fileSize > 0) put("fileSize", fileSize)
                        if (fileHash.isNotEmpty()) put("fileHash", fileHash)
                    }
                )
            } catch (err: Throwable) {
                call.reject(err.message ?: "Failed to extract audio")
            }
        }
    }

    @PluginMethod
    fun checkMediaExists(call: PluginCall) {
        val fileName = call.getString("fileName") ?: ""
        val expectedSize = call.getDouble("expectedSize", -1.0)?.toLong() ?: -1L
        if (fileName.isBlank()) {
            call.resolve(JSObject().apply { put("exists", false) })
            return
        }
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val resJson = engine.checkMediaExists(fileName, expectedSize)
                call.resolve(JSObject(resJson.toString()))
            } catch (err: Throwable) {
                call.resolve(JSObject().apply { put("exists", false) })
            }
        }
    }

    @PluginMethod
    fun importMediaUri(call: PluginCall) {
        val uriStr = call.getString("uri") ?: run {
            call.reject("Missing uri")
            return
        }
        val fileName = call.getString("fileName")
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val resJson = engine.importMediaFromUri(android.net.Uri.parse(uriStr), fileName)
                call.resolve(JSObject(resJson.toString()))
            } catch (err: Throwable) {
                call.reject(err.message ?: "Не удалось импортировать медиафайл")
            }
        }
    }

    @PluginMethod
    fun saveProjectJson(call: PluginCall) {
        val projectId = call.getString("projectId") ?: run {
            call.reject("Missing projectId")
            return
        }
        val projectJson = call.getString("projectJson") ?: run {
            call.reject("Missing projectJson")
            return
        }
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val resJson = engine.saveProjectJson(projectId, projectJson)
                call.resolve(JSObject(resJson.toString()))
            } catch (err: Throwable) {
                call.reject(err.message ?: "Не удалось сохранить проект")
            }
        }
    }

    @PluginMethod
    fun listProjectsJson(call: PluginCall) {
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val arr = engine.listProjectsJson()
                val jsArr = JSArray()
                for (i in 0 until arr.length()) {
                    arr.optJSONObject(i)?.let { jsArr.put(JSObject(it.toString())) }
                }
                call.resolve(JSObject().apply { put("projects", jsArr) })
            } catch (err: Throwable) {
                call.reject(err.message ?: "Не удалось прочитать проекты")
            }
        }
    }

    @PluginMethod
    fun loadProjectJson(call: PluginCall) {
        val projectId = call.getString("projectId") ?: run {
            call.reject("Missing projectId")
            return
        }
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val obj = engine.loadProjectJson(projectId)
                call.resolve(JSObject().apply {
                    put("found", obj != null)
                    if (obj != null) put("project", JSObject(obj.toString()))
                })
            } catch (err: Throwable) {
                call.reject(err.message ?: "Не удалось загрузить проект")
            }
        }
    }

    @PluginMethod
    fun deleteProjectJson(call: PluginCall) {
        val projectId = call.getString("projectId") ?: run {
            call.reject("Missing projectId")
            return
        }
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val deleted = engine.deleteProjectJson(projectId)
                call.resolve(JSObject().apply { put("deleted", deleted) })
            } catch (err: Throwable) {
                call.reject(err.message ?: "Не удалось удалить проект")
            }
        }
    }

    @PluginMethod
    fun cleanupUnusedMedia(call: PluginCall) {
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val resJson = engine.cleanupUnusedMedia()
                call.resolve(JSObject(resJson.toString()))
            } catch (err: Throwable) {
                call.reject(err.message ?: "Не удалось очистить неиспользуемые файлы")
            }
        }
    }

    @PluginMethod
    fun renderTextBitmap(call: PluginCall) {
        val text = call.getString("text") ?: ""
        val styleJson = call.getObject("style")
        val scaleFactor = (call.getDouble("scaleFactor", 1.0) ?: 1.0).toFloat()
        CoroutineScope(Dispatchers.Default).launch {
            try {
                val (width, height, base64) = TextBitmapRenderer.renderToPngBase64(
                    context = context,
                    text = text,
                    styleJson = styleJson,
                    scaleFactor = scaleFactor,
                    engine = engine
                )
                call.resolve(
                    JSObject().apply {
                        put("width", width)
                        put("height", height)
                        put("base64", base64)
                    }
                )
            } catch (err: Throwable) {
                call.reject(err.message ?: "Failed to render text bitmap")
            }
        }
    }

    private fun jsonToStorageResult(obj: JSONObject, migratedCount: Int = 0): JSObject {
        val res = JSObject()
        res.put("currentDir", obj.optString("currentDir", ""))
        res.put("defaultDir", obj.optString("defaultDir", ""))
        res.put("isDefault", obj.optBoolean("isDefault", true))
        res.put("mode", obj.optString("mode", "internal"))
        res.put("displayName", obj.optString("displayName", ""))
        res.put("filesCount", obj.optInt("filesCount", 0))
        res.put("totalBytes", obj.optLong("totalBytes", 0L))
        res.put("migratedCount", migratedCount)
        val presetsArr = JSArray()
        obj.optJSONArray("presets")?.let { arr ->
            for (i in 0 until arr.length()) {
                arr.optJSONObject(i)?.let { p ->
                    presetsArr.put(JSObject().apply {
                        put("label", p.optString("label"))
                        put("path", p.optString("path"))
                        put("isDefault", p.optBoolean("isDefault", false))
                    })
                }
            }
        }
        res.put("presets", presetsArr)
        return res
    }

    @PluginMethod
    fun getStorageConfig(call: PluginCall) {
        call.resolve(jsonToStorageResult(engine.getStorageConfigJson()))
    }

    @PluginMethod
    fun setStorageFolder(call: PluginCall) {
        val dirPath = call.getString("dirPath") ?: run {
            call.reject("Missing dirPath")
            return
        }
        val migrate = call.getBoolean("migrateExisting", true) ?: true
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val (cfg, migrated) = engine.setStorageFolderPath(dirPath, migrate)
                call.resolve(jsonToStorageResult(cfg, migrated))
            } catch (err: Throwable) {
                call.reject(err.message ?: "Не удалось выбрать папку")
            }
        }
    }

    @PluginMethod
    fun resetStorageFolder(call: PluginCall) {
        val migrate = call.getBoolean("migrateExisting", true) ?: true
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val (cfg, migrated) = engine.resetStorageFolder(migrate)
                call.resolve(jsonToStorageResult(cfg, migrated))
            } catch (err: Throwable) {
                call.reject(err.message ?: "Не удалось сбросить папку")
            }
        }
    }

    @PluginMethod
    fun pickStorageFolder(call: PluginCall) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
            addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION or
                    Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                    Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
                    Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
            )
        }
        startActivityForResult(call, intent, "onStorageFolderPicked")
    }

    @ActivityCallback
    private fun onStorageFolderPicked(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            val res = jsonToStorageResult(engine.getStorageConfigJson(), 0)
            res.put("canceled", true)
            call.resolve(res)
            return
        }
        val migrate = call.getBoolean("migrateExisting", true) ?: true
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val (cfg, migrated) = engine.setSafStorageTree(uri, migrate)
                val res = jsonToStorageResult(cfg, migrated)
                res.put("canceled", false)
                call.resolve(res)
            } catch (err: Throwable) {
                call.reject(err.message ?: "Не удалось открыть выбранную папку")
            }
        }
    }

    private fun resolveShareableUri(contentUriStr: String?, savedPath: String?, fileName: String?): Uri? {
        if (!contentUriStr.isNullOrBlank() && contentUriStr.startsWith("content://")) {
            return Uri.parse(contentUriStr)
        }
        val candidateFile = when {
            !savedPath.isNullOrBlank() -> java.io.File(savedPath)
            !fileName.isNullOrBlank() -> java.io.File(engine.getLocalExportDir(), fileName)
            else -> null
        } ?: return null
        if (!candidateFile.exists() || !candidateFile.isFile) return null
        val authority = "${context.packageName}.fileprovider"
        return try {
            FileProvider.getUriForFile(context, authority, candidateFile)
        } catch (_: Throwable) {
            try {
                val cacheCopy = java.io.File(context.cacheDir, candidateFile.name)
                candidateFile.copyTo(cacheCopy, overwrite = true)
                FileProvider.getUriForFile(context, authority, cacheCopy)
            } catch (_: Throwable) {
                null
            }
        }
    }

    @PluginMethod
    fun prepareExportDir(call: PluginCall) {
        val ext = call.getString("ext") ?: "mp4"
        val fileName = call.getString("fileName")
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val resJson = engine.prepareExportDir(ext = ext, rawName = fileName)
                call.resolve(JSObject(resJson.toString()))
            } catch (err: Throwable) {
                call.reject(err.message ?: "Не удалось подготовить папку export/")
            }
        }
    }

    @PluginMethod
    fun saveExportedFile(call: PluginCall) {
        val base64Data = call.getString("base64Data") ?: run {
            call.reject("Missing base64Data")
            return
        }
        val fileName = call.getString("fileName")
        val ext = call.getString("ext") ?: "mp4"
        val mimeType = call.getString("mimeType")
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val cleanBase64 = if (base64Data.contains(",")) {
                    base64Data.substringAfter(",")
                } else {
                    base64Data
                }
                val bytes = Base64.decode(cleanBase64, Base64.DEFAULT)
                val resJson = engine.saveExportBytesToExportDir(
                    bytes = bytes,
                    rawName = fileName,
                    fallbackExt = ext,
                    explicitMimeType = mimeType
                )
                call.resolve(JSObject(resJson.toString()))
            } catch (err: Throwable) {
                call.reject(err.message ?: "Не удалось сохранить файл в export/")
            }
        }
    }

    @PluginMethod
    fun shareExportedFile(call: PluginCall) {
        val contentUriStr = call.getString("contentUri")
        val savedPath = call.getString("savedPath")
        val fileName = call.getString("fileName") ?: "Webcut.mp4"
        val mimeType = call.getString("mimeType") ?: "video/mp4"
        val shareUri = resolveShareableUri(contentUriStr, savedPath, fileName)
        if (shareUri == null) {
            call.reject("Не найден экспортированный файл для отправки")
            return
        }
        try {
            val sendIntent = Intent(Intent.ACTION_SEND).apply {
                type = mimeType
                putExtra(Intent.EXTRA_STREAM, shareUri)
                putExtra(Intent.EXTRA_SUBJECT, fileName)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            val chooser = Intent.createChooser(sendIntent, "Поделиться видео").apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            (activity ?: context).startActivity(chooser)
            call.resolve(JSObject().apply { put("shared", true) })
        } catch (err: Throwable) {
            call.reject(err.message ?: "Не удалось открыть меню «Поделиться»")
        }
    }

    @PluginMethod
    fun openExportFolder(call: PluginCall) {
        val contentUriStr = call.getString("contentUri")
        val savedPath = call.getString("savedPath")
        val fileName = call.getString("fileName")
        val mimeType = call.getString("mimeType") ?: "video/mp4"

        val safExportUri = engine.getSafExportDirUri()
        if (safExportUri != null) {
            try {
                val folderIntent = Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(safExportUri, DocumentsContract.Document.MIME_TYPE_DIR)
                    addFlags(
                        Intent.FLAG_GRANT_READ_URI_PERMISSION or
                            Intent.FLAG_ACTIVITY_NEW_TASK
                    )
                }
                (activity ?: context).startActivity(folderIntent)
                call.resolve(JSObject().apply { put("opened", true) })
                return
            } catch (_: Throwable) {
            }
        }

        val viewUri = resolveShareableUri(contentUriStr, savedPath, fileName)
        if (viewUri != null) {
            try {
                val viewIntent = Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(viewUri, mimeType)
                    addFlags(
                        Intent.FLAG_GRANT_READ_URI_PERMISSION or
                            Intent.FLAG_ACTIVITY_NEW_TASK
                    )
                }
                (activity ?: context).startActivity(viewIntent)
                call.resolve(JSObject().apply { put("opened", true) })
                return
            } catch (_: Throwable) {
            }
        }

        call.resolve(
            JSObject().apply {
                put("opened", false)
                put("exportDir", engine.getLocalExportDir().absolutePath)
            }
        )
    }
}
