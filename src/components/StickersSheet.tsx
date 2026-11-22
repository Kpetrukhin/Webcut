import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  KeyRound,
  Loader2,
  RefreshCw,
  Search,
  Settings,
  Smile,
  Sparkles,
  X,
} from 'lucide-react';
import {
  downloadStickerAsFile,
  fetchTrendingStickers,
  getEffectiveGiphyApiKey,
  GiphyApiError,
  searchStickers,
} from '../lib/giphyApi.ts';
import type {GiphyStickerItem} from '../lib/giphyApi.ts';
import {uploadFileForP2P} from '../lib/lanSyncBridge.ts';

interface StickersSheetProps {
  onSelectSticker: (opts: {
    name: string;
    src: string;
    fileName?: string;
    remoteUrl?: string;
  }) => void;
  onOpenSettings: () => void;
  onClose: () => void;
  keyVersion?: number;
}

const QUICK_TAGS = [
  {label: 'В тренде', query: ''},
  {label: 'Огонь', query: 'fire'},
  {label: 'Смех', query: 'laugh'},
  {label: 'Сердце', query: 'heart'},
  {label: 'Стрелка', query: 'arrow'},
  {label: 'Вау', query: 'wow'},
  {label: 'Лайк', query: 'like'},
  {label: 'Салют', query: 'sparkle'},
];

