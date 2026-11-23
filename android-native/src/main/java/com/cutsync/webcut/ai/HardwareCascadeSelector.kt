package com.cutsync.webcut.ai

import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtProvider
import ai.onnxruntime.OrtSession
import ai.onnxruntime.providers.NNAPIFlags
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import java.io.File
import java.util.EnumSet

data class CreatedSessionBundle(
    val session: OrtSession,
    val options: OrtSession.SessionOptions,
    val hardware: HardwareInitResult,
    val inputNames: List<String>,
    val outputNames: List<String>
)

/**
 * Hardware Cascade Fallback initializer for ONNX Runtime Mobile:
 * 1) NPU / DSP (Qualcomm QNN / NNAPI Hardware NPU/DSP)
 * 2) GPU (Vulkan / OpenCL / NNAPI GPU Delegate)
 * 3) CPU (XNNPACK with optimal thread count)
 */
object HardwareCascadeSelector {
    private const val TAG = "WebcutAIHardware"

    data class DeviceCapabilities(
        val socModel: String,
        val hasDedicatedNpu: Boolean,
        val hasVulkanGpu: Boolean,
        val availableProviders: Set<OrtProvider>,
        val optimalCpuThreads: Int
    )

    fun probeDeviceCapabilities(context: Context): DeviceCapabilities {
        val socModel = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            "${Build.SOC_MANUFACTURER} ${Build.SOC_MODEL}".trim()
        } else {
            "${Build.HARDWARE} ${Build.BOARD}".trim()
        }

        val lowerSoc = socModel.lowercase()
        val lowerHardware = "${Build.HARDWARE} ${Build.BOARD} ${Build.MODEL}".lowercase()

        val hasDedicatedNpu = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && (
            lowerSoc.contains("qualcomm") ||
                lowerSoc.contains("qcom") ||
                lowerSoc.contains("snapdragon") ||
                lowerSoc.contains("sm8") ||
                lowerSoc.contains("sm7") ||
                lowerSoc.contains("dimensity") ||
                lowerSoc.contains("mediatek") ||
                lowerSoc.contains("exynos") ||
                lowerSoc.contains("tensor") ||
                lowerHardware.contains("qcom") ||
                lowerHardware.contains("kalama") ||
                lowerHardware.contains("pineapple") ||
                lowerHardware.contains("cliffs")
            )

        val pm = context.packageManager
        val hasVulkanGpu = pm.hasSystemFeature(PackageManager.FEATURE_VULKAN_HARDWARE_LEVEL) ||
            pm.hasSystemFeature(PackageManager.FEATURE_VULKAN_HARDWARE_VERSION)

        val providers = try {
            OrtEnvironment.getAvailableProviders()
        } catch (err: Throwable) {
            Log.w(TAG, "Unable to query ORT available providers: ${err.message}")
            emptySet()
        }

        val cores = Runtime.getRuntime().availableProcessors().coerceAtLeast(2)
        val optimalThreads = (cores / 2).coerceIn(2, 6)

