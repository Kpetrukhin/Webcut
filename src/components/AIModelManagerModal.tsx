import React, {useCallback, useEffect, useState} from 'react';
import {
  CheckCircle2,
  Cpu,
  Download,
  FileArchive,
  HardDrive,
  Loader2,
  Play,
  Power,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import {
  closeAIModelManager,
  subscribeAIModal,
  webcutAI,
} from '../lib/webcutAi.ts';
import type {
  AIModelInfo,
  AIModelPrepareResult,
  AIModelsStatusSnapshot,
  HardwareAccelerator,
} from '../lib/webcutAi.ts';

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 Б';
  if (bytes < 1024) return `${bytes} Б`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} КБ`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} МБ`;
  return `${(mb / 1024).toFixed(2)} ГБ`;
}

function AcceleratorBadge({
  accelerator,
  detail,
}: {
  accelerator: HardwareAccelerator;
  detail?: string;
}) {
  const palette =
    accelerator === 'NPU'
      ? 'border-emerald-400/50 bg-emerald-500/15 text-emerald-200'
      : accelerator === 'GPU'
        ? 'border-cyan-400/50 bg-cyan-500/15 text-cyan-200'
        : accelerator === 'CPU'
          ? 'border-amber-400/50 bg-amber-500/15 text-amber-200'
          : 'border-white/10 bg-zinc-900 text-zinc-400';

  const label =
    accelerator === 'NPU'
      ? 'NPU / DSP'
      : accelerator === 'GPU'
        ? 'GPU'
        : accelerator === 'CPU'
          ? 'CPU (XNNPACK)'
          : 'Не загружена';

  return (
    <span
      title={detail || label}
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-bold ${palette}`}
    >
      {accelerator === 'NPU' || accelerator === 'GPU' ? (
        <Zap className="h-3 w-3" />
      ) : (
        <Cpu className="h-3 w-3" />
      )}
      <span>{label}</span>
    </span>
  );
}

export const AIModelManagerModal: React.FC = () => {
  const [modalReq, setModalReq] = useState<{
    open: boolean;
    focusModelId?: string | null;
    featureTitle?: string | null;
    autoPrepareIfReady?: boolean;
  }>({open: false});

  const [snapshot, setSnapshot] = useState<AIModelsStatusSnapshot | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [progressMap, setProgressMap] = useState<Record<string, number>>({});
  const [prepareResult, setPrepareResult] = useState<AIModelPrepareResult | null>(
    null
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    return subscribeAIModal((req) => {
      setModalReq(req);
      if (req.open) {
        setErrorMsg(null);
        setNotice(null);
      }
    });
  }, []);

  const refreshStatus = useCallback(async () => {
    setLoadingStatus(true);
    try {
      const next = await webcutAI.getAvailableModelsStatus();
      setSnapshot(next);
      return next;
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Не удалось получить статус AI'
      );
      return null;
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  useEffect(() => {
    if (!modalReq.open) return;

    let cancelled = false;
    const init = async () => {
      const st = await refreshStatus();
      if (cancelled || !st) return;

      if (modalReq.autoPrepareIfReady && modalReq.focusModelId) {
        const target = st.models.find((m) => m.id === modalReq.focusModelId);
        if (target?.status === 'ready' && st.environment === 'android') {
          setBusyAction(`prepare:${target.id}`);
          try {
            const prep = await webcutAI.prepareModel(target.id);
            if (!cancelled) {
              setPrepareResult(prep);
              setNotice(
                `Модель «${target.title}» загружена в RAM (${prep.accelerator}) за ${prep.loadTimeMs} мс`
              );
              await refreshStatus();
            }
          } catch (err) {
            if (!cancelled) {
              setErrorMsg(
                err instanceof Error ? err.message : 'Ошибка инициализации модели'
              );
            }
          } finally {
            if (!cancelled) setBusyAction(null);
          }
        }
      }
    };

    void init();

    const offProg = webcutAI.onDownloadProgress((ev) => {
      setProgressMap((prev) => ({...prev, [ev.modelId]: ev.progress}));
    });
    const offDone = webcutAI.onDownloadComplete((ev) => {
      setProgressMap((prev) => ({...prev, [ev.modelId]: 100}));
      setNotice(`Модель ${ev.fileName} скачана и проверена`);
      void refreshStatus();
    });
    const offErr = webcutAI.onDownloadError((ev) => {
      setErrorMsg(ev.message);
      setProgressMap((prev) => {
        const next = {...prev};
        delete next[ev.modelId];
        return next;
      });
      void refreshStatus();
    });

    return () => {
      cancelled = true;
      offProg();
      offDone();
      offErr();
    };
  }, [
    modalReq.open,
    modalReq.focusModelId,
    modalReq.autoPrepareIfReady,
    refreshStatus,
  ]);

  if (!modalReq.open) return null;

  const isAndroid = snapshot?.environment === 'android';

  const handleDownloadModel = async (model: AIModelInfo) => {
    setErrorMsg(null);
    setNotice(null);
    setBusyAction(`download:${model.id}`);
    try {
      await webcutAI.downloadModel(model.id);
      await refreshStatus();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Ошибка скачивания');
    } finally {
      setBusyAction(null);
    }
  };

  const handleImportZip = async () => {
    setErrorMsg(null);
    setNotice(null);
    setBusyAction('import_zip');
    try {
      const res = await webcutAI.importModelsZip();
      if (res.canceled) return;
      setNotice(
        `Импортировано файлов: ${res.importedCount} (${formatBytes(res.totalBytes)})`
      );
      await refreshStatus();
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Не удалось распаковать .zip-пак'
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handlePrepareModel = async (model: AIModelInfo) => {
    setErrorMsg(null);
    setNotice(null);
    setBusyAction(`prepare:${model.id}`);
    try {
      const res = await webcutAI.prepareModel(model.id);
      setPrepareResult(res);
      setNotice(
        res.reusedFromRam
          ? `Модель уже активна в RAM (${res.accelerator})`
          : `Загружена в RAM: ${res.acceleratorDetail} (${res.loadTimeMs} мс)`
      );
      await refreshStatus();
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Не удалось загрузить модель'
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleReleaseRam = async () => {
    setErrorMsg(null);
    setBusyAction('release');
    try {
      const res = await webcutAI.releaseActiveModel();
      setPrepareResult(null);
      if (res.releasedModelId) {
        setNotice(`Модель ${res.releasedModelId} выгружена из RAM`);
      }
      await refreshStatus();
    } finally {
      setBusyAction(null);
    }
  };

  const handleDeleteModel = async (model: AIModelInfo) => {
    setErrorMsg(null);
    setBusyAction(`delete:${model.id}`);
    try {
      await webcutAI.deleteModel(model.id);
      setNotice(`Файл ${model.fileName} удалён с устройства`);
      await refreshStatus();
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Не удалось удалить файл модели'
      );
    } finally {
      setBusyAction(null);
    }
  };

  const sortedModels = [...(snapshot?.models ?? [])].sort((a, b) => {
    if (a.id === modalReq.focusModelId) return -1;
    if (b.id === modalReq.focusModelId) return 1;
    return 0;
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 backdrop-blur-xs sm:items-center sm:p-4"
      onClick={closeAIModelManager}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="studio-scrollbar max-h-[90dvh] w-full max-w-lg space-y-4 overflow-y-auto rounded-t-3xl border border-white/15 bg-[#141418] p-5 shadow-2xl sm:rounded-2xl"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-violet-400/40 bg-violet-500/15">
              <Sparkles className="h-4.5 w-4.5 text-violet-300" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white">
                {modalReq.featureTitle || 'Локальный AI-движок (ONNX)'}
              </h2>
              <p className="text-[11px] text-zinc-400">
                Ленивая загрузка весов · 1 активная модель в RAM · NPU → GPU → CPU
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={closeAIModelManager}
            aria-label="Закрыть окно AI-моделей"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-zinc-300 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Hardware & RAM Singleton Status */}
        <div className="space-y-2.5 rounded-2xl border border-white/10 bg-zinc-900/70 p-3.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Cpu className="h-4 w-4 text-cyan-400" />
              <span className="text-xs font-semibold text-white">
                Аппаратный ускоритель и RAM
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <AcceleratorBadge
                accelerator={snapshot?.activeAccelerator ?? 'NONE'}
                detail={snapshot?.activeAcceleratorDetail}
              />
              <button
                type="button"
                disabled={loadingStatus}
                onClick={() => void refreshStatus()}
                title="Обновить статус"
                className="flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-zinc-950 text-zinc-400 hover:text-white"
              >
                <RefreshCw
                  className={`h-3 w-3 ${loadingStatus ? 'animate-spin' : ''}`}
                />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <div className="rounded-xl border border-white/10 bg-zinc-950/70 px-2.5 py-2">
              <p className="text-[10px] text-zinc-500">Платформа / SoC</p>
              <p className="truncate font-medium text-zinc-200">
                {snapshot?.deviceSoc || 'Определение...'}
              </p>
            </div>
            <div className="rounded-xl border border-white/10 bg-zinc-950/70 px-2.5 py-2">
              <p className="text-[10px] text-zinc-500">Занято на диске</p>
              <p className="font-mono font-medium text-zinc-200">
                {formatBytes(snapshot?.totalStorageBytes ?? 0)}
              </p>
            </div>
          </div>

          {snapshot?.activeModelId && (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[11px]">
              <div className="min-w-0">
                <p className="font-semibold text-emerald-200">
                  В RAM: {snapshot.activeModelId}
                </p>
                {snapshot.activeAcceleratorDetail && (
                  <p className="truncate text-[10px] text-emerald-300/80">
                    {snapshot.activeAcceleratorDetail}
                  </p>
                )}
              </div>
              <button
                type="button"
                disabled={busyAction === 'release'}
                onClick={() => void handleReleaseRam()}
                className="flex shrink-0 items-center gap-1 rounded-lg border border-emerald-400/40 bg-zinc-950 px-2.5 py-1 text-[10px] font-semibold text-emerald-200 hover:bg-emerald-500/20"
              >
                <Power className="h-3 w-3" />
                <span>Выгрузить</span>
              </button>
            </div>
          )}

          {!isAndroid && snapshot && (
            <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
              Вы открыли Web/PWA версию. Скачивание весов, распаковка .zip и
              каскадный запуск ONNX Runtime Mobile (NPU → GPU → CPU) работают
              внутри Android-приложения (APK ~17 МБ).
            </p>
          )}
        </div>

        {/* ZIP Pack Importer */}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-cyan-500/25 bg-cyan-500/5 p-3.5">
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-white">
              <FileArchive className="h-4 w-4 text-cyan-400" />
              <span>Импорт AI-пака (.zip)</span>
            </p>
            <p className="mt-0.5 text-[10px] leading-snug text-zinc-400">
              Безопасная распаковка .onnx / .tflite файлов во внутреннюю папку
              приложения (Zip Slip защита + проверка заголовков).
            </p>
          </div>
          <button
            type="button"
            disabled={busyAction === 'import_zip'}
            onClick={() => void handleImportZip()}
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-cyan-500 px-3 text-xs font-bold text-zinc-950 hover:bg-cyan-400 disabled:opacity-50"
          >
            {busyAction === 'import_zip' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FileArchive className="h-3.5 w-3.5" />
            )}
            <span>Выбрать .zip</span>
          </button>
        </div>

        {errorMsg && (
          <div className="rounded-xl border border-rose-500/35 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
            {errorMsg}
          </div>
        )}
        {notice && (
          <div className="rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
            {notice}
          </div>
        )}

        {/* Models Catalog */}
        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-zinc-300">
              Модули нейросетей
            </span>
            <span className="flex items-center gap-1 text-[10px] text-zinc-500">
              <HardDrive className="h-3 w-3" />
              filesDir/ai_models/
            </span>
          </div>

          {sortedModels.map((model) => {
            const focused = model.id === modalReq.focusModelId;
            const livePct =
              progressMap[model.id] ?? model.downloadProgress ?? 0;
            const isDownloading =
              model.status === 'downloading' ||
              busyAction === `download:${model.id}`;
            const isPreparing = busyAction === `prepare:${model.id}`;
            const isReady = model.status === 'ready';

            return (
              <div
                key={model.id}
                className={`space-y-2.5 rounded-2xl border p-3.5 transition ${
                  focused
                    ? 'border-violet-400/60 bg-violet-500/10'
                    : 'border-white/10 bg-zinc-900/60'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-bold text-white">
                        {model.title}
                      </span>
                      <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[9px] uppercase text-zinc-300">
                        .{model.format}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] leading-snug text-zinc-400">
                      {model.description}
                    </p>
                    <p className="mt-1 font-mono text-[10px] text-zinc-500">
                      {model.fileName}
                      {model.installedBytes > 0
                        ? ` · ${formatBytes(model.installedBytes)}`
                        : ''}
                    </p>
                  </div>

                  {model.isActiveInRam ? (
                    <AcceleratorBadge accelerator={model.accelerator} />
                  ) : isReady ? (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-emerald-500/35 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                      <CheckCircle2 className="h-3 w-3" />
                      Готова
                    </span>
                  ) : (
                    <span className="shrink-0 rounded-md border border-white/10 bg-zinc-950 px-2 py-0.5 text-[10px] font-medium text-zinc-400">
                      Не скачана
                    </span>
                  )}
                </div>

                {isDownloading && (
                  <div className="space-y-1">
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                      <div
                        style={{width: `${Math.min(100, Math.max(0, livePct))}%`}}
                        className="h-full bg-cyan-400 transition-all duration-150"
                      />
                    </div>
                    <div className="flex items-center justify-between text-[10px] text-zinc-400">
                      <span>Скачивание с GitHub Releases...</span>
                      <span className="font-mono text-cyan-300">{livePct}%</span>
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2 pt-0.5">
                  {!isReady && !isDownloading && (
                    <button
                      type="button"
                      onClick={() => void handleDownloadModel(model)}
                      className="flex h-8 items-center gap-1.5 rounded-lg bg-violet-500 px-3 text-[11px] font-bold text-white hover:bg-violet-400 active:scale-95"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>Скачать модель</span>
                    </button>
                  )}

                  {isDownloading && (
                    <button
                      type="button"
                      onClick={() => void webcutAI.cancelDownload(model.id)}
                      className="flex h-8 items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/15 px-3 text-[11px] font-semibold text-rose-200"
                    >
                      <X className="h-3.5 w-3.5" />
                      <span>Отмена</span>
                    </button>
                  )}

                  {isReady && (
                    <button
                      type="button"
                      disabled={isPreparing}
                      onClick={() => void handlePrepareModel(model)}
                      className="flex h-8 items-center gap-1.5 rounded-lg bg-cyan-500 px-3 text-[11px] font-bold text-zinc-950 hover:bg-cyan-400 disabled:opacity-50"
                    >
                      {isPreparing ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Play className="h-3.5 w-3.5" />
                      )}
                      <span>
                        {model.isActiveInRam
                          ? 'Активна в RAM'
                          : 'Загрузить в RAM'}
                      </span>
                    </button>
                  )}

                  {isReady && (
                    <button
                      type="button"
                      disabled={busyAction === `delete:${model.id}`}
                      onClick={() => void handleDeleteModel(model)}
                      className="flex h-8 items-center gap-1 rounded-lg border border-white/10 bg-zinc-950 px-2.5 text-[11px] text-zinc-400 hover:border-rose-400/50 hover:text-rose-300"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      <span>Удалить</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Cascade Diagnostics Log */}
        {(prepareResult?.cascadeLog?.length || snapshot?.cascadeLog?.length) ? (
          <div className="space-y-1.5 rounded-xl border border-white/10 bg-zinc-950 p-3">
            <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
              <span>Каскад инициализации железа</span>
            </p>
            <div className="space-y-0.5 font-mono text-[10px] text-zinc-400">
              {(prepareResult?.cascadeLog ?? snapshot?.cascadeLog ?? []).map(
                (line, idx) => (
                  <p key={idx} className="break-words">
                    {line}
                  </p>
                )
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};
