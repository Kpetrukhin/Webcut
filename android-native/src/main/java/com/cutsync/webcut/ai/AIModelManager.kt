package com.cutsync.webcut.ai

import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
import android.net.Uri
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/**
 * Thread-safe Singleton AI Model Manager.
 *
 * Architectural guarantees:
 * 1. Lazy Loading: Zero models or OrtEnvironment loaded on app startup.
 * 2. Single Active Session in RAM: Preparing a new model forcefully closes() any previous OrtSession
 *    to prevent OutOfMemory (OOM) during mobile video rendering.
 * 3. Hardware Cascade Fallback: NPU/DSP -> GPU -> CPU (XNNPACK).
 */
class AIModelManager private constructor(private val appContext: Context) {

    companion object {
        private const val TAG = "WebcutAIManager"
        private const val MODELS_FOLDER = "ai_models"

        @Volatile
        private var instance: AIModelManager? = null

        fun getInstance(context: Context): AIModelManager {
            return instance ?: synchronized(this) {
                instance ?: AIModelManager(context.applicationContext).also { instance = it }
            }
        }
    }

    val modelsDir: File = File(appContext.filesDir, MODELS_FOLDER).apply { mkdirs() }
    private val installer = ModelArchiveInstaller(appContext, modelsDir)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val sessionMutex = Mutex()

    @Volatile
    private var ortEnv: OrtEnvironment? = null

    @Volatile
    private var activeModelId: String? = null

    @Volatile
    private var activeSession: OrtSession? = null

    @Volatile
    private var activeOptions: OrtSession.SessionOptions? = null

    @Volatile
    private var activeAccelerator: HardwareAccelerator = HardwareAccelerator.NONE

    @Volatile
    private var activeAcceleratorDetail: String = ""

    @Volatile
    private var activeCascadeLog: List<String> = emptyList()

    private val downloadJobs = ConcurrentHashMap<String, Job>()
    private val downloadProgress = ConcurrentHashMap<String, Int>()
    private val modelErrors = ConcurrentHashMap<String, String>()

    var onDownloadProgress: ((modelId: String, progress: Int) -> Unit)? = null
    var onDownloadComplete: ((modelId: String, fileName: String, sizeBytes: Long) -> Unit)? = null
    var onDownloadError: ((modelId: String, message: String) -> Unit)? = null

    private fun getModelFile(spec: AIModelSpec): File = File(modelsDir, spec.fileName)

    fun isModelInstalled(spec: AIModelSpec): Boolean {
        val f = getModelFile(spec)
        return f.exists() && f.isFile && f.length() > 16L
    }

    fun getAvailableModelsStatusJson(): JSONObject {
        modelsDir.mkdirs()
        val arr = JSONArray()
        var totalStorageBytes = 0L

        for (spec in AIModelRegistry.getAll()) {
            val file = getModelFile(spec)
            val installed = file.exists() && file.isFile && file.length() > 16L
            val fileBytes = if (installed) file.length() else 0L
            totalStorageBytes += fileBytes

            val isDownloading = downloadJobs[spec.id]?.isActive == true
            val err = modelErrors[spec.id]
            val status = when {
                isDownloading -> ModelInstallStatus.DOWNLOADING
                installed -> ModelInstallStatus.READY
                !err.isNullOrBlank() -> ModelInstallStatus.ERROR
                else -> ModelInstallStatus.NOT_INSTALLED
            }
            val pct = when (status) {
                ModelInstallStatus.DOWNLOADING -> downloadProgress[spec.id] ?: 0
                ModelInstallStatus.READY -> 100
                else -> 0
            }
            val isActive = activeModelId == spec.id && activeSession != null

            arr.put(
                spec.toJson(
                    status = status,
                    progress = pct,
                    installedBytes = fileBytes,
                    isActiveInRam = isActive,
                    activeAccelerator = activeAccelerator,
                    lastError = err
                )
            )
        }

        val caps = HardwareCascadeSelector.probeDeviceCapabilities(appContext)
        return JSONObject().apply {
            put("environment", "android")
            put("modelsDir", modelsDir.absolutePath)
            put("totalStorageBytes", totalStorageBytes)
            put("activeModelId", activeModelId ?: JSONObject.NULL)
            put("activeAccelerator", activeAccelerator.code)
            put("activeAcceleratorDetail", activeAcceleratorDetail)
            put("deviceSoc", caps.socModel)
            put("supportsNpu", caps.hasDedicatedNpu || caps.availableProviders.any { it.name.equals("QNN", true) })
            put("supportsGpu", caps.hasVulkanGpu)
            put("cascadeLog", JSONArray(activeCascadeLog))
            put("models", arr)
        }
    }

    fun startModelDownload(
        modelId: String,
        overrideUrl: String? = null,
        overrideSize: Long? = null,
        overrideHash: String? = null
    ) {
        val spec = AIModelRegistry.getById(modelId)
            ?: throw IllegalArgumentException("Неизвестная модель: $modelId")

        if (downloadJobs[modelId]?.isActive == true) {
            return
        }

        modelErrors.remove(modelId)
        downloadProgress[modelId] = 0

        val job = scope.launch {
            try {
                val file = installer.downloadModelFile(
                    spec = spec,
                    overrideUrl = overrideUrl,
                    overrideSize = overrideSize,
                    overrideHash = overrideHash
                ) { pct ->
                    downloadProgress[modelId] = pct
                    onDownloadProgress?.invoke(modelId, pct)
                }
                downloadProgress[modelId] = 100
                onDownloadComplete?.invoke(modelId, file.name, file.length())
            } catch (err: Throwable) {
                val msg = err.message ?: "Ошибка скачивания модели"
                modelErrors[modelId] = msg
                downloadProgress.remove(modelId)
                onDownloadError?.invoke(modelId, msg)
            } finally {
                downloadJobs.remove(modelId)
            }
        }
        downloadJobs[modelId] = job
    }

