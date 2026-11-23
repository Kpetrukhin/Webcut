import {Capacitor, registerPlugin} from '@capacitor/core';
import type {PluginListenerHandle} from '@capacitor/core';
import {isNativeCapacitorApp} from './serverConfig.ts';

export type HardwareAccelerator = 'NPU' | 'GPU' | 'CPU' | 'NONE';
export type AIModelStatus = 'not_installed' | 'downloading' | 'ready' | 'error';
export type AIModelCategory = 'mask' | 'keyframe' | 'text';
export type AIModelId =
  | 'sam2_tiny_seg'
  | 'motion_tracker_nano'
  | 'whisper_tiny_asr'
  | (string & {});

export interface AIModelInfo {
  id: AIModelId;
  title: string;
  category: AIModelCategory;
  categoryLabel: string;
  fileName: string;
  format: 'onnx' | 'tflite' | string;
  downloadUrl: string;
  expectedSizeBytes: number;
  installedBytes: number;
  sha256: string;
  description: string;
  status: AIModelStatus;
  downloadProgress: number;
  isActiveInRam: boolean;
  accelerator: HardwareAccelerator;
  error?: string;
}

export interface AIModelsStatusSnapshot {
  environment: 'android' | 'web';
  modelsDir: string;
  totalStorageBytes: number;
  activeModelId: AIModelId | null;
  activeAccelerator: HardwareAccelerator;
  activeAcceleratorDetail: string;
  deviceSoc: string;
  supportsNpu: boolean;
  supportsGpu: boolean;
  cascadeLog: string[];
  models: AIModelInfo[];
}

export interface AIModelPrepareResult {
  ok: boolean;
  modelId: AIModelId;
  ready: boolean;
  reusedFromRam: boolean;
  accelerator: HardwareAccelerator;
  acceleratorDetail: string;
  loadTimeMs: number;
  cascadeLog: string[];
  inputNames: string[];
  outputNames: string[];
}

export interface AIZipImportResult {
  ok: boolean;
  canceled: boolean;
  importedCount: number;
  importedFiles: string[];
  matchedModelIds: string[];
  skippedFiles: string[];
  totalBytes: number;
}

export interface DownloadModelOptions {
  url?: string;
  expectedSize?: number;
  expectedHash?: string;
  onProgress?: (pct: number) => void;
}

export type SubtitleLanguage = 'auto' | 'ru' | 'en';

export interface SubtitleSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface TranscribeProgressEvent {
  progress: number;
  stage: string;
  clipId?: string;
}

export interface TranscribeAudioOptions {
  sourceUrl: string;
  fileName?: string;
  clipId?: string;
  language?: SubtitleLanguage;
  trimStartMs?: number;
  durationMs?: number;
  onProgress?: (ev: TranscribeProgressEvent) => void;
}

export interface TranscribeAudioResult {
  ok: boolean;
  language: string;
  durationMs: number;
  segments: SubtitleSegment[];
}

export interface TrackBbox {
  x: number; // normalized top-left X [0..1]
  y: number; // normalized top-left Y [0..1]
  w: number; // normalized width [0..1]
  h: number; // normalized height [0..1]
}

export interface TrackPointResult {
  timeMs: number;
  x: number; // normalized center X [0..1]
  y: number; // normalized center Y [0..1]
  scale: number;
  w: number;
  h: number;
  score: number;
}

export interface TrackProgressEvent {
  progress: number;
  timeMs: number;
  clipId?: string;
  point?: TrackPointResult;
}

export interface TrackObjectOptions {
  sourceUrl: string;
  fileName?: string;
  clipId?: string;
  startMs: number;
  endMs: number;
  bbox: TrackBbox;
  sampleFps?: number;
  onProgress?: (ev: TrackProgressEvent) => void;
}

export interface TrackObjectResult {
  ok: boolean;
  frameCount: number;
  durationMs: number;
  videoWidth: number;
  videoHeight: number;
  points: TrackPointResult[];
}

