import React, {useCallback, useEffect, useState} from 'react';
import {
  Check,
  ExternalLink,
  FolderCog,
  FolderOpen,
  HardDrive,
  KeyRound,
  RotateCcw,
  Settings,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  GIPHY_API_KEY,
  getCustomGiphyApiKey,
  getEffectiveGiphyApiKey,
  saveCustomGiphyApiKey,
} from '../lib/giphyApi.ts';
import {
  cleanupUnusedMediaStorage,
  fetchServerStorageConfig,
  getNativeStorageConfig,
  pickNativeStorageFolder,
  pickServerStorageFolder,
  resetNativeStorageFolder,
  setNativeStorageFolder,
  updateServerStorageConfig,
} from '../lib/lanSyncBridge.ts';
import type {NativeStorageConfig} from '../lib/lanSyncBridge.ts';
import {
  clearClientAppRootCache,
  formatStorageBytes,
  getClientStorageSummary,
  pickClientDirectory,
  reauthorizeClientDirectory,
  resetClientDirectory,
} from '../lib/mediaStorage.ts';
import type {
  ClientStorageSummary,
  ServerStorageConfig,
} from '../lib/mediaStorage.ts';
import {isNativeCapacitorApp} from '../lib/serverConfig.ts';
import {openAIModelManager} from '../lib/webcutAi.ts';

interface AppSettingsModalProps {
  onClose: () => void;
  onKeyChanged?: () => void;
  onStorageChanged?: () => void;
}