        return DeviceCapabilities(
            socModel = socModel.ifBlank { "Android Device" },
            hasDedicatedNpu = hasDedicatedNpu,
            hasVulkanGpu = hasVulkanGpu,
            availableProviders = providers,
            optimalCpuThreads = optimalThreads
        )
    }

    fun createSessionWithCascade(
        context: Context,
        env: OrtEnvironment,
        modelFile: File
    ): CreatedSessionBundle {
        val caps = probeDeviceCapabilities(context)
        val cascadeLog = mutableListOf<String>()
        cascadeLog += "Device SoC: ${caps.socModel} (API ${Build.VERSION.SDK_INT}), ORT providers: ${caps.availableProviders.joinToString { it.name }}"

        val modelPath = modelFile.absolutePath

        // =========================================================================
        // 1) NPU / DSP TIER (Qualcomm QNN HTP -> NNAPI NPU/DSP with CPU_DISABLED)
        // =========================================================================
        if (caps.availableProviders.any { it.name.equals("QNN", ignoreCase = true) }) {
            val qnnOpts = buildBaseOptions(caps.optimalCpuThreads)
            try {
                if (tryEnableQnnViaReflection(qnnOpts)) {
                    val session = env.createSession(modelPath, qnnOpts)
                    val detail = "QNN Hexagon HTP NPU (${caps.socModel})"
                    cascadeLog += "[NPU] OK -> $detail"
                    Log.i(TAG, "Initialized ${modelFile.name} on NPU: $detail")
                    return bundle(session, qnnOpts, HardwareAccelerator.NPU, detail, cascadeLog)
                }
            } catch (err: Throwable) {
                cascadeLog += "[NPU/QNN] Fallback: ${err.message}"
                Log.w(TAG, "QNN NPU init failed for ${modelFile.name}: ${err.message}")
                safeClose(qnnOpts)
            }
        } else {
            cascadeLog += "[NPU/QNN] QNN EP not bundled in lightweight APK; trying NNAPI NPU/DSP"
        }

        if (caps.availableProviders.contains(OrtProvider.NNAPI) && caps.hasDedicatedNpu) {
            val nnapiNpuOpts = buildBaseOptions(caps.optimalCpuThreads)
            try {
                nnapiNpuOpts.addNnapi(
                    EnumSet.of(NNAPIFlags.USE_FP16, NNAPIFlags.CPU_DISABLED)
                )
                val session = env.createSession(modelPath, nnapiNpuOpts)
                val detail = "NNAPI Hardware NPU/DSP FP16 (${caps.socModel})"
                cascadeLog += "[NPU] OK -> $detail"
                Log.i(TAG, "Initialized ${modelFile.name} on NPU via NNAPI: $detail")
                return bundle(session, nnapiNpuOpts, HardwareAccelerator.NPU, detail, cascadeLog)
            } catch (err: Throwable) {
                cascadeLog += "[NPU/NNAPI] Fallback: ${err.message}"
                Log.w(TAG, "NNAPI NPU init failed for ${modelFile.name}: ${err.message}")
                safeClose(nnapiNpuOpts)
            }
        } else {
            cascadeLog += "[NPU/NNAPI] Dedicated NPU/DSP not detected on ${caps.socModel}"
        }

        // =========================================================================
        // 2) GPU TIER (Vulkan / OpenCL / NNAPI GPU Delegate)
        // =========================================================================
        if (caps.availableProviders.contains(OrtProvider.NNAPI) && caps.hasVulkanGpu) {
            val gpuOpts = buildBaseOptions(caps.optimalCpuThreads)
            try {
                // If NPU wasn't attempted (no dedicated NPU), enforce CPU_DISABLED so NNAPI targets GPU driver;
                // if NPU already failed with CPU_DISABLED, allow FP16 NNAPI GPU/hybrid scheduling.
                val flags = if (!caps.hasDedicatedNpu) {
                    EnumSet.of(NNAPIFlags.USE_FP16, NNAPIFlags.CPU_DISABLED)
                } else {
                    EnumSet.of(NNAPIFlags.USE_FP16)
                }
                gpuOpts.addNnapi(flags)
                val session = env.createSession(modelPath, gpuOpts)
                val detail = "GPU Delegate (NNAPI FP16 / Vulkan)"
                cascadeLog += "[GPU] OK -> $detail"
                Log.i(TAG, "Initialized ${modelFile.name} on GPU: $detail")
                return bundle(session, gpuOpts, HardwareAccelerator.GPU, detail, cascadeLog)
            } catch (err: Throwable) {
                cascadeLog += "[GPU] Fallback: ${err.message}"
                Log.w(TAG, "GPU delegate init failed for ${modelFile.name}: ${err.message}")
                safeClose(gpuOpts)
            }
        } else {
            cascadeLog += "[GPU] Vulkan/NNAPI GPU delegate unavailable"
        }

        // =========================================================================
        // 3) CPU TIER (XNNPACK + Optimal Thread Count — Universal Fallback)
        // =========================================================================
        val cpuOpts = buildBaseOptions(caps.optimalCpuThreads)
        val xnnpackEnabled = if (caps.availableProviders.contains(OrtProvider.XNNPACK)) {
            try {
                cpuOpts.addXnnpack(mapOf("intra_op_num_threads" to caps.optimalCpuThreads.toString()))
                true
            } catch (err: Throwable) {
                cascadeLog += "[CPU/XNNPACK] XNNPACK attach warning: ${err.message}"
                false
            }
        } else {
            false
        }

        val cpuSession = try {
            env.createSession(modelPath, cpuOpts)
        } catch (err: Throwable) {
            safeClose(cpuOpts)
            throw err
        }

        val cpuDetail = if (xnnpackEnabled) {
            "XNNPACK CPU (${caps.optimalCpuThreads} threads)"
        } else {
            "ORT CPU (${caps.optimalCpuThreads} threads)"
        }
        cascadeLog += "[CPU] OK -> $cpuDetail"
        Log.i(TAG, "Initialized ${modelFile.name} on CPU fallback: $cpuDetail")
        return bundle(cpuSession, cpuOpts, HardwareAccelerator.CPU, cpuDetail, cascadeLog)
    }

    private fun buildBaseOptions(threads: Int): OrtSession.SessionOptions {
        return OrtSession.SessionOptions().apply {
            setIntraOpNumThreads(threads)
            setInterOpNumThreads(1)
            setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
        }
    }

    private fun tryEnableQnnViaReflection(options: OrtSession.SessionOptions): Boolean {
        return try {
            val method = options.javaClass.getMethod("addQnn", Map::class.java)
            val qnnConfig = mapOf(
                "backend_path" to "libQnnHtp.so",
                "htp_performance_mode" to "burst",
                "enable_htp_fp16_precision" to "1"
            )
            method.invoke(options, qnnConfig)
            true
        } catch (_: Throwable) {
            false
        }
    }

    private fun bundle(
        session: OrtSession,
        options: OrtSession.SessionOptions,
        accelerator: HardwareAccelerator,
        detail: String,
        cascadeLog: List<String>
    ): CreatedSessionBundle {
        return CreatedSessionBundle(
            session = session,
            options = options,
            hardware = HardwareInitResult(
                accelerator = accelerator,
                detail = detail,
                cascadeLog = cascadeLog
            ),
            inputNames = session.inputNames.toList(),
            outputNames = session.outputNames.toList()
        )
    }

    fun createCpuSession(
        context: Context,
        env: OrtEnvironment,
        modelFile: File
    ): Pair<OrtSession, OrtSession.SessionOptions> {
        val caps = probeDeviceCapabilities(context)
        val cpuOpts = buildBaseOptions(caps.optimalCpuThreads)
        if (caps.availableProviders.contains(OrtProvider.XNNPACK)) {
            try {
                cpuOpts.addXnnpack(mapOf("intra_op_num_threads" to caps.optimalCpuThreads.toString()))
            } catch (_: Throwable) {
            }
        }
        val session = try {
            env.createSession(modelFile.absolutePath, cpuOpts)
        } catch (err: Throwable) {
            safeClose(cpuOpts)
            throw err
        }
        return session to cpuOpts
    }

    private fun safeClose(options: OrtSession.SessionOptions) {
        try {
            options.close()
        } catch (_: Throwable) {
        }
    }
}