interface WebcutAINativePlugin {
  getAvailableModelsStatus(): Promise<AIModelsStatusSnapshot>;
  downloadModel(options: {
    modelId: string;
    url?: string;
    expectedSize?: number;
    expectedHash?: string;
  }): Promise<{started: boolean; modelId: string}>;
  cancelDownload(options: {modelId: string}): Promise<{ok: boolean}>;
  importModelsZip(): Promise<AIZipImportResult>;
  prepareModel(options: {modelId: string}): Promise<AIModelPrepareResult>;
  releaseActiveModel(): Promise<{ok: boolean; releasedModelId: string | null}>;
  deleteModel(options: {
    modelId: string;
  }): Promise<{ok: boolean; modelId: string; deleted: boolean}>;
  transcribeAudio(options: {
    sourceUrl: string;
    fileName?: string;
    clipId?: string;
    language?: SubtitleLanguage;
    trimStartMs?: number;
    durationMs?: number;
  }): Promise<TranscribeAudioResult>;
  cancelTranscribe(): Promise<{ok: boolean}>;
  trackObject(options: {
    sourceUrl: string;
    fileName?: string;
    clipId?: string;
    startMs: number;
    endMs: number;
    bbox: TrackBbox;
    sampleFps?: number;
  }): Promise<TrackObjectResult>;
  cancelTracking(): Promise<{ok: boolean}>;
  addListener(
    eventName: 'aiModelDownloadProgress',
    listenerFunc: (data: {modelId: string; progress: number}) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'aiModelDownloadComplete',
    listenerFunc: (data: {
      modelId: string;
      fileName: string;
      sizeBytes: number;
    }) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'aiModelDownloadError',
    listenerFunc: (data: {modelId: string; message: string}) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'aiTranscribeProgress',
    listenerFunc: (data: TranscribeProgressEvent) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'aiTrackProgress',
    listenerFunc: (data: TrackProgressEvent) => void
  ): Promise<PluginListenerHandle>;
}

const WebcutAINative = registerPlugin<WebcutAINativePlugin>('WebcutAI');

export const BUILTIN_AI_MODEL_CATALOG: AIModelInfo[] = [
  {
    id: 'sam2_tiny_seg',
    title: 'AI Авто-маска (Сегментация)',
    category: 'mask',
    categoryLabel: 'Маски и вырезка фона',
    fileName: 'sam2_tiny_image_encoder.onnx',
    format: 'onnx',
    downloadUrl:
      'https://github.com/cutsync/webcut-ai-models/releases/download/v1.0.0/sam2_tiny_image_encoder.onnx',
    expectedSizeBytes: 0,
    installedBytes: 0,
    sha256: '',
    description:
      'Выделение объекта и автоматическое построение маски на кадре (ONNX FP16).',
    status: 'not_installed',
    downloadProgress: 0,
    isActiveInRam: false,
    accelerator: 'NONE',
  },
  {
    id: 'motion_tracker_nano',
    title: 'AI Авто-трекинг (Ключи)',
    category: 'keyframe',
    categoryLabel: 'Анимация и трекинг',
    fileName: 'object_tracking_vittrack_2023sep.onnx',
    format: 'onnx',
    downloadUrl:
      'https://github.com/opencv/opencv_zoo/raw/main/models/object_tracking_vittrack/object_tracking_vittrack_2023sep.onnx',
    expectedSizeBytes: 0,
    installedBytes: 0,
    sha256: '',
    description:
      'Отслеживание точки на видео и автогенерация ключевых кадров движения.',
    status: 'not_installed',
    downloadProgress: 0,
    isActiveInRam: false,
    accelerator: 'NONE',
  },
  {
    id: 'whisper_tiny_asr',
    title: 'AI Авто-субтитры (Речь -> Текст)',
    category: 'text',
    categoryLabel: 'Текст и субтитры',
    fileName: 'encoder_model_quantized.onnx',
    format: 'onnx',
    downloadUrl:
      'https://github.com/cutsync/webcut-ai-models/releases/download/v1.0.0/encoder_model_quantized.onnx',
    expectedSizeBytes: 0,
    installedBytes: 0,
    sha256: '',
    description:
      'Офлайн-распознавание речи (RU/EN) и создание анимированных титров.',
    status: 'not_installed',
    downloadProgress: 0,
    isActiveInRam: false,
    accelerator: 'NONE',
  },
];

