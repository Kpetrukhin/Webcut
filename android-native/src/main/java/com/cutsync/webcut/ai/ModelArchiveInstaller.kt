package com.cutsync.webcut.ai

import android.content.Context
import android.net.Uri
import android.util.Log
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.request.prepareGet
import io.ktor.client.statement.bodyAsChannel
import io.ktor.http.contentLength
import io.ktor.http.isSuccess
import io.ktor.utils.io.core.isEmpty
import io.ktor.utils.io.core.readBytes
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.zip.ZipInputStream

data class ZipImportResult(
    val importedFiles: List<String>,
    val matchedModelIds: List<String>,
    val skippedFiles: List<String>,
    val totalBytes: Long
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("ok", true)
        put("canceled", false)
        put("importedCount", importedFiles.size)
        put("importedFiles", JSONArray(importedFiles))
        put("matchedModelIds", JSONArray(matchedModelIds))
        put("skippedFiles", JSONArray(skippedFiles))
        put("totalBytes", totalBytes)
    }
}

/**
 * Handles downloading individual ONNX/TFLite models from GitHub Releases
 * and securely unpacking .zip AI model packs (with Zip Slip & size guards).
 */
class ModelArchiveInstaller(
    private val context: Context,
    private val modelsDir: File
) {
    companion object {
        private const val TAG = "WebcutAIInstaller"
        private const val MAX_ZIP_ENTRIES = 128
        private const val MAX_UNCOMPRESSED_BYTES = 2L * 1024L * 1024L * 1024L // 2 GB safety cap
        private val ALLOWED_EXTENSIONS = setOf("onnx", "tflite", "json", "txt", "vocab")
    }

    private val httpClient = HttpClient(CIO) {
        engine {
            requestTimeout = 0L // large model files may take several minutes
        }
    }

    suspend fun downloadModelFile(
        spec: AIModelSpec,
        overrideUrl: String? = null,
        overrideSize: Long? = null,
        overrideHash: String? = null,
        onProgress: (Int) -> Unit
    ): File {
        modelsDir.mkdirs()
        val url = overrideUrl?.takeIf { it.isNotBlank() } ?: spec.downloadUrl
        if (!url.startsWith("https://", ignoreCase = true) &&
            !url.startsWith("http://", ignoreCase = true)
        ) {
            throw IllegalArgumentException("Некорректный URL модели: $url")
        }

        val expectedSize = overrideSize?.takeIf { it > 0L } ?: spec.expectedSizeBytes
        val expectedHash = (overrideHash?.takeIf { it.isNotBlank() } ?: spec.sha256)
            .trim()
            .lowercase()

        val destFile = File(modelsDir, spec.fileName)
        val tempFile = File(modelsDir, "${spec.fileName}.part")
        if (tempFile.exists()) tempFile.delete()

        var downloadedBytes = 0L
        val digest = MessageDigest.getInstance("SHA-256")

        try {
            onProgress(0)
            httpClient.prepareGet(url).execute { response ->
                if (!response.status.isSuccess()) {
                    throw IllegalStateException("HTTP ${response.status.value} при скачивании ${spec.fileName}")
                }
                val contentLength = response.contentLength() ?: -1L
                val totalTarget = if (expectedSize > 0L) expectedSize else contentLength
                val channel = response.bodyAsChannel()
                var lastReportedPct = -1

                FileOutputStream(tempFile).use { fos ->
                    while (!channel.isClosedForRead) {
                        currentCoroutineContext().ensureActive()
                        val packet = channel.readRemaining(64 * 1024L)
                        if (packet.isEmpty) break
                        val bytes = packet.readBytes()
                        fos.write(bytes)
                        digest.update(bytes)
                        downloadedBytes += bytes.size

                        if (totalTarget > 0L) {
                            val pct = ((downloadedBytes * 99L) / totalTarget).toInt().coerceIn(0, 99)
                            if (pct != lastReportedPct) {
                                lastReportedPct = pct
                                onProgress(pct)
                            }
                        }
                    }
                    fos.flush()
                }
            }

            if (downloadedBytes <= 0L) {
                throw IllegalStateException("Скачан пустой файл модели")
            }

            if (expectedSize > 0L && downloadedBytes != expectedSize) {
                throw IllegalStateException(
                    "Размер файла не совпал: получено $downloadedBytes Б, ожидалось $expectedSize Б"
                )
            }

            if (expectedHash.isNotEmpty()) {
                val actualHash = digest.digest().joinToString("") { "%02x".format(it) }
                if (actualHash != expectedHash) {
                    throw SecurityException(
                        "Контрольная сумма SHA-256 не совпала для ${spec.fileName}"
                    )
                }
            }

            validateModelBinary(tempFile, spec.format)

            if (destFile.exists()) {
                destFile.delete()
            }
            if (!tempFile.renameTo(destFile)) {
                tempFile.copyTo(destFile, overwrite = true)
                tempFile.delete()
            }

            onProgress(100)
            Log.i(TAG, "Downloaded & verified ${spec.fileName} ($downloadedBytes bytes)")
            return destFile
        } catch (err: Throwable) {
            if (tempFile.exists()) tempFile.delete()
            if (err is CancellationException) throw err
            throw err
        }
    }

    /**
     * Imports a user-selected .zip AI pack using Android SAF Uri.
     * Enforces strict Zip Slip canonical path validation and validates extracted .onnx/.tflite headers.
     */
    fun importModelsFromZipUri(zipUri: Uri): ZipImportResult {
        modelsDir.mkdirs()
        val canonicalModelsRoot = modelsDir.canonicalPath + File.separator

        val importedFiles = mutableListOf<String>()
        val matchedModelIds = mutableSetOf<String>()
        val skippedFiles = mutableListOf<String>()
        var totalExtractedBytes = 0L
        var entryCount = 0

        val inputStream = context.contentResolver.openInputStream(zipUri)
            ?: throw IllegalStateException("Не удалось открыть выбранный ZIP-архив")

        inputStream.use { rawIn ->
            ZipInputStream(BufferedInputStream(rawIn)).use { zis ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val entry = zis.nextEntry ?: break
                    entryCount++
                    if (entryCount > MAX_ZIP_ENTRIES) {
                        throw SecurityException("Архив содержит слишком много файлов (> $MAX_ZIP_ENTRIES)")
                    }
                    if (entry.isDirectory) {
                        zis.closeEntry()
                        continue
                    }

                    val rawEntryName = entry.name.replace('\\', '/')
                    if (rawEntryName.contains("..") || rawEntryName.startsWith("/")) {
                        throw SecurityException("Обнаружен небезопасный путь в архиве (Zip Slip): $rawEntryName")
                    }

                    // Flatten nested folder inside zip safely by using only base filename,
                    // while still verifying Zip Slip against modelsDir canonical path.
                    val baseName = File(rawEntryName).name.trim()
                    if (baseName.isEmpty() || baseName.startsWith(".")) {
                        skippedFiles += rawEntryName
                        zis.closeEntry()
                        continue
                    }

                    val ext = baseName.substringAfterLast('.', "").lowercase()
                    if (ext !in ALLOWED_EXTENSIONS) {
                        skippedFiles += baseName
                        zis.closeEntry()
                        continue
                    }

                    val targetFile = File(modelsDir, baseName)
                    val canonicalTarget = targetFile.canonicalPath
                    if (!canonicalTarget.startsWith(canonicalModelsRoot)) {
                        throw SecurityException("Заблокирована попытка Zip Slip: $rawEntryName")
                    }

                    val tempFile = File(modelsDir, "$baseName.unpack")
                    if (tempFile.exists()) tempFile.delete()

                    var fileBytes = 0L
                    try {
                        FileOutputStream(tempFile).use { fos ->
                            while (true) {
                                val read = zis.read(buffer)
                                if (read <= 0) break
                                fileBytes += read
                                totalExtractedBytes += read
                                if (totalExtractedBytes > MAX_UNCOMPRESSED_BYTES) {
                                    throw SecurityException("Превышен допустимый размер распаковки архива")
                                }
                                fos.write(buffer, 0, read)
                            }
                            fos.flush()
                        }

                        if (ext == "onnx" || ext == "tflite") {
                            validateModelBinary(tempFile, ext)
                        }

                        val matchedSpec = AIModelRegistry.findByFileName(baseName)
                        if (matchedSpec != null) {
                            if (matchedSpec.sha256.isNotBlank()) {
                                val actualHash = computeSha256(tempFile)
                                if (!actualHash.equals(matchedSpec.sha256, ignoreCase = true)) {
                                    throw SecurityException("SHA-256 не совпал для ${matchedSpec.fileName}")
                                }
                            }
                            matchedModelIds += matchedSpec.id
                        }

                        if (targetFile.exists()) targetFile.delete()
                        if (!tempFile.renameTo(targetFile)) {
                            tempFile.copyTo(targetFile, overwrite = true)
                            tempFile.delete()
                        }
                        importedFiles += baseName
                    } catch (err: Throwable) {
                        if (tempFile.exists()) tempFile.delete()
                        throw err
                    } finally {
                        zis.closeEntry()
                    }
                }
            }
        }

        val hasNeuralWeights = importedFiles.any {
            it.endsWith(".onnx", ignoreCase = true) || it.endsWith(".tflite", ignoreCase = true)
        }
        if (!hasNeuralWeights) {
            throw IllegalStateException("В выбранном .zip не найдено валидных файлов .onnx или .tflite")
        }

        Log.i(
            TAG,
            "Imported ZIP pack: ${importedFiles.size} files, matched=${matchedModelIds.joinToString()}"
        )
        return ZipImportResult(
            importedFiles = importedFiles,
            matchedModelIds = matchedModelIds.toList(),
            skippedFiles = skippedFiles,
            totalBytes = totalExtractedBytes
        )
    }

    fun validateModelBinary(file: File, format: String) {
        if (!file.exists() || !file.isFile || file.length() < 16L) {
            throw IllegalStateException("Файл модели повреждён или слишком мал: ${file.name}")
        }
        val header = ByteArray(16)
        FileInputStream(file).use { fis ->
            val read = fis.read(header)
            if (read < 8) {
                throw IllegalStateException("Не удалось прочитать заголовок модели: ${file.name}")
            }
        }
        if (format.equals("tflite", ignoreCase = true)) {
            // FlatBuffer TFLite identifier at bytes 4..7 is "TFL3"
            val magic = String(header, 4, 4, Charsets.US_ASCII)
            if (magic != "TFL3") {
                throw IllegalStateException("Файл ${file.name} не является корректной моделью TFLite (нет сигнатуры TFL3)")
            }
        }
    }

    fun computeSha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val buf = ByteArray(64 * 1024)
        FileInputStream(file).use { fis ->
            while (true) {
                val read = fis.read(buf)
                if (read <= 0) break
                digest.update(buf, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    fun close() {
        try {
            httpClient.close()
        } catch (_: Throwable) {
        }
    }
}
