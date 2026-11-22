import React, {useEffect, useState} from 'react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Check,
  Copy,
  Diamond,
  Film,
  FlipHorizontal,
  Layers,
  Music,
  Plus,
  Send,
  Sparkles,
  Trash2,
  Type,
  Upload,
  Users,
  Wifi,
  X,
} from 'lucide-react';
import {
  BUILTIN_FONTS,
  loadCustomFont,
  sanitizeFontFamilyName,
} from '../lib/fontLoader.ts';
import {
  EASING_OPTIONS,
  evaluateClipTransform,
  generateKeyframePreset,
  upsertKeyframeAtTime,
} from '../lib/keyframeEngine.ts';
import {uploadFileForP2P} from '../lib/lanSyncBridge.ts';
import {
  SAMPLE_MEDIA_ASSETS,
  SYNTH_AUDIO_PRESETS,
} from '../shared/types.ts';
import type {
  BlendMode,
  ChatMessage,
  Clip,
  ClipKeyframe,
  Collaborator,
  DiscoveredUdpRoom,
  FilterPreset,
  KeyframeEasing,
  MotionEffect,
  NetworkInterfaceInfo,
  ProjectFont,
  RoomSummary,
  TransitionType,
} from '../shared/types.ts';

export type ActiveToolTab =
  | 'edit'
  | 'media'
  | 'overlay'
  | 'text'
  | 'effects'
  | 'audio'
  | 'team';

async function uploadOrLocalMedia(
  file: File,
  fallbackKind: 'video' | 'image' | 'audio' | 'font'
): Promise<{
  name: string;
  fileName: string;
  kind: 'video' | 'image' | 'audio' | 'font';
  src: string;
  shareUrl: string;
}> {
  const prepared = await uploadFileForP2P(file, fallbackKind);
  return {
    name: prepared.name,
    fileName: prepared.fileName,
    kind: prepared.kind,
    src: prepared.localSrc,
    shareUrl: prepared.shareUrl,
  };
}

function probeMediaDuration(
  url: string,
  kind: 'video' | 'image' | 'audio'
): Promise<number> {
  if (kind === 'image') return Promise.resolve(4.5);
  return new Promise((resolve) => {
    const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
    el.preload = 'metadata';
    el.onloadedmetadata = () => {
      const d = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 5;
      resolve(Math.round(d * 10) / 10);
    };
    el.onerror = () => resolve(5);
    el.src = url;
  });
}

/* =========================================================================
   KEYFRAME & CURVE EDITOR (for Overlays & Text)
   ========================================================================= */

interface KeyframeControlsProps {
  clip: Clip;
  currentTime: number;
  onSeek: (time: number) => void;
  onUpdateClip: (clipId: string, patch: Partial<Clip>) => void;
}

