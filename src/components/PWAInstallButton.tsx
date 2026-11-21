import React, {useState} from 'react';
import {Download, WifiOff, X} from 'lucide-react';
import {useOnlineStatus} from '../hooks/useOnlineStatus.ts';
import {usePWAInstall} from '../hooks/usePWAInstall.ts';

export const PWAInstallButton: React.FC = () => {
  const {isInstallable, isInstalled, isIOS, install} = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) return null;

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={install}
        title="Установить как приложение"
        className="flex h-9 items-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-2.5 text-xs font-medium text-cyan-300 hover:bg-cyan-500/20 active:scale-95 whitespace-nowrap shrink-0"
      >
        <Download className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Установить</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          title="Установить на iPhone"
          className="flex h-9 items-center gap-1 rounded-lg border border-white/15 bg-zinc-900 px-2.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 whitespace-nowrap shrink-0"
        >
          <Download className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">На экран</span>
        </button>

        {showIOSGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-xs">
            <div className="w-full max-w-sm rounded-2xl border border-white/15 bg-[#141418] p-5 shadow-2xl">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold text-white">
                  Установить CutSync на iPhone
                </h3>
                <button
                  type="button"
                  onClick={() => setShowIOSGuide(false)}
                  aria-label="Закрыть инструкцию"
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-800 text-zinc-400"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <ol className="mt-3 space-y-2 text-sm text-zinc-300">
                <li>1. Нажмите кнопку «Поделиться» в нижней панели Safari.</li>
                <li>2. Выберите «На экран «Домой»» (Add to Home Screen).</li>
                <li>3. Запускайте редактор как отдельное приложение без браузера.</li>
              </ol>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="mt-4 h-11 w-full rounded-xl bg-cyan-500 text-sm font-semibold text-zinc-950"
              >
                Понятно
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div className="fixed bottom-20 left-4 z-50 flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-950/90 px-3 py-2 text-xs font-medium text-amber-200 shadow-lg backdrop-blur-md">
      <WifiOff className="h-3.5 w-3.5 text-amber-400" />
      <span>Нет сети — изменения сохранятся после подключения</span>
    </div>
  );
};