    fun cancelDownload(modelId: String) {
        downloadJobs[modelId]?.cancel()
        downloadJobs.remove(modelId)
        downloadProgress.remove(modelId)
        val spec = AIModelRegistry.getById(modelId) ?: return
        val part = File(modelsDir, "${spec.fileName}.part")
        if (part.exists()) part.delete()
    }

    fun importModelsFromZipUri(zipUri: Uri): ZipImportResult {
        val res = installer.importModelsFromZipUri(zipUri)
        for (id in res.matchedModelIds) {
            modelErrors.remove(id)
        }
        return res
    }

    /**
     * Unloads any currently active OrtSession from RAM and lazily loads [modelId]
     * using Hardware Cascade Fallback (NPU -> GPU -> CPU).
     */
    suspend fun prepareModel(modelId: String): JSONObject {
        val spec = AIModelRegistry.getById(modelId)
            ?: throw IllegalArgumentException("Модель $modelId не найдена в реестре")

        val modelFile = getModelFile(spec)
        if (!modelFile.exists() || !modelFile.isFile || modelFile.length() <= 16L) {
            throw IllegalStateException(
                "Файл модели ${spec.fileName} не установлен. Скачайте модель или импортируйте .zip-пак."
            )
        }

        return sessionMutex.withLock {
            // Fast path: already loaded in RAM
            if (activeModelId == modelId && activeSession != null) {
                val session = activeSession!!
                return@withLock JSONObject().apply {
                    put("ok", true)
                    put("modelId", modelId)
                    put("ready", true)
                    put("reusedFromRam", true)
                    put("accelerator", activeAccelerator.code)
                    put("acceleratorDetail", activeAcceleratorDetail)
                    put("loadTimeMs", 0L)
                    put("cascadeLog", JSONArray(activeCascadeLog))
                    put("inputNames", JSONArray(session.inputNames.toList()))
                    put("outputNames", JSONArray(session.outputNames.toList()))
                }
            }

            // Enforce Single Active Model in RAM: close previous session before allocating a new one
            releaseActiveModelLocked()

            if (!spec.format.equals("onnx", ignoreCase = true)) {
                throw UnsupportedOperationException(
                    "Формат ${spec.format} зарезервирован под LiteRT делегат; для текущего ядра требуется .onnx"
                )
            }

            val startNs = System.nanoTime()
            val env = ortEnv ?: OrtEnvironment.getEnvironment().also { ortEnv = it }
            val bundle = HardwareCascadeSelector.createSessionWithCascade(
                context = appContext,
                env = env,
                modelFile = modelFile
            )
            val elapsedMs = (System.nanoTime() - startNs) / 1_000_000L

            activeModelId = modelId
            activeSession = bundle.session
            activeOptions = bundle.options
            activeAccelerator = bundle.hardware.accelerator
            activeAcceleratorDetail = bundle.hardware.detail
            activeCascadeLog = bundle.hardware.cascadeLog

            JSONObject().apply {
                put("ok", true)
                put("modelId", modelId)
                put("ready", true)
                put("reusedFromRam", false)
                put("accelerator", bundle.hardware.accelerator.code)
                put("acceleratorDetail", bundle.hardware.detail)
                put("loadTimeMs", elapsedMs)
                put("cascadeLog", bundle.hardware.toLogJsonArray())
                put("inputNames", JSONArray(bundle.inputNames))
                put("outputNames", JSONArray(bundle.outputNames))
            }
        }
    }

    /**
     * Exposes the currently loaded OrtSession for downstream task runners (SAM, Tracker, Whisper).
     */
    fun getActiveSession(): Pair<String, OrtSession>? {
        val id = activeModelId ?: return null
        val session = activeSession ?: return null
        return id to session
    }

    suspend fun releaseActiveModel(): JSONObject {
        return sessionMutex.withLock {
            val prev = activeModelId
            releaseActiveModelLocked()
            JSONObject().apply {
                put("ok", true)
                put("releasedModelId", prev ?: JSONObject.NULL)
            }
        }
    }

    suspend fun deleteModel(modelId: String): JSONObject {
        val spec = AIModelRegistry.getById(modelId)
            ?: throw IllegalArgumentException("Модель $modelId не найдена")

        cancelDownload(modelId)
        return sessionMutex.withLock {
            if (activeModelId == modelId) {
                releaseActiveModelLocked()
            }
            val file = getModelFile(spec)
            val deleted = if (file.exists()) file.delete() else false
            modelErrors.remove(modelId)
            JSONObject().apply {
                put("ok", true)
                put("modelId", modelId)
                put("deleted", deleted)
            }
        }
    }

    private fun releaseActiveModelLocked() {
        val prevId = activeModelId
        try {
            activeSession?.close()
        } catch (err: Throwable) {
            Log.w(TAG, "Error closing OrtSession ($prevId): ${err.message}")
        }
        try {
            activeOptions?.close()
        } catch (_: Throwable) {
        }
        activeSession = null
        activeOptions = null
        activeModelId = null
        activeAccelerator = HardwareAccelerator.NONE
        activeAcceleratorDetail = ""
        activeCascadeLog = emptyList()
        if (prevId != null) {
            Log.i(TAG, "Released AI model from RAM: $prevId")
        }
    }
}
