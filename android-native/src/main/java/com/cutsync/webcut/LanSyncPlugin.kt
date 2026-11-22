package com.cutsync.webcut

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray

@CapacitorPlugin(name = "LanSync")
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
}
