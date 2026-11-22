package com.cutsync.webcut

import android.content.Context
import android.net.wifi.WifiManager
import android.webkit.MimeTypeMap
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO as ClientCIO
import io.ktor.client.request.prepareGet
import io.ktor.client.statement.bodyAsChannel
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.cio.CIO as ServerCIO
import io.ktor.server.engine.ApplicationEngine
import io.ktor.server.engine.embeddedServer
import io.ktor.server.request.receiveChannel
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.response.respondFile
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.options
import io.ktor.server.routing.post
import io.ktor.server.routing.routing
import io.ktor.server.websocket.WebSockets
import io.ktor.server.websocket.webSocket
import io.ktor.utils.io.ByteReadChannel
import io.ktor.utils.io.core.isEmpty
import io.ktor.utils.io.core.readBytes
import io.ktor.utils.io.jvm.javaio.copyTo
import io.ktor.websocket.DefaultWebSocketSession
import io.ktor.websocket.Frame
import io.ktor.websocket.readText
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.time.Duration
import java.util.concurrent.ConcurrentHashMap

data class NetIfaceInfo(
    val name: String,
    val ip: String,
    val type: String,
    val label: String,
    val broadcast: InetAddress?
)

data class RoomPeerSession(
    val id: String,
    val session: DefaultWebSocketSession,
    var userJson: JSONObject
)