export const KeyframeControls: React.FC<KeyframeControlsProps> = ({
  clip,
  currentTime,
  onSeek,
  onUpdateClip,
}) => {
  const keyframes = [...(clip.keyframes ?? [])].sort(
    (a, b) => a.timeOffset - b.timeOffset
  );
  const localTime = Math.max(
    0,
    Math.min(clip.duration, currentTime - clip.start)
  );
  const activeKf = keyframes.find(
    (k) => Math.abs(k.timeOffset - localTime) <= 0.12
  );
  const currentEval = evaluateClipTransform(clip, currentTime);

  const handleToggleOrAddKeyframe = () => {
    if (activeKf) {
      const remaining = keyframes.filter((k) => k.id !== activeKf.id);
      onUpdateClip(clip.id, {keyframes: remaining});
      return;
    }
    const {keyframes: next} = upsertKeyframeAtTime(clip, currentTime);
    onUpdateClip(clip.id, {keyframes: next});
  };

  const handleEasingChange = (easing: KeyframeEasing) => {
    if (activeKf) {
      const next = keyframes.map((k) =>
        k.id === activeKf.id ? {...k, easing} : k
      );
      onUpdateClip(clip.id, {keyframes: next});
      return;
    }
    const {keyframes: next} = upsertKeyframeAtTime(clip, currentTime, {easing});
    onUpdateClip(clip.id, {keyframes: next});
  };

  const handleUpdateActiveKfField = (patch: Partial<ClipKeyframe>) => {
    const {keyframes: next} = upsertKeyframeAtTime(clip, currentTime, patch);
    onUpdateClip(clip.id, {keyframes: next});
  };

  return (
    <div className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Diamond className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
          <span className="text-xs font-semibold text-amber-200">
            Ключи движения ({keyframes.length})
          </span>
        </div>
        <span className="font-mono text-[10px] text-zinc-400 tabular-nums">
          {localTime.toFixed(1)}с / {clip.duration.toFixed(1)}с
        </span>
      </div>

      {/* Add / Remove Keyframe + Clear */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleToggleOrAddKeyframe}
          className={`flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg text-xs font-semibold transition ${
            activeKf
              ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
              : 'bg-amber-400 text-zinc-950 hover:bg-amber-300'
          }`}
        >
          <Diamond className="h-3.5 w-3.5" />
          {activeKf ? 'Удалить ключ здесь' : '+ Ключ в этой точке'}
        </button>
        {keyframes.length > 0 && (
          <button
            type="button"
            onClick={() => onUpdateClip(clip.id, {keyframes: []})}
            aria-label="Очистить все ключи"
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-zinc-900 text-zinc-400 hover:text-rose-400"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Keyframe Timeline Chips */}
      {keyframes.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {keyframes.map((kf, idx) => {
            const isAtPlayhead = activeKf?.id === kf.id;
            return (
              <button
                key={kf.id}
                type="button"
                onClick={() => onSeek(clip.start + kf.timeOffset)}
                className={`flex items-center gap-1 rounded-lg border px-2 py-1 font-mono text-[11px] transition ${
                  isAtPlayhead
                    ? 'border-amber-400 bg-amber-400/20 text-amber-200'
                    : 'border-white/10 bg-zinc-900 text-zinc-300 hover:border-white/25'
                }`}
              >
                <span className="h-1.5 w-1.5 rotate-45 bg-amber-300" />
                #{idx + 1} · {kf.timeOffset.toFixed(1)}с
              </button>
            );
          })}
        </div>
      )}

      {/* Easing Curve Selector */}
      <div>
        <p className="mb-1.5 text-[11px] font-medium text-zinc-300">
          Кривая скорости {activeKf ? '(для выбранного ключа)' : '(при добавлении)'}
        </p>
        <div className="grid grid-cols-5 gap-1">
          {EASING_OPTIONS.map((opt) => {
            const selected = (activeKf?.easing ?? 'ease-in-out') === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => handleEasingChange(opt.id)}
                className={`flex flex-col items-center justify-center gap-1 rounded-lg border py-1.5 px-1 text-[10px] transition ${
                  selected
                    ? 'border-amber-400 bg-amber-400/20 text-amber-200'
                    : 'border-white/10 bg-zinc-900 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <svg viewBox="0 0 20 20" className="h-4 w-4">
                  <path
                    d={opt.path}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
                <span className="truncate max-w-full">{opt.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Live Keyframed Values at Playhead */}
      {keyframes.length > 0 && (
        <div className="grid grid-cols-2 gap-2 border-t border-white/10 pt-2 text-[11px] text-zinc-300">
          <label className="space-y-1">
            <div className="flex justify-between">
              <span>Масштаб (ключ)</span>
              <span className="font-mono">
                {Math.round(currentEval.scale * 100)}%
              </span>
            </div>
            <input
              type="range"
              min={0.15}
              max={1.4}
              step={0.05}
              value={currentEval.scale}
              onChange={(e) =>
                handleUpdateActiveKfField({scale: Number(e.target.value)})
              }
              className="w-full accent-amber-400"
            />
          </label>
          <label className="space-y-1">
            <div className="flex justify-between">
              <span>Поворот (ключ)</span>
              <span className="font-mono">
                {Math.round(currentEval.rotation)}°
              </span>
            </div>
            <input
              type="range"
              min={-180}
              max={180}
              step={2}
              value={currentEval.rotation}
              onChange={(e) =>
                handleUpdateActiveKfField({rotation: Number(e.target.value)})
              }
              className="w-full accent-amber-400"
            />
          </label>
        </div>
      )}

      {/* Quick Motion Presets */}
      <div>
        <p className="mb-1.5 text-[11px] font-medium text-zinc-400">
          Готовая анимация по ключам:
        </p>
        <div className="grid grid-cols-2 gap-1.5">
          {(
            [
              {id: 'slide-in', label: 'Вылет слева'},
              {id: 'spin-zoom', label: 'Зум + поворот'},
              {id: 'float', label: 'Плавное парение'},
              {id: 'bounce-in', label: 'Прыжок (Пружина)'},
            ] as const
          ).map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() =>
                onUpdateClip(clip.id, {
                  keyframes: generateKeyframePreset(clip, preset.id),
                })
              }
              className="rounded-lg border border-white/10 bg-zinc-900 px-2 py-1.5 text-[11px] font-medium text-zinc-200 hover:border-amber-400/50"
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      <p className="text-[10px] text-zinc-400">
        Подсказка: переместите линию времени и перетащите объект пальцем по экрану — ключ сохранит новую позицию.
      </p>
    </div>
  );
};

/* =========================================================================
   MEDIA PANEL
   ========================================================================= */

interface MediaPanelProps {
  defaultTrack?: 'video' | 'overlay';
  onAddMediaClip: (opts: {
    name: string;
    kind: 'video' | 'image';
    src: string;
    fileName?: string;
    remoteUrl?: string;
    duration: number;
    track: 'video' | 'overlay';
    forceNewTrack?: boolean;
  }) => void;
  onClose?: () => void;
}

export const MediaPanel: React.FC<MediaPanelProps> = ({
  defaultTrack = 'video',
  onAddMediaClip,
  onClose,
}) => {
  const [targetTrack, setTargetTrack] = useState<'video' | 'overlay'>(
    defaultTrack
  );
  const [forceNewTrack, setForceNewTrack] = useState(
    defaultTrack === 'overlay'
  );
  const [uploading, setUploading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    setErrorMsg(null);

    try {
      for (const file of Array.from(files)) {
        const isVideo = file.type.startsWith('video/');
        const uploaded = await uploadOrLocalMedia(
          file,
          isVideo ? 'video' : 'image'
        );
        const mediaKind = uploaded.kind === 'video' ? 'video' : 'image';
        const dur = await probeMediaDuration(uploaded.src, mediaKind);
        onAddMediaClip({
          name: uploaded.name,
          kind: mediaKind,
          src: uploaded.src,
          fileName: uploaded.fileName,
          remoteUrl: uploaded.shareUrl,
          duration: Math.min(30, dur),
          track: targetTrack,
          forceNewTrack,
        });
      }
      onClose?.();
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Не удалось добавить файл'
      );
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-zinc-400">Куда добавить:</span>
        <div className="flex rounded-lg border border-white/10 bg-zinc-900 p-1">
          <button
            type="button"
            onClick={() => {
              setTargetTrack('video');
              setForceNewTrack(false);
            }}
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
            onClick={() => {
              setTargetTrack('overlay');
              setForceNewTrack(true);
            }}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
              targetTrack === 'overlay'
                ? 'bg-indigo-500 text-white'
                : 'text-zinc-300 hover:text-white'
            }`}
          >
            <Layers className="h-3.5 w-3.5" />
            Наложение
          </button>
        </div>
      </div>

      <label className="flex items-center justify-between rounded-xl border border-white/10 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-300 cursor-pointer">
        <span>Создавать новую дорожку (без наслаивания)</span>
        <input
          type="checkbox"
          checked={forceNewTrack}
          onChange={(e) => setForceNewTrack(e.target.checked)}
          className="h-4 w-4 accent-cyan-400"
        />
      </label>

      <label className="flex min-h-[56px] cursor-pointer items-center justify-center gap-2.5 rounded-xl border border-dashed border-cyan-500/40 bg-cyan-500/10 px-4 py-3 text-sm font-medium text-cyan-200 transition hover:bg-cyan-500/15 active:scale-[0.99]">
        <Upload className="h-4 w-4 shrink-0 text-cyan-400" />
        <span>
          {uploading
            ? 'Загрузка файла...'
            : 'Выбрать видео или фото с устройства'}
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

      {errorMsg && <p className="text-xs text-rose-400">{errorMsg}</p>}

      <div>
        <p className="mb-2 text-xs font-medium text-zinc-400">
          Готовые сцены для монтажа
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
                  forceNewTrack,
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

/* =========================================================================
   OVERLAY PANEL (PIP + Keyframes + Border + Flip + Blend)
   ========================================================================= */

interface OverlayPanelProps {
  selectedClip: Clip | null;
  currentTime: number;
  onSeek: (time: number) => void;
  onAddMediaClip: MediaPanelProps['onAddMediaClip'];
  onUpdateClip: (clipId: string, patch: Partial<Clip>) => void;
  onClose?: () => void;
}

const BLEND_MODES: Array<{id: BlendMode; label: string}> = [
  {id: 'source-over', label: 'Обычный'},
  {id: 'screen', label: 'Экран'},
  {id: 'multiply', label: 'Умножение'},
  {id: 'overlay', label: 'Перекрытие'},
  {id: 'lighten', label: 'Светлее'},
];

export const OverlayPanel: React.FC<OverlayPanelProps> = ({
  selectedClip,
  currentTime,
  onSeek,
  onAddMediaClip,
  onUpdateClip,
  onClose,
}) => {
  const isOverlay = selectedClip?.track === 'overlay';

  return (
    <div className="space-y-4">
      {isOverlay && (
        <>
          <div className="space-y-3 rounded-xl border border-indigo-500/30 bg-indigo-500/10 p-3">
            <div className="flex items-center justify-between">
              <p className="truncate text-xs font-semibold text-indigo-200">
                Наложение: {selectedClip.name}
              </p>
              <button
                type="button"
                onClick={() =>
                  onUpdateClip(selectedClip.id, {
                    flipHorizontal: !selectedClip.flipHorizontal,
                  })
                }
                className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium ${
                  selectedClip.flipHorizontal
                    ? 'border-indigo-400 bg-indigo-500 text-white'
                    : 'border-white/10 bg-zinc-900 text-zinc-300'
                }`}
              >
                <FlipHorizontal className="h-3.5 w-3.5" />
                Зеркало
              </button>
            </div>

            {/* Quick PIP Corner Positions */}
            <div>
              <p className="mb-1 text-[11px] text-zinc-400">Позиция PIP</p>
              <div className="grid grid-cols-5 gap-1">
                {[
                  {label: '↖', x: 0.25, y: 0.22},
                  {label: '↗', x: 0.75, y: 0.22},
                  {label: '●', x: 0.5, y: 0.5},
                  {label: '↙', x: 0.25, y: 0.78},
                  {label: '↘', x: 0.75, y: 0.78},
                ].map((pos) => (
                  <button
                    key={pos.label}
                    type="button"
                    onClick={() =>
                      onUpdateClip(selectedClip.id, {
                        mediaX: pos.x,
                        mediaY: pos.y,
                      })
                    }
                    className="h-8 rounded-lg border border-white/10 bg-zinc-900 text-xs font-bold text-zinc-200 hover:border-indigo-400"
                  >
                    {pos.label}
                  </button>
                ))}
              </div>
            </div>

            <label className="block space-y-1 text-xs text-zinc-300">
              <div className="flex justify-between">
                <span>Размер (PIP)</span>
                <span className="font-mono tabular-nums">
                  {Math.round((selectedClip.mediaScale ?? 0.42) * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={0.15}
                max={0.95}
                step={0.05}
                value={selectedClip.mediaScale ?? 0.42}
                onChange={(e) =>
                  onUpdateClip(selectedClip.id, {
                    mediaScale: Number(e.target.value),
                  })
                }
                className="w-full accent-indigo-400"
              />
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="block space-y-1 text-xs text-zinc-300">
                <div className="flex justify-between">
                  <span>Поворот</span>
                  <span className="font-mono tabular-nums">
                    {selectedClip.rotation ?? 0}°
                  </span>
                </div>
                <input
                  type="range"
                  min={-180}
                  max={180}
                  step={2}
                  value={selectedClip.rotation ?? 0}
                  onChange={(e) =>
                    onUpdateClip(selectedClip.id, {
                      rotation: Number(e.target.value),
                    })
                  }
                  className="w-full accent-indigo-400"
                />
              </label>

              <label className="block space-y-1 text-xs text-zinc-300">
                <div className="flex justify-between">
                  <span>Скругление</span>
                  <span className="font-mono tabular-nums">
                    {selectedClip.borderRadius ?? 20}px
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={120}
                  step={4}
                  value={selectedClip.borderRadius ?? 20}
                  onChange={(e) =>
                    onUpdateClip(selectedClip.id, {
                      borderRadius: Number(e.target.value),
                    })
                  }
                  className="w-full accent-indigo-400"
                />
              </label>

              <label className="block space-y-1 text-xs text-zinc-300">
                <div className="flex justify-between">
                  <span>Рамка</span>
                  <span className="font-mono tabular-nums">
                    {selectedClip.borderWidth ?? 0}px
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={14}
                  step={1}
                  value={selectedClip.borderWidth ?? 0}
                  onChange={(e) =>
                    onUpdateClip(selectedClip.id, {
                      borderWidth: Number(e.target.value),
                    })
                  }
                  className="w-full accent-indigo-400"
                />
              </label>

              <div className="flex items-end justify-between gap-2 pb-0.5">
                <span className="text-xs text-zinc-300">Цвет рамки</span>
                <input
                  type="color"
                  value={selectedClip.borderColor || '#ffffff'}
                  onChange={(e) =>
                    onUpdateClip(selectedClip.id, {borderColor: e.target.value})
                  }
                  className="h-7 w-10 cursor-pointer rounded border border-white/20 bg-transparent"
                />
              </div>
            </div>

            <div>
              <p className="mb-1.5 text-xs text-zinc-300">Режим смешивания</p>
              <div className="flex flex-wrap gap-1.5">
                {BLEND_MODES.map((bm) => (
                  <button
                    key={bm.id}
                    type="button"
                    onClick={() =>
                      onUpdateClip(selectedClip.id, {blendMode: bm.id})
                    }
                    className={`rounded-lg px-2.5 py-1.5 text-[11px] font-medium ${
                      (selectedClip.blendMode ?? 'source-over') === bm.id
                        ? 'bg-indigo-500 text-white'
                        : 'bg-zinc-900 text-zinc-300 border border-white/10'
                    }`}
                  >
                    {bm.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Keyframe & Curve Editor */}
          <KeyframeControls
            clip={selectedClip}
            currentTime={currentTime}
            onSeek={onSeek}
            onUpdateClip={onUpdateClip}
          />
        </>
      )}

      <MediaPanel
        defaultTrack="overlay"
        onAddMediaClip={onAddMediaClip}
        onClose={onClose}
      />
    </div>
  );
};

/* =========================================================================
   TEXT PANEL (Custom Fonts Upload + Styling + Keyframes)
   ========================================================================= */

interface TextPanelProps {
  selectedClip: Clip | null;
  customFonts: ProjectFont[];
  currentTime: number;
  onSeek: (time: number) => void;
  onAddText: (text: string, forceNewTrack: boolean) => void;
  onUpdateClip: (clipId: string, patch: Partial<Clip>) => void;
  onAddCustomFont: (font: ProjectFont) => void;
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
  customFonts,
  currentTime,
  onSeek,
  onAddText,
  onUpdateClip,
  onAddCustomFont,
}) => {
  const [draftText, setDraftText] = useState('НОВЫЙ ТИТР');
  const [forceNewTrack, setForceNewTrack] = useState(true);
  const [uploadingFont, setUploadingFont] = useState(false);
  const [fontError, setFontError] = useState<string | null>(null);
  const isTextSelected = selectedClip?.track === 'text';

  const style = selectedClip?.textStyle ?? {
    fontSize: 48,
    color: '#ffffff',
    bgColor: 'rgba(9, 9, 11, 0.72)',
    fontWeight: 'bold' as const,
    fontFamily: 'Plus Jakarta Sans',
    shadow: true,
    outline: false,
    x: 0.5,
    y: 0.78,
    align: 'center' as const,
  };

  const handleFontUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingFont(true);
    setFontError(null);
    try {
      const uploaded = await uploadOrLocalMedia(file, 'font');
      const family = sanitizeFontFamilyName(uploaded.name);
      await loadCustomFont(family, uploaded.src);
      const newFont: ProjectFont = {
        id: `font-${Math.random().toString(36).slice(2, 8)}`,
        name: family,
        fontFamily: family,
        src: uploaded.src,
      };
      onAddCustomFont(newFont);
      if (isTextSelected) {
        onUpdateClip(selectedClip.id, {
          textStyle: {...style, fontFamily: family, fontSrc: uploaded.src},
        });
      }
    } catch (err) {
      setFontError(
        err instanceof Error ? err.message : 'Не удалось загрузить шрифт'
      );
    } finally {
      setUploadingFont(false);
      e.target.value = '';
    }
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
          onClick={() => onAddText(draftText || 'ТИТР', forceNewTrack)}
          className="flex h-11 shrink-0 items-center gap-1.5 rounded-xl bg-cyan-500 px-4 text-xs font-semibold text-zinc-950 hover:bg-cyan-400 active:scale-95 whitespace-nowrap"
        >
          <Plus className="h-4 w-4" />
          Добавить
        </button>
      </div>

      <label className="flex items-center justify-between rounded-xl border border-white/10 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-300 cursor-pointer">
        <span>Новый титр на отдельную дорожку</span>
        <input
          type="checkbox"
          checked={forceNewTrack}
          onChange={(e) => setForceNewTrack(e.target.checked)}
          className="h-4 w-4 accent-cyan-400"
        />
      </label>

      {/* Custom Font Upload Button */}
      <div className="space-y-2 rounded-xl border border-white/10 bg-zinc-900/50 p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-zinc-300">
            Шрифты и загрузка своего
          </span>
          <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/15 px-2.5 py-1.5 text-[11px] font-semibold text-cyan-300 hover:bg-cyan-500/25">
            <Upload className="h-3.5 w-3.5" />
            <span>
              {uploadingFont ? 'Загрузка...' : 'Загрузить (.ttf / .otf)'}
            </span>
            <input
              type="file"
              accept=".ttf,.otf,.woff,.woff2,font/*"
              disabled={uploadingFont}
              onChange={handleFontUpload}
              className="hidden"
            />
          </label>
        </div>

        {fontError && <p className="text-[11px] text-rose-400">{fontError}</p>}

        {isTextSelected && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {BUILTIN_FONTS.map((f) => {
              const active =
                (style.fontFamily || 'Plus Jakarta Sans') === f.family;
              return (
                <button
                  key={f.family}
                  type="button"
                  onClick={() =>
                    onUpdateClip(selectedClip.id, {
                      textStyle: {
                        ...style,
                        fontFamily: f.family,
                        fontSrc: undefined,
                      },
                    })
                  }
                  style={{fontFamily: f.css}}
                  className={`rounded-lg border px-2.5 py-1.5 text-xs transition ${
                    active
                      ? 'border-cyan-400 bg-cyan-500/20 text-cyan-200'
                      : 'border-white/10 bg-zinc-900 text-zinc-300 hover:border-white/25'
                  }`}
                >
                  {f.name}
                </button>
              );
            })}
            {customFonts.map((cf) => {
              const active = style.fontFamily === cf.fontFamily;
              return (
                <button
                  key={cf.id}
                  type="button"
                  onClick={() =>
                    onUpdateClip(selectedClip.id, {
                      textStyle: {
                        ...style,
                        fontFamily: cf.fontFamily,
                        fontSrc: cf.src,
                      },
                    })
                  }
                  style={{fontFamily: `"${cf.fontFamily}", sans-serif`}}
                  className={`rounded-lg border px-2.5 py-1.5 text-xs transition ${
                    active
                      ? 'border-amber-400 bg-amber-500/20 text-amber-200'
                      : 'border-amber-500/30 bg-zinc-900 text-amber-200/90'
                  }`}
                >
                  ★ {cf.name}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {isTextSelected ? (
        <div className="space-y-3 border-t border-white/10 pt-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex gap-1">
              {(
                [
                  {id: 'left', icon: AlignLeft},
                  {id: 'center', icon: AlignCenter},
                  {id: 'right', icon: AlignRight},
                ] as const
              ).map((al) => {
                const Icon = al.icon;
                return (
                  <button
                    key={al.id}
                    type="button"
                    onClick={() =>
                      onUpdateClip(selectedClip.id, {
                        textStyle: {...style, align: al.id},
                      })
                    }
                    className={`flex h-9 w-9 items-center justify-center rounded-lg border ${
                      style.align === al.id
                        ? 'border-cyan-400 bg-cyan-500/20 text-cyan-300'
                        : 'border-white/10 bg-zinc-900 text-zinc-400'
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                  </button>
                );
              })}
            </div>

            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() =>
                  onUpdateClip(selectedClip.id, {
                    textStyle: {
                      ...style,
                      fontWeight: style.fontWeight === 'bold' ? 'normal' : 'bold',
                    },
                  })
                }
                className={`h-9 rounded-lg border px-2.5 text-xs font-bold ${
                  style.fontWeight === 'bold'
                    ? 'border-cyan-400 bg-cyan-500/20 text-cyan-300'
                    : 'border-white/10 bg-zinc-900 text-zinc-400'
                }`}
              >
                B
              </button>
              <button
                type="button"
                onClick={() =>
                  onUpdateClip(selectedClip.id, {
                    textStyle: {...style, outline: !style.outline},
                  })
                }
                className={`h-9 rounded-lg border px-2.5 text-xs font-semibold ${
                  style.outline
                    ? 'border-cyan-400 bg-cyan-500/20 text-cyan-300'
                    : 'border-white/10 bg-zinc-900 text-zinc-400'
                }`}
              >
                Обводка
              </button>
            </div>
          </div>

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

          <KeyframeControls
            clip={selectedClip}
            currentTime={currentTime}
            onSeek={onSeek}
            onUpdateClip={onUpdateClip}
          />
        </div>
      ) : (
        <p className="text-xs text-zinc-400">
          Нажмите «Добавить», чтобы создать титр на текущем времени, или выберите существующий титр на дорожке «Текст».
        </p>
      )}
    </div>
  );
};

/* =========================================================================
   EFFECTS PANEL
   ========================================================================= */

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
        Выберите видео, фото, наложение или титр на таймлайне, чтобы настроить фильтры и анимацию.
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

      <div>
        <p className="mb-2 text-xs font-medium text-zinc-400">Переход в конце</p>
        <div className="grid grid-cols-4 gap-1.5">
          {TRANSITIONS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() =>
                onUpdateClip(selectedClip.id, {transitionOut: t.id})
              }
              className={`min-h-[38px] rounded-lg px-2 text-xs font-medium transition whitespace-nowrap ${
                (selectedClip.transitionOut ?? 'none') === t.id
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
            min={0}
            max={1}
            step={0.01}
            value={selectedClip.opacity}
            onChange={(e) =>
              onUpdateClip(selectedClip.id, {opacity: Number(e.target.value)})
            }
            className="w-full accent-cyan-400"
          />
        </label>

        <label className="space-y-1 text-xs text-zinc-400">
          <div className="flex justify-between">
            <span>Размытие</span>
            <span className="font-mono tabular-nums text-zinc-200">
              {selectedClip.blur ?? 0}px
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={16}
            step={1}
            value={selectedClip.blur ?? 0}
            onChange={(e) =>
              onUpdateClip(selectedClip.id, {blur: Number(e.target.value)})
            }
            className="w-full accent-cyan-400"
          />
        </label>

        <label className="space-y-1 text-xs text-zinc-400">
          <div className="flex justify-between">
            <span>Виньетка</span>
            <span className="font-mono tabular-nums text-zinc-200">
              {Math.round((selectedClip.vignette ?? 0) * 100)}%
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={0.85}
            step={0.05}
            value={selectedClip.vignette ?? 0}
            onChange={(e) =>
              onUpdateClip(selectedClip.id, {vignette: Number(e.target.value)})
            }
            className="w-full accent-cyan-400"
          />
        </label>
      </div>
    </div>
  );
};

/* =========================================================================
   AUDIO PANEL
   ========================================================================= */

interface AudioPanelProps {
  selectedClip: Clip | null;
  onAddAudioClip: (opts: {
    name: string;
    kind: 'audio' | 'synth';
    src: string;
    duration: number;
    forceNewTrack?: boolean;
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
      const uploaded = await uploadOrLocalMedia(file, 'audio');
      const dur = await probeMediaDuration(uploaded.src, 'audio');
      onAddAudioClip({
        name: uploaded.name,
        kind: 'audio',
        src: uploaded.src,
        duration: Math.min(60, dur),
        forceNewTrack: false,
      });
      onClose?.();
    } catch {
      // keep open
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
                  forceNewTrack: false,
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

/* =========================================================================
   TEAM & CHAT PANEL
   ========================================================================= */

interface TeamPanelProps {
  roomId: string;
  serverUrl: string;
  p2pMode: 'idle' | 'host' | 'client';
  networkInterfaces: NetworkInterfaceInfo[];
  hostPort: number;
  udpRooms: DiscoveredUdpRoom[];
  user: {id: string; name: string; color: string};
  allCollaborators: Collaborator[];
  availableRooms: RoomSummary[];
  chat: ChatMessage[];
  status: 'connecting' | 'connected' | 'reconnecting' | 'offline';
  onUpdateProfile: (name: string, color: string) => void;
  onOpenLobby: () => void;
  onSwitchRoom: (nextRoomId: string) => void;
  onSendChat: (text: string) => void;
  onUpdateServerUrl: (url: string) => void;
  onStartHost: () => Promise<unknown>;
  onStopHost: () => Promise<void>;
  onConnectToHostIp: (ipOrUrl: string, targetRoomId?: string) => void;
  onRefreshNetwork: () => void;
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
  serverUrl,
  p2pMode,
  networkInterfaces,
  hostPort,
  udpRooms,
  user,
  allCollaborators,
  availableRooms,
  chat,
  status,
  onUpdateProfile,
  onOpenLobby,
  onSwitchRoom,
  onSendChat,
  onStartHost,
  onStopHost,
  onConnectToHostIp,
  onRefreshNetwork,
}) => {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [nameInput, setNameInput] = useState(user.name);
  const [chatInput, setChatInput] = useState('');
  const [manualIpInput, setManualIpInput] = useState(
    serverUrl ? serverUrl.replace(/^https?:\/\//, '') : ''
  );
  const [startingHost, setStartingHost] = useState(false);

  useEffect(() => {
    setNameInput(user.name);
  }, [user.name]);

  useEffect(() => {
    if (serverUrl) {
      setManualIpInput(serverUrl.replace(/^https?:\/\//, ''));
    }
  }, [serverUrl]);

  const handleCopyText = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1600);
    } catch {
      // ignore clipboard error
    }
  };

  return (
    <div className="space-y-4">
      {/* P2P Host & Client Control Panel (Ktor 8080 + UDP 8081 + ZeroTier) */}
      <div className="space-y-3 rounded-xl border border-emerald-500/35 bg-gradient-to-br from-emerald-950/30 via-zinc-900/90 to-zinc-950 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Wifi className="h-4 w-4 text-emerald-400" />
            <div>
              <p className="text-xs font-bold text-white">
                Локальная сеть (LAN / ZeroTier)
              </p>
              <p className="text-[10px] text-zinc-400">
                Порт {hostPort} (WS / HTTP) · UDP 8081 автопоиск
              </p>
            </div>
          </div>
          <span
            className={`rounded-md px-2 py-0.5 text-[10px] font-bold ${
              p2pMode === 'host'
                ? 'bg-emerald-500/20 text-emerald-300'
                : status === 'connected'
                  ? 'bg-cyan-500/20 text-cyan-300'
                  : 'bg-zinc-800 text-zinc-400'
            }`}
          >
            {p2pMode === 'host'
              ? 'ХОСТ АКТИВЕН'
              : status === 'connected'
                ? 'ПОДКЛЮЧЕНО'
                : 'ОФФЛАЙН'}
          </span>
        </div>

        {/* 1. Host Mode Button & Local/ZeroTier IPs */}
        <div className="flex gap-2">
          {p2pMode === 'host' ? (
            <button
              type="button"
              onClick={() => void onStopHost()}
              className="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl border border-rose-500/40 bg-rose-500/15 text-xs font-semibold text-rose-300 hover:bg-rose-500/25"
            >
              Остановить хост
            </button>
          ) : (
            <button
              type="button"
              disabled={startingHost}
              onClick={async () => {
                setStartingHost(true);
                try {
                  await onStartHost();
                } finally {
                  setStartingHost(false);
                }
              }}
              className="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl bg-emerald-500 text-xs font-bold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50 active:scale-[0.99]"
            >
              <Plus className="h-4 w-4" />
              {startingHost ? 'Запуск Ktor...' : 'Создать комнату (Хост)'}
            </button>
          )}
          <button
            type="button"
            onClick={onRefreshNetwork}
            className="flex h-10 items-center justify-center rounded-xl border border-white/10 bg-zinc-900 px-3 text-[11px] font-medium text-zinc-200 hover:border-cyan-400/50"
          >
            IP / Сеть
          </button>
        </div>

        {/* Local Interfaces (ZeroTier zt* + Wi-Fi) */}
        {networkInterfaces.length > 0 && (
          <div className="space-y-1.5 rounded-lg border border-white/10 bg-zinc-950/80 p-2.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
              Ваши IP-адреса для подключения друзей:
            </p>
            <div className="space-y-1">
              {networkInterfaces.map((iface) => (
                <button
                  key={`${iface.name}-${iface.ip}`}
                  type="button"
                  onClick={() =>
                    void handleCopyText(iface.ip, `${iface.ip}:${hostPort}`)
                  }
                  className="flex w-full items-center justify-between rounded-lg border border-white/5 bg-zinc-900/90 px-2.5 py-1.5 text-left hover:border-cyan-400/50"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${
                        iface.type === 'zerotier'
                          ? 'bg-violet-500/25 text-violet-300'
                          : iface.type === 'wifi'
                            ? 'bg-emerald-500/20 text-emerald-300'
                            : 'bg-zinc-800 text-zinc-300'
                      }`}
                    >
                      {iface.type === 'zerotier'
                        ? 'ZeroTier'
                        : iface.type === 'wifi'
                          ? 'Wi-Fi'
                          : 'LAN'}
                    </span>
                    <span className="truncate font-mono text-xs text-white">
                      {iface.ip}:{hostPort}
                    </span>
                  </div>
                  <span className="text-[10px] font-medium text-cyan-400">
                    {copiedKey === iface.ip ? 'Скопировано' : 'Копировать'}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 2. Client Mode: UDP 8081 Discovered Rooms + Manual Host IP */}
        <div className="space-y-2 border-t border-white/10 pt-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-zinc-200">
              Подключиться (Клиент)
            </span>
            <button
              type="button"
              onClick={onOpenLobby}
              className="text-[11px] font-medium text-cyan-400 hover:underline"
            >
              Все комнаты ({availableRooms.length + udpRooms.length})
            </button>
          </div>

          {udpRooms.length > 0 && (
            <div className="space-y-1.5">
              {udpRooms.map((ur) => (
                <button
                  key={`${ur.ip}-${ur.roomId}`}
                  type="button"
                  onClick={() =>
                    onConnectToHostIp(`${ur.ip}:${ur.port}`, ur.roomId)
                  }
                  className="flex w-full items-center justify-between rounded-xl border border-emerald-500/60 bg-emerald-950/30 px-3 py-2 text-left hover:bg-emerald-950/50"
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs font-bold text-white">
                      {ur.title} · {ur.hostName}
                    </p>
                    <p className="font-mono text-[10px] text-emerald-300">
                      UDP 8081 · {ur.ip}:{ur.port}
                    </p>
                  </div>
                  <span className="rounded-lg bg-emerald-500 px-2.5 py-1 text-[10px] font-bold text-zinc-950">
                    Войти
                  </span>
                </button>
              ))}
            </div>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!manualIpInput.trim()) return;
              onConnectToHostIp(manualIpInput.trim());
            }}
            className="flex gap-2"
          >
            <input
              type="text"
              value={manualIpInput}
              onChange={(e) => setManualIpInput(e.target.value)}
              placeholder="IP хоста (Wi-Fi или ZeroTier, напр. 10.147.20.5)"
              className="h-10 flex-1 rounded-lg border border-white/15 bg-zinc-950 px-2.5 font-mono text-xs text-white placeholder:text-zinc-500 focus:border-cyan-400 focus:outline-none"
            />
            <button
              type="submit"
              className="h-10 shrink-0 rounded-lg bg-cyan-500 px-3.5 text-xs font-bold text-zinc-950 hover:bg-cyan-400"
            >
              Подкл.
            </button>
          </form>
        </div>
      </div>

      {/* Live Studio Chat */}
      <div className="space-y-2 rounded-xl border border-white/10 bg-zinc-900/70 p-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-white">Чат команды</p>
          <span className="text-[11px] font-medium text-emerald-400">
            • {allCollaborators.length} в комнате ({roomId})
          </span>
        </div>
        <div className="studio-scrollbar max-h-40 space-y-1.5 overflow-y-auto rounded-lg border border-white/5 bg-zinc-950/90 p-2.5">
          {chat.map((m) => (
            <div key={m.id} className="text-xs leading-relaxed">
              <span
                style={{color: m.userColor}}
                className="mr-1.5 font-semibold"
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
            className="h-10 flex-1 rounded-lg border border-white/10 bg-zinc-950 px-3 text-xs text-white placeholder:text-zinc-500 focus:border-cyan-400 focus:outline-none"
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

      {/* Your Profile: Name + Lock/Cursor Color */}
      <div className="space-y-2 rounded-xl border border-white/10 bg-zinc-900/70 p-3">
        <p className="text-xs font-medium text-zinc-300">
          Ваше имя и цвет рамки блокировки
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onBlur={() => onUpdateProfile(nameInput, user.color)}
            className="h-10 min-w-[120px] flex-1 rounded-lg border border-white/10 bg-zinc-950 px-3 text-xs text-white focus:border-cyan-400 focus:outline-none"
          />
          <div className="flex items-center gap-1.5">
            {PROFILE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => onUpdateProfile(nameInput, c)}
                style={{backgroundColor: c}}
                aria-label={`Выбрать цвет ${c}`}
                className={`h-7 w-7 rounded-full border-2 transition ${
                  user.color === c ? 'border-white scale-110' : 'border-transparent'
                }`}
              />
            ))}
            <input
              type="color"
              value={user.color}
              onChange={(e) => onUpdateProfile(nameInput, e.target.value)}
              title="Свой цвет участника"
              className="h-7 w-7 cursor-pointer rounded-full border border-white/20 bg-transparent p-0"
            />
          </div>
        </div>
      </div>

      {/* Room Switcher Shortcut */}
      {availableRooms.length > 1 && (
        <div className="space-y-1.5 rounded-xl border border-white/10 bg-zinc-900/70 p-3">
          <p className="text-[11px] text-zinc-400">Быстрый вход в комнату:</p>
          <div className="flex flex-wrap gap-1.5">
            {availableRooms.slice(0, 4).map((r) => (
              <button
                key={r.roomId}
                type="button"
                onClick={() => onSwitchRoom(r.roomId)}
                className={`rounded-lg px-2.5 py-1.5 text-[11px] font-medium border ${
                  r.roomId === roomId
                    ? 'border-cyan-400 bg-cyan-500/15 text-cyan-300'
                    : 'border-emerald-500/50 bg-emerald-950/30 text-emerald-200'
                }`}
              >
                {r.title} ({r.collaboratorsCount})
              </button>
            ))}
          </div>
        </div>
      )}

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
      <div className="max-h-[82dvh] w-full overflow-y-auto rounded-t-3xl border-t border-white/15 bg-[#141418] px-4 pt-2 pb-6 shadow-2xl">
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
  {id: 'overlay', label: 'Наложение', icon: Layers},
  {id: 'text', label: 'Текст', icon: Type},
  {id: 'effects', label: 'Эффекты', icon: Sparkles},
  {id: 'audio', label: 'Аудио', icon: Music},
  {id: 'team', label: 'Чат/Сеть', icon: Users},
];