export function hasNativeWebcutAI(): boolean {
  try {
    return isNativeCapacitorApp() && Capacitor.isPluginAvailable('WebcutAI');
  } catch {
    return false;
  }
}

export interface WebcutAIBridge {
  isNativeAvailable(): boolean;
  getAvailableModelsStatus(): Promise<AIModelsStatusSnapshot>;
  downloadModel(
    modelId: AIModelId,
    options?: DownloadModelOptions
  ): Promise<{started: boolean; modelId: string}>;
  cancelDownload(modelId: AIModelId): Promise<void>;
  importModelsZip(): Promise<AIZipImportResult>;
  prepareModel(modelId: AIModelId): Promise<AIModelPrepareResult>;
  releaseActiveModel(): Promise<{ok: boolean; releasedModelId: string | null}>;
  deleteModel(
    modelId: AIModelId
  ): Promise<{ok: boolean; modelId: string; deleted: boolean}>;
  onDownloadProgress(
    listener: (ev: {modelId: string; progress: number}) => void
  ): () => void;
  onDownloadComplete(
    listener: (ev: {
      modelId: string;
      fileName: string;
      sizeBytes: number;
    }) => void
  ): () => void;
  onDownloadError(
    listener: (ev: {modelId: string; message: string}) => void
  ): () => void;
  transcribeAudio(options: TranscribeAudioOptions): Promise<TranscribeAudioResult>;
  cancelTranscribe(): Promise<void>;
  onTranscribeProgress(
    listener: (ev: TranscribeProgressEvent) => void
  ): () => void;
  trackObject(options: TrackObjectOptions): Promise<TrackObjectResult>;
  cancelTracking(): Promise<void>;
  onTrackProgress(listener: (ev: TrackProgressEvent) => void): () => void;
}

const progressListeners = new Set<
  (ev: {modelId: string; progress: number}) => void
>();
const completeListeners = new Set<
  (ev: {modelId: string; fileName: string; sizeBytes: number}) => void
>();
const errorListeners = new Set<
  (ev: {modelId: string; message: string}) => void
>();
const transcribeProgressListeners = new Set<
  (ev: TranscribeProgressEvent) => void
>();
const trackProgressListeners = new Set<(ev: TrackProgressEvent) => void>();

let nativeListenersBound = false;

function ensureNativeEventListeners(): void {
  if (nativeListenersBound || !hasNativeWebcutAI()) return;
  nativeListenersBound = true;

  void WebcutAINative.addListener('aiModelDownloadProgress', (ev) => {
    for (const cb of progressListeners) cb(ev);
  }).catch(() => {});

  void WebcutAINative.addListener('aiModelDownloadComplete', (ev) => {
    for (const cb of completeListeners) cb(ev);
  }).catch(() => {});

  void WebcutAINative.addListener('aiModelDownloadError', (ev) => {
    for (const cb of errorListeners) cb(ev);
  }).catch(() => {});

  void WebcutAINative.addListener('aiTranscribeProgress', (ev) => {
    for (const cb of transcribeProgressListeners) cb(ev);
  }).catch(() => {});

  void WebcutAINative.addListener('aiTrackProgress', (ev) => {
    for (const cb of trackProgressListeners) cb(ev);
  }).catch(() => {});
}

const NATIVE_REQUIRED_ERROR =
  'Локальный ONNX Runtime Mobile AI-движок доступен в нативной Android-сборке (APK).';

