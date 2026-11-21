import React, {useEffect, useState} from 'react';
import {
  Check,
  Copy,
  Film,
  Layers,
  Music,
  Plus,
  Send,
  Sparkles,
  Type,
  Upload,
  Users,
  X,
} from 'lucide-react';
import {
  SAMPLE_MEDIA_ASSETS,
  SYNTH_AUDIO_PRESETS,
} from '../shared/types.ts';
import type {
  ChatMessage,
  Clip,
  Collaborator,
  FilterPreset,
  MotionEffect,
  TrackType,
  TransitionType,
} from '../shared/types.ts';

export type ActiveToolTab =
  | 'edit'
  | 'media'
  | 'text'
  | 'effects'
  | 'audio'
  | 'team';

interface MediaPanelProps {
  onAddMediaClip: (opts: {
    name: string;
    kind: 'video' | 'image';
    src: string;
    duration: number;
    track: 'video' | 'overlay';
  }) => void;
  onClose?: () => void;
}

export const MediaPanel: React.FC<MediaPanelProps> = ({
  onAddMediaClip,
  onClose,
}) => {
  const [targetTrack, setTargetTrack] = useState<'video' | 'overlay'>('video');
  const [uploading, setUploading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const probeMediaDuration = (
    url: string,
    kind: 'video' | 'image'
  ): Promise<number> => {
    if (kind === 'image') return Promise.resolve(4.5);
    return new Promise((resolve) => {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.onloadedmetadata = () => {
        const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 5;
        resolve(Math.round(d * 10) / 10);
      };
      v.onerror = () => resolve(5);
      v.src = url;
    });
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    setErrorMsg(null);

    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append('file', file);
        const res = await fetch('/api/upload', {method: 'POST', body: form});
        const data = (await res.json()) as {
          name?: string;
          kind?: 'video' | 'image' | 'audio';
          src?: string;
          error?: string;
        };
        if (!res.ok || !data.src) {
          throw new Error(data.error || 'Ошибка загрузки');
        }
        const mediaKind = data.kind === 'video' ? 'video' : 'image';
        const dur = await probeMediaDuration(data.src, mediaKind);
        onAddMediaClip({
          name: data.name || file.name,
          kind: mediaKind,
          src: data.src,
          duration: Math.min(30, dur),
          track: targetTrack,
        });
      }
      onClose?.();
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Не удалось загрузить файл'
      );
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-zinc-400">
          Куда добавить:
        </span>
        <div className="flex rounded-lg bg-zinc-900 p-1 border border-white/10">
          <button
            type="button"
            onClick={() => setTargetTrack('video')}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
              targetTrack === 'video'
                ? 'bg-cyan-500 text-zinc-950'
                : 'text-zinc-300 hover:text-white'
            }`}
          >
            <Film className="h-3.5 w-3.5" />
            Видео
          </button>
          <button
            type="button"
            onClick={() => setTargetTrack('overlay')}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
              targetTrack === 'overlay'
                ? 'bg-cyan-500 text-zinc-950'
                : 'text-zinc-300 hover:text-white'
            }`}
          >
            <Layers className="h-3.5 w-3.5" />
            Слой (PIP)
          </button>
        </div>
      </div>

      {/* Upload from Phone / PC */}
      <label className="flex min-h-[56px] cursor-pointer items-center justify-center gap-2.5 rounded-xl border border-dashed border-cyan-500/40 bg-cyan-500/10 px-4 py-3 text-sm font-medium text-cyan-200 transition hover:bg-cyan-500/15 active:scale-[0.99]">
        <Upload className="h-4 w-4 shrink-0 text-cyan-400" />
        <span>
          {uploading
            ? 'Загрузка на сервер...'
            : 'Загрузить видео или фото с устройства'}
        </span>
        <input
          type="file"
          accept="video/*,image/*"
          multiple
          disabled={uploading}
          onChange={handleFileChange}
          className="hidden"
        />
      </label>

      {errorMsg && (
        <p className="text-xs text-rose-400">{errorMsg}</p>
      )}

      <div>
        <p className="mb-2 text-xs font-medium text-zinc-400">
          Готовые сцены для быстрого монтажа
        </p>
        <div className="grid grid-cols-3 gap-2.5">
          {SAMPLE_MEDIA_ASSETS.map((asset) => (
            <button
              key={asset.id}
              type="button"
              onClick={() => {
                onAddMediaClip({
                  name: asset.name,
                  kind: 'image',
                  src: asset.src,
                  duration: asset.duration,
                  track: targetTrack,
                });
                onClose?.();
              }}
              className="group relative aspect-[9/16] overflow-hidden rounded-xl border border-white/10 bg-zinc-900 text-left transition hover:border-cyan-400 active:scale-[0.97]"
            >
              <img
                src={asset.src}
                alt={asset.name}
                referrerPolicy="no-referrer"
                className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
              />
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent p-2">
                <span className="block truncate text-[11px] font-medium text-white">
                  {asset.name}
                </span>
              </div>
              <span className="absolute top-1.5 right-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white">
                <Plus className="h-3.5 w-3.5" />
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

interface TextPanelProps {
  selectedClip: Clip | null;
  onAddText: (text: string) => void;
  onUpdateClip: (clipId: string, patch: Partial<Clip>) => void;
}

const TEXT_COLORS = [
  '#ffffff',
  '#22d3ee',
  '#facc15',
  '#fb7185',
  '#34d399',
  '#09090b',
];

const TEXT_BG_COLORS = [
  'rgba(9, 9, 11, 0.72)',
  'rgba(34, 211, 238, 0.85)',
  'rgba(249, 115, 22, 0.85)',
  'rgba(255, 255, 255, 0.9)',
  'transparent',
];

export const TextPanel: React.FC<TextPanelProps> = ({
  selectedClip,
  onAddText,
  onUpdateClip,
}) => {
  const [draftText, setDraftText] = useState('НОВЫЙ ТИТР');
  const isTextSelected = selectedClip?.track === 'text';

  const style = selectedClip?.textStyle ?? {
    fontSize: 48,
    color: '#ffffff',
    bgColor: 'rgba(9, 9, 11, 0.72)',
    fontWeight: 'bold' as const,
    x: 0.5,
    y: 0.78,
    align: 'center' as const,
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <input
          type="text"
          value={isTextSelected ? selectedClip.text ?? '' : draftText}
          onChange={(e) => {
            if (isTextSelected) {
              onUpdateClip(selectedClip.id, {text: e.target.value});
            } else {
              setDraftText(e.target.value);
            }
          }}
          placeholder="Введите текст титра..."
          className="h-11 flex-1 rounded-xl border border-white/10 bg-zinc-900 px-3 text-sm text-white placeholder:text-zinc-500 focus:border-cyan-400 focus:outline-none"
        />
        <button
          type="button"
          onClick={() => onAddText(draftText || 'ТИТР')}
          className="flex h-11 shrink-0 items-center gap-1.5 rounded-xl bg-cyan-500 px-4 text-xs font-semibold text-zinc-950 hover:bg-cyan-400 active:scale-95 whitespace-nowrap"
        >
          <Plus className="h-4 w-4" />
          Добавить
        </button>
      </div>

      {isTextSelected ? (
        <div className="space-y-3 border-t border-white/10 pt-3">
          <div>
            <div className="mb-1.5 flex justify-between text-xs text-zinc-400">
              <span>Размер шрифта</span>
              <span className="font-mono tabular-nums text-zinc-200">
                {style.fontSize}px
              </span>
            </div>
            <input
              type="range"
              min={24}
              max={96}
              value={style.fontSize}
              onChange={(e) =>
                onUpdateClip(selectedClip.id, {
                  textStyle: {...style, fontSize: Number(e.target.value)},
                })
              }
              className="w-full accent-cyan-400"
            />
          </div>

          <div>
            <p className="mb-1.5 text-xs text-zinc-400">Цвет текста</p>
            <div className="flex flex-wrap gap-2">
              {TEXT_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() =>
                    onUpdateClip(selectedClip.id, {
                      textStyle: {...style, color: c},
                    })
                  }
                  style={{backgroundColor: c}}
                  aria-label={`Цвет текста ${c}`}
                  className={`h-9 w-9 rounded-full border-2 transition ${
                    style.color === c
                      ? 'border-cyan-400 scale-110'
                      : 'border-white/20'
                  }`}
                />
              ))}
            </div>
          </div>

          <div>
            <p className="mb-1.5 text-xs text-zinc-400">Подложка текста</p>
            <div className="flex flex-wrap gap-2">
              {TEXT_BG_COLORS.map((bg) => (
                <button
                  key={bg}
                  type="button"
                  onClick={() =>
                    onUpdateClip(selectedClip.id, {
                      textStyle: {...style, bgColor: bg},
                    })
                  }
                  style={{
                    backgroundColor: bg === 'transparent' ? '#18181b' : bg,
                  }}
                  className={`flex h-9 min-w-[44px] items-center justify-center rounded-lg border px-2 text-[11px] font-medium transition ${
                    style.bgColor === bg
                      ? 'border-cyan-400 text-cyan-300'
                      : 'border-white/15 text-zinc-300'
                  }`}
                >
                  {bg === 'transparent' ? 'Без' : 'Aa'}
                </button>
              ))}
            </div>
          </div>
          <p className="text-[11px] text-zinc-500">
            Перетаскивайте текст пальцем или мышью прямо на экране предпросмотра.
          </p>
        </div>
      ) : (
        <p className="text-xs text-zinc-400">
          Нажмите «Добавить», чтобы создать титр на текущем времени, или выберите существующий титр на дорожке «Текст».
        </p>
      )}
    </div>
  );
};

