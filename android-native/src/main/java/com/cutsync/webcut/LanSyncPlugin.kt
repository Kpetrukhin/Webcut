package com.cutsync.webcut

import android.Manifest
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONArray

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
    fun ensureMediaServer(call: PluginCall) {
        val port = engine.ensureMediaServerStarted()
        val res = buildInterfacesPayload()
        res.put("port", port)
        res.put("localUploadUrl", "http://127.0.0.1:$port/media/upload")
        call.resolve(res)
    }

    @PluginMethod
    fun startHostServer(call: PluginCall) {
        val snapshot = call.getString("snapshotJson")
        val port = engine.startHostServer(snapshot)
        val res = buildInterfacesPayload()
        res.put("ok", true)
        res.put("port", port)
        res.put("wsUrl", "ws://127.0.0.1:$port/sync")
        res.put("localUploadUrl", "http://127.0.0.1:$port/media/upload")
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
        engine.downloadMediaToCache(layerId, url, fileName)
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
                val shareUrl = "http://${engine.getPrimaryIp()}:${engine.getBoundPort()}/media/$outName"
                call.resolve(
                    JSObject().apply {
                        put("fileName", outName)
                        put("localUrl", localUrl)
                        put("shareUrl", shareUrl)
                        put("durationSec", durSec)
                    }
                )
            } catch (err: Throwable) {
                call.reject(err.message ?: "Failed to extract audio")
            }
        }
    }
}