export const webcutAI: WebcutAIBridge = {
  isNativeAvailable(): boolean {
    return hasNativeWebcutAI();
  },

  async getAvailableModelsStatus(): Promise<AIModelsStatusSnapshot> {
    if (hasNativeWebcutAI()) {
      ensureNativeEventListeners();
      return await WebcutAINative.getAvailableModelsStatus();
    }

    return {
      environment: 'web',
      modelsDir: 'context.filesDir/ai_models',
      totalStorageBytes: 0,
      activeModelId: null,
      activeAccelerator: 'NONE',
      activeAcceleratorDetail: 'Только в Android APK (ONNX Runtime Mobile)',
      deviceSoc: typeof navigator !== 'undefined' ? navigator.platform : 'Web',
      supportsNpu: false,
      supportsGpu: false,
      cascadeLog: [],
      models: BUILTIN_AI_MODEL_CATALOG.map((m) => ({...m})),
    };
  },

  async downloadModel(
    modelId: AIModelId,
    options?: DownloadModelOptions
  ): Promise<{started: boolean; modelId: string}> {
    if (!hasNativeWebcutAI()) {
      throw new Error(NATIVE_REQUIRED_ERROR);
    }
    ensureNativeEventListeners();

    if (options?.onProgress) {
      const onProg = options.onProgress;
      const offProg = webcutAI.onDownloadProgress((ev) => {
        if (ev.modelId === modelId) onProg(ev.progress);
      });
      const offDone = webcutAI.onDownloadComplete((ev) => {
        if (ev.modelId === modelId) {
          onProg(100);
          offProg();
          offDone();
          offErr();
        }
      });
      const offErr = webcutAI.onDownloadError((ev) => {
        if (ev.modelId === modelId) {
          offProg();
          offDone();
          offErr();
        }
      });
    }

    return await WebcutAINative.downloadModel({
      modelId,
      url: options?.url,
      expectedSize: options?.expectedSize,
      expectedHash: options?.expectedHash,
    });
  },

  async cancelDownload(modelId: AIModelId): Promise<void> {
    if (!hasNativeWebcutAI()) return;
    await WebcutAINative.cancelDownload({modelId});
  },

  async importModelsZip(): Promise<AIZipImportResult> {
    if (!hasNativeWebcutAI()) {
      throw new Error(NATIVE_REQUIRED_ERROR);
    }
    ensureNativeEventListeners();
    return await WebcutAINative.importModelsZip();
  },

  async prepareModel(modelId: AIModelId): Promise<AIModelPrepareResult> {
    if (!hasNativeWebcutAI()) {
      throw new Error(NATIVE_REQUIRED_ERROR);
    }
    ensureNativeEventListeners();
    return await WebcutAINative.prepareModel({modelId});
  },

  async releaseActiveModel(): Promise<{
    ok: boolean;
    releasedModelId: string | null;
  }> {
    if (!hasNativeWebcutAI()) {
      return {ok: true, releasedModelId: null};
    }
    return await WebcutAINative.releaseActiveModel();
  },

  async deleteModel(
    modelId: AIModelId
  ): Promise<{ok: boolean; modelId: string; deleted: boolean}> {
    if (!hasNativeWebcutAI()) {
      return {ok: false, modelId, deleted: false};
    }
    return await WebcutAINative.deleteModel({modelId});
  },

  onDownloadProgress(
    listener: (ev: {modelId: string; progress: number}) => void
  ): () => void {
    ensureNativeEventListeners();
    progressListeners.add(listener);
    return () => {
      progressListeners.delete(listener);
    };
  },

  onDownloadComplete(
    listener: (ev: {
      modelId: string;
      fileName: string;
      sizeBytes: number;
    }) => void
  ): () => void {
    ensureNativeEventListeners();
    completeListeners.add(listener);
    return () => {
      completeListeners.delete(listener);
    };
  },

  onDownloadError(
    listener: (ev: {modelId: string; message: string}) => void
  ): () => void {
    ensureNativeEventListeners();
    errorListeners.add(listener);
    return () => {
      errorListeners.delete(listener);
    };
  },

  async transcribeAudio(
    options: TranscribeAudioOptions
  ): Promise<TranscribeAudioResult> {
    if (!hasNativeWebcutAI()) {
      throw new Error(NATIVE_REQUIRED_ERROR);
    }
    ensureNativeEventListeners();

    const offProg = options.onProgress
      ? webcutAI.onTranscribeProgress((ev) => {
          if (!options.clipId || !ev.clipId || ev.clipId === options.clipId) {
            options.onProgress?.(ev);
          }
        })
      : null;

    try {
      return await WebcutAINative.transcribeAudio({
        sourceUrl: options.sourceUrl,
        fileName: options.fileName,
        clipId: options.clipId,
        language: options.language ?? 'auto',
        trimStartMs: options.trimStartMs,
        durationMs: options.durationMs,
      });
    } finally {
      offProg?.();
    }
  },

  async cancelTranscribe(): Promise<void> {
    if (!hasNativeWebcutAI()) return;
    await WebcutAINative.cancelTranscribe();
  },

  onTranscribeProgress(
    listener: (ev: TranscribeProgressEvent) => void
  ): () => void {
    ensureNativeEventListeners();
    transcribeProgressListeners.add(listener);
    return () => {
      transcribeProgressListeners.delete(listener);
    };
  },

  async trackObject(options: TrackObjectOptions): Promise<TrackObjectResult> {
    if (!hasNativeWebcutAI()) {
      throw new Error(NATIVE_REQUIRED_ERROR);
    }
    ensureNativeEventListeners();

    const offProg = options.onProgress
      ? webcutAI.onTrackProgress((ev) => {
          if (!options.clipId || !ev.clipId || ev.clipId === options.clipId) {
            options.onProgress?.(ev);
          }
        })
      : null;

    try {
      return await WebcutAINative.trackObject({
        sourceUrl: options.sourceUrl,
        fileName: options.fileName,
        clipId: options.clipId,
        startMs: options.startMs,
        endMs: options.endMs,
        bbox: options.bbox,
        sampleFps: options.sampleFps ?? 24,
      });
    } finally {
      offProg?.();
    }
  },

  async cancelTracking(): Promise<void> {
    if (!hasNativeWebcutAI()) return;
    await WebcutAINative.cancelTracking();
  },

  onTrackProgress(listener: (ev: TrackProgressEvent) => void): () => void {
    ensureNativeEventListeners();
    trackProgressListeners.add(listener);
    return () => {
      trackProgressListeners.delete(listener);
    };
  },
};

