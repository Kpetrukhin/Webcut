package com.cutsync.webcut.ai

import org.json.JSONArray
import org.json.JSONObject

enum class HardwareAccelerator(val code: String, val label: String) {
    NPU("NPU", "NPU / Hexagon DSP"),
    GPU("GPU", "GPU Delegate (Vulkan / OpenCL)"),
    CPU("CPU", "CPU (XNNPACK)"),
    NONE("NONE", "Не загружена")
}

enum class ModelInstallStatus(val code: String) {
    NOT_INSTALLED("not_installed"),
    DOWNLOADING("downloading"),
    READY("ready"),
    ERROR("error")
}

enum class ModelCategory(val code: String, val label: String) {
    MASK("mask", "Маски и вырезка фона"),
    KEYFRAME("keyframe", "Анимация и трекинг"),
    TEXT("text", "Текст и субтитры")
}

data class AIModelSpec(
    val id: String,
    val title: String,
    val category: ModelCategory,
    val fileName: String,
    val format: String, // "onnx" | "tflite"
    val downloadUrl: String,
    val expectedSizeBytes: Long,
    val sha256: String, // empty = skip hash check when custom/unpinned mirror
    val description: String,
    val minAndroidApi: Int = 26
) {
    fun toJson(
        status: ModelInstallStatus,
        progress: Int,
        installedBytes: Long,
        isActiveInRam: Boolean,
        activeAccelerator: HardwareAccelerator,
        lastError: String?
    ): JSONObject {
        return JSONObject().apply {
            put("id", id)
            put("title", title)
            put("category", category.code)
            put("categoryLabel", category.label)
            put("fileName", fileName)
            put("format", format)
            put("downloadUrl", downloadUrl)
            put("expectedSizeBytes", expectedSizeBytes)
            put("installedBytes", installedBytes)
            put("sha256", sha256)
            put("description", description)
            put("status", status.code)
            put("downloadProgress", progress)
            put("isActiveInRam", isActiveInRam)
            put(
                "accelerator",
                if (isActiveInRam) activeAccelerator.code else HardwareAccelerator.NONE.code
            )
            if (!lastError.isNullOrBlank()) {
                put("error", lastError)
            }
        }
    }
}

data class HardwareInitResult(
    val accelerator: HardwareAccelerator,
    val detail: String,
    val cascadeLog: List<String>
) {
    fun toLogJsonArray(): JSONArray = JSONArray().apply {
        cascadeLog.forEach { put(it) }
    }
}

object AIModelRegistry {
    /**
     * Built-in modular catalog. No model weights are bundled in the APK (~17 MB limit).
     * Models are downloaded on demand from GitHub Releases or imported via a .zip AI pack.
     */
            private val builtInModels: List<AIModelSpec> = listOf(
        AIModelSpec(
            id = "sam2_tiny_seg",
            title = "AI Авто-маска (Сегментация)",
            category = ModelCategory.MASK,
            fileName = "mobile_sam_image_encoder.onnx",
            format = "onnx",
            downloadUrl = "https://github.com",
            expectedSizeBytes = 0L,
            sha256 = "",
            description = "Волшебная палочка: выделение объекта и построение маски (MobileSAM)."
        ),
        AIModelSpec(
            id = "motion_tracker_nano",
            title = "AI Авто-трекинг (Ключи)",
            category = ModelCategory.KEYFRAME,
            fileName = "object_tracking_vittrack_2023sep.onnx",
            format = "onnx",
            downloadUrl = "https://github.com",
            expectedSizeBytes = 0L,
            sha256 = "",
            description = "Отслеживание объекта на видео и автогенерация ключевых кадров (VitTrack)."
        ),
        AIModelSpec(
            id = "whisper_tiny_asr",
            title = "AI Авто-субтитры (Речь -> Текст)",
            category = ModelCategory.TEXT,
            fileName = "encoder_model_quantized.onnx",
            format = "onnx",
            downloadUrl = "https://github.com",
            expectedSizeBytes = 0L,
            sha256 = "",
            description = "Офлайн-распознавание речи (RU/EN) и создание титров (Whisper Tiny)."
        )
    )

    private val customSpecs = LinkedHashMap<String, AIModelSpec>()

    init {
        builtInModels.forEach { customSpecs[it.id] = it }
    }

    @Synchronized
    fun getAll(): List<AIModelSpec> = customSpecs.values.toList()

    @Synchronized
    fun getById(id: String): AIModelSpec? = customSpecs[id]

    @Synchronized
    fun findByFileName(fileName: String): AIModelSpec? {
        val clean = fileName.substringAfterLast('/').substringAfterLast('\\')
        return customSpecs.values.firstOrNull {
            it.fileName.equals(clean, ignoreCase = true)
        }
    }

    @Synchronized
    fun registerOrOverride(spec: AIModelSpec) {
        customSpecs[spec.id] = spec
    }
}
