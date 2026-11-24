package com.cutsync.webcut

import android.content.Context
import android.content.Intent
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.media.MediaMuxer
import android.media.MediaScannerConnection
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.DocumentsContract
import android.webkit.MimeTypeMap
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.Presentation
import androidx.media3.transformer.Composition
import androidx.media3.transformer.DefaultEncoderFactory
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import androidx.media3.transformer.VideoEncoderSettings
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
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
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

data class LayerLockEntry(
    val lockJson: JSONObject,
    var lastActivityMs: Long
)

class KtorLanEngine(private val context: Context) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val storagePrefs = context.getSharedPreferences("cutsync_storage", Context.MODE_PRIVATE)
    private val defaultMediaDir = File(context.filesDir, "cutsync_media").apply { mkdirs() }
    private val legacyCacheDir = File(context.cacheDir, "cutsync_media").apply { mkdirs() }

    @Volatile
    private var mediaDir: File = loadConfiguredMediaDir()

    @Volatile
    private var safTreeUriString: String? = storagePrefs.getString("saf_tree_uri", null)

    @Volatile
    private var safDisplayName: String? = storagePrefs.getString("saf_display_name", null)

    private val registeredFiles = ConcurrentHashMap<String, File>()
    private val fileHashCache = ConcurrentHashMap<String, String>()
    private val safSubdirCache = ConcurrentHashMap<String, Uri>()

    private fun mediaSubDir(baseDir: File = mediaDir): File {
        return File(baseDir, "media").apply { mkdirs() }
    }

    private fun projectsSubDir(baseDir: File = mediaDir): File {
        return File(baseDir, "projects").apply { mkdirs() }
    }

    private fun exportSubDir(baseDir: File = mediaDir): File {
        return File(baseDir, "export").apply { mkdirs() }
    }

    private fun sanitizeExtension(rawName: String?): String {
        val clean = (rawName ?: "").substringBefore('?').substringBefore('#').trim()
        val dot = clean.lastIndexOf('.')
        if (dot >= 0 && dot < clean.length - 1) {
            val ext = clean.substring(dot + 1)
                .lowercase()
                .replace(Regex("[^a-z0-9]"), "")
                .take(10)
            if (ext.isNotEmpty()) return ext
        }
        return "bin"
    }

    private fun normalizeBaseMediaName(fileNameOrRel: String): String {
        val trimmed = fileNameOrRel.trim().replace('\\', '/').substringBefore('?')
        val stripped = if (trimmed.startsWith("media/")) trimmed.removePrefix("media/") else trimmed
        return File(stripped).name.replace(Regex("[^a-zA-Z0-9._-]"), "_")
    }

    private fun buildDedupBaseName(hash24: String, size: Long, rawName: String?): String {
        val ext = sanitizeExtension(rawName)
        return "${hash24.lowercase().take(24)}_${size.coerceAtLeast(0L)}.$ext"
    }

    private fun computeFastFileFingerprint(file: File): Pair<String, Long> {
        val size = file.length()
        if (size <= 0L) {
            val emptyDigest = MessageDigest.getInstance("SHA-256").digest(ByteArray(0))
            return emptyDigest.joinToString("") { "%02x".format(it) }.take(24) to 0L
        }
        val chunkBytes = 64 * 1024
        val digest = MessageDigest.getInstance("SHA-256")
        java.io.RandomAccessFile(file, "r").use { raf ->
            if (size <= (chunkBytes * 2).toLong()) {
                val buf = ByteArray(size.toInt())
                raf.seek(0L)
                raf.readFully(buf)
                digest.update(buf)
            } else {
                val head = ByteArray(chunkBytes)
                raf.seek(0L)
                raf.readFully(head)
                digest.update(head)

                val tail = ByteArray(chunkBytes)
                raf.seek(size - chunkBytes.toLong())
                raf.readFully(tail)
                digest.update(tail)
            }
        }
        val hex = digest.digest().joinToString("") { "%02x".format(it) }
        return hex.take(24) to size
    }

    private fun computeFastUriFingerprint(uri: Uri): Pair<String, Long>? {
        return try {
            val chunkBytes = 64 * 1024
            context.contentResolver.openFileDescriptor(uri, "r")?.use { pfd ->
                val size = pfd.statSize
                if (size > 0L) {
                    val digest = MessageDigest.getInstance("SHA-256")
                    FileInputStream(pfd.fileDescriptor).use { fis ->
                        val ch = fis.channel
                        if (size <= (chunkBytes * 2).toLong()) {
                            val bb = java.nio.ByteBuffer.allocate(size.toInt())
                            ch.position(0L)
                            while (bb.hasRemaining()) {
                                if (ch.read(bb) <= 0) break
                            }
                            digest.update(bb.array(), 0, bb.position())
                        } else {
                            val headBb = java.nio.ByteBuffer.allocate(chunkBytes)
                            ch.position(0L)
                            while (headBb.hasRemaining()) {
                                if (ch.read(headBb) <= 0) break
                            }
                            digest.update(headBb.array(), 0, headBb.position())

                            val tailBb = java.nio.ByteBuffer.allocate(chunkBytes)
                            ch.position(size - chunkBytes.toLong())
                            while (tailBb.hasRemaining()) {
                                if (ch.read(tailBb) <= 0) break
                            }
                            digest.update(tailBb.array(), 0, tailBb.position())
                        }
                    }
                    val hex = digest.digest().joinToString("") { "%02x".format(it) }
                    return hex.take(24) to size
                }
            }
            null
        } catch (_: Throwable) {
            null
        }
    }

    private fun loadConfiguredMediaDir(): File {
        val custom = storagePrefs.getString("custom_media_dir", null)?.trim()
        if (!custom.isNullOrEmpty()) {
            val dir = File(custom)
            if ((dir.exists() || dir.mkdirs()) && dir.isDirectory && dir.canWrite()) {
                return dir
            }
        }
        defaultMediaDir.mkdirs()
        return defaultMediaDir
    }

    private fun copyFlatFiles(fromDir: File, toDir: File, registerAsMedia: Boolean): Int {
        if (!fromDir.exists() || !fromDir.isDirectory) return 0
        toDir.mkdirs()
        var count = 0
        fromDir.listFiles()?.forEach { f ->
            if (f.isFile && !f.name.endsWith(".part")) {
                val dest = File(toDir, f.name)
                if (!dest.exists() || dest.length() != f.length()) {
                    try {
                        f.copyTo(dest, overwrite = true)
                        if (registerAsMedia) {
                            registeredFiles[f.name] = dest
                        }
                        count++
                    } catch (_: Throwable) {
                    }
                }
            }
        }
        return count
    }

    private fun copyMediaBetweenDirs(fromDir: File, toDir: File): Int {
        if (fromDir.absolutePath == toDir.absolutePath) return 0
        if (!fromDir.exists() || !fromDir.isDirectory) return 0
        toDir.mkdirs()
        var count = 0
        count += copyFlatFiles(File(fromDir, "media"), File(toDir, "media"), registerAsMedia = true)
        count += copyFlatFiles(File(fromDir, "projects"), File(toDir, "projects"), registerAsMedia = false)
        count += copyFlatFiles(File(fromDir, "export"), File(toDir, "export"), registerAsMedia = false)
        // Legacy flat files inside root -> migrate to media/ (or projects/ if json)
        fromDir.listFiles()?.forEach { f ->
            if (f.isFile && !f.name.endsWith(".part")) {
                val sub = if (f.extension.equals("json", ignoreCase = true)) "projects" else "media"
                val destDir = File(toDir, sub).apply { mkdirs() }
                val dest = File(destDir, f.name)
                if (!dest.exists()) {
                    try {
                        f.copyTo(dest, overwrite = false)
                        if (sub == "media") registeredFiles[f.name] = dest
                        count++
                    } catch (_: Throwable) {
                    }
                }
            }
        }
        return count
    }

    private data class SafChildEntry(
        val name: String,
        val uri: Uri,
        val mimeType: String,
        val size: Long
    )

    private fun querySafChildren(treeUri: Uri, parentDocId: String): List<SafChildEntry> {
        val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentDocId)
        val result = mutableListOf<SafChildEntry>()
        val projection = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE
        )
        try {
            context.contentResolver.query(childrenUri, projection, null, null, null)?.use { cursor ->
                val idIdx = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
                val nameIdx = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
                val mimeIdx = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE)
                val sizeIdx = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_SIZE)
                while (cursor.moveToNext()) {
                    val docId = if (idIdx >= 0) cursor.getString(idIdx) else continue
                    val name = if (nameIdx >= 0) cursor.getString(nameIdx) else continue
                    val mime = if (mimeIdx >= 0) cursor.getString(mimeIdx) ?: "" else ""
                    val size = if (sizeIdx >= 0 && !cursor.isNull(sizeIdx)) cursor.getLong(sizeIdx) else -1L
                    val docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId)
                    result.add(SafChildEntry(name = name, uri = docUri, mimeType = mime, size = size))
                }
            }
        } catch (_: Throwable) {
        }
        return result
    }

    private fun getOrCreateSafSubdir(treeUri: Uri, subName: String, createIfMissing: Boolean): Uri? {
        val cacheKey = "${treeUri}::$subName"
        safSubdirCache[cacheKey]?.let { cached ->
            return cached
        }
        return try {
            val rootDocId = DocumentsContract.getTreeDocumentId(treeUri)
            val existing = querySafChildren(treeUri, rootDocId).firstOrNull {
                it.name == subName && it.mimeType == DocumentsContract.Document.MIME_TYPE_DIR
            }
            if (existing != null) {
                safSubdirCache[cacheKey] = existing.uri
                return existing.uri
            }
            if (!createIfMissing) return null
            val rootDocUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, rootDocId)
            val created = DocumentsContract.createDocument(
                context.contentResolver,
                rootDocUri,
                DocumentsContract.Document.MIME_TYPE_DIR,
                subName
            )
            if (created != null) {
                safSubdirCache[cacheKey] = created
            }
            created
        } catch (_: Throwable) {
            null
        }
    }

    private fun mirrorFileToSafIfConfigured(
        file: File,
        subFolder: String = "media",
        overwriteExisting: Boolean = false
    ) {
        val uriStr = safTreeUriString ?: return
        if (!file.exists() || !file.isFile) return
        try {
            val treeUri = Uri.parse(uriStr)
            val parentUri = getOrCreateSafSubdir(treeUri, subFolder, createIfMissing = true)
                ?: DocumentsContract.buildDocumentUriUsingTree(
                    treeUri,
                    DocumentsContract.getTreeDocumentId(treeUri)
                )
            val parentDocId = DocumentsContract.getDocumentId(parentUri)
            val existing = querySafChildren(treeUri, parentDocId).firstOrNull { it.name == file.name }
            if (existing != null) {
                if (!overwriteExisting && existing.size == file.length()) {
                    return
                }
                if (overwriteExisting) {
                    try {
                        DocumentsContract.deleteDocument(context.contentResolver, existing.uri)
                    } catch (_: Throwable) {
                    }
                } else if (existing.size > 0L) {
                    return
                }
            }
            val mime = if (file.extension.equals("json", ignoreCase = true)) {
                "application/json"
            } else {
                contentTypeForFile(file).toString()
            }
            val createdUri = DocumentsContract.createDocument(
                context.contentResolver,
                parentUri,
                mime,
                file.name
            ) ?: return
            context.contentResolver.openOutputStream(createdUri, "wt")?.use { out ->
                FileInputStream(file).use { input ->
                    input.copyTo(out)
                }
            }
        } catch (_: Throwable) {
        }
    }

    private fun restoreFileFromSaf(safeName: String, subFolder: String, expectedSize: Long = -1L): File? {
        val uriStr = safTreeUriString ?: return null
        return try {
            val treeUri = Uri.parse(uriStr)
            val subUri = getOrCreateSafSubdir(treeUri, subFolder, createIfMissing = false)
            val searchParents = listOfNotNull(
                subUri?.let { DocumentsContract.getDocumentId(it) },
                DocumentsContract.getTreeDocumentId(treeUri)
            )
            for (pid in searchParents) {
                val match = querySafChildren(treeUri, pid).firstOrNull {
                    it.name == safeName && it.mimeType != DocumentsContract.Document.MIME_TYPE_DIR
                } ?: continue
                if (expectedSize > 0L && match.size > 0L && match.size != expectedSize) {
                    continue
                }
                val targetDir = if (subFolder == "projects") projectsSubDir() else mediaSubDir()
                val dest = File(targetDir, safeName)
                val part = File(targetDir, "$safeName.part")
                context.contentResolver.openInputStream(match.uri)?.use { inp ->
                    FileOutputStream(part).use { out -> inp.copyTo(out) }
                } ?: continue
                if (dest.exists()) dest.delete()
                if (!part.renameTo(dest)) {
                    part.copyTo(dest, overwrite = true)
                    part.delete()
                }
                if (subFolder == "media") {
                    registeredFiles[safeName] = dest
                }
                return dest
            }
            null
        } catch (_: Throwable) {
            null
        }
    }

    private fun restoreAllProjectsFromSafIfConfigured() {
        val uriStr = safTreeUriString ?: return
        try {
            val treeUri = Uri.parse(uriStr)
            val projDirUri = getOrCreateSafSubdir(treeUri, "projects", createIfMissing = false) ?: return
            val projDocId = DocumentsContract.getDocumentId(projDirUri)
            val localProjDir = projectsSubDir()
            for (child in querySafChildren(treeUri, projDocId)) {
                if (!child.name.endsWith(".json", ignoreCase = true)) continue
                val dest = File(localProjDir, child.name)
                if (!dest.exists() || (child.size > 0L && dest.length() != child.size)) {
                    try {
                        context.contentResolver.openInputStream(child.uri)?.use { inp ->
                            FileOutputStream(dest).use { out -> inp.copyTo(out) }
                        }
                    } catch (_: Throwable) {
                    }
                }
            }
        } catch (_: Throwable) {
        }
    }

    private fun listAllMediaFiles(baseDir: File = mediaDir): List<File> {
        val mediaFolder = File(baseDir, "media")
        val mediaFiles = if (mediaFolder.exists() && mediaFolder.isDirectory) {
            mediaFolder.listFiles()?.filter { it.isFile && !it.name.endsWith(".part") } ?: emptyList()
        } else emptyList()
        val legacyRootFiles = baseDir.listFiles()?.filter {
            it.isFile && !it.name.endsWith(".part") && !it.extension.equals("json", ignoreCase = true)
        } ?: emptyList()
        return mediaFiles + legacyRootFiles
    }

    fun getStorageConfigJson(): JSONObject {
        val active = mediaDir
        val files = listAllMediaFiles(active)
        val totalBytes = files.sumOf { it.length() }
        val isSaf = !safTreeUriString.isNullOrBlank()
        val isDefault = !isSaf && active.absolutePath == defaultMediaDir.absolutePath
        val presets = JSONArray().apply {
            put(JSONObject().apply {
                put("label", "По стандарту (корень приложения)")
                put("path", defaultMediaDir.absolutePath)
                put("isDefault", true)
            })
            context.getExternalFilesDir(Environment.DIRECTORY_MOVIES)?.let { extMovies ->
                val target = File(extMovies, "CutSyncMedia")
                put(JSONObject().apply {
                    put("label", "Папка приложения (Android/data)")
                    put("path", target.absolutePath)
                })
            }
        }
        return JSONObject().apply {
            put("currentDir", if (isSaf) (safDisplayName ?: safTreeUriString) else active.absolutePath)
            put("defaultDir", defaultMediaDir.absolutePath)
            put("isDefault", isDefault)
            put("mode", when {
                isSaf -> "saf"
                isDefault -> "internal"
                else -> "custom"
            })
            put("displayName", when {
                isSaf -> safDisplayName ?: "Выбранная папка Android"
                isDefault -> "Корень приложения (внутри CutSync)"
                else -> active.name
            })
            put("filesCount", files.size)
            put("totalBytes", totalBytes)
            put("presets", presets)
        }
    }

    fun setStorageFolderPath(rawPath: String, migrateExisting: Boolean): Pair<JSONObject, Int> {
        val target = File(rawPath.trim())
        if (!target.exists() && !target.mkdirs()) {
            throw IllegalArgumentException("Не удалось создать папку: $rawPath")
        }
        if (!target.isDirectory || !target.canWrite()) {
            throw IllegalArgumentException("Нет прав на запись в папку: $rawPath")
        }
        val prevDir = mediaDir
        mediaDir = target
        safTreeUriString = null
        safDisplayName = null
        safSubdirCache.clear()
        val isDefault = target.absolutePath == defaultMediaDir.absolutePath
        storagePrefs.edit().apply {
            if (isDefault) remove("custom_media_dir") else putString("custom_media_dir", target.absolutePath)
            remove("saf_tree_uri")
            remove("saf_display_name")
            apply()
        }
        val migrated = if (migrateExisting) copyMediaBetweenDirs(prevDir, target) else 0
        return getStorageConfigJson() to migrated
    }

    fun setSafStorageTree(treeUri: Uri, migrateExisting: Boolean): Pair<JSONObject, Int> {
        val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        try {
            context.contentResolver.takePersistableUriPermission(treeUri, flags)
        } catch (_: Throwable) {
        }
        val docId = try {
            DocumentsContract.getTreeDocumentId(treeUri)
        } catch (_: Throwable) {
            treeUri.lastPathSegment ?: "Выбранная папка"
        }
        val display = docId.substringAfter(':').ifEmpty { docId }
        safTreeUriString = treeUri.toString()
        safDisplayName = display
        safSubdirCache.clear()
        storagePrefs.edit()
            .putString("saf_tree_uri", treeUri.toString())
            .putString("saf_display_name", display)
            .apply()
        var migrated = 0
        if (migrateExisting) {
            listAllMediaFiles(mediaDir).forEach { f ->
                mirrorFileToSafIfConfigured(f, subFolder = "media", overwriteExisting = false)
                migrated++
            }
            projectsSubDir().listFiles()?.forEach { pf ->
                if (pf.isFile && pf.extension.equals("json", ignoreCase = true)) {
                    mirrorFileToSafIfConfigured(pf, subFolder = "projects", overwriteExisting = true)
                    migrated++
                }
            }
        }
        restoreAllProjectsFromSafIfConfigured()
        return getStorageConfigJson() to migrated
    }

    fun resetStorageFolder(migrateExisting: Boolean): Pair<JSONObject, Int> {
        val prevDir = mediaDir
        mediaDir = defaultMediaDir.apply { mkdirs() }
        safTreeUriString = null
        safDisplayName = null
        safSubdirCache.clear()
        storagePrefs.edit()
            .remove("custom_media_dir")
            .remove("saf_tree_uri")
            .remove("saf_display_name")
            .apply()
        val migrated = if (migrateExisting) copyMediaBetweenDirs(prevDir, defaultMediaDir) else 0
        return getStorageConfigJson() to migrated
    }

    private var server: ApplicationEngine? = null
    private var serverPort: Int = 8080
    private var serverState: String = "stopped"
    private var serverError: String? = null
    private var isHostingRoom: Boolean = false

    private var hostRoomState: JSONObject = JSONObject().apply {
        put("roomId", "lan-studio")
        put("title", "Локальный проект")
        put("aspectRatio", "9:16")
        put("backgroundColor", "#09090b")
        put("hostName", "Хост")
        put("fps", 30)
        put("isPublicLan", true)
        put("revision", 0)
        put("tracks", JSONArray())
        put("clips", JSONArray())
        put("chat", JSONArray())
    }

    private val wsSessions = ConcurrentHashMap<String, RoomPeerSession>()
    private val layerLocks = ConcurrentHashMap<String, LayerLockEntry>()

    private var beaconJob: Job? = null
    private var udpListenerJob: Job? = null
    private var lockExpiryJob: Job? = null
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
    var onCompressProgress: ((String, Int) -> Unit)? = null
    var onCompressComplete: ((String, String, String, String, Long, Long) -> Unit)? = null
    var onCompressError: ((String, String) -> Unit)? = null

    private val mainHandler = Handler(Looper.getMainLooper())
    private val activeTransformers = ConcurrentHashMap<String, Transformer>()

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
                        val isVpnIface = lower.startsWith("zt") || lower.startsWith("tun") || lower.startsWith("tap")
                        val isWifiIface = lower.startsWith("wlan") || lower.startsWith("ap") || lower.startsWith("swlan") || lower.startsWith("wifi")
                        val type = when {
                            isVpnIface -> "zerotier"
                            isWifiIface || ip.startsWith("192.168.") -> "wifi"
                            ip.startsWith("10.") -> "zerotier"
                            else -> "lan"
                        }
                        val label = when {
                            lower.startsWith("zt") -> "ZeroTier ($name)"
                            type == "zerotier" -> "VPN / ZeroTier ($name)"
                            type == "wifi" -> "Wi-Fi ($name)"
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

    fun getServerStatusJson(): JSONObject {
        return JSONObject().apply {
            put("state", serverState)
            put("port", serverPort)
            put("preferredPort", 8080)
            put("hosting", isHostingRoom)
            if (!serverError.isNullOrBlank()) {
                put("error", serverError)
            }
        }
    }

    private fun computeFileSha256(file: File): String {
        val cacheKey = "${file.name}:${file.length()}:${file.lastModified()}"
        fileHashCache[cacheKey]?.let { return it }
        return try {
            val digest = MessageDigest.getInstance("SHA-256")
            val buf = ByteArray(32 * 1024)
            FileInputStream(file).use { fis ->
                while (true) {
                    val read = fis.read(buf)
                    if (read <= 0) break
                    digest.update(buf, 0, read)
                }
            }
            val hex = digest.digest().joinToString("") { "%02x".format(it) }
            fileHashCache[cacheKey] = hex
            hex
        } catch (_: Throwable) {
            ""
        }
    }

    private fun findMediaFileByBaseName(safeName: String, allowSafRestore: Boolean = true): File? {
        if (safeName.isBlank()) return null
        registeredFiles[safeName]?.takeIf { it.exists() && it.isFile }?.let { return it }
        File(File(mediaDir, "media"), safeName).takeIf { it.exists() && it.isFile }?.let { return it }
        File(mediaDir, safeName).takeIf { it.exists() && it.isFile }?.let { return it }
        File(File(defaultMediaDir, "media"), safeName).takeIf { it.exists() && it.isFile }?.let { return it }
        File(defaultMediaDir, safeName).takeIf { it.exists() && it.isFile }?.let { return it }
        File(File(legacyCacheDir, "media"), safeName).takeIf { it.exists() && it.isFile }?.let { return it }
        File(legacyCacheDir, safeName).takeIf { it.exists() && it.isFile }?.let { return it }
        if (allowSafRestore && !safTreeUriString.isNullOrBlank()) {
            return restoreFileFromSaf(safeName, "media")
        }
        return null
    }

    fun getCachedFileMetadata(fileName: String): Pair<Long, String> {
        val safe = normalizeBaseMediaName(fileName)
        val target = findMediaFileByBaseName(safe, allowSafRestore = false) ?: return 0L to ""
        if (!target.exists()) return 0L to ""
        return target.length() to computeFileSha256(target)
    }

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
            "ttf" -> ContentType("font", "ttf")
            "otf" -> ContentType("font", "otf")
            "woff" -> ContentType("font", "woff")
            "woff2" -> ContentType("font", "woff2")
            else -> {
                val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)
                if (mime != null) ContentType.parse(mime) else ContentType.Application.OctetStream
            }
        }
    }

    fun resolveCachedMediaFile(sourceUrl: String?, fileName: String? = null): File? {
        if (!fileName.isNullOrEmpty()) {
            val safe = normalizeBaseMediaName(fileName)
            findMediaFileByBaseName(safe)?.let { return it }
        }
        if (!sourceUrl.isNullOrEmpty()) {
            val trimmed = sourceUrl.trim().replace('\\', '/')
            if (trimmed.contains("/media/")) {
                val rawPart = trimmed.substringAfterLast("/media/").substringBefore("?")
                val decoded = try {
                    java.net.URLDecoder.decode(rawPart, "UTF-8")
                } catch (_: Throwable) {
                    rawPart
                }
                val safe = normalizeBaseMediaName(decoded)
                findMediaFileByBaseName(safe)?.let { return it }
            } else if (trimmed.startsWith("media/")) {
                val safe = normalizeBaseMediaName(trimmed)
                findMediaFileByBaseName(safe)?.let { return it }
            }
        }
        return null
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
        serverError = if (chosenPort != preferredPort) {
            "Порт $preferredPort занят, используется $chosenPort"
        } else {
            null
        }

        val engine = embeddedServer(ServerCIO, port = chosenPort, host = "0.0.0.0") {
            install(WebSockets) {
                pingPeriodMillis = 15_000L
                timeoutMillis = 30_000L
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
                        put("state", serverState)
                        put("port", serverPort)
                        put("hosting", isHostingRoom)
                        put("participants", wsSessions.size)
                        if (!serverError.isNullOrBlank()) put("error", serverError)
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

                suspend fun serveMediaByRawName(call: ApplicationCall, rawName: String) {
                    applyCors(call)
                    val safeName = normalizeBaseMediaName(rawName)
                    val file = withContext(Dispatchers.IO) {
                        findMediaFileByBaseName(safeName)
                    }
                    if (file == null || !file.exists() || !file.isFile) {
                        call.respond(HttpStatusCode.NotFound, "Media not found")
                        return
                    }
                    val sha = computeFileSha256(file)
                    call.response.header(HttpHeaders.AcceptRanges, "bytes")
                    call.response.header(HttpHeaders.ContentType, contentTypeForFile(file).toString())
                    call.response.header("X-File-Size", file.length().toString())
                    if (sha.isNotEmpty()) {
                        call.response.header("X-Content-Sha256", sha)
                    }
                    call.respondFile(file)
                }

                get("/media/{fileName}") {
                    serveMediaByRawName(call, call.parameters["fileName"] ?: "")
                }

                get("/media/media/{fileName}") {
                    serveMediaByRawName(call, call.parameters["fileName"] ?: "")
                }

                post("/media/upload") {
                    applyCors(call)
                    val rawName = call.request.queryParameters["fileName"]
                        ?: "clip-${System.currentTimeMillis()}.bin"
                    val activeMediaDir = mediaSubDir()
                    val tempFile = File(activeMediaDir, ".upload-${System.nanoTime()}.part")
                    val channel: ByteReadChannel = call.receiveChannel()
                    var deduplicated = false
                    var baseName = ""
                    var destFile: File = tempFile
                    withContext(Dispatchers.IO) {
                        try {
                            FileOutputStream(tempFile).use { fos ->
                                channel.copyTo(fos)
                            }
                            val (fastHash, size) = computeFastFileFingerprint(tempFile)
                            baseName = buildDedupBaseName(fastHash, size, rawName)
                            destFile = File(activeMediaDir, baseName)
                            if (destFile.exists() && destFile.isFile && destFile.length() == size) {
                                tempFile.delete()
                                deduplicated = true
                            } else {
                                if (destFile.exists()) destFile.delete()
                                if (!tempFile.renameTo(destFile)) {
                                    tempFile.copyTo(destFile, overwrite = true)
                                    tempFile.delete()
                                }
                                mirrorFileToSafIfConfigured(destFile, subFolder = "media", overwriteExisting = false)
                            }
                        } catch (err: Throwable) {
                            if (tempFile.exists()) tempFile.delete()
                            throw err
                        }
                    }
                    registeredFiles[baseName] = destFile
                    val sha = computeFileSha256(destFile)
                    val bestIp = getPrimaryIp()
                    val relPath = "media/$baseName"
                    val resp = JSONObject().apply {
                        put("ok", true)
                        put("deduplicated", deduplicated)
                        put("fileName", relPath)
                        put("baseName", baseName)
                        put("relativePath", relPath)
                        put("fileSize", destFile.length())
                        if (sha.isNotEmpty()) put("fileHash", sha)
                        put("localUrl", "http://127.0.0.1:$serverPort/media/$baseName")
                        put("shareUrl", "http://$bestIp:$serverPort/media/$baseName")
                    }
                    call.respondText(resp.toString(), ContentType.Application.Json)
                }

                get("/export/{fileName}") {
                    applyCors(call)
                    val rawName = call.parameters["fileName"] ?: ""
                    val safeName = normalizeBaseMediaName(rawName)
                    val file = withContext(Dispatchers.IO) {
                        File(exportSubDir(), safeName).takeIf { it.exists() && it.isFile }
                    }
                    if (file == null) {
                        call.respond(HttpStatusCode.NotFound, "Export file not found")
                        return@get
                    }
                    call.response.header(HttpHeaders.AcceptRanges, "bytes")
                    call.response.header(HttpHeaders.ContentType, contentTypeForFile(file).toString())
                    call.respondFile(file)
                }

                post("/export/upload") {
                    applyCors(call)
                    val rawName = call.request.queryParameters["fileName"]
                    val extParam = call.request.queryParameters["ext"] ?: "mp4"
                    val mimeParam = call.request.queryParameters["mimeType"]
                    val channel: ByteReadChannel = call.receiveChannel()
                    val resp = withContext(Dispatchers.IO) {
                        saveExportChannelToExportDir(
                            channel = channel,
                            rawName = rawName,
                            fallbackExt = extParam,
                            explicitMimeType = mimeParam
                        )
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

        try {
            engine.start(wait = false)
            server = engine
            serverState = "running"
            startLockExpirySweeper()
        } catch (err: Throwable) {
            server = null
            serverState = "port_error"
            serverError = err.message ?: "Ошибка запуска порта $chosenPort"
        }
        return chosenPort
    }

    private fun startLockExpirySweeper() {
        if (lockExpiryJob?.isActive == true) return
        lockExpiryJob = scope.launch {
            while (isActive) {
                delay(1000L)
                val now = System.currentTimeMillis()
                val expired = layerLocks.entries
                    .filter { now - it.value.lastActivityMs >= 5000L }
                    .map { it.key to it.value }
                for ((layerId, entry) in expired) {
                    layerLocks.remove(layerId, entry)
                    val ownerId = entry.lockJson.optString("userId", "")
                    applyLockToHostClips(layerId, null, null, null)
                    val unlockMsg = JSONObject().apply {
                        put("type", "LAYER_LOCK")
                        put("layerId", layerId)
                        put("userId", ownerId)
                        put("userName", "")
                        put("userColor", "")
                        put("locked", false)
                    }
                    broadcastAll(unlockMsg.toString())
                }
            }
        }
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

                        val currentRev = hostRoomState.optInt("revision", 0)
                        val initMsg = JSONObject().apply {
                            put("type", "room:init")
                            put("project", hostRoomState)
                            put("revision", currentRev)
                            put("prevRevision", currentRev)
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

                    "ping" -> {
                        val pongMsg = JSONObject().apply {
                            put("type", "pong")
                            put("ts", msg.optLong("ts", System.currentTimeMillis()))
                            put("serverTime", System.currentTimeMillis())
                        }
                        ws.send(Frame.Text(pongMsg.toString()))
                    }

                    "REQUEST_SYNC", "SYNC_FULL_STATE" -> {
                        val currentRev = hostRoomState.optInt("revision", 0)
                        val syncMsg = JSONObject().apply {
                            put("type", "SYNC_FULL_STATE")
                            put("project", hostRoomState)
                            put("revision", currentRev)
                            put("prevRevision", currentRev)
                            put("collaborators", buildCollaboratorsArray())
                            put("rooms", JSONArray().apply {
                                if (isHostingRoom) put(buildRoomSummaryJson())
                            })
                        }
                        ws.send(Frame.Text(syncMsg.toString()))
                    }

                    "LAYER_LOCK" -> {
                        val layerId = msg.optString("layerId", "")
                        val locked = msg.optBoolean("locked", false)
                        val userId = msg.optString("userId", "")
                        if (layerId.isNotEmpty()) {
                            if (locked) {
                                val existing = layerLocks[layerId]
                                if (existing != null &&
                                    existing.lockJson.optString("userId") != userId &&
                                    System.currentTimeMillis() - existing.lastActivityMs < 5000L
                                ) {
                                    continue
                                }
                                layerLocks[layerId] = LayerLockEntry(
                                    lockJson = JSONObject(msg.toString()),
                                    lastActivityMs = System.currentTimeMillis()
                                )
                            } else {
                                val existing = layerLocks[layerId]
                                if (existing != null && existing.lockJson.optString("userId") != userId) {
                                    continue
                                }
                                layerLocks.remove(layerId)
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
                        val layerId = msg.optString("layerId", "")
                        layerLocks[layerId]?.let { it.lastActivityMs = System.currentTimeMillis() }
                        val senderId = wsSessions[connId]?.userJson?.optString("id") ?: msg.optString("senderId", "")
                        msg.put("senderId", senderId)
                        val prevRev = hostRoomState.optInt("revision", 0)
                        val rev = prevRev + 1
                        hostRoomState.put("revision", rev)
                        msg.put("prevRevision", prevRev)
                        msg.put("revision", rev)
                        applyMediaUpdateToHostState(msg)
                        broadcastAll(msg.toString(), excludeConnId = connId)
                        ws.send(
                            Frame.Text(
                                JSONObject().apply {
                                    put("type", "sync:ack")
                                    put("revision", rev)
                                    put("prevRevision", prevRev)
                                    put("opType", "LAYER_MEDIA_UPDATED")
                                }.toString()
                            )
                        )
                    }

                    else -> {
                        if (type.startsWith("op:")) {
                            val senderId = wsSessions[connId]?.userJson?.optString("id") ?: ""
                            if (type == "op:clip_update") {
                                val clipId = msg.optString("clipId", "")
                                layerLocks[clipId]?.let { lock ->
                                    if (lock.lockJson.optString("userId") == senderId) {
                                        lock.lastActivityMs = System.currentTimeMillis()
                                    }
                                }
                                if (msg.optBoolean("ephemeral", false)) {
                                    val currentRev = hostRoomState.optInt("revision", 0)
                                    msg.put("ephemeral", true)
                                    msg.put("prevRevision", currentRev)
                                    msg.put("revision", currentRev)
                                    msg.put("senderId", senderId)
                                    broadcastAll(msg.toString(), excludeConnId = connId)
                                    continue
                                }
                            }
                            val prevRev = hostRoomState.optInt("revision", 0)
                            val rev = prevRev + 1
                            hostRoomState.put("revision", rev)
                            msg.put("prevRevision", prevRev)
                            msg.put("revision", rev)
                            msg.put("senderId", senderId)
                            applyOpToHostState(type, msg)
                            broadcastAll(msg.toString(), excludeConnId = connId)
                            ws.send(
                                Frame.Text(
                                    JSONObject().apply {
                                        put("type", "sync:ack")
                                        put("revision", rev)
                                        put("prevRevision", prevRev)
                                        put("opType", type)
                                    }.toString()
                                )
                            )
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
                    .filter { it.value.lockJson.optString("userId") == removedUserId }
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

    private fun insertTrackAt(tracks: JSONArray, newTrack: JSONObject, insertAt: Int): JSONArray {
        val next = JSONArray()
        val len = tracks.length()
        val idx = if (insertAt in 0..len) insertAt else len
        for (i in 0 until idx) {
            next.put(tracks.get(i))
        }
        next.put(newTrack)
        for (i in idx until len) {
            next.put(tracks.get(i))
        }
        return next
    }

    private fun applyMediaUpdateToHostState(msg: JSONObject) {
        val layerId = msg.optString("layerId", "")
        val fileName = msg.optString("fileName", "")
        val mediaUrl = msg.optString("mediaUrl", "")
        val hasFileSize = msg.has("fileSize") && !msg.isNull("fileSize")
        val fileSize = msg.optLong("fileSize", -1L)
        val fileHash = msg.optString("fileHash", "")
        val insertAt = msg.optInt("insertAt", -1)
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
                hostRoomState.put("tracks", insertTrackAt(tracks, newTrack, insertAt))
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
                c.remove("mediaError")
                if (hasFileSize && fileSize > 0) c.put("mediaFileSize", fileSize)
                if (fileHash.isNotEmpty()) c.put("mediaFileHash", fileHash)
                val incomingClip = msg.optJSONObject("clip")
                if (incomingClip != null) {
                    if (incomingClip.has("name")) c.put("name", incomingClip.optString("name"))
                    if (incomingClip.has("kind")) c.put("kind", incomingClip.optString("kind"))
                    if (incomingClip.has("trimStart")) c.put("trimStart", incomingClip.optDouble("trimStart", 0.0))
                    if (incomingClip.has("sourceDuration")) c.put("sourceDuration", incomingClip.optDouble("sourceDuration", c.optDouble("sourceDuration", 60.0)))
                }
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
                incomingClip.remove("mediaError")
                if (hasFileSize && fileSize > 0) incomingClip.put("mediaFileSize", fileSize)
                if (fileHash.isNotEmpty()) incomingClip.put("mediaFileHash", fileHash)
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
                val tid = t.optString("id")
                for (i in 0 until tracks.length()) {
                    if (tracks.optJSONObject(i)?.optString("id") == tid) return
                }
                hostRoomState.put("tracks", insertTrackAt(tracks, t, msg.optInt("insertAt", -1)))
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
                    hostRoomState.put("tracks", insertTrackAt(tracks, nt, msg.optInt("insertAt", -1)))
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
            "op:track_reorder" -> {
                val trackIds = msg.optJSONArray("trackIds") ?: return
                val tracks = hostRoomState.optJSONArray("tracks") ?: return
                val byId = LinkedHashMap<String, JSONObject>()
                for (i in 0 until tracks.length()) {
                    val t = tracks.optJSONObject(i) ?: continue
                    byId[t.optString("id")] = t
                }
                val reordered = JSONArray()
                val seen = HashSet<String>()
                for (i in 0 until trackIds.length()) {
                    val id = trackIds.optString(i)
                    val t = byId[id]
                    if (t != null && seen.add(id)) {
                        reordered.put(t)
                    }
                }
                for ((id, t) in byId) {
                    if (seen.add(id)) {
                        reordered.put(t)
                    }
                }
                hostRoomState.put("tracks", reordered)
            }
            "op:clip_split" -> {
                val clipId = msg.optString("clipId")
                val newClipId = msg.optString("newClipId")
                val splitTime = msg.optDouble("splitTime", 0.0)
                val clips = hostRoomState.optJSONArray("clips") ?: return
                var targetIdx = -1
                var targetClip: JSONObject? = null
                for (i in 0 until clips.length()) {
                    val c = clips.optJSONObject(i) ?: continue
                    if (c.optString("id") == newClipId) return
                    if (c.optString("id") == clipId) {
                        targetIdx = i
                        targetClip = c
                    }
                }
                if (targetIdx == -1 || targetClip == null) return
                val start = targetClip.optDouble("start", 0.0)
                val duration = targetClip.optDouble("duration", 0.0)
                val relOffset = splitTime - start
                if (relOffset <= 0.15 || relOffset >= duration - 0.15) return
                val speed = targetClip.optDouble("speed", 1.0)
                val trimStart = targetClip.optDouble("trimStart", 0.0)

                val firstHalf = JSONObject(targetClip.toString()).apply {
                    put("duration", Math.round(relOffset * 100.0) / 100.0)
                    targetClip.optJSONArray("keyframes")?.let { kfs ->
                        val nextKfs = JSONArray()
                        for (k in 0 until kfs.length()) {
                            val kf = kfs.optJSONObject(k) ?: continue
                            if (kf.optDouble("timeOffset", 0.0) <= relOffset) {
                                nextKfs.put(JSONObject(kf.toString()))
                            }
                        }
                        put("keyframes", nextKfs)
                    }
                }

                val secondHalf = JSONObject(targetClip.toString()).apply {
                    put("id", newClipId)
                    put("name", "${targetClip.optString("name")} (2)")
                    put("start", Math.round(splitTime * 100.0) / 100.0)
                    put("duration", Math.round((duration - relOffset) * 100.0) / 100.0)
                    put(
                        "trimStart",
                        if (targetClip.optString("kind") == "adjustment") 0.0
                        else Math.round((trimStart + relOffset * speed) * 100.0) / 100.0
                    )
                    put("transitionIn", "none")
                    remove("lockedByUserId")
                    remove("lockedByUserName")
                    remove("lockedByUserColor")
                    targetClip.optJSONArray("keyframes")?.let { kfs ->
                        val nextKfs = JSONArray()
                        for (k in 0 until kfs.length()) {
                            val kf = kfs.optJSONObject(k) ?: continue
                            val to = kf.optDouble("timeOffset", 0.0)
                            if (to >= relOffset) {
                                nextKfs.put(JSONObject(kf.toString()).apply {
                                    put("id", "kf-${System.nanoTime().toString(36).takeLast(6)}-$k")
                                    put("timeOffset", Math.round((to - relOffset) * 100.0) / 100.0)
                                })
                            }
                        }
                        put("keyframes", nextKfs)
                    }
                }

                val nextClips = JSONArray()
                for (i in 0 until clips.length()) {
                    if (i == targetIdx) {
                        nextClips.put(firstHalf)
                        nextClips.put(secondHalf)
                    } else {
                        nextClips.put(clips.get(i))
                    }
                }
                hostRoomState.put("clips", nextClips)
            }
            "op:clip_duplicate" -> {
                val clipId = msg.optString("clipId")
                val newClipId = msg.optString("newClipId")
                val clips = hostRoomState.optJSONArray("clips") ?: return
                var targetIdx = -1
                var targetClip: JSONObject? = null
                for (i in 0 until clips.length()) {
                    val c = clips.optJSONObject(i) ?: continue
                    if (c.optString("id") == newClipId) return
                    if (c.optString("id") == clipId) {
                        targetIdx = i
                        targetClip = c
                    }
                }
                if (targetIdx == -1 || targetClip == null) return
                val copyStart = Math.round((targetClip.optDouble("start", 0.0) + targetClip.optDouble("duration", 0.0)) * 100.0) / 100.0
                val dur = targetClip.optDouble("duration", 0.0)
                val targetTrackId = targetClip.optString("trackId")
                val copy = JSONObject(targetClip.toString()).apply {
                    put("id", newClipId)
                    put("name", "${targetClip.optString("name")} (копия)")
                    put("start", copyStart)
                    remove("lockedByUserId")
                    remove("lockedByUserName")
                    remove("lockedByUserColor")
                    optJSONArray("keyframes")?.let { kfs ->
                        val nextKfs = JSONArray()
                        for (k in 0 until kfs.length()) {
                            val kf = kfs.optJSONObject(k) ?: continue
                            nextKfs.put(JSONObject(kf.toString()).apply {
                                put("id", "kf-${System.nanoTime().toString(36).takeLast(6)}-$k")
                            })
                        }
                        put("keyframes", nextKfs)
                    }
                }
                val nextClips = JSONArray()
                for (i in 0 until clips.length()) {
                    val c = clips.optJSONObject(i) ?: continue
                    if (c.optString("id") != clipId &&
                        c.optString("trackId") == targetTrackId &&
                        c.optDouble("start", 0.0) >= copyStart - 0.05
                    ) {
                        c.put("start", Math.round((c.optDouble("start", 0.0) + dur) * 100.0) / 100.0)
                    }
                    nextClips.put(c)
                    if (i == targetIdx) {
                        nextClips.put(copy)
                    }
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
                if (msg.has("canvasBackground")) hostRoomState.put("canvasBackground", msg.opt("canvasBackground"))
                if (msg.has("customFonts")) hostRoomState.put("customFonts", msg.optJSONArray("customFonts"))
                if (msg.has("trackers")) hostRoomState.put("trackers", msg.optJSONArray("trackers"))
            }
        }
    }

    private fun mergeJson(target: JSONObject, patch: JSONObject) {
        val keys = patch.keys()
        while (keys.hasNext()) {
            val k = keys.next()
            if (k == "id") continue
            if (patch.isNull(k)) {
                if (k.startsWith("lockedBy")) {
                    target.put(k, JSONObject.NULL)
                } else {
                    target.remove(k)
                }
            } else {
                target.put(k, patch.get(k))
            }
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

    fun checkMediaExists(fileName: String, expectedSize: Long = -1L): JSONObject {
        val safeName = normalizeBaseMediaName(fileName)
        val existing = findMediaFileByBaseName(safeName, allowSafRestore = true)
        if (existing != null && existing.exists() && existing.isFile &&
            (expectedSize <= 0L || existing.length() == expectedSize)
        ) {
            ensureMediaServerStarted()
            val sha = computeFileSha256(existing)
            val bestIp = getPrimaryIp()
            val relPath = "media/$safeName"
            return JSONObject().apply {
                put("exists", true)
                put("fileName", relPath)
                put("baseName", safeName)
                put("relativePath", relPath)
                put("fileSize", existing.length())
                if (sha.isNotEmpty()) put("fileHash", sha)
                put("localUrl", "http://127.0.0.1:$serverPort/media/$safeName")
                put("shareUrl", "http://$bestIp:$serverPort/media/$safeName")
            }
        }
        return JSONObject().apply { put("exists", false) }
    }

    fun importMediaFromUri(uri: Uri, rawFileName: String? = null): JSONObject {
        val activeMediaDir = mediaSubDir()
        val displayName = rawFileName?.takeIf { it.isNotBlank() } ?: uri.lastPathSegment ?: "media.bin"
        val fastFp = computeFastUriFingerprint(uri)
        var deduplicated = false
        val baseName: String
        val destFile: File
        if (fastFp != null) {
            baseName = buildDedupBaseName(fastFp.first, fastFp.second, displayName)
            val existing = findMediaFileByBaseName(baseName, allowSafRestore = true)
            if (existing != null && existing.exists() && existing.length() == fastFp.second) {
                deduplicated = true
                destFile = existing
            } else {
                val target = File(activeMediaDir, baseName)
                val part = File(activeMediaDir, ".import-${System.nanoTime()}.part")
                context.contentResolver.openInputStream(uri)?.use { inp ->
                    FileOutputStream(part).use { out -> inp.copyTo(out) }
                } ?: throw IllegalStateException("Не удалось прочитать URI: $uri")
                if (target.exists()) target.delete()
                if (!part.renameTo(target)) {
                    part.copyTo(target, overwrite = true)
                    part.delete()
                }
                mirrorFileToSafIfConfigured(target, subFolder = "media", overwriteExisting = false)
                destFile = target
            }
        } else {
            val part = File(activeMediaDir, ".import-${System.nanoTime()}.part")
            context.contentResolver.openInputStream(uri)?.use { inp ->
                FileOutputStream(part).use { out -> inp.copyTo(out) }
            } ?: throw IllegalStateException("Не удалось прочитать URI: $uri")
            val (hash24, size) = computeFastFileFingerprint(part)
            baseName = buildDedupBaseName(hash24, size, displayName)
            val existing = findMediaFileByBaseName(baseName, allowSafRestore = true)
            if (existing != null && existing.exists() && existing.length() == size) {
                part.delete()
                deduplicated = true
                destFile = existing
            } else {
                val target = File(activeMediaDir, baseName)
                if (target.exists()) target.delete()
                if (!part.renameTo(target)) {
                    part.copyTo(target, overwrite = true)
                    part.delete()
                }
                mirrorFileToSafIfConfigured(target, subFolder = "media", overwriteExisting = false)
                destFile = target
            }
        }

        registeredFiles[baseName] = destFile
        ensureMediaServerStarted()
        val sha = computeFileSha256(destFile)
        val bestIp = getPrimaryIp()
        val relPath = "media/$baseName"
        return JSONObject().apply {
            put("ok", true)
            put("deduplicated", deduplicated)
            put("fileName", relPath)
            put("baseName", baseName)
            put("relativePath", relPath)
            put("fileSize", destFile.length())
            if (sha.isNotEmpty()) put("fileHash", sha)
            put("localUrl", "http://127.0.0.1:$serverPort/media/$baseName")
            put("shareUrl", "http://$bestIp:$serverPort/media/$baseName")
        }
    }

    private fun sanitizeProjectId(rawId: String): String {
        val cleaned = rawId.trim().replace(Regex("[^a-zA-Z0-9_-]"), "").take(64)
        return cleaned.ifEmpty { "studio-demo" }
    }

    fun saveProjectJson(projectId: String, projectJson: String): JSONObject {
        val safeId = sanitizeProjectId(projectId)
        val projDir = projectsSubDir()
        val target = File(projDir, "$safeId.json")
        val tmp = File(projDir, ".$safeId-${System.nanoTime()}.tmp")
        tmp.writeText(projectJson, Charsets.UTF_8)
        if (!tmp.renameTo(target)) {
            tmp.copyTo(target, overwrite = true)
            tmp.delete()
        }
        mirrorFileToSafIfConfigured(target, subFolder = "projects", overwriteExisting = true)
        return JSONObject().apply {
            put("ok", true)
            put("projectId", safeId)
            put("relativePath", "projects/$safeId.json")
        }
    }

    fun listProjectsJson(): JSONArray {
        restoreAllProjectsFromSafIfConfigured()
        val projDir = projectsSubDir()
        val list = mutableListOf<Pair<Long, JSONObject>>()
        projDir.listFiles()?.forEach { file ->
            if (!file.isFile || !file.extension.equals("json", ignoreCase = true)) return@forEach
            if (file.name.startsWith(".")) return@forEach
            try {
                val obj = JSONObject(file.readText(Charsets.UTF_8))
                val updatedAt = obj.optLong("updatedAt", file.lastModified())
                list.add(updatedAt to obj)
            } catch (_: Throwable) {
            }
        }
        list.sortByDescending { it.first }
        return JSONArray().apply {
            list.forEach { put(it.second) }
        }
    }

    fun loadProjectJson(projectId: String): JSONObject? {
        val safeId = sanitizeProjectId(projectId)
        var file = File(projectsSubDir(), "$safeId.json")
        if (!file.exists()) {
            file = restoreFileFromSaf("$safeId.json", "projects") ?: file
        }
        if (!file.exists() || !file.isFile) return null
        return try {
            JSONObject(file.readText(Charsets.UTF_8))
        } catch (_: Throwable) {
            null
        }
    }

    fun deleteProjectJson(projectId: String): Boolean {
        val safeId = sanitizeProjectId(projectId)
        val file = File(projectsSubDir(), "$safeId.json")
        val deletedLocal = if (file.exists()) file.delete() else false
        val uriStr = safTreeUriString
        if (!uriStr.isNullOrBlank()) {
            try {
                val treeUri = Uri.parse(uriStr)
                getOrCreateSafSubdir(treeUri, "projects", createIfMissing = false)?.let { subUri ->
                    val pid = DocumentsContract.getDocumentId(subUri)
                    querySafChildren(treeUri, pid).firstOrNull { it.name == "$safeId.json" }?.let {
                        DocumentsContract.deleteDocument(context.contentResolver, it.uri)
                    }
                }
            } catch (_: Throwable) {
            }
        }
        return deletedLocal
    }

    private fun collectReferencedMediaNamesFromProjectJson(obj: JSONObject, outNames: MutableSet<String>) {
        fun addRef(raw: String?) {
            if (raw.isNullOrBlank()) return
            val trimmed = raw.trim().replace('\\', '/')
            if (trimmed.startsWith("synth:") || trimmed.startsWith("data:") || trimmed.startsWith("/src/") || trimmed.startsWith("/assets/")) {
                return
            }
            if (trimmed.startsWith("media/") || trimmed.contains("/media/") || trimmed.contains("/uploads/") || !trimmed.contains("/")) {
                val base = normalizeBaseMediaName(trimmed)
                if (base.isNotEmpty()) outNames.add(base)
            }
        }

        val clips = obj.optJSONArray("clips")
        if (clips != null) {
            for (i in 0 until clips.length()) {
                val c = clips.optJSONObject(i) ?: continue
                addRef(c.optString("src", ""))
                addRef(c.optString("mediaFileName", ""))
                addRef(c.optString("mediaRemoteUrl", ""))
                c.optJSONObject("textStyle")?.let { ts ->
                    addRef(ts.optString("fontSrc", ""))
                }
            }
        }

        val fonts = obj.optJSONArray("customFonts")
        if (fonts != null) {
            for (i in 0 until fonts.length()) {
                val f = fonts.optJSONObject(i) ?: continue
                addRef(f.optString("src", ""))
                addRef(f.optString("fileName", ""))
            }
        }
    }

    fun cleanupUnusedMedia(): JSONObject {
        restoreAllProjectsFromSafIfConfigured()
        val referenced = HashSet<String>()
        projectsSubDir().listFiles()?.forEach { f ->
            if (f.isFile && f.extension.equals("json", ignoreCase = true) && !f.name.startsWith(".")) {
                try {
                    collectReferencedMediaNamesFromProjectJson(JSONObject(f.readText(Charsets.UTF_8)), referenced)
                } catch (_: Throwable) {
                }
            }
        }
        // Also protect currently open host room clips if hosting
        collectReferencedMediaNamesFromProjectJson(hostRoomState, referenced)

        var deletedCount = 0
        var freedBytes = 0L
        var remainingCount = 0
        var remainingBytes = 0L

        for (file in listAllMediaFiles(mediaDir)) {
            if (referenced.contains(file.name)) {
                remainingCount++
                remainingBytes += file.length()
            } else {
                val len = file.length()
                if (file.delete()) {
                    registeredFiles.remove(file.name)
                    deletedCount++
                    freedBytes += len
                } else {
                    remainingCount++
                    remainingBytes += len
                }
            }
        }

        val uriStr = safTreeUriString
        if (!uriStr.isNullOrBlank()) {
            try {
                val treeUri = Uri.parse(uriStr)
                getOrCreateSafSubdir(treeUri, "media", createIfMissing = false)?.let { subUri ->
                    val pid = DocumentsContract.getDocumentId(subUri)
                    for (child in querySafChildren(treeUri, pid)) {
                        if (child.mimeType == DocumentsContract.Document.MIME_TYPE_DIR) continue
                        if (!referenced.contains(child.name)) {
                            try {
                                if (DocumentsContract.deleteDocument(context.contentResolver, child.uri)) {
                                    // Local count already accounts for local media files
                                    if (freedBytes == 0L && child.size > 0L) {
                                        freedBytes += child.size
                                    }
                                }
                            } catch (_: Throwable) {
                            }
                        }
                    }
                }
            } catch (_: Throwable) {
            }
        }

        return JSONObject().apply {
            put("ok", true)
            put("deletedCount", deletedCount)
            put("freedBytes", freedBytes)
            put("remainingCount", remainingCount)
            put("remainingBytes", remainingBytes)
        }
    }

    fun downloadMediaToCache(
        layerId: String,
        remoteUrl: String,
        fileName: String,
        fallbackUrl: String? = null,
        expectedSize: Long = -1L,
        expectedHash: String? = null,
        maxRetries: Int = 3
    ) {
        scope.launch {
            val safeName = normalizeBaseMediaName(fileName)
            val activeMediaDir = mediaSubDir()
            val existingCached = findMediaFileByBaseName(safeName, allowSafRestore = true)
            if (existingCached != null && existingCached.exists() &&
                expectedSize > 0L && existingCached.length() == expectedSize
            ) {
                val hashOk = expectedHash.isNullOrBlank() ||
                    computeFileSha256(existingCached).equals(expectedHash, ignoreCase = true)
                if (hashOk) {
                    registeredFiles[safeName] = existingCached
                    ensureMediaServerStarted()
                    val localUrl = "http://127.0.0.1:$serverPort/media/$safeName"
                    onDownloadProgress?.invoke(layerId, 100)
                    onDownloadComplete?.invoke(layerId, "media/$safeName", localUrl)
                    return@launch
                }
            }

            val tempFile = File(activeMediaDir, "$safeName.part")
            val candidates = listOfNotNull(
                remoteUrl.takeIf { it.isNotBlank() },
                fallbackUrl?.takeIf { it.isNotBlank() && it != remoteUrl }
            )
            val totalAttempts = maxRetries.coerceIn(1, 5)
            var lastError = "Download failed"

            for (attempt in 1..totalAttempts) {
                val attemptUrl = candidates.getOrElse((attempt - 1) % candidates.size.coerceAtLeast(1)) { remoteUrl }
                try {
                    if (tempFile.exists()) tempFile.delete()
                    var headerExpectedSize = -1L
                    var headerExpectedHash = ""
                    val digest = MessageDigest.getInstance("SHA-256")
                    var downloaded = 0L

                    httpClient.prepareGet(attemptUrl).execute { response ->
                        if (response.status.value !in 200..299) {
                            throw IllegalStateException("HTTP ${response.status.value}")
                        }
                        val xSize = response.headers["X-File-Size"]?.toLongOrNull() ?: -1L
                        val cLen = response.headers[HttpHeaders.ContentLength]?.toLongOrNull() ?: -1L
                        headerExpectedSize = if (xSize > 0) xSize else cLen
                        headerExpectedHash = response.headers["X-Content-Sha256"]?.trim()?.lowercase() ?: ""
                        val totalBytes = if (expectedSize > 0) expectedSize else headerExpectedSize

                        val channel = response.bodyAsChannel()
                        var lastPct = -1

                        FileOutputStream(tempFile).use { fos ->
                            while (!channel.isClosedForRead) {
                                val packet = channel.readRemaining(32 * 1024)
                                while (!packet.isEmpty) {
                                    val bytes = packet.readBytes()
                                    fos.write(bytes)
                                    digest.update(bytes)
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

                    val reqSize = if (expectedSize > 0) expectedSize else headerExpectedSize
                    if (reqSize > 0 && downloaded != reqSize) {
                        throw IllegalStateException("Размер файла не совпал ($downloaded != $reqSize)")
                    }
                    if (headerExpectedSize > 0 && downloaded != headerExpectedSize) {
                        throw IllegalStateException("Размер ответа HTTP не совпал ($downloaded != $headerExpectedSize)")
                    }
                    val reqHash = (expectedHash?.takeIf { it.isNotBlank() } ?: headerExpectedHash).lowercase()
                    val actualHash = digest.digest().joinToString("") { "%02x".format(it) }
                    if (reqHash.isNotEmpty() && actualHash != reqHash) {
                        throw IllegalStateException("Контрольная сумма SHA-256 не совпала")
                    }
                    if (headerExpectedHash.isNotEmpty() && actualHash != headerExpectedHash) {
                        throw IllegalStateException("Контрольная сумма сервера SHA-256 не совпала")
                    }

                    val (fastHash, size) = computeFastFileFingerprint(tempFile)
                    val dedupName = if (Regex("^[a-f0-9]{24}_\\d+\\.[a-z0-9]+$").matches(safeName)) {
                        safeName
                    } else {
                        buildDedupBaseName(fastHash, size, safeName)
                    }
                    val destTargetFile = File(mediaSubDir(), dedupName)
                    if (destTargetFile.exists() && destTargetFile.length() == size) {
                        tempFile.delete()
                    } else {
                        if (destTargetFile.exists()) destTargetFile.delete()
                        if (!tempFile.renameTo(destTargetFile)) {
                            tempFile.copyTo(destTargetFile, overwrite = true)
                            tempFile.delete()
                        }
                        mirrorFileToSafIfConfigured(destTargetFile, subFolder = "media", overwriteExisting = false)
                    }
                    registeredFiles[dedupName] = destTargetFile
                    fileHashCache["${destTargetFile.name}:${destTargetFile.length()}:${destTargetFile.lastModified()}"] = actualHash
                    ensureMediaServerStarted()

                    val localUrl = "http://127.0.0.1:$serverPort/media/$dedupName"
                    onDownloadComplete?.invoke(layerId, "media/$dedupName", localUrl)
                    return@launch
                } catch (err: Throwable) {
                    if (tempFile.exists()) tempFile.delete()
                    lastError = err.message ?: "Download failed"
                    if (attempt < totalAttempts) {
                        delay(350L * attempt)
                    }
                }
            }
            onDownloadError?.invoke(layerId, lastError)
        }
    }

    @OptIn(UnstableApi::class)
    fun compressVideo(
        layerId: String,
        sourceUrl: String,
        fileName: String,
        targetHeight: Int,
        targetBitrate: Int
    ) {
        scope.launch {
            try {
                var inputFile: File? = resolveCachedMediaFile(sourceUrl, fileName)
                if (inputFile == null && (sourceUrl.startsWith("http://") || sourceUrl.startsWith("https://"))) {
                    val safeSrc = ".cmp-src-${System.nanoTime()}.mp4"
                    val dlFile = File(mediaSubDir(), safeSrc)
                    httpClient.prepareGet(sourceUrl).execute { response ->
                        val channel = response.bodyAsChannel()
                        FileOutputStream(dlFile).use { fos ->
                            while (!channel.isClosedForRead) {
                                val packet = channel.readRemaining(32 * 1024)
                                while (!packet.isEmpty) {
                                    fos.write(packet.readBytes())
                                }
                            }
                        }
                    }
                    inputFile = dlFile
                }

                val inputUri = if (inputFile != null && inputFile.exists()) {
                    Uri.fromFile(inputFile)
                } else {
                    Uri.parse(sourceUrl)
                }
                val originalSizeBytes = inputFile?.length() ?: 0L

                val outTempFile = File(mediaSubDir(), ".cmp-out-${System.nanoTime()}.mp4")
                if (outTempFile.exists()) outTempFile.delete()

                mainHandler.post {
                    try {
                        activeTransformers.remove(layerId)?.cancel()

                        val mediaItem = MediaItem.fromUri(inputUri)
                        val videoEffects = if (targetHeight > 0) {
                            listOf(Presentation.createForHeight(targetHeight))
                        } else {
                            emptyList()
                        }
                        val effects = Effects(emptyList(), videoEffects)
                        val editedMediaItem = EditedMediaItem.Builder(mediaItem)
                            .setEffects(effects)
                            .build()

                        val encoderBuilder = DefaultEncoderFactory.Builder(context)
                            .setEnableFallback(true)
                        if (targetBitrate > 0) {
                            val encoderSettings = VideoEncoderSettings.Builder()
                                .setBitrate(targetBitrate)
                                .build()
                            encoderBuilder.setRequestedVideoEncoderSettings(encoderSettings)
                        }

                        var transformerRef: Transformer? = null
                        val transformer = Transformer.Builder(context)
                            .setEncoderFactory(encoderBuilder.build())
                            .setVideoMimeType(MimeTypes.VIDEO_H264)
                            .setAudioMimeType(MimeTypes.AUDIO_AAC)
                            .addListener(object : Transformer.Listener {
                                override fun onCompleted(
                                    composition: Composition,
                                    exportResult: ExportResult
                                ) {
                                    if (activeTransformers[layerId] === transformerRef) {
                                        activeTransformers.remove(layerId)
                                    }
                                    scope.launch {
                                        val (fastHash, size) = computeFastFileFingerprint(outTempFile)
                                        val dedupName = buildDedupBaseName(fastHash, size, "compressed.mp4")
                                        val finalFile = File(mediaSubDir(), dedupName)
                                        if (finalFile.exists() && finalFile.length() == size) {
                                            outTempFile.delete()
                                        } else {
                                            if (finalFile.exists()) finalFile.delete()
                                            if (!outTempFile.renameTo(finalFile)) {
                                                outTempFile.copyTo(finalFile, overwrite = true)
                                                outTempFile.delete()
                                            }
                                            mirrorFileToSafIfConfigured(finalFile, subFolder = "media", overwriteExisting = false)
                                        }
                                        registeredFiles[dedupName] = finalFile
                                        ensureMediaServerStarted()
                                        val bestIp = getPrimaryIp()
                                        val localUrl = "http://127.0.0.1:$serverPort/media/$dedupName"
                                        val shareUrl = "http://$bestIp:$serverPort/media/$dedupName"
                                        val compressedSize = finalFile.length()
                                        onCompressProgress?.invoke(layerId, 100)
                                        onCompressComplete?.invoke(
                                            layerId,
                                            "media/$dedupName",
                                            localUrl,
                                            shareUrl,
                                            originalSizeBytes,
                                            compressedSize
                                        )
                                    }
                                }

                                override fun onError(
                                    composition: Composition,
                                    exportResult: ExportResult,
                                    exportException: ExportException
                                ) {
                                    if (activeTransformers[layerId] === transformerRef) {
                                        activeTransformers.remove(layerId)
                                    }
                                    if (outTempFile.exists()) outTempFile.delete()
                                    onCompressError?.invoke(
                                        layerId,
                                        exportException.message ?: "Media3 Transformer error (${exportException.errorCode})"
                                    )
                                }
                            })
                            .build()

                        transformerRef = transformer
                        activeTransformers[layerId] = transformer
                        transformer.start(editedMediaItem, outTempFile.absolutePath)

                        val progressHolder = ProgressHolder()
                        val poller = object : Runnable {
                            override fun run() {
                                if (activeTransformers[layerId] !== transformer) return
                                val state = transformer.getProgress(progressHolder)
                                if (state == Transformer.PROGRESS_STATE_AVAILABLE) {
                                    onCompressProgress?.invoke(
                                        layerId,
                                        progressHolder.progress.coerceIn(0, 99)
                                    )
                                }
                                mainHandler.postDelayed(this, 250)
                            }
                        }
                        mainHandler.postDelayed(poller, 250)
                    } catch (err: Throwable) {
                        activeTransformers.remove(layerId)
                        onCompressError?.invoke(layerId, err.message ?: "Media3 start failed")
                    }
                }
            } catch (err: Throwable) {
                onCompressError?.invoke(layerId, err.message ?: "Compression setup failed")
            }
        }
    }

    @OptIn(UnstableApi::class)
    fun cancelCompressVideo(layerId: String) {
        mainHandler.post {
            activeTransformers.remove(layerId)?.cancel()
        }
    }

    /**
     * Extracts the audio track from a video file into an M4A/AAC file inside mediaDir/media
     * using MediaExtractor + MediaMuxer and returns deduplicated relative path, localUrl, and durationSec.
     */
    suspend fun extractAudioFromVideo(
        sourceUrl: String,
        fileName: String,
        trimStartMs: Long = 0L,
        durationMs: Long = -1L
    ): Triple<String, String, Double> = withContext(Dispatchers.IO) {
        var inputFile: File? = resolveCachedMediaFile(sourceUrl, fileName)
        var tempDownloadedSrc: File? = null
        if (inputFile == null && (sourceUrl.startsWith("http://") || sourceUrl.startsWith("https://"))) {
            val tmpSrc = File(mediaSubDir(), ".ext-src-${System.nanoTime()}.mp4")
            httpClient.prepareGet(sourceUrl).execute { response ->
                val channel = response.bodyAsChannel()
                FileOutputStream(tmpSrc).use { fos ->
                    while (!channel.isClosedForRead) {
                        val packet = channel.readRemaining(32 * 1024)
                        while (!packet.isEmpty) {
                            fos.write(packet.readBytes())
                        }
                    }
                }
            }
            inputFile = tmpSrc
            tempDownloadedSrc = tmpSrc
        }

        val extractor = MediaExtractor()
        val tempOutFile = File(mediaSubDir(), ".ext-out-${System.nanoTime()}.m4a")
        try {
            if (inputFile != null && inputFile.exists()) {
                extractor.setDataSource(inputFile.absolutePath)
            } else {
                extractor.setDataSource(context, Uri.parse(sourceUrl), null)
            }

            var audioTrackIdx = -1
            var audioFormat: MediaFormat? = null
            for (i in 0 until extractor.trackCount) {
                val fmt = extractor.getTrackFormat(i)
                val mime = fmt.getString(MediaFormat.KEY_MIME) ?: ""
                if (mime.startsWith("audio/")) {
                    audioTrackIdx = i
                    audioFormat = fmt
                    break
                }
            }
            if (audioTrackIdx < 0 || audioFormat == null) {
                throw IllegalStateException("В этом видео нет звуковой дорожки")
            }

            if (tempOutFile.exists()) tempOutFile.delete()

            extractor.selectTrack(audioTrackIdx)
            val startUs = (trimStartMs * 1000L).coerceAtLeast(0L)
            if (startUs > 0L) {
                extractor.seekTo(startUs, MediaExtractor.SEEK_TO_CLOSEST_SYNC)
            }
            val endUs = if (durationMs > 0L) startUs + durationMs * 1000L else Long.MAX_VALUE

            val muxer = MediaMuxer(tempOutFile.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
            val muxTrackIdx = muxer.addTrack(audioFormat)
            muxer.start()

            val buf = java.nio.ByteBuffer.allocate(256 * 1024)
            val info = android.media.MediaCodec.BufferInfo()
            try {
                while (true) {
                    val sampleSize = extractor.readSampleData(buf, 0)
                    if (sampleSize < 0) break
                    val sampleTime = extractor.sampleTime
                    if (sampleTime > endUs) break
                    if (sampleTime >= startUs) {
                        info.offset = 0
                        info.size = sampleSize
                        info.presentationTimeUs = (sampleTime - startUs).coerceAtLeast(0L)
                        info.flags = extractor.sampleFlags
                        muxer.writeSampleData(muxTrackIdx, buf, info)
                    }
                    extractor.advance()
                }
            } finally {
                try {
                    muxer.stop()
                    muxer.release()
                } catch (_: Throwable) {
                }
            }

            val retriever = MediaMetadataRetriever()
            var measuredDurSec = 0.0
            try {
                retriever.setDataSource(tempOutFile.absolutePath)
                val durStr = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
                measuredDurSec = (durStr?.toLongOrNull() ?: 0L) / 1000.0
            } catch (_: Throwable) {
            } finally {
                try {
                    retriever.release()
                } catch (_: Throwable) {
                }
            }

            val (fastHash, size) = computeFastFileFingerprint(tempOutFile)
            val dedupName = buildDedupBaseName(fastHash, size, "extracted.m4a")
            val finalFile = File(mediaSubDir(), dedupName)
            if (finalFile.exists() && finalFile.length() == size) {
                tempOutFile.delete()
            } else {
                if (finalFile.exists()) finalFile.delete()
                if (!tempOutFile.renameTo(finalFile)) {
                    tempOutFile.copyTo(finalFile, overwrite = true)
                    tempOutFile.delete()
                }
                mirrorFileToSafIfConfigured(finalFile, subFolder = "media", overwriteExisting = false)
            }

            registeredFiles[dedupName] = finalFile
            ensureMediaServerStarted()
            val localUrl = "http://127.0.0.1:$serverPort/media/$dedupName"
            Triple("media/$dedupName", localUrl, if (measuredDurSec > 0) measuredDurSec else 5.0)
        } finally {
            if (tempDownloadedSrc != null && tempDownloadedSrc.exists()) {
                tempDownloadedSrc.delete()
            }
            if (tempOutFile.exists()) {
                tempOutFile.delete()
            }
            try {
                extractor.release()
            } catch (_: Throwable) {
            }
        }
    }

    private fun mimeTypeForExportExt(ext: String): String {
        return when (ext.lowercase().trimStart('.')) {
            "mp4", "m4v" -> "video/mp4"
            "webm" -> "video/webm"
            "mov" -> "video/quicktime"
            "webp" -> "image/webp"
            "gif" -> "image/gif"
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            else -> "application/octet-stream"
        }
    }

    private fun buildExportFileName(rawName: String?, fallbackExt: String = "mp4"): String {
        val cleanExt = sanitizeExtension(rawName?.takeIf { it.contains('.') } ?: ".$fallbackExt")
            .let { if (it == "bin") sanitizeExtension(".$fallbackExt") else it }
            .let { if (it == "bin") "mp4" else it }
        if (!rawName.isNullOrBlank()) {
            val baseOnly = File(rawName.trim().replace('\\', '/').substringBefore('?')).name
            val sanitized = baseOnly.replace(Regex("[^a-zA-Z0-9._-]"), "_")
            if (sanitized.isNotBlank() && !sanitized.startsWith(".")) {
                return if (sanitized.contains('.')) sanitized else "$sanitized.$cleanExt"
            }
        }
        val stamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
        return "Webcut_$stamp.$cleanExt"
    }

    private fun resolveSafSubPathRealFile(
        treeUri: Uri,
        subFolder: String,
        fileName: String? = null
    ): File? {
        return try {
            val docId = DocumentsContract.getTreeDocumentId(treeUri)
            if (!docId.startsWith("primary:", ignoreCase = true)) return null
            val relRoot = docId.substringAfter(':').trim('/')
            val baseDir = if (relRoot.isEmpty()) {
                Environment.getExternalStorageDirectory()
            } else {
                File(Environment.getExternalStorageDirectory(), relRoot)
            }
            val subDir = File(baseDir, subFolder)
            if (fileName.isNullOrBlank()) subDir else File(subDir, fileName)
        } catch (_: Throwable) {
            null
        }
    }

    private fun scanExportedMedia(filePath: String?, mimeType: String) {
        if (filePath.isNullOrBlank()) return
        try {
            MediaScannerConnection.scanFile(
                context,
                arrayOf(filePath),
                arrayOf(mimeType),
                null
            )
        } catch (_: Throwable) {
        }
    }

    fun prepareExportDir(ext: String = "mp4", rawName: String? = null): JSONObject {
        val localExportDir = exportSubDir()
        val uriStr = safTreeUriString
        val isSaf = !uriStr.isNullOrBlank()
        var displayExportDir = localExportDir.absolutePath
        if (isSaf) {
            try {
                val treeUri = Uri.parse(uriStr)
                getOrCreateSafSubdir(treeUri, "export", createIfMissing = true)
                displayExportDir = resolveSafSubPathRealFile(treeUri, "export")?.absolutePath
                    ?: "${safDisplayName ?: "Выбранная папка"}/export"
            } catch (_: Throwable) {
                displayExportDir = "${safDisplayName ?: "Выбранная папка"}/export"
            }
        }
        val fileName = buildExportFileName(rawName, ext)
        ensureMediaServerStarted()
        val mode = when {
            isSaf -> "saf"
            mediaDir.absolutePath == defaultMediaDir.absolutePath -> "internal"
            else -> "custom"
        }
        return JSONObject().apply {
            put("ok", true)
            put("exportDir", displayExportDir)
            put("relativePath", "export/$fileName")
            put("fileName", fileName)
            put("localUploadUrl", "http://127.0.0.1:$serverPort/export/upload")
            put("mode", mode)
        }
    }

    private suspend fun saveExportChannelToExportDir(
        channel: ByteReadChannel,
        rawName: String?,
        fallbackExt: String = "mp4",
        explicitMimeType: String? = null
    ): JSONObject {
        val safeName = buildExportFileName(rawName, fallbackExt)
        val mime = explicitMimeType?.takeIf { it.isNotBlank() }
            ?: mimeTypeForExportExt(sanitizeExtension(safeName))
        val uriStr = safTreeUriString

        if (!uriStr.isNullOrBlank()) {
            try {
                val treeUri = Uri.parse(uriStr)
                val exportDirUri = getOrCreateSafSubdir(treeUri, "export", createIfMissing = true)
                if (exportDirUri != null) {
                    val parentDocId = DocumentsContract.getDocumentId(exportDirUri)
                    querySafChildren(treeUri, parentDocId)
                        .firstOrNull { it.name == safeName }
                        ?.let { existing ->
                            try {
                                DocumentsContract.deleteDocument(context.contentResolver, existing.uri)
                            } catch (_: Throwable) {
                            }
                        }
                    val createdUri = DocumentsContract.createDocument(
                        context.contentResolver,
                        exportDirUri,
                        mime,
                        safeName
                    )
                    if (createdUri != null) {
                        var bytesWritten = 0L
                        context.contentResolver.openOutputStream(createdUri, "wt")?.use { out ->
                            bytesWritten = channel.copyTo(out)
                        } ?: throw IllegalStateException("Не удалось открыть поток записи SAF")

                        val realFile = resolveSafSubPathRealFile(treeUri, "export", safeName)
                        if (realFile != null && realFile.exists()) {
                            scanExportedMedia(realFile.absolutePath, mime)
                        }
                        val savedPath = realFile?.absolutePath
                            ?: "${safDisplayName ?: "Выбранная папка"}/export/$safeName"
                        return JSONObject().apply {
                            put("ok", true)
                            put("fileName", safeName)
                            put("relativePath", "export/$safeName")
                            put("savedPath", savedPath)
                            put("contentUri", createdUri.toString())
                            put("mimeType", mime)
                            put("fileSize", bytesWritten)
                            put("localUrl", "http://127.0.0.1:$serverPort/export/$safeName")
                        }
                    }
                }
            } catch (_: Throwable) {
                // Fall back to local exportSubDir() only if SAF creation failed before consuming channel
            }
        }

        val dir = exportSubDir()
        val partFile = File(dir, ".$safeName.${System.nanoTime()}.part")
        val destFile = File(dir, safeName)
        try {
            FileOutputStream(partFile).use { fos ->
                channel.copyTo(fos)
            }
            if (destFile.exists()) destFile.delete()
            if (!partFile.renameTo(destFile)) {
                partFile.copyTo(destFile, overwrite = true)
                partFile.delete()
            }
        } catch (err: Throwable) {
            if (partFile.exists()) partFile.delete()
            throw err
        }

        scanExportedMedia(destFile.absolutePath, mime)
        return JSONObject().apply {
            put("ok", true)
            put("fileName", safeName)
            put("relativePath", "export/$safeName")
            put("savedPath", destFile.absolutePath)
            put("contentUri", "")
            put("mimeType", mime)
            put("fileSize", destFile.length())
            put("localUrl", "http://127.0.0.1:$serverPort/export/$safeName")
        }
    }

    fun saveExportBytesToExportDir(
        bytes: ByteArray,
        rawName: String?,
        fallbackExt: String = "mp4",
        explicitMimeType: String? = null
    ): JSONObject {
        val safeName = buildExportFileName(rawName, fallbackExt)
        val mime = explicitMimeType?.takeIf { it.isNotBlank() }
            ?: mimeTypeForExportExt(sanitizeExtension(safeName))
        val uriStr = safTreeUriString

        if (!uriStr.isNullOrBlank()) {
            try {
                val treeUri = Uri.parse(uriStr)
                val exportDirUri = getOrCreateSafSubdir(treeUri, "export", createIfMissing = true)
                if (exportDirUri != null) {
                    val parentDocId = DocumentsContract.getDocumentId(exportDirUri)
                    querySafChildren(treeUri, parentDocId)
                        .firstOrNull { it.name == safeName }
                        ?.let { existing ->
                            try {
                                DocumentsContract.deleteDocument(context.contentResolver, existing.uri)
                            } catch (_: Throwable) {
                            }
                        }
                    val createdUri = DocumentsContract.createDocument(
                        context.contentResolver,
                        exportDirUri,
                        mime,
                        safeName
                    )
                    if (createdUri != null) {
                        context.contentResolver.openOutputStream(createdUri, "wt")?.use { out ->
                            out.write(bytes)
                        } ?: throw IllegalStateException("Не удалось открыть поток записи SAF")

                        val realFile = resolveSafSubPathRealFile(treeUri, "export", safeName)
                        if (realFile != null && realFile.exists()) {
                            scanExportedMedia(realFile.absolutePath, mime)
                        }
                        val savedPath = realFile?.absolutePath
                            ?: "${safDisplayName ?: "Выбранная папка"}/export/$safeName"
                        return JSONObject().apply {
                            put("ok", true)
                            put("fileName", safeName)
                            put("relativePath", "export/$safeName")
                            put("savedPath", savedPath)
                            put("contentUri", createdUri.toString())
                            put("mimeType", mime)
                            put("fileSize", bytes.size.toLong())
                            put("localUrl", "http://127.0.0.1:$serverPort/export/$safeName")
                        }
                    }
                }
            } catch (_: Throwable) {
            }
        }

        val dir = exportSubDir()
        val partFile = File(dir, ".$safeName.${System.nanoTime()}.part")
        val destFile = File(dir, safeName)
        FileOutputStream(partFile).use { fos ->
            fos.write(bytes)
        }
        if (destFile.exists()) destFile.delete()
        if (!partFile.renameTo(destFile)) {
            partFile.copyTo(destFile, overwrite = true)
            partFile.delete()
        }
        scanExportedMedia(destFile.absolutePath, mime)
        return JSONObject().apply {
            put("ok", true)
            put("fileName", safeName)
            put("relativePath", "export/$safeName")
            put("savedPath", destFile.absolutePath)
            put("contentUri", "")
            put("mimeType", mime)
            put("fileSize", destFile.length())
            put("localUrl", "http://127.0.0.1:$serverPort/export/$safeName")
        }
    }

    fun getSafExportDirUri(): Uri? {
        val uriStr = safTreeUriString ?: return null
        return try {
            getOrCreateSafSubdir(Uri.parse(uriStr), "export", createIfMissing = true)
        } catch (_: Throwable) {
            null
        }
    }

    fun getLocalExportDir(): File = exportSubDir()

    fun stopHostServer() {
        isHostingRoom = false
        beaconJob?.cancel()
        beaconJob = null
        if (udpListenerJob == null) releaseMulticastLock()
    }

    fun stopServer() {
        stopHostServer()
        lockExpiryJob?.cancel()
        lockExpiryJob = null
        mainHandler.post {
            for (t in activeTransformers.values) {
                try {
                    t.cancel()
                } catch (_: Throwable) {
                }
            }
            activeTransformers.clear()
        }
        try {
            server?.stop(200, 500)
        } catch (_: Throwable) {
        }
        server = null
        serverState = "stopped"
    }
}