class KtorLanEngine(private val context: Context) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val mediaDir = File(context.cacheDir, "cutsync_media").apply { mkdirs() }
    private val registeredFiles = ConcurrentHashMap<String, File>()

    private var server: ApplicationEngine? = null
    private var serverPort: Int = 8080
    private var isHostingRoom: Boolean = false

    private var hostRoomState: JSONObject = JSONObject().apply {
        put("roomId", "lan-studio")
        put("title", "Локальный проект")
        put("aspectRatio", "9:16")
        put("backgroundColor", "#09090b")
        put("hostName", "Хост")
        put("fps", 30)
        put("isPublicLan", true)
        put("revision", 1)
        put("tracks", JSONArray())
        put("clips", JSONArray())
        put("chat", JSONArray())
    }

    private val wsSessions = ConcurrentHashMap<String, RoomPeerSession>()
    private val layerLocks = ConcurrentHashMap<String, JSONObject>()

    private var beaconJob: Job? = null
    private var udpListenerJob: Job? = null
    private var multicastLock: WifiManager.MulticastLock? = null

    private val httpClient = HttpClient(ClientCIO) {
        engine {
            requestTimeout = 120_000
        }
    }

    var onUdpRoomsChanged: ((JSONArray) -> Unit)? = null
    var onDownloadProgress: ((String, Int) -> Unit)? = null
    var onDownloadComplete: ((String, String, String) -> Unit)? = null
    var onDownloadError: ((String, String) -> Unit)? = null

    fun getLocalNetworkInterfaces(): List<NetIfaceInfo> {
        val result = mutableListOf<NetIfaceInfo>()
        try {
            val interfaces = NetworkInterface.getNetworkInterfaces() ?: return result
            while (interfaces.hasMoreElements()) {
                val iface = interfaces.nextElement()
                if (!iface.isUp || iface.isLoopback) continue
                val name = iface.name ?: "eth"
                for (ifaceAddr in iface.interfaceAddresses) {
                    val addr = ifaceAddr.address
                    if (addr is Inet4Address && !addr.isLoopbackAddress) {
                        val ip = addr.hostAddress ?: continue
                        val lower = name.lowercase()
                        val type = when {
                            lower.startsWith("zt") -> "zerotier"
                            lower.startsWith("wlan") || lower.startsWith("ap") || lower.startsWith("swlan") -> "wifi"
                            else -> "lan"
                        }
                        val label = when (type) {
                            "zerotier" -> "ZeroTier ($name)"
                            "wifi" -> "Wi-Fi ($name)"
                            else -> "LAN ($name)"
                        }
                        result.add(
                            NetIfaceInfo(
                                name = name,
                                ip = ip,
                                type = type,
                                label = label,
                                broadcast = ifaceAddr.broadcast
                            )
                        )
                    }
                }
            }
        } catch (_: Throwable) {
        }
        return result.sortedWith(
            compareBy {
                when (it.type) {
                    "zerotier" -> 0
                    "wifi" -> 1
                    else -> 2
                }
            }
        )
    }

    fun getPrimaryIp(): String {
        val list = getLocalNetworkInterfaces()
        val wifi = list.firstOrNull { it.type == "wifi" }
        val zt = list.firstOrNull { it.type == "zerotier" }
        return wifi?.ip ?: zt?.ip ?: list.firstOrNull()?.ip ?: "127.0.0.1"
    }

    fun getBoundPort(): Int = serverPort

    private fun findAvailablePort(preferred: Int = 8080): Int {
        return try {
            ServerSocket(preferred).use { preferred }
        } catch (_: Throwable) {
            try {
                ServerSocket(0).use { it.localPort }
            } catch (_: Throwable) {
                preferred
            }
        }
    }

    private fun applyCors(call: ApplicationCall) {
        call.response.header(HttpHeaders.AccessControlAllowOrigin, "*")
        call.response.header(HttpHeaders.AccessControlAllowMethods, "GET, POST, OPTIONS")
        call.response.header(HttpHeaders.AccessControlAllowHeaders, "*")
    }

    private fun contentTypeForFile(file: File): ContentType {
        val ext = file.extension.lowercase()
        return when (ext) {
            "mp4", "m4v" -> ContentType.Video.MP4
            "webm" -> ContentType("video", "webm")
            "mov" -> ContentType.Video.QuickTime
            "jpg", "jpeg" -> ContentType.Image.JPEG
            "png" -> ContentType.Image.PNG
            "webp" -> ContentType("image", "webp")
            "gif" -> ContentType.Image.GIF
            "mp3" -> ContentType.Audio.MPEG
            "wav" -> ContentType("audio", "wav")
            else -> {
                val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)
                if (mime != null) ContentType.parse(mime) else ContentType.Application.OctetStream
            }
        }
    }

    fun ensureMediaServerStarted(): Int {
        if (server != null) return serverPort
        return startServerInternal(asHost = false, preferredPort = 8080)
    }

    fun startHostServer(initialRoomJson: String?): Int {
        if (initialRoomJson != null) {
            try {
                hostRoomState = JSONObject(initialRoomJson)
            } catch (_: Throwable) {
            }
        }
        val port = if (server != null && serverPort == 8080) {
            isHostingRoom = true
            8080
        } else {
            stopServer()
            startServerInternal(asHost = true, preferredPort = 8080)
        }
        isHostingRoom = true
        startUdpHostBeacon()
        return port
    }

    fun syncHostSnapshot(snapshotJson: String) {
        try {
            hostRoomState = JSONObject(snapshotJson)
        } catch (_: Throwable) {
        }
    }

    private fun startServerInternal(asHost: Boolean, preferredPort: Int): Int {
        val chosenPort = findAvailablePort(preferredPort)
        serverPort = chosenPort
        isHostingRoom = asHost

        val engine = embeddedServer(ServerCIO, port = chosenPort, host = "0.0.0.0") {
            install(WebSockets) {
                pingPeriod = Duration.ofSeconds(15)
                timeout = Duration.ofSeconds(30)
                maxFrameSize = Long.MAX_VALUE
                masking = false
            }

            routing {
                options("/{...}") {
                    applyCors(call)
                    call.respond(HttpStatusCode.NoContent)
                }

                get("/api/health") {
                    applyCors(call)
                    val info = JSONObject().apply {
                        put("ok", true)
                        put("app", "CutSync")
                        put("engine", "Ktor-CIO")
                        put("port", serverPort)
                        put("hosting", isHostingRoom)
                        put("participants", wsSessions.size)
                    }
                    call.respondText(info.toString(), ContentType.Application.Json)
                }

                get("/api/rooms") {
                    applyCors(call)
                    val arr = JSONArray()
                    if (isHostingRoom) {
                        arr.put(buildRoomSummaryJson())
                    }
                    val resp = JSONObject().apply { put("rooms", arr) }
                    call.respondText(resp.toString(), ContentType.Application.Json)
                }

                get("/media/{fileName}") {
                    applyCors(call)
                    val rawName = call.parameters["fileName"] ?: ""
                    val safeName = File(rawName).name
                    val file = registeredFiles[safeName] ?: File(mediaDir, safeName)
                    if (!file.exists() || !file.isFile) {
                        call.respond(HttpStatusCode.NotFound, "Media not found")
                        return@get
                    }
                    call.response.header(HttpHeaders.AcceptRanges, "bytes")
                    call.response.header(HttpHeaders.ContentType, contentTypeForFile(file).toString())
                    call.respondFile(file)
                }

                post("/media/upload") {
                    applyCors(call)
                    val rawName = call.request.queryParameters["fileName"]
                        ?: "clip-${System.currentTimeMillis()}.bin"
                    val safeName = File(rawName).name.replace(Regex("[^a-zA-Z0-9._-]"), "_")
                    val destFile = File(mediaDir, safeName)
                    val channel: ByteReadChannel = call.receiveChannel()
                    withContext(Dispatchers.IO) {
                        FileOutputStream(destFile).use { fos ->
                            channel.copyTo(fos)
                        }
                    }
                    registeredFiles[safeName] = destFile
                    val bestIp = getPrimaryIp()
                    val resp = JSONObject().apply {
                        put("ok", true)
                        put("fileName", safeName)
                        put("localUrl", "http://127.0.0.1:$serverPort/media/$safeName")
                        put("shareUrl", "http://$bestIp:$serverPort/media/$safeName")
                    }
                    call.respondText(resp.toString(), ContentType.Application.Json)
                }

                webSocket("/sync") {
                    handleWebSocketClient(this)
                }

                webSocket("/ws") {
                    handleWebSocketClient(this)
                }
            }
        }

        engine.start(wait = false)
        server = engine
        return chosenPort
    }

    private suspend fun handleWebSocketClient(ws: DefaultWebSocketSession) {
        val connId = "peer-${System.nanoTime()}"
        try {
            for (frame in ws.incoming) {
                if (frame !is Frame.Text) continue
                val text = frame.readText()
                val msg = try {
                    JSONObject(text)
                } catch (_: Throwable) {
                    continue
                }
                val type = msg.optString("type", "")
                when (type) {
                    "join" -> {
                        val userObj = msg.optJSONObject("user") ?: JSONObject().apply {
                            put("id", connId)
                            put("name", "Участник")
                            put("color", "#22d3ee")
                        }
                        userObj.put("playhead", 0.0)
                        userObj.put("selectedClipId", JSONObject.NULL)
                        userObj.put("isPlaying", false)
                        userObj.put("lastActive", System.currentTimeMillis())

                        val sessionEntry = RoomPeerSession(connId, ws, userObj)
                        wsSessions[connId] = sessionEntry

                        val initMsg = JSONObject().apply {
                            put("type", "room:init")
                            put("project", hostRoomState)
                            put("collaborators", buildCollaboratorsArray())
                            put("rooms", JSONArray().apply {
                                if (isHostingRoom) put(buildRoomSummaryJson())
                            })
                        }
                        ws.send(Frame.Text(initMsg.toString()))
                        broadcastAll(
                            JSONObject().apply {
                                put("type", "presence:update")
                                put("collaborators", buildCollaboratorsArray())
                            }.toString()
                        )
                    }

                    "presence:cursor" -> {
                        val entry = wsSessions[connId] ?: continue
                        entry.userJson.put("playhead", msg.optDouble("playhead", 0.0))
                        val sel = msg.opt("selectedClipId")
                        entry.userJson.put("selectedClipId", sel ?: JSONObject.NULL)
                        entry.userJson.put("isPlaying", msg.optBoolean("isPlaying", false))
                        entry.userJson.put("lastActive", System.currentTimeMillis())
                        broadcastAll(
                            JSONObject().apply {
                                put("type", "presence:update")
                                put("collaborators", buildCollaboratorsArray())
                            }.toString(),
                            excludeConnId = connId
                        )
                    }

                    "presence:profile" -> {
                        val entry = wsSessions[connId] ?: continue
                        entry.userJson.put("name", msg.optString("name", entry.userJson.optString("name")))
                        entry.userJson.put("color", msg.optString("color", entry.userJson.optString("color")))
                        broadcastAll(
                            JSONObject().apply {
                                put("type", "presence:update")
                                put("collaborators", buildCollaboratorsArray())
                            }.toString()
                        )
                    }

                    "chat:send" -> {
                        val entry = wsSessions[connId] ?: continue
                        val chatMsg = JSONObject().apply {
                            put("id", msg.optString("messageId", "m-${System.currentTimeMillis()}"))
                            put("userId", entry.userJson.optString("id"))
                            put("userName", entry.userJson.optString("name"))
                            put("userColor", entry.userJson.optString("color"))
                            put("text", msg.optString("text", ""))
                            put("timestamp", System.currentTimeMillis())
                        }
                        val chatArr = hostRoomState.optJSONArray("chat") ?: JSONArray()
                        chatArr.put(chatMsg)
                        hostRoomState.put("chat", chatArr)

                        val out = JSONObject().apply {
                            put("type", "chat:message")
                            put("message", chatMsg)
                        }
                        broadcastAll(out.toString(), excludeConnId = connId)
                    }

                    "LAYER_LOCK" -> {
                        val layerId = msg.optString("layerId", "")
                        val locked = msg.optBoolean("locked", false)
                        val userId = msg.optString("userId", "")
                        if (layerId.isNotEmpty()) {
                            if (locked) {
                                layerLocks[layerId] = JSONObject(msg.toString())
                            } else {
                                val existing = layerLocks[layerId]
                                if (existing == null || existing.optString("userId") == userId) {
                                    layerLocks.remove(layerId)
                                }
                            }
                            applyLockToHostClips(
                                layerId,
                                if (locked) userId else null,
                                if (locked) msg.optString("userName") else null,
                                if (locked) msg.optString("userColor") else null
                            )
                            broadcastAll(msg.toString(), excludeConnId = connId)
                        }
                    }

                    "LAYER_MEDIA_UPDATED" -> {
                        val senderId = wsSessions[connId]?.userJson?.optString("id") ?: msg.optString("senderId", "")
                        msg.put("senderId", senderId)
                        val rev = hostRoomState.optInt("revision", 1) + 1
                        hostRoomState.put("revision", rev)
                        msg.put("revision", rev)
                        applyMediaUpdateToHostState(msg)
                        broadcastAll(msg.toString(), excludeConnId = connId)
                    }

                    else -> {
                        if (type.startsWith("op:")) {
                            val senderId = wsSessions[connId]?.userJson?.optString("id") ?: ""
                            val rev = hostRoomState.optInt("revision", 1) + 1
                            hostRoomState.put("revision", rev)
                            msg.put("revision", rev)
                            msg.put("senderId", senderId)
                            applyOpToHostState(type, msg)
                            broadcastAll(msg.toString(), excludeConnId = connId)
                        }
                    }
                }
            }
        } catch (_: Throwable) {
        } finally {
            val removed = wsSessions.remove(connId)
            val removedUserId = removed?.userJson?.optString("id") ?: ""
            if (removedUserId.isNotEmpty()) {
                val unlockedLayers = layerLocks.entries
                    .filter { it.value.optString("userId") == removedUserId }
                    .map { it.key }
                for (lid in unlockedLayers) {
                    layerLocks.remove(lid)
                    applyLockToHostClips(lid, null, null, null)
                    val unlockMsg = JSONObject().apply {
                        put("type", "LAYER_LOCK")
                        put("layerId", lid)
                        put("userId", removedUserId)
                        put("userName", "")
                        put("userColor", "")
                        put("locked", false)
                    }
                    broadcastAll(unlockMsg.toString())
                }
            }
            broadcastAll(
                JSONObject().apply {
                    put("type", "presence:update")
                    put("collaborators", buildCollaboratorsArray())
                }.toString()
            )
        }
    }

    private fun applyLockToHostClips(
        layerId: String,
        userId: String?,
        userName: String?,
        userColor: String?
    ) {
        val clips = hostRoomState.optJSONArray("clips") ?: return
        for (i in 0 until clips.length()) {
            val c = clips.optJSONObject(i) ?: continue
            if (c.optString("id") == layerId) {
                if (userId != null) {
                    c.put("lockedByUserId", userId)
                    c.put("lockedByUserName", userName)
                    c.put("lockedByUserColor", userColor)
                } else {
                    c.remove("lockedByUserId")
                    c.remove("lockedByUserName")
                    c.remove("lockedByUserColor")
                }
                break
            }
        }
    }

    private fun applyMediaUpdateToHostState(msg: JSONObject) {
        val layerId = msg.optString("layerId", "")
        val fileName = msg.optString("fileName", "")
        val mediaUrl = msg.optString("mediaUrl", "")
        val newTrack = msg.optJSONObject("newTrack")
        if (newTrack != null) {
            val tracks = hostRoomState.optJSONArray("tracks") ?: JSONArray()
            var hasTrack = false
            for (i in 0 until tracks.length()) {
                if (tracks.optJSONObject(i)?.optString("id") == newTrack.optString("id")) {
                    hasTrack = true
                    break
                }
            }
            if (!hasTrack) {
                tracks.put(newTrack)
                hostRoomState.put("tracks", tracks)
            }
        }

        val clips = hostRoomState.optJSONArray("clips") ?: JSONArray()
        var found = false
        for (i in 0 until clips.length()) {
            val c = clips.optJSONObject(i) ?: continue
            if (c.optString("id") == layerId) {
                c.put("mediaRemoteUrl", mediaUrl)
                c.put("mediaFileName", fileName)
                c.put("src", mediaUrl)
                found = true
                break
            }
        }
        if (!found) {
            val incomingClip = msg.optJSONObject("clip")
            if (incomingClip != null) {
                incomingClip.put("src", mediaUrl)
                incomingClip.put("mediaRemoteUrl", mediaUrl)
                incomingClip.put("mediaFileName", fileName)
                clips.put(incomingClip)
                hostRoomState.put("clips", clips)
            }
        }
    }

    private fun applyOpToHostState(type: String, msg: JSONObject) {
        when (type) {
            "op:track_add" -> {
                val t = msg.optJSONObject("track") ?: return
                val tracks = hostRoomState.optJSONArray("tracks") ?: JSONArray()
                tracks.put(t)
                hostRoomState.put("tracks", tracks)
            }
            "op:track_update" -> {
                val trackId = msg.optString("trackId")
                val patch = msg.optJSONObject("patch") ?: return
                val tracks = hostRoomState.optJSONArray("tracks") ?: return
                for (i in 0 until tracks.length()) {
                    val t = tracks.optJSONObject(i) ?: continue
                    if (t.optString("id") == trackId) {
                        mergeJson(t, patch)
                    }
                }
            }
            "op:track_delete" -> {
                val trackId = msg.optString("trackId")
                val tracks = hostRoomState.optJSONArray("tracks") ?: JSONArray()
                val nextTracks = JSONArray()
                for (i in 0 until tracks.length()) {
                    val t = tracks.optJSONObject(i) ?: continue
                    if (t.optString("id") != trackId) nextTracks.put(t)
                }
                hostRoomState.put("tracks", nextTracks)

                val clips = hostRoomState.optJSONArray("clips") ?: JSONArray()
                val nextClips = JSONArray()
                for (i in 0 until clips.length()) {
                    val c = clips.optJSONObject(i) ?: continue
                    if (c.optString("trackId") != trackId) nextClips.put(c)
                }
                hostRoomState.put("clips", nextClips)
            }
            "op:clip_add" -> {
                val c = msg.optJSONObject("clip") ?: return
                val nt = msg.optJSONObject("newTrack")
                if (nt != null) {
                    val tracks = hostRoomState.optJSONArray("tracks") ?: JSONArray()
                    tracks.put(nt)
                    hostRoomState.put("tracks", tracks)
                }
                val clips = hostRoomState.optJSONArray("clips") ?: JSONArray()
                clips.put(c)
                hostRoomState.put("clips", clips)
            }
            "op:clip_update" -> {
                val clipId = msg.optString("clipId")
                val patch = msg.optJSONObject("patch") ?: return
                val clips = hostRoomState.optJSONArray("clips") ?: return
                for (i in 0 until clips.length()) {
                    val c = clips.optJSONObject(i) ?: continue
                    if (c.optString("id") == clipId) {
                        mergeJson(c, patch)
                    }
                }
            }
            "op:clip_delete" -> {
                val clipId = msg.optString("clipId")
                val clips = hostRoomState.optJSONArray("clips") ?: JSONArray()
                val nextClips = JSONArray()
                for (i in 0 until clips.length()) {
                    val c = clips.optJSONObject(i) ?: continue
                    if (c.optString("id") != clipId) nextClips.put(c)
                }
                hostRoomState.put("clips", nextClips)
            }
            "op:project_meta" -> {
                val patch = msg.optJSONObject("patch") ?: return
                mergeJson(hostRoomState, patch)
            }
            "op:project_replace" -> {
                msg.optJSONArray("clips")?.let { hostRoomState.put("clips", it) }
                msg.optJSONArray("tracks")?.let { hostRoomState.put("tracks", it) }
                if (msg.has("title")) hostRoomState.put("title", msg.optString("title"))
                if (msg.has("aspectRatio")) hostRoomState.put("aspectRatio", msg.optString("aspectRatio"))
                if (msg.has("backgroundColor")) hostRoomState.put("backgroundColor", msg.optString("backgroundColor"))
                if (msg.has("customFonts")) hostRoomState.put("customFonts", msg.optJSONArray("customFonts"))
            }
        }
    }

    private fun mergeJson(target: JSONObject, patch: JSONObject) {
        val keys = patch.keys()
        while (keys.hasNext()) {
            val k = keys.next()
            target.put(k, patch.get(k))
        }
    }

    private fun buildCollaboratorsArray(): JSONArray {
        val arr = JSONArray()
        for (entry in wsSessions.values) {
            arr.put(entry.userJson)
        }
        return arr
    }

    private fun buildRoomSummaryJson(): JSONObject {
        val ips = JSONArray()
        getLocalNetworkInterfaces().forEach { ips.put(it.ip) }
        return JSONObject().apply {
            put("app", "CutSync")
            put("roomId", hostRoomState.optString("roomId", "lan-studio"))
            put("title", hostRoomState.optString("title", "Локальный проект"))
            put("hostName", hostRoomState.optString("hostName", "Хост"))
            put("ip", getPrimaryIp())
            put("ips", ips)
            put("port", serverPort)
            put("aspectRatio", hostRoomState.optString("aspectRatio", "9:16"))
            put("participants", wsSessions.size)
            put("collaboratorsCount", wsSessions.size)
        }
    }

    private suspend fun broadcastAll(payload: String, excludeConnId: String? = null) {
        for ((id, peer) in wsSessions) {
            if (excludeConnId != null && id == excludeConnId) continue
            try {
                peer.session.send(Frame.Text(payload))
            } catch (_: Throwable) {
            }
        }
    }

    private fun acquireMulticastLock() {
        try {
            if (multicastLock == null) {
                val wm = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
                multicastLock = wm?.createMulticastLock("CutSyncUdpLock")?.apply {
                    setReferenceCounted(false)
                }
            }
            if (multicastLock?.isHeld == false) {
                multicastLock?.acquire()
            }
        } catch (_: Throwable) {
        }
    }

    private fun releaseMulticastLock() {
        try {
            if (multicastLock?.isHeld == true) {
                multicastLock?.release()
            }
        } catch (_: Throwable) {
        }
    }

    private fun startUdpHostBeacon() {
        beaconJob?.cancel()
        acquireMulticastLock()
        beaconJob = scope.launch {
            var socket: DatagramSocket? = null
            try {
                socket = DatagramSocket().apply { broadcast = true }
                while (isActive && isHostingRoom) {
                    val payloadBytes = buildRoomSummaryJson().toString().toByteArray(Charsets.UTF_8)
                    val targets = mutableSetOf<InetAddress>()
                    try {
                        targets.add(InetAddress.getByName("255.255.255.255"))
                    } catch (_: Throwable) {
                    }
                    for (iface in getLocalNetworkInterfaces()) {
                        iface.broadcast?.let { targets.add(it) }
                    }
                    for (addr in targets) {
                        try {
                            socket.send(DatagramPacket(payloadBytes, payloadBytes.size, addr, 8081))
                        } catch (_: Throwable) {
                        }
                    }
                    delay(1200)
                }
            } catch (_: Throwable) {
            } finally {
                try {
                    socket?.close()
                } catch (_: Throwable) {
                }
            }
        }
    }

    fun startUdpDiscovery() {
        udpListenerJob?.cancel()
        acquireMulticastLock()
        val discovered = ConcurrentHashMap<String, JSONObject>()

        udpListenerJob = scope.launch {
            var socket: DatagramSocket? = null
            try {
                socket = DatagramSocket(null).apply {
                    reuseAddress = true
                    broadcast = true
                    bind(java.net.InetSocketAddress(8081))
                    soTimeout = 1000
                }
                val buf = ByteArray(4096)
                while (isActive) {
                    try {
                        val packet = DatagramPacket(buf, buf.size)
                        socket.receive(packet)
                        val msg = String(packet.data, 0, packet.length, Charsets.UTF_8).trim()
                        if (msg == "CUTSYNC_DISCOVER" && isHostingRoom) {
                            val reply = buildRoomSummaryJson().toString().toByteArray(Charsets.UTF_8)
                            socket.send(DatagramPacket(reply, reply.size, packet.address, packet.port))
                            continue
                        }
                        val obj = JSONObject(msg)
                        if (obj.optString("app") == "CutSync") {
                            val hostIp = obj.optString("ip").ifEmpty { packet.address.hostAddress ?: "" }
                            obj.put("ip", hostIp)
                            obj.put("lastSeen", System.currentTimeMillis())
                            discovered[hostIp] = obj

                            val now = System.currentTimeMillis()
                            discovered.entries.removeIf { now - it.value.optLong("lastSeen", 0) > 5500 }

                            val arr = JSONArray()
                            discovered.values.forEach { arr.put(it) }
                            onUdpRoomsChanged?.invoke(arr)
                        }
                    } catch (_: java.net.SocketTimeoutException) {
                        val now = System.currentTimeMillis()
                        discovered.entries.removeIf { now - it.value.optLong("lastSeen", 0) > 5500 }
                        val arr = JSONArray()
                        discovered.values.forEach { arr.put(it) }
                        onUdpRoomsChanged?.invoke(arr)
                    } catch (_: Throwable) {
                    }
                }
            } catch (_: Throwable) {
            } finally {
                try {
                    socket?.close()
                } catch (_: Throwable) {
                }
            }
        }
    }

    fun stopUdpDiscovery() {
        udpListenerJob?.cancel()
        udpListenerJob = null
        if (!isHostingRoom) releaseMulticastLock()
    }

    fun downloadMediaToCache(layerId: String, remoteUrl: String, fileName: String) {
        scope.launch {
            try {
                val safeName = File(fileName).name.replace(Regex("[^a-zA-Z0-9._-]"), "_")
                val targetFile = File(mediaDir, safeName)
                val tempFile = File(mediaDir, "$safeName.part")

                httpClient.prepareGet(remoteUrl).execute { response ->
                    val totalBytes = response.headers[HttpHeaders.ContentLength]?.toLongOrNull() ?: -1L
                    val channel = response.bodyAsChannel()
                    var downloaded = 0L
                    var lastPct = -1

                    FileOutputStream(tempFile).use { fos ->
                        while (!channel.isClosedForRead) {
                            val packet = channel.readRemaining(32 * 1024)
                            while (!packet.isEmpty) {
                                val bytes = packet.readBytes()
                                fos.write(bytes)
                                downloaded += bytes.size
                                if (totalBytes > 0) {
                                    val pct = ((downloaded * 100) / totalBytes).toInt().coerceIn(0, 99)
                                    if (pct != lastPct) {
                                        lastPct = pct
                                        onDownloadProgress?.invoke(layerId, pct)
                                    }
                                }
                            }
                        }
                    }
                }

                if (targetFile.exists()) targetFile.delete()
                tempFile.renameTo(targetFile)
                registeredFiles[safeName] = targetFile
                ensureMediaServerStarted()

                val localUrl = "http://127.0.0.1:$serverPort/media/$safeName"
                onDownloadComplete?.invoke(layerId, safeName, localUrl)
            } catch (err: Throwable) {
                onDownloadError?.invoke(layerId, err.message ?: "Download failed")
            }
        }
    }

    fun stopHostServer() {
        isHostingRoom = false
        beaconJob?.cancel()
        beaconJob = null
        if (udpListenerJob == null) releaseMulticastLock()
    }

    fun stopServer() {
        stopHostServer()
        try {
            server?.stop(200, 500)
        } catch (_: Throwable) {
        }
        server = null
    }
}
