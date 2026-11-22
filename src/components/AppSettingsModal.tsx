import React, {useState} from 'react';
import {Check, ExternalLink, KeyRound, Settings, Trash2, X} from 'lucide-react';
import {
  GIPHY_API_KEY,
  getCustomGiphyApiKey,
  getEffectiveGiphyApiKey,
  saveCustomGiphyApiKey,
} from '../lib/giphyApi.ts';

interface AppSettingsModalProps {
  onClose: () => void;
  onKeyChanged?: () => void;
}

export const AppSettingsModal: React.FC<AppSettingsModalProps> = ({
  onClose,
  onKeyChanged,
}) => {
  const [giphyKeyInput, setGiphyKeyInput] = useState<string>(getCustomGiphyApiKey);
  const [savedNotice, setSavedNotice] = useState(false);

  const effectiveKey = getEffectiveGiphyApiKey();
  const hasEnvKey = Boolean(GIPHY_API_KEY);
  const hasCustomKey = Boolean(giphyKeyInput.trim());

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

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 backdrop-blur-xs sm:items-center sm:p-4"
      onClick={onClose}
    >
      <form
        onSubmit={handleSave}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md space-y-4 rounded-t-3xl border border-white/15 bg-[#141418] p-5 shadow-2xl sm:rounded-2xl"
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
                API-ключи и интеграции CutSync
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