interface EffectsPanelProps {
  selectedClip: Clip | null;
  onUpdateClip: (clipId: string, patch: Partial<Clip>) => void;
}

const FILTER_PRESETS: Array<{id: FilterPreset; label: string}> = [
  {id: 'none', label: 'Оригинал'},
  {id: 'cinema', label: 'Кино'},
  {id: 'warm', label: 'Тёплый'},
  {id: 'cool', label: 'Холод'},
  {id: 'vivid', label: 'Яркий'},
  {id: 'vintage', label: 'Винтаж'},
  {id: 'bw', label: 'Ч/Б'},
];

const TRANSITIONS: Array<{id: TransitionType; label: string}> = [
  {id: 'none', label: 'Нет'},
  {id: 'fade', label: 'Плавный'},
  {id: 'zoom', label: 'Зум'},
  {id: 'slide', label: 'Слайд'},
];

const MOTIONS: Array<{id: MotionEffect; label: string}> = [
  {id: 'none', label: 'Статика'},
  {id: 'kenburns-in', label: 'Наезд'},
  {id: 'kenburns-out', label: 'Отлёт'},
  {id: 'pan-left', label: 'Влево'},
  {id: 'pan-right', label: 'Вправо'},
];

export const EffectsPanel: React.FC<EffectsPanelProps> = ({
  selectedClip,
  onUpdateClip,
}) => {
  if (!selectedClip || selectedClip.track === 'audio') {
    return (
      <div className="rounded-xl border border-white/10 bg-zinc-900/60 p-4 text-center text-xs text-zinc-400">
        Выберите видео, фото, слой или титр на таймлайне, чтобы настроить фильтры и анимацию.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 text-xs font-medium text-zinc-400">Цветовой фильтр</p>
        <div className="flex flex-wrap gap-1.5">
          {FILTER_PRESETS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => onUpdateClip(selectedClip.id, {filter: f.id})}
              className={`min-h-[38px] rounded-lg px-3 text-xs font-medium transition whitespace-nowrap ${
                selectedClip.filter === f.id
                  ? 'bg-cyan-500 text-zinc-950'
                  : 'bg-zinc-900 text-zinc-300 border border-white/10 hover:border-white/25'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="mb-2 text-xs font-medium text-zinc-400">Переход в начале</p>
        <div className="grid grid-cols-4 gap-1.5">
          {TRANSITIONS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onUpdateClip(selectedClip.id, {transitionIn: t.id})}
              className={`min-h-[38px] rounded-lg px-2 text-xs font-medium transition whitespace-nowrap ${
                selectedClip.transitionIn === t.id
                  ? 'bg-cyan-500 text-zinc-950'
                  : 'bg-zinc-900 text-zinc-300 border border-white/10'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {(selectedClip.track === 'video' || selectedClip.track === 'overlay') && (
        <div>
          <p className="mb-2 text-xs font-medium text-zinc-400">Движение камеры</p>
          <div className="flex flex-wrap gap-1.5">
            {MOTIONS.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() =>
                  onUpdateClip(selectedClip.id, {motionEffect: m.id})
                }
                className={`min-h-[38px] rounded-lg px-3 text-xs font-medium transition whitespace-nowrap ${
                  selectedClip.motionEffect === m.id
                    ? 'bg-cyan-500 text-zinc-950'
                    : 'bg-zinc-900 text-zinc-300 border border-white/10'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 border-t border-white/10 pt-3">
        <label className="space-y-1 text-xs text-zinc-400">
          <div className="flex justify-between">
            <span>Яркость</span>
            <span className="font-mono tabular-nums text-zinc-200">
              {Math.round(selectedClip.brightness * 100)}%
            </span>
          </div>
          <input
            type="range"
            min={0.5}
            max={1.5}
            step={0.05}
            value={selectedClip.brightness}
            onChange={(e) =>
              onUpdateClip(selectedClip.id, {
                brightness: Number(e.target.value),
              })
            }
            className="w-full accent-cyan-400"
          />
        </label>

        <label className="space-y-1 text-xs text-zinc-400">
          <div className="flex justify-between">
            <span>Контраст</span>
            <span className="font-mono tabular-nums text-zinc-200">
              {Math.round(selectedClip.contrast * 100)}%
            </span>
          </div>
          <input
            type="range"
            min={0.5}
            max={1.5}
            step={0.05}
            value={selectedClip.contrast}
            onChange={(e) =>
              onUpdateClip(selectedClip.id, {contrast: Number(e.target.value)})
            }
            className="w-full accent-cyan-400"
          />
        </label>

        <label className="space-y-1 text-xs text-zinc-400">
          <div className="flex justify-between">
            <span>Насыщенность</span>
            <span className="font-mono tabular-nums text-zinc-200">
              {Math.round(selectedClip.saturate * 100)}%
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={selectedClip.saturate}
            onChange={(e) =>
              onUpdateClip(selectedClip.id, {saturate: Number(e.target.value)})
            }
            className="w-full accent-cyan-400"
          />
        </label>

        <label className="space-y-1 text-xs text-zinc-400">
          <div className="flex justify-between">
            <span>Прозрачность</span>
            <span className="font-mono tabular-nums text-zinc-200">
              {Math.round(selectedClip.opacity * 100)}%
            </span>
          </div>
          <input
            type="range"
            min={0.1}
            max={1}
            step={0.05}
            value={selectedClip.opacity}
            onChange={(e) =>
              onUpdateClip(selectedClip.id, {opacity: Number(e.target.value)})
            }
            className="w-full accent-cyan-400"
          />
        </label>
      </div>
    </div>
  );
};

interface AudioPanelProps {
  selectedClip: Clip | null;
  onAddAudioClip: (opts: {
    name: string;
    kind: 'audio' | 'synth';
    src: string;
    duration: number;
  }) => void;
  onUpdateClip: (clipId: string, patch: Partial<Clip>) => void;
  onClose?: () => void;
}

export const AudioPanel: React.FC<AudioPanelProps> = ({
  selectedClip,
  onAddAudioClip,
  onUpdateClip,
  onClose,
}) => {
  const [uploading, setUploading] = useState(false);

  const handleAudioUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/upload', {method: 'POST', body: form});
      const data = (await res.json()) as {
        name?: string;
        src?: string;
        error?: string;
      };
      if (!res.ok || !data.src) throw new Error(data.error || 'Ошибка загрузки');

      const audio = new Audio(data.src);
      const dur = await new Promise<number>((resolve) => {
        audio.onloadedmetadata = () =>
          resolve(Number.isFinite(audio.duration) ? audio.duration : 10);
        audio.onerror = () => resolve(10);
      });

      onAddAudioClip({
        name: data.name || file.name,
        kind: 'audio',
        src: data.src,
        duration: Math.min(60, Math.round(dur * 10) / 10),
      });
      onClose?.();
    } catch {
      // keep panel open on failure
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  return (
    <div className="space-y-4">
      <label className="flex min-h-[52px] cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm font-medium text-emerald-200 hover:bg-emerald-500/15">
        <Upload className="h-4 w-4 text-emerald-400" />
        <span>
          {uploading ? 'Загрузка аудио...' : 'Загрузить музыку (MP3 / WAV)'}
        </span>
        <input
          type="file"
          accept="audio/*"
          disabled={uploading}
          onChange={handleAudioUpload}
          className="hidden"
        />
      </label>

      {selectedClip &&
        (selectedClip.track === 'audio' || selectedClip.kind === 'video') && (
          <div className="rounded-xl border border-white/10 bg-zinc-900/70 p-3">
            <div className="mb-1 flex justify-between text-xs text-zinc-300">
              <span>Громкость: {selectedClip.name}</span>
              <span className="font-mono tabular-nums">
                {Math.round(selectedClip.volume * 100)}%
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={selectedClip.volume}
              onChange={(e) =>
                onUpdateClip(selectedClip.id, {volume: Number(e.target.value)})
              }
              className="w-full accent-emerald-400"
            />
          </div>
        )}

      <div>
        <p className="mb-2 text-xs font-medium text-zinc-400">
          Встроенные саундтреки (Web Audio)
        </p>
        <div className="space-y-2">
          {SYNTH_AUDIO_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => {
                onAddAudioClip({
                  name: preset.name,
                  kind: 'synth',
                  src: preset.src,
                  duration: preset.duration,
                });
                onClose?.();
              }}
              className="flex min-h-[48px] w-full items-center justify-between rounded-xl border border-white/10 bg-zinc-900 px-3.5 py-2 text-left hover:border-emerald-400/60 active:scale-[0.99]"
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-400">
                  <Music className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-white">
                    {preset.name}
                  </p>
                  <p className="text-[11px] text-zinc-500">
                    {preset.bpm} BPM · {preset.duration}с
                  </p>
                </div>
              </div>
              <Plus className="h-4 w-4 shrink-0 text-emerald-400" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

interface TeamPanelProps {
  roomId: string;
  user: {id: string; name: string; color: string};
  allCollaborators: Collaborator[];
  chat: ChatMessage[];
  status: 'connecting' | 'connected' | 'reconnecting';
  onUpdateProfile: (name: string, color: string) => void;
  onSwitchRoom: (nextRoomId: string) => void;
  onCreateNewRoom: (blank: boolean) => void;
  onSendChat: (text: string) => void;
}

const PROFILE_COLORS = [
  '#22d3ee',
  '#f97316',
  '#a78bfa',
  '#34d399',
  '#fb7185',
  '#facc15',
];

export const TeamPanel: React.FC<TeamPanelProps> = ({
  roomId,
  user,
  allCollaborators,
  chat,
  status,
  onUpdateProfile,
  onSwitchRoom,
  onCreateNewRoom,
  onSendChat,
}) => {
  const [copied, setCopied] = useState(false);
  const [nameInput, setNameInput] = useState(user.name);
  const [roomInput, setRoomInput] = useState('');
  const [chatInput, setChatInput] = useState('');
  const [lanUrls, setLanUrls] = useState<string[]>([]);

  useEffect(() => {
    setNameInput(user.name);
  }, [user.name]);

  useEffect(() => {
    fetch('/api/network-info')
      .then((r) => r.json())
      .then((d: {lanUrls?: string[]}) => {
        if (Array.isArray(d.lanUrls)) setLanUrls(d.lanUrls);
      })
      .catch(() => {});
  }, []);

  const shareUrl = `${window.location.origin}/?room=${encodeURIComponent(roomId)}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // ignore clipboard error
    }
  };

  return (
    <div className="space-y-4">
      {/* Room Link & Status */}
      <div className="rounded-xl border border-white/10 bg-zinc-900/80 p-3 space-y-2.5">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-zinc-200">
            Комната: <span className="font-mono text-cyan-400">{roomId}</span>
          </span>
          <span className="flex items-center gap-1.5 text-[11px] text-zinc-400">
            <span
              className={`h-2 w-2 rounded-full ${
                status === 'connected' ? 'bg-emerald-400' : 'bg-amber-400'
              }`}
            />
            {status === 'connected' ? 'Онлайн' : 'Подключение...'}
          </span>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleCopy}
            className="flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-xl bg-cyan-500 px-3 text-xs font-semibold text-zinc-950 hover:bg-cyan-400 active:scale-[0.98]"
          >
            {copied ? (
              <>
                <Check className="h-4 w-4" />
                Ссылка скопирована
              </>
            ) : (
              <>
                <Copy className="h-4 w-4" />
                Пригласить по ссылке
              </>
            )}
          </button>
          <button
            type="button"
            onClick={() => onCreateNewRoom(false)}
            className="min-h-[44px] rounded-xl border border-white/15 bg-zinc-800 px-3 text-xs font-medium text-zinc-200 hover:bg-zinc-700 whitespace-nowrap"
          >
            + Новая
          </button>
        </div>

        {lanUrls.length > 0 && (
          <div className="rounded-lg bg-zinc-950/70 px-2.5 py-2 text-[11px] text-zinc-400">
            <span className="block text-zinc-500">
              Открыть с телефона в той же Wi-Fi сети:
            </span>
            <span className="font-mono text-zinc-300 break-all">
              {lanUrls[0]}/?room={roomId}
            </span>
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (roomInput.trim()) {
              onSwitchRoom(roomInput.trim());
              setRoomInput('');
            }
          }}
          className="flex gap-2 pt-1"
        >
          <input
            type="text"
            value={roomInput}
            onChange={(e) => setRoomInput(e.target.value)}
            placeholder="Код комнаты для входа..."
            className="h-10 flex-1 rounded-lg border border-white/10 bg-zinc-950 px-3 text-xs text-white placeholder:text-zinc-500 focus:border-cyan-400 focus:outline-none"
          />
          <button
            type="submit"
            className="h-10 rounded-lg border border-white/15 bg-zinc-800 px-3 text-xs font-medium text-zinc-200 hover:bg-zinc-700"
          >
            Войти
          </button>
        </form>
      </div>

      {/* Your Profile */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-zinc-400">Ваше имя и цвет курсора</p>
        <div className="flex gap-2">
          <input
            type="text"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onBlur={() => onUpdateProfile(nameInput, user.color)}
            className="h-10 flex-1 rounded-lg border border-white/10 bg-zinc-900 px-3 text-xs text-white focus:border-cyan-400 focus:outline-none"
          />
          <div className="flex items-center gap-1">
            {PROFILE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => onUpdateProfile(nameInput, c)}
                style={{backgroundColor: c}}
                aria-label={`Выбрать цвет ${c}`}
                className={`h-7 w-7 rounded-full border-2 ${
                  user.color === c ? 'border-white scale-110' : 'border-transparent'
                }`}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Active Collaborators */}
      <div className="space-y-1.5">
        <p className="flex items-center gap-1.5 text-xs font-medium text-zinc-400">
          <Users className="h-3.5 w-3.5" />
          Участники в комнате ({allCollaborators.length})
        </p>
        <div className="space-y-1">
          {allCollaborators.map((c) => (
            <div
              key={c.id}
              className="flex items-center justify-between rounded-lg bg-zinc-900/70 px-3 py-2 text-xs"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span
                  style={{backgroundColor: c.color}}
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                />
                <span className="truncate font-medium text-zinc-200">
                  {c.name} {c.id === user.id ? '(Вы)' : ''}
                </span>
              </div>
              <span className="font-mono text-[11px] tabular-nums text-zinc-400">
                {c.playhead.toFixed(1)}s
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Live Studio Chat */}
      <div className="space-y-2 border-t border-white/10 pt-3">
        <p className="text-xs font-medium text-zinc-400">Чат монтажёров</p>
        <div className="studio-scrollbar max-h-36 space-y-1.5 overflow-y-auto rounded-xl bg-zinc-950/80 p-2.5 border border-white/5">
          {chat.map((m) => (
            <div key={m.id} className="text-xs leading-relaxed">
              <span
                style={{color: m.userColor}}
                className="font-semibold mr-1.5"
              >
                {m.userName}:
              </span>
              <span className="text-zinc-200">{m.text}</span>
            </div>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!chatInput.trim()) return;
            onSendChat(chatInput);
            setChatInput('');
          }}
          className="flex gap-2"
        >
          <input
            type="text"
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            placeholder="Написать команде..."
            className="h-10 flex-1 rounded-lg border border-white/10 bg-zinc-900 px-3 text-xs text-white placeholder:text-zinc-500 focus:border-cyan-400 focus:outline-none"
          />
          <button
            type="submit"
            aria-label="Отправить сообщение"
            className="flex h-10 w-10 items-center justify-center rounded-lg bg-cyan-500 text-zinc-950 hover:bg-cyan-400"
          >
            <Send className="h-4 w-4" />
          </button>
        </form>
      </div>
    </div>
  );
};

interface BottomSheetProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}

export const BottomSheet: React.FC<BottomSheetProps> = ({
  title,
  onClose,
  children,
}) => {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-xs lg:hidden">
      <div className="max-h-[78dvh] w-full overflow-y-auto rounded-t-3xl border-t border-white/15 bg-[#141418] px-4 pt-2 pb-6 shadow-2xl">
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-zinc-700" />
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-white">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть панель"
            className="flex h-10 w-10 items-center justify-center rounded-full bg-zinc-800 text-zinc-300 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
};

export const TOOL_TABS: Array<{
  id: ActiveToolTab;
  label: string;
  icon: React.FC<{className?: string}>;
}> = [
  {id: 'edit', label: 'Монтаж', icon: Film},
  {id: 'media', label: 'Медиа', icon: Plus},
  {id: 'text', label: 'Текст', icon: Type},
  {id: 'effects', label: 'Эффекты', icon: Sparkles},
  {id: 'audio', label: 'Аудио', icon: Music},
  {id: 'team', label: 'Команда', icon: Users},
];

export type TrackFilter = TrackType;