declare global {
  interface Window {
    WebcutAI?: WebcutAIBridge;
  }
}

export function attachWebcutAIGlobal(): WebcutAIBridge {
  if (typeof window !== 'undefined') {
    window.WebcutAI = webcutAI;
  }
  return webcutAI;
}

attachWebcutAIGlobal();

/* =========================================================================
   UI Modal Coordination Store (lazy-loaded on user click of any ✨ feature)
   ========================================================================= */

export interface AIModalRequest {
  open: boolean;
  focusModelId?: AIModelId | null;
  featureTitle?: string | null;
  autoPrepareIfReady?: boolean;
}

type AIModalListener = (req: AIModalRequest) => void;
const modalListeners = new Set<AIModalListener>();

let currentModalState: AIModalRequest = {
  open: false,
  focusModelId: null,
  featureTitle: null,
  autoPrepareIfReady: false,
};

function notifyModalListeners() {
  for (const listener of modalListeners) {
    listener(currentModalState);
  }
}

export function subscribeAIModal(listener: AIModalListener): () => void {
  modalListeners.add(listener);
  listener(currentModalState);
  return () => {
    modalListeners.delete(listener);
  };
}

export function openAIModelManager(opts?: {
  focusModelId?: AIModelId | null;
  featureTitle?: string | null;
  autoPrepareIfReady?: boolean;
}): void {
  currentModalState = {
    open: true,
    focusModelId: opts?.focusModelId ?? null,
    featureTitle: opts?.featureTitle ?? null,
    autoPrepareIfReady: opts?.autoPrepareIfReady ?? false,
  };
  notifyModalListeners();
}

export function closeAIModelManager(): void {
  currentModalState = {
    open: false,
    focusModelId: null,
    featureTitle: null,
    autoPrepareIfReady: false,
  };
  notifyModalListeners();
}

/**
 * Triggered by ✨ buttons in Masks, Keyframes, and Text panels.
 * Checks whether the required model is installed; if ready on Android,
 * prepares it on best hardware (NPU -> GPU -> CPU) and shows active hardware status,
 * otherwise prompts user to download the model or import a .zip pack.
 */
export function requestAIFeature(
  modelId: AIModelId,
  featureTitle: string
): void {
  openAIModelManager({
    focusModelId: modelId,
    featureTitle,
    autoPrepareIfReady: true,
  });
}