export const StickersSheet: React.FC<StickersSheetProps> = ({
  onSelectSticker,
  onOpenSettings,
  onClose,
  keyVersion = 0,
}) => {
  const [queryInput, setQueryInput] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [stickers, setStickers] = useState<GiphyStickerItem[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [needsKey, setNeedsKey] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const loadStickers = useCallback(
    async (query: string, offset: number, append: boolean) => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
      setErrorMsg(null);
      setNeedsKey(false);

      try {
        const page = query.trim()
          ? await searchStickers({
              query,
              limit: 30,
              offset,
              signal: ctrl.signal,
            })
          : await fetchTrendingStickers({
              limit: 30,
              offset,
              signal: ctrl.signal,
            });
        if (ctrl.signal.aborted) return;
        setTotalCount(page.totalCount);
        setStickers((prev) =>
          append
            ? [
                ...prev,
                ...page.items.filter((n) => !prev.some((p) => p.id === n.id)),
              ]
            : page.items
        );
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
        if (err instanceof GiphyApiError) {
          setNeedsKey(
            err.code === 'MISSING_KEY' || err.code === 'INVALID_KEY'
          );
          setErrorMsg(err.message);
        } else {
          setErrorMsg(
            err instanceof Error
              ? err.message
              : 'Не удалось загрузить стикеры Giphy'
          );
        }
        if (!append) setStickers([]);
      } finally {
        if (!ctrl.signal.aborted) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    []
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      setActiveQuery(queryInput);
    }, 320);
    return () => clearTimeout(timer);
  }, [queryInput]);

  useEffect(() => {
    void loadStickers(activeQuery, 0, false);
    return () => abortRef.current?.abort();
  }, [activeQuery, keyVersion, loadStickers]);

  const handlePickSticker = async (sticker: GiphyStickerItem) => {
    if (downloadingId) return;
    setDownloadingId(sticker.id);
    setErrorMsg(null);
    try {
      const file = await downloadStickerAsFile(sticker);
      const prepared = await uploadFileForP2P(file, 'image');
      onSelectSticker({
        name: sticker.title.slice(0, 22) || 'Стикер',
        src: prepared.localSrc,
        fileName: prepared.fileName,
        remoteUrl: prepared.shareUrl,
      });
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Не удалось кэшировать стикер в проект'
      );
    } finally {
      setDownloadingId(null);
    }
  };

  const hasKey = Boolean(getEffectiveGiphyApiKey());
  const canLoadMore = stickers.length > 0 && stickers.length < totalCount;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 backdrop-blur-xs sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[82dvh] w-full max-w-xl flex-col rounded-t-3xl border border-white/15 bg-[#121216] shadow-2xl sm:max-h-[78dvh] sm:rounded-2xl"
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
          <div className="flex items-center gap-2">
            <Smile className="h-5 w-5 text-amber-400" />
            <div>
              <h3 className="text-sm font-semibold text-white">
                Стикеры Giphy
              </h3>
              <p className="text-[10px] text-zinc-400">
                Прозрачный фон · WebP / GIF · кэш проекта
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onOpenSettings}
              title="Настроить Giphy API ключ"
              aria-label="Настройки Giphy API"
              className="flex h-8 items-center gap-1 rounded-full border border-white/10 bg-zinc-900 px-2.5 text-[11px] font-medium text-zinc-300 hover:border-cyan-400/60 hover:text-white"
            >
              <Settings className="h-3.5 w-3.5 text-cyan-400" />
              <span className="hidden sm:inline">API ключ</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Закрыть панель стикеров"
              className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-800 text-zinc-300 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Search Bar + Quick Tags */}
        <div className="shrink-0 space-y-2 border-b border-white/10 px-4 py-2.5">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setActiveQuery(queryInput);
              void loadStickers(queryInput, 0, false);
            }}
            className="flex items-center gap-2"
          >
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-zinc-500" />
              <input
                type="search"
                value={queryInput}
                onChange={(e) => setQueryInput(e.target.value)}
                placeholder="Поиск стикеров (например: fire, reaction, neon)..."
                className="h-10 w-full rounded-xl border border-white/15 bg-zinc-950 pr-8 pl-9 text-xs text-white placeholder:text-zinc-500 focus:border-cyan-400 focus:outline-none sm:text-sm"
              />
              {queryInput && (
                <button
                  type="button"
                  onClick={() => {
                    setQueryInput('');
                    setActiveQuery('');
                  }}
                  aria-label="Очистить поиск"
                  className="absolute top-1/2 right-2.5 -translate-y-1/2 text-zinc-400 hover:text-white"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => void loadStickers(activeQuery, 0, false)}
              disabled={loading}
              title="Обновить"
              aria-label="Обновить стикеры"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-zinc-900 text-zinc-300 hover:border-cyan-400/60 hover:text-white disabled:opacity-40"
            >
              <RefreshCw
                className={`h-4 w-4 ${loading ? 'animate-spin text-cyan-400' : ''}`}
              />
            </button>
          </form>

          <div className="no-scrollbar flex items-center gap-1.5 overflow-x-auto pb-0.5">
            {QUICK_TAGS.map((tag) => {
              const active = activeQuery.trim() === tag.query;
              return (
                <button
                  key={tag.label}
                  type="button"
                  onClick={() => {
                    setQueryInput(tag.query);
                    setActiveQuery(tag.query);
                  }}
                  className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium transition ${
                    active
                      ? 'border-amber-400 bg-amber-500/20 text-amber-200'
                      : 'border-white/10 bg-zinc-900 text-zinc-300 hover:border-white/25'
                  }`}
                >
                  {tag.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Sticker Grid Body */}
        <div className="studio-scrollbar min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
          {errorMsg && (
            <div className="mb-3 flex flex-col items-center gap-2.5 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-center">
              <KeyRound className="h-6 w-6 text-amber-400" />
              <p className="text-xs leading-relaxed text-amber-100">
                {errorMsg}
              </p>
              {(!hasKey || needsKey) && (
                <button
                  type="button"
                  onClick={onOpenSettings}
                  className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-amber-400 px-3.5 text-xs font-bold text-zinc-950 hover:bg-amber-300 active:scale-95"
                >
                  <Settings className="h-3.5 w-3.5" />
                  <span>Вставить Giphy API ключ</span>
                </button>
              )}
            </div>
          )}

          {loading ? (
            <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4">
              {Array.from({length: 12}).map((_, idx) => (
                <div
                  key={idx}
                  className="aspect-square animate-pulse rounded-2xl border border-white/10 bg-zinc-900/80"
                />
              ))}
            </div>
          ) : stickers.length === 0 && !errorMsg ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-zinc-400">
              <Sparkles className="h-7 w-7 text-zinc-600" />
              <p className="text-xs">
                По запросу «{activeQuery}» стикеры не найдены.
              </p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4">
                {stickers.map((st) => {
                  const isBusy = downloadingId === st.id;
                  return (
                    <button
                      key={st.id}
                      type="button"
                      disabled={Boolean(downloadingId)}
                      onClick={() => void handlePickSticker(st)}
                      title={st.title}
                      style={{
                        backgroundImage:
                          'linear-gradient(45deg, rgba(255,255,255,0.04) 25%, transparent 25%), linear-gradient(-45deg, rgba(255,255,255,0.04) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(255,255,255,0.04) 75%), linear-gradient(-45deg, transparent 75%, rgba(255,255,255,0.04) 75%)',
                        backgroundSize: '14px 14px',
                        backgroundPosition: '0 0, 0 7px, 7px -7px, -7px 0',
                      }}
                      className="group relative flex aspect-square items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-zinc-950/90 p-2 transition hover:border-amber-400/70 active:scale-95 disabled:opacity-60"
                    >
                      <img
                        src={st.previewUrl}
                        alt={st.title}
                        loading="lazy"
                        className="h-full w-full object-contain transition duration-150 group-hover:scale-105"
                      />
                      {isBusy && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-zinc-950/80 backdrop-blur-xs">
                          <Loader2 className="h-5 w-5 animate-spin text-amber-400" />
                          <span className="text-[10px] font-semibold text-amber-200">
                            Кэш...
                          </span>
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>

              {canLoadMore && (
                <div className="mt-4 flex justify-center">
                  <button
                    type="button"
                    disabled={loadingMore}
                    onClick={() =>
                      void loadStickers(activeQuery, stickers.length, true)
                    }
                    className="flex h-9 items-center gap-1.5 rounded-xl border border-white/15 bg-zinc-900 px-4 text-xs font-semibold text-zinc-200 hover:border-cyan-400 disabled:opacity-50"
                  >
                    {loadingMore ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        <span>Загрузка...</span>
                      </>
                    ) : (
                      <span>Загрузить ещё</span>
                    )}
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer attribution */}
        <div className="flex shrink-0 items-center justify-between border-t border-white/10 px-4 py-2 text-[10px] text-zinc-500">
          <span>Powered by GIPHY</span>
          <span>Нажмите на стикер для добавления на холст</span>
        </div>
      </div>
    </div>
  );
};