export const AppSettingsModal: React.FC<AppSettingsModalProps> = ({
  onClose,
  onKeyChanged,
  onStorageChanged,
}) => {
  const [giphyKeyInput, setGiphyKeyInput] = useState<string>(getCustomGiphyApiKey);
  const [savedNotice, setSavedNotice] = useState(false);

  const [clientSummary, setClientSummary] = useState<ClientStorageSummary | null>(
    null
  );
  const [nativeConfig, setNativeConfig] = useState<NativeStorageConfig | null>(
    null
  );
  const [serverConfig, setServerConfig] = useState<ServerStorageConfig | null>(
    null
  );
  const [serverDirInput, setServerDirInput] = useState('');
  const [migrateExisting, setMigrateExisting] = useState(true);
  const [storageBusy, setStorageBusy] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [storageNotice, setStorageNotice] = useState<string | null>(null);

  const isNative = isNativeCapacitorApp();
  const effectiveKey = getEffectiveGiphyApiKey();
  const hasEnvKey = Boolean(GIPHY_API_KEY);
  const hasCustomKey = Boolean(giphyKeyInput.trim());

  const loadStorageInfo = useCallback(async () => {
    const [client, nativeCfg, srvCfg] = await Promise.all([
      getClientStorageSummary().catch(() => null),
      getNativeStorageConfig().catch(() => null),
      fetchServerStorageConfig().catch(() => null),
    ]);
    if (client) setClientSummary(client);
    if (nativeCfg) setNativeConfig(nativeCfg);
    if (srvCfg) {
      setServerConfig(srvCfg);
      setServerDirInput(srvCfg.currentDir);
    }
  }, []);

  useEffect(() => {
    void loadStorageInfo();
  }, [loadStorageInfo]);

  const showTempStorageNotice = (msg: string) => {
    setStorageError(null);
    setStorageNotice(msg);
    setTimeout(() => {
      setStorageNotice((cur) => (cur === msg ? null : cur));
    }, 3500);
  };

  const handlePickDeviceFolder = async () => {
    setStorageBusy(true);
    setStorageError(null);
    try {
      if (isNative && nativeConfig) {
        const res = await pickNativeStorageFolder(migrateExisting);
        if (res && !res.canceled) {
          setNativeConfig(res);
          onStorageChanged?.();
          showTempStorageNotice(
            res.migratedCount
              ? `Папка обновлена (${res.displayName}), перенесено файлов: ${res.migratedCount}`
              : `Папка обновлена: ${res.displayName}`
          );
        }
      } else {
        const {summary, copiedCount} = await pickClientDirectory(migrateExisting);
        setClientSummary(summary);
        onStorageChanged?.();
        showTempStorageNotice(
          copiedCount > 0
            ? `Выбрана папка «${summary.folderName}», перенесено файлов: ${copiedCount}`
            : `Выбрана папка «${summary.folderName}»`
        );
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return;
      }
      setStorageError(
        err instanceof Error
          ? err.message
          : 'Не удалось выбрать папку на устройстве'
      );
    } finally {
      setStorageBusy(false);
    }
  };

  const handleResetDeviceFolder = async () => {
    setStorageBusy(true);
    setStorageError(null);
    try {
      if (isNative && nativeConfig) {
        const res = await resetNativeStorageFolder(migrateExisting);
        if (res) {
          setNativeConfig(res);
          onStorageChanged?.();
          showTempStorageNotice('Папка сброшена на стандартную (корень приложения)');
        }
      } else {
        const summary = await resetClientDirectory();
        setClientSummary(summary);
        onStorageChanged?.();
        showTempStorageNotice('Папка сброшена на стандартную (корень приложения)');
      }
    } catch (err) {
      setStorageError(
        err instanceof Error ? err.message : 'Не удалось сбросить папку'
      );
    } finally {
      setStorageBusy(false);
    }
  };

  const handleReauthorizeClient = async () => {
    setStorageBusy(true);
    setStorageError(null);
    try {
      const summary = await reauthorizeClientDirectory();
      setClientSummary(summary);
      onStorageChanged?.();
      if (!summary.needsPermission) {
        showTempStorageNotice(`Доступ к папке «${summary.folderName}» подтверждён`);
      }
    } finally {
      setStorageBusy(false);
    }
  };

  const handleClearClientCache = async () => {
    setStorageBusy(true);
    try {
      const summary = await clearClientAppRootCache();
      setClientSummary(summary);
      onStorageChanged?.();
      showTempStorageNotice('Кэш внутренней папки очищен');
    } finally {
      setStorageBusy(false);
    }
  };

  const handleCleanupUnusedMedia = async () => {
    setStorageBusy(true);
    setStorageError(null);
    try {
      const res = await cleanupUnusedMediaStorage();
      await loadStorageInfo();
      onStorageChanged?.();
      if (res.deletedCount > 0) {
        showTempStorageNotice(
          `Удалено неиспользуемых файлов: ${res.deletedCount} (освобождено ${formatStorageBytes(res.freedBytes)})`
        );
      } else {
        showTempStorageNotice(
          'Все медиафайлы используются в проектах (лишних нет)'
        );
      }
    } catch (err) {
      setStorageError(
        err instanceof Error
          ? err.message
          : 'Не удалось очистить неиспользуемые файлы'
      );
    } finally {
      setStorageBusy(false);
    }
  };

  const handleNativePresetSelect = async (presetPath: string) => {
    setStorageBusy(true);
    setStorageError(null);
    try {
      const res = await setNativeStorageFolder(presetPath, migrateExisting);
      if (res) {
        setNativeConfig(res);
        onStorageChanged?.();
        showTempStorageNotice(`Папка переключена: ${res.displayName}`);
      }
    } catch (err) {
      setStorageError(
        err instanceof Error ? err.message : 'Не удалось переключить папку'
      );
    } finally {
      setStorageBusy(false);
    }
  };

  const handleApplyServerFolder = async (targetPath?: string) => {
    const dirPath = (targetPath ?? serverDirInput).trim();
    if (!dirPath) return;
    setStorageBusy(true);
    setStorageError(null);
    try {
      const next = await updateServerStorageConfig({
        dirPath,
        migrateExisting,
      });
      setServerConfig(next);
      setServerDirInput(next.currentDir);
      onStorageChanged?.();
      showTempStorageNotice(
        next.migratedCount
          ? `Папка хоста изменена, скопировано файлов: ${next.migratedCount}`
          : 'Папка хранения и обмена медиа на сервере обновлена'
      );
    } catch (err) {
      setStorageError(
        err instanceof Error ? err.message : 'Не удалось применить папку сервера'
      );
    } finally {
      setStorageBusy(false);
    }
  };

  const handleResetServerFolder = async () => {
    setStorageBusy(true);
    setStorageError(null);
    try {
      const next = await updateServerStorageConfig({
        reset: true,
        migrateExisting,
      });
      setServerConfig(next);
      setServerDirInput(next.currentDir);
      onStorageChanged?.();
      showTempStorageNotice('Серверная папка сброшена на стандартную (корень приложения)');
    } catch (err) {
      setStorageError(
        err instanceof Error ? err.message : 'Не удалось сбросить папку сервера'
      );
    } finally {
      setStorageBusy(false);
    }
  };

  const handlePickServerFolderNative = async () => {
    setStorageBusy(true);
    setStorageError(null);
    try {
      const picked = await pickServerStorageFolder();
      if (picked.supported && !picked.canceled && picked.dirPath) {
        setServerDirInput(picked.dirPath);
        await handleApplyServerFolder(picked.dirPath);
      }
    } catch (err) {
      setStorageError(
        err instanceof Error ? err.message : 'Не удалось выбрать папку'
      );
    } finally {
      setStorageBusy(false);
    }
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    saveCustomGiphyApiKey(giphyKeyInput);
    onKeyChanged?.();
    setSavedNotice(true);
    setTimeout(() => {
      setSavedNotice(false);
    }, 1500);
  };

  const handleClearCustom = () => {
    setGiphyKeyInput('');
    saveCustomGiphyApiKey('');
    onKeyChanged?.();
  };

  const deviceIsDefault = isNative && nativeConfig
    ? nativeConfig.isDefault
    : clientSummary?.isDefault ?? true;
  const deviceFolderLabel = isNative && nativeConfig
    ? nativeConfig.displayName
    : clientSummary?.folderName || 'Корень приложения';
  const deviceFilesCount = isNative && nativeConfig
    ? nativeConfig.filesCount
    : clientSummary?.filesCount ?? 0;
  const deviceTotalBytes = isNative && nativeConfig
    ? nativeConfig.totalBytes
    : clientSummary?.totalBytes ?? 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 backdrop-blur-xs sm:items-center sm:p-4"
      onClick={onClose}
    >
      <form
        onSubmit={handleSave}
        onClick={(e) => e.stopPropagation()}
        className="studio-scrollbar max-h-[90dvh] w-full max-w-lg space-y-4 overflow-y-auto rounded-t-3xl border border-white/15 bg-[#141418] p-5 shadow-2xl sm:rounded-2xl"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-cyan-500/30 bg-cyan-500/15">
              <Settings className="h-4.5 w-4.5 text-cyan-400" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white">
                Настройки приложения
              </h2>
              <p className="text-[11px] text-zinc-400">
                Папка сохранений медиа, обмен между устройствами и API
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть настройки"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-800 text-zinc-300 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Media Storage & Sync Folder Section */}
        <div className="space-y-3 rounded-2xl border border-cyan-500/25 bg-zinc-900/70 p-3.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <FolderCog className="h-4 w-4 text-cyan-400" />
              <span className="text-xs font-semibold text-white">
                Папка сохранений и обмена медиа
              </span>
            </div>
            <span
              className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold ${
                deviceIsDefault && (!serverConfig || serverConfig.isDefault)
                  ? 'border-cyan-500/30 bg-cyan-500/15 text-cyan-300'
                  : 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300'
              }`}
            >
              {deviceIsDefault && (!serverConfig || serverConfig.isDefault)
                ? 'По стандарту'
                : 'Своя папка'}
            </span>
          </div>

          <p className="text-[11px] leading-relaxed text-zinc-400">
            Все фото и видео, которые перекидываются между подключёнными
            устройствами, автоматически сохраняются здесь. По стандарту
            используется корневая папка внутри приложения.
          </p>

          {/* Local Device Folder Block */}
          <div className="space-y-2 rounded-xl border border-white/10 bg-zinc-950/70 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <HardDrive className="h-4 w-4 shrink-0 text-cyan-400" />
                <div className="min-w-0">
                  <p className="text-[11px] font-medium text-zinc-300">
                    На этом устройстве
                  </p>
                  <p className="truncate font-mono text-xs font-semibold text-white">
                    {deviceFolderLabel}
                  </p>
                </div>
              </div>
              <span className="shrink-0 text-[10px] text-zinc-400">
                {deviceFilesCount} файл. · {formatStorageBytes(deviceTotalBytes)}
              </span>
            </div>

            {isNative && nativeConfig?.currentDir && (
              <p className="break-all rounded-lg bg-zinc-900/80 px-2.5 py-1.5 font-mono text-[10px] text-zinc-400">
                {nativeConfig.currentDir}
              </p>
            )}

            {!isNative && clientSummary?.needsPermission && (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-200">
                <span className="flex items-center gap-1.5">
                  <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                  Браузер просит подтвердить доступ к выбранной папке
                </span>
                <button
                  type="button"
                  disabled={storageBusy}
                  onClick={() => void handleReauthorizeClient()}
                  className="shrink-0 rounded-lg bg-amber-400 px-2.5 py-1 text-[10px] font-bold text-zinc-950 hover:bg-amber-300"
                >
                  Разрешить
                </button>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              {(isNative || clientSummary?.supportsDirectoryPicker) && (
                <button
                  type="button"
                  disabled={storageBusy}
                  onClick={() => void handlePickDeviceFolder()}
                  className="flex h-8 items-center gap-1.5 rounded-lg bg-cyan-500 px-3 text-[11px] font-bold text-zinc-950 hover:bg-cyan-400 disabled:opacity-50"
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  <span>Выбрать папку...</span>
                </button>
              )}

              {!deviceIsDefault && (
                <button
                  type="button"
                  disabled={storageBusy}
                  onClick={() => void handleResetDeviceFolder()}
                  className="flex h-8 items-center gap-1 rounded-lg border border-white/10 bg-zinc-900 px-2.5 text-[11px] font-medium text-zinc-200 hover:border-cyan-400/50 disabled:opacity-50"
                >
                  <RotateCcw className="h-3 w-3" />
                  <span>По стандарту (корень)</span>
                </button>
              )}

              {!isNative && deviceIsDefault && deviceFilesCount > 0 && (
                <button
                  type="button"
                  disabled={storageBusy}
                  onClick={() => void handleClearClientCache()}
                  className="flex h-8 items-center gap-1 rounded-lg border border-white/10 bg-zinc-900 px-2.5 text-[11px] text-zinc-400 hover:border-rose-400/40 hover:text-rose-300"
                >
                  <Trash2 className="h-3 w-3" />
                  <span>Очистить кэш</span>
                </button>
              )}
            </div>

            {isNative && nativeConfig?.presets && nativeConfig.presets.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {nativeConfig.presets.map((preset) => (
                  <button
                    key={preset.path}
                    type="button"
                    disabled={storageBusy}
                    onClick={() => void handleNativePresetSelect(preset.path)}
                    className={`rounded-lg border px-2 py-1 text-[10px] font-medium transition ${
                      nativeConfig.currentDir === preset.path
                        ? 'border-cyan-400/60 bg-cyan-500/15 text-cyan-200'
                        : 'border-white/10 bg-zinc-900 text-zinc-400 hover:text-white'
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            )}

            {!isNative && !clientSummary?.supportsDirectoryPicker && (
              <p className="text-[10px] text-zinc-500">
                На этом браузере медиафайлы сохраняются во внутреннюю корневую
                папку приложения.
              </p>
            )}
          </div>

          {/* Host / Server Root Media Directory Block */}
          {serverConfig && (
            <div className="space-y-2 rounded-xl border border-white/10 bg-zinc-950/70 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] font-medium text-zinc-300">
                  Корневая папка обмена на хосте / сервере
                </p>
                <span className="text-[10px] text-zinc-400">
                  {serverConfig.filesCount} файл. ·{' '}
                  {formatStorageBytes(serverConfig.totalBytes)}
                </span>
              </div>

              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={serverDirInput}
                  onChange={(e) => setServerDirInput(e.target.value)}
                  placeholder={serverConfig.defaultDir}
                  aria-label="Путь к папке сохранений сервера"
                  className="h-9 min-w-0 flex-1 rounded-lg border border-white/15 bg-zinc-900 px-2.5 font-mono text-[11px] text-white placeholder:text-zinc-500 focus:border-cyan-400 focus:outline-none"
                />
                {serverConfig.canNativePick && (
                  <button
                    type="button"
                    disabled={storageBusy}
                    onClick={() => void handlePickServerFolderNative()}
                    title="Выбрать папку в проводнике"
                    className="flex h-9 shrink-0 items-center gap-1 rounded-lg border border-white/15 bg-zinc-900 px-2.5 text-[11px] font-semibold text-zinc-200 hover:border-cyan-400"
                  >
                    <FolderOpen className="h-3.5 w-3.5 text-cyan-400" />
                    <span>Обзор</span>
                  </button>
                )}
                <button
                  type="button"
                  disabled={storageBusy || !serverDirInput.trim()}
                  onClick={() => void handleApplyServerFolder()}
                  className="h-9 shrink-0 rounded-lg bg-zinc-800 px-3 text-[11px] font-semibold text-white hover:bg-cyan-500 hover:text-zinc-950 disabled:opacity-50"
                >
                  Применить
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                {serverConfig.presets.map((preset) => {
                  const active = serverConfig.currentDir === preset.path;
                  return (
                    <button
                      key={preset.path}
                      type="button"
                      disabled={storageBusy}
                      onClick={() =>
                        preset.isDefault
                          ? void handleResetServerFolder()
                          : void handleApplyServerFolder(preset.path)
                      }
                      className={`rounded-lg border px-2 py-1 text-[10px] font-medium transition ${
                        active
                          ? 'border-cyan-400/60 bg-cyan-500/15 text-cyan-200'
                          : 'border-white/10 bg-zinc-900 text-zinc-400 hover:text-white'
                      }`}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <label className="flex cursor-pointer items-center gap-2 text-[11px] text-zinc-300">
            <input
              type="checkbox"
              checked={migrateExisting}
              onChange={(e) => setMigrateExisting(e.target.checked)}
              className="h-3.5 w-3.5 accent-cyan-400"
            />
            <span>Переносить уже скачанные фото и видео при смене папки</span>
          </label>

          <div className="flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-zinc-950/60 px-3 py-2">
            <div className="min-w-0">
              <p className="text-[11px] font-medium text-zinc-200">
                Обслуживание папки медиа и проектов
              </p>
              <p className="text-[10px] text-zinc-500">
                Удаляет файлы из media/, на которые нет ссылок в projects/*.json
              </p>
            </div>
            <button
              type="button"
              disabled={storageBusy}
              onClick={() => void handleCleanupUnusedMedia()}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-rose-500/35 bg-rose-500/15 px-2.5 text-[11px] font-semibold text-rose-200 hover:bg-rose-500/25 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>Очистить неиспользуемые файлы</span>
            </button>
          </div>

          {storageError && (
            <p className="rounded-lg border border-rose-500/35 bg-rose-500/10 px-2.5 py-1.5 text-[11px] text-rose-300">
              {storageError}
            </p>
          )}
          {storageNotice && (
            <p className="rounded-lg border border-emerald-500/35 bg-emerald-500/10 px-2.5 py-1.5 text-[11px] text-emerald-300">
              {storageNotice}
            </p>
          )}
        </div>

        {/* Giphy Stickers API Section */}
        <div className="space-y-2.5 rounded-2xl border border-white/10 bg-zinc-900/60 p-3.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <KeyRound className="h-4 w-4 text-amber-400" />
              <span className="text-xs font-semibold text-white">
                Giphy Stickers API Key
              </span>
            </div>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                effectiveKey
                  ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                  : 'bg-zinc-800 text-zinc-400 border border-white/10'
              }`}
            >
              {hasCustomKey
                ? 'Свой ключ'
                : hasEnvKey
                  ? 'Из .env'
                  : 'Не задан'}
            </span>
          </div>

          <p className="text-[11px] leading-relaxed text-zinc-400">
            Используется для поиска и загрузки прозрачных анимированных стикеров
            через Giphy API. Ключ сохраняется локально на вашем устройстве.
          </p>

          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={giphyKeyInput}
              onChange={(e) => setGiphyKeyInput(e.target.value)}
              placeholder={
                hasEnvKey
                  ? 'Задан через VITE_GIPHY_API_KEY (можно переопределить)'
                  : 'Вставьте бесплатный Giphy API ключ...'
              }
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="h-10 min-w-0 flex-1 rounded-xl border border-white/15 bg-zinc-950 px-3 font-mono text-xs text-white placeholder:font-sans placeholder:text-zinc-500 focus:border-cyan-400 focus:outline-none"
            />
            {hasCustomKey && (
              <button
                type="button"
                onClick={handleClearCustom}
                title="Очистить сохранённый ключ"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-zinc-950 text-zinc-400 hover:border-rose-400/50 hover:text-rose-300"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>

          <a
            href="https://developers.giphy.com/dashboard/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[11px] font-medium text-cyan-400 hover:text-cyan-300"
          >
            <span>Получить бесплатный ключ на developers.giphy.com</span>
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>

        {/* Local AI Engine (ONNX Mobile) */}
        <div className="space-y-2.5 rounded-2xl border border-violet-500/25 bg-violet-500/5 p-3.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <Sparkles className="h-4 w-4 text-violet-300" />
              <span className="text-xs font-semibold text-white">
                Локальный AI-движок (ONNX Mobile)
              </span>
            </div>
            <span className="rounded-full border border-violet-400/35 bg-violet-500/15 px-2 py-0.5 text-[10px] font-semibold text-violet-200">
              NPU → GPU → CPU
            </span>
          </div>
          <p className="text-[11px] leading-relaxed text-zinc-400">
            Веса нейросетей не вшиты в APK и загружаются лениво во внутреннюю
            папку приложения (filesDir/ai_models) или из .zip-пака.
          </p>
          <button
            type="button"
            onClick={() => {
              onClose();
              openAIModelManager();
            }}
            className="flex h-9 w-full items-center justify-center gap-1.5 rounded-xl bg-violet-500 px-3 text-xs font-bold text-white hover:bg-violet-400 active:scale-[0.99]"
          >
            <Sparkles className="h-3.5 w-3.5" />
            <span>Модели AI и импорт .zip-пака</span>
          </button>
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-xl border border-white/10 bg-zinc-900 px-4 text-xs font-semibold text-zinc-300 hover:bg-zinc-800"
          >
            Закрыть
          </button>
          <button
            type="submit"
            className="flex h-10 items-center gap-1.5 rounded-xl bg-cyan-500 px-4 text-xs font-bold text-zinc-950 hover:bg-cyan-400 active:scale-95"
          >
            {savedNotice ? (
              <>
                <Check className="h-4 w-4" />
                <span>Сохранено</span>
              </>
            ) : (
              <span>Сохранить</span>
            )}
          </button>
        </div>
      </form>
    </div>
  );
};
