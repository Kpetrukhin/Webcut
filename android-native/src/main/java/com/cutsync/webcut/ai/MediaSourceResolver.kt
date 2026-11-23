package com.cutsync.webcut.ai

import android.content.Context
import android.media.MediaExtractor
import android.net.Uri
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.request.prepareGet
import io.ktor.client.statement.bodyAsChannel
import io.ktor.http.isSuccess
import io.ktor.utils.io.core.isEmpty
import io.ktor.utils.io.core.readBytes
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import java.io.File
import java.io.FileOutputStream
import java.net.URLDecoder

/**
 * Shared local-cache / URI / HTTP media source resolver for Whisper & VitTrack extractors.
 */
internal object MediaSourceResolver {
    private val httpClient by lazy {
        HttpClient(CIO) {
            engine {
                requestTimeout = 120_000L
            }
        }
    }

    /**
     * Configures [extractor] data source from cached media directories, content/file URIs,
     * local paths, or HTTP(S) URLs (downloading to a temporary cache file if needed).
     * Returns the temporary downloaded [File] so callers can delete it in `finally`, or null.
     */
    suspend fun prepareExtractorDataSource(
        context: Context,
        extractor: MediaExtractor,
        sourceUrl: String,
        fileName: String? = null,
        tempPrefix: String = "webcut-src"
    ): File? {
        val localFile = resolveLocalCachedFile(context, sourceUrl, fileName)
        when {
            localFile != null && localFile.exists() -> {
                extractor.setDataSource(localFile.absolutePath)
                return null
            }
            sourceUrl.startsWith("content://", ignoreCase = true) -> {
                extractor.setDataSource(context, Uri.parse(sourceUrl), null)
                return null
            }
            sourceUrl.startsWith("file://", ignoreCase = true) -> {
                val path = Uri.parse(sourceUrl).path
                    ?: throw IllegalArgumentException("Некорректный file:// путь: $sourceUrl")
                extractor.setDataSource(path)
                return null
            }
            sourceUrl.startsWith("/") -> {
                extractor.setDataSource(sourceUrl)
                return null
            }
            sourceUrl.startsWith("http://", ignoreCase = true) ||
                sourceUrl.startsWith("https://", ignoreCase = true) -> {
                val safeExt = fileName
                    ?.substringAfterLast('.', "")
                    ?.takeIf { it.isNotBlank() && it.length <= 6 }
                    ?: "mp4"
                val dlFile = File(
                    context.cacheDir,
                    "$tempPrefix-${System.currentTimeMillis()}.$safeExt"
                )
                downloadToTempFile(sourceUrl, dlFile)
                extractor.setDataSource(dlFile.absolutePath)
                return dlFile
            }
            else -> {
                throw IllegalArgumentException(
                    "Не удалось открыть медиафайл: $sourceUrl"
                )
            }
        }
    }

    /**
     * Resolves a local file path/Uri or downloads HTTP(S) media to a temporary file for APIs
     * such as MediaMetadataRetriever that benefit from direct file access.
     * Pair is `(localFileOrNull, tempDownloadedFileOrNull)`.
     */
    suspend fun resolveFileOrUri(
        context: Context,
        sourceUrl: String,
        fileName: String? = null,
        tempPrefix: String = "webcut-src"
    ): Pair<String?, File?> {
        val localFile = resolveLocalCachedFile(context, sourceUrl, fileName)
        if (localFile != null && localFile.exists()) {
            return localFile.absolutePath to null
        }
        if (sourceUrl.startsWith("content://", ignoreCase = true) ||
            sourceUrl.startsWith("file://", ignoreCase = true) ||
            sourceUrl.startsWith("/")
        ) {
            return sourceUrl to null
        }
        if (sourceUrl.startsWith("http://", ignoreCase = true) ||
            sourceUrl.startsWith("https://", ignoreCase = true)
        ) {
            val safeExt = fileName
                ?.substringAfterLast('.', "")
                ?.takeIf { it.isNotBlank() && it.length <= 6 }
                ?: "mp4"
            val dlFile = File(
                context.cacheDir,
                "$tempPrefix-${System.currentTimeMillis()}.$safeExt"
            )
            downloadToTempFile(sourceUrl, dlFile)
            return dlFile.absolutePath to dlFile
        }
        throw IllegalArgumentException("Не удалось открыть медиафайл: $sourceUrl")
    }

    fun resolveLocalCachedFile(
        context: Context,
        sourceUrl: String,
        fileName: String?
    ): File? {
        val prefs = context.getSharedPreferences("cutsync_storage", Context.MODE_PRIVATE)
        val customDirPath = prefs.getString("custom_media_dir", null)?.trim()
        val candidateDirs = buildList {
            if (!customDirPath.isNullOrEmpty()) {
                add(File(customDirPath, "media"))
                add(File(customDirPath))
            }
            val filesMedia = File(context.filesDir, "cutsync_media")
            add(File(filesMedia, "media"))
            add(filesMedia)
            val cacheMedia = File(context.cacheDir, "cutsync_media")
            add(File(cacheMedia, "media"))
            add(cacheMedia)
        }

        val candidateNames = LinkedHashSet<String>()
        if (!fileName.isNullOrBlank()) {
            val base = File(fileName.removePrefix("media/")).name
            candidateNames += base
            candidateNames += base.replace(Regex("[^a-zA-Z0-9._-]"), "_")
        }
        if (sourceUrl.contains("/media/")) {
            val rawPart = sourceUrl.substringAfterLast("/media/").substringBefore("?")
            val decoded = try {
                URLDecoder.decode(rawPart, "UTF-8")
            } catch (_: Throwable) {
                rawPart
            }
            val base = File(decoded.removePrefix("media/")).name
            candidateNames += base
            candidateNames += base.replace(Regex("[^a-zA-Z0-9._-]"), "_")
        } else if (sourceUrl.startsWith("media/")) {
            val base = File(sourceUrl.removePrefix("media/").substringBefore("?")).name
            candidateNames += base
            candidateNames += base.replace(Regex("[^a-zA-Z0-9._-]"), "_")
        }

        for (dir in candidateDirs) {
            if (!dir.exists() || !dir.isDirectory) continue
            for (name in candidateNames) {
                val f = File(dir, name)
                if (f.exists() && f.isFile && f.length() > 0L) {
                    return f
                }
            }
        }
        return null
    }

    suspend fun downloadToTempFile(url: String, destFile: File) {
        httpClient.prepareGet(url).execute { response ->
            if (!response.status.isSuccess()) {
                throw IllegalStateException("HTTP ${response.status.value} при загрузке медиа: $url")
            }
            val channel = response.bodyAsChannel()
            FileOutputStream(destFile).use { fos ->
                while (!channel.isClosedForRead) {
                    currentCoroutineContext().ensureActive()
                    val packet = channel.readRemaining(64 * 1024L)
                    if (packet.isEmpty) break
                    fos.write(packet.readBytes())
                }
                fos.flush()
            }
        }
    }
}
