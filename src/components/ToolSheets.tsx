import React, {useEffect, useRef, useState} from 'react';
import {
  Activity,
  AlertTriangle,
  Check,
  Copy,
  Diamond,
  Download,
  Film,
  FlipHorizontal,
  Layers,
  Minimize2,
  Music,
  Plus,
  RefreshCw,
  Scissors,
  Send,
  Settings,
  Sparkles,
  Trash2,
  Type,
  Upload,
  Users,
  Wifi,
  X,
} from 'lucide-react';
import {ScrubNumberField} from './ScrubNumberField.tsx';
import {
  EASING_OPTIONS,
  evaluateClipTransform,
  generateAdjustmentKeyframePreset,
  generateKeyframePreset,
  upsertKeyframeAtTime,
} from '../lib/keyframeEngine.ts';
import {
  cancelNativeVideoCompression,
  compressClipMedia,
  isNativeMedia3Available,
  uploadFileForP2P,
} from '../lib/lanSyncBridge.ts';
import {requestAIFeature} from '../lib/webcutAi.ts';
import type {
  CompressedMediaResult,
  KtorServerStatus,
} from '../lib/lanSyncBridge.ts';
import type {DownloadQueueItem} from '../hooks/useCollaborativeRoom.ts';
import {
  applyFilterPresetToClipPatch,
  findBuiltinPreset,
} from '../lib/colorPresets.ts';
import {SAMPLE_MEDIA_ASSETS} from '../shared/types.ts';
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
  RoomSummary,
  TransitionType,
} from '../shared/types.ts';

export type ActiveToolTab =
  | 'edit'
  | 'overlay'
  | 'text'
  | 'effects'
  | 'audio'
  | 'settings'
  | 'team';

async function uploadOrLocalMedia(
  file: File,
  fallbackKind: 'video' | 'image' | 'audio' | 'font',
  onProgress?: (pct: number) => void
): Promise<{
  name: string;
  fileName: string;
  kind: 'video' | 'image' | 'audio' | 'font';
  src: string;
  shareUrl: string;
  fileSize?: number;
  fileHash?: string;
}> {
  const prepared = await uploadFileForP2P(file, fallbackKind, onProgress);
  return {
    name: prepared.name,
    fileName: prepared.fileName,
    kind: prepared.kind,
    src: prepared.localSrc,
    shareUrl: prepared.shareUrl,
    fileSize: prepared.fileSize,
    fileHash: prepared.fileHash,
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

  const isAdjustment =
    clip.track === 'adjustment' || clip.kind === 'adjustment';

  return (
    <div
      className={`space-y-3 rounded-xl border p-3 ${
        isAdjustment
          ? 'border-violet-500/35 bg-violet-500/10'
          : 'border-amber-500/30 bg-amber-500/5'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Diamond
            className={`h-3.5 w-3.5 ${
              isAdjustment
                ? 'fill-violet-400 text-violet-400'
                : 'fill-amber-400 text-amber-400'
            }`}
          />
          <span
            className={`text-xs font-semibold ${
              isAdjustment ? 'text-violet-200' : 'text-amber-200'
            }`}
          >
            {isAdjustment
              ? `Ключи эффекта (${keyframes.length})`
              : `Ключи движения (${keyframes.length})`}
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

      {!isAdjustment && (
        <button
          type="button"
          onClick={() =>
            requestAIFeature('motion_tracker_nano', 'AI Авто-трекинг (Ключи)')
          }
          className="flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-violet-400/40 bg-violet-500/15 px-3 text-xs font-semibold text-violet-100 transition hover:bg-violet-500/25 active:scale-[0.99]"
        >
          <span className="flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5 text-violet-300" />
            <span>✨ AI Авто-трекинг объекта</span>
          </span>
          <span className="rounded bg-violet-500/30 px-1.5 py-0.5 font-mono text-[9px] text-violet-200">
            ONNX
          </span>
        </button>
      )}

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
        isAdjustment ? (
          <div className="space-y-1.5 border-t border-white/10 pt-2 text-[11px] text-zinc-300">
            <div className="flex items-center justify-between gap-1">
              <span>Интенсивность эффекта (ключ)</span>
              <ScrubNumberField
                compact
                accent="violet"
                value={Math.round(currentEval.opacity * 100)}
                min={0}
                max={100}
                step={1}
                suffix="%"
                ariaLabel="Интенсивность эффекта ключа"
                onChange={(pct) =>
                  handleUpdateActiveKfField({opacity: pct / 100})
                }
              />
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={currentEval.opacity}
              onChange={(e) =>
                handleUpdateActiveKfField({opacity: Number(e.target.value)})
              }
              className="w-full accent-violet-400"
            />
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 border-t border-white/10 pt-2 text-[11px] text-zinc-300">
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-1">
                <span>Масштаб (ключ)</span>
                <ScrubNumberField
                  compact
                  accent="amber"
                  value={Math.round(currentEval.scale * 100)}
                  min={15}
                  max={250}
                  step={1}
                  suffix="%"
                  ariaLabel="Масштаб ключа"
                  onChange={(pct) => handleUpdateActiveKfField({scale: pct / 100})}
                />
              </div>
              <input
                type="range"
                min={0.15}
                max={2.5}
                step={0.05}
                value={Math.max(0.15, Math.min(2.5, currentEval.scale))}
                onChange={(e) =>
                  handleUpdateActiveKfField({scale: Number(e.target.value)})
                }
                className="w-full accent-amber-400"
              />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-1">
                <span>Поворот (ключ)</span>
                <ScrubNumberField
                  compact
                  accent="amber"
                  value={Math.round(currentEval.rotation)}
                  min={-180}
                  max={180}
                  step={1}
                  suffix="°"
                  ariaLabel="Поворот ключа"
                  onChange={(deg) => handleUpdateActiveKfField({rotation: deg})}
                />
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
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-1">
                <span>Scale X (ключ)</span>
                <ScrubNumberField
                  compact
                  accent="amber"
                  value={Math.round(currentEval.scaleX * 100)}
                  min={10}
                  max={300}
                  step={1}
                  suffix="%"
                  ariaLabel="Scale X ключа"
                  onChange={(pct) =>
                    handleUpdateActiveKfField({scaleX: pct / 100})
                  }
                />
              </div>
              <input
                type="range"
                min={0.1}
                max={3}
                step={0.02}
                value={Math.max(0.1, Math.min(3, currentEval.scaleX))}
                onChange={(e) =>
                  handleUpdateActiveKfField({scaleX: Number(e.target.value)})
                }
                className="w-full accent-amber-400"
              />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-1">
                <span>Scale Y (ключ)</span>
                <ScrubNumberField
                  compact
                  accent="amber"
                  value={Math.round(currentEval.scaleY * 100)}
                  min={10}
                  max={300}
                  step={1}
                  suffix="%"
                  ariaLabel="Scale Y ключа"
                  onChange={(pct) =>
                    handleUpdateActiveKfField({scaleY: pct / 100})
                  }
                />
              </div>
              <input
                type="range"
                min={0.1}
                max={3}
                step={0.02}
                value={Math.max(0.1, Math.min(3, currentEval.scaleY))}
                onChange={(e) =>
                  handleUpdateActiveKfField({scaleY: Number(e.target.value)})
                }
                className="w-full accent-amber-400"
              />
            </div>
          </div>
        )
      )}

      {/* Quick Presets */}
      <div>
        <p className="mb-1.5 text-[11px] font-medium text-zinc-400">
          {isAdjustment
            ? 'Готовая анимация появления эффекта:'
            : 'Готовая анимация по ключам:'}
        </p>
        {isAdjustment ? (
          <div className="grid grid-cols-2 gap-1.5">
            {(
              [
                {id: 'fade-in', label: 'Плавный вход'},
                {id: 'fade-out', label: 'Плавный выход'},
                {id: 'fade-in-out', label: 'Вход и выход'},
                {id: 'pulse', label: 'Пульсация'},
              ] as const
            ).map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() =>
                  onUpdateClip(clip.id, {
                    keyframes: generateAdjustmentKeyframePreset(clip, preset.id),
                  })
                }
                className="rounded-lg border border-white/10 bg-zinc-900 px-2 py-1.5 text-[11px] font-medium text-zinc-200 hover:border-violet-400/50"
              >
                {preset.label}
              </button>
            ))}
          </div>
        ) : (
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
        )}
      </div>

      <p className="text-[10px] text-zinc-400">
        {isAdjustment
          ? 'Подсказка: задайте ключи интенсивности в разных точках слоя для плавного появления и затухания эффекта.'
          : 'Подсказка: переместите линию времени и перетащите объект пальцем по экрану — ключ сохранит новую позицию.'}
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
    fileSize?: number;
    fileHash?: string;
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
  const [forceNewTrack, setForceNewTrack] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState<number>(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    setUploadPct(0);
    setErrorMsg(null);

    try {
      for (const file of Array.from(files)) {
        const isVideo =
          file.type.startsWith('video/') ||
          /\.(mp4|mov|webm|mkv|avi|m4v|3gp)$/i.test(file.name);
        const uploaded = await uploadOrLocalMedia(
          file,
          isVideo ? 'video' : 'image',
          (pct) => setUploadPct(pct)
        );
        const mediaKind = uploaded.kind === 'video' ? 'video' : 'image';
        const dur = await probeMediaDuration(uploaded.src, mediaKind);
        onAddMediaClip({
          name: uploaded.name,
          kind: mediaKind,
          src: uploaded.src,
          fileName: uploaded.fileName,
          remoteUrl: uploaded.shareUrl,
          fileSize: uploaded.fileSize,
          fileHash: uploaded.fileHash,
          duration: Math.min(1800, dur),
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
      setUploadPct(0);
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
              setForceNewTrack(false);
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
            ? uploadPct > 0
              ? `Загрузка файла... ${uploadPct}%`
              : 'Загрузка файла...'
            : 'Выбрать видео (до 30 мин) или фото'}
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
  const overlayEval =
    isOverlay && selectedClip
      ? evaluateClipTransform(selectedClip, currentTime)
      : null;

  const updateOverlayTransform = (patch: {
    x?: number;
    y?: number;
    scale?: number;
    rotation?: number;
    flipHorizontal?: boolean;
  }) => {
    if (!selectedClip) return;
    if (selectedClip.keyframes && selectedClip.keyframes.length > 0) {
      const {keyframes} = upsertKeyframeAtTime(selectedClip, currentTime, patch);
      onUpdateClip(selectedClip.id, {keyframes});
      return;
    }
    const basePatch: Partial<Clip> = {};
    if (patch.x !== undefined) basePatch.mediaX = patch.x;
    if (patch.y !== undefined) basePatch.mediaY = patch.y;
    if (patch.scale !== undefined) basePatch.mediaScale = patch.scale;
    if (patch.rotation !== undefined) basePatch.rotation = patch.rotation;
    if (patch.flipHorizontal !== undefined) {
      basePatch.flipHorizontal = patch.flipHorizontal;
    }
    onUpdateClip(selectedClip.id, basePatch);
  };

  return (
    <div className="space-y-4">
      {isOverlay && overlayEval && (
        <>
          <div className="space-y-3 rounded-xl border border-indigo-500/30 bg-indigo-500/10 p-3">
            <div className="flex items-center justify-between">
              <p className="truncate text-xs font-semibold text-indigo-200">
                Наложение: {selectedClip.name}
              </p>
              <button
                type="button"
                onClick={() =>
                  updateOverlayTransform({
                    flipHorizontal: !overlayEval.flipHorizontal,
                  })
                }
                className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium ${
                  overlayEval.flipHorizontal
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
                      updateOverlayTransform({
                        x: pos.x,
                        y: pos.y,
                      })
                    }
                    className="h-8 rounded-lg border border-white/10 bg-zinc-900 text-xs font-bold text-zinc-200 hover:border-indigo-400"
                  >
                    {pos.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1 text-xs text-zinc-300">
              <div className="flex items-center justify-between">
                <span>Размер (PIP)</span>
                <ScrubNumberField
                  compact
                  accent="indigo"
                  value={Math.round(overlayEval.scale * 100)}
                  min={10}
                  max={250}
                  step={1}
                  suffix="%"
                  ariaLabel="Размер PIP"
                  onChange={(pct) =>
                    updateOverlayTransform({scale: pct / 100})
                  }
                />
              </div>
              <input
                type="range"
                min={0.15}
                max={2.5}
                step={0.05}
                value={Math.max(0.15, Math.min(2.5, overlayEval.scale))}
                onChange={(e) =>
                  updateOverlayTransform({
                    scale: Number(e.target.value),
                  })
                }
                className="w-full accent-indigo-400"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1 text-xs text-zinc-300">
                <div className="flex items-center justify-between">
                  <span>Поворот</span>
                  <ScrubNumberField
                    compact
                    accent="indigo"
                    value={Math.round(overlayEval.rotation)}
                    min={-180}
                    max={180}
                    step={1}
                    suffix="°"
                    ariaLabel="Поворот PIP"
                    onChange={(deg) =>
                      updateOverlayTransform({rotation: deg})
                    }
                  />
                </div>
                <input
                  type="range"
                  min={-180}
                  max={180}
                  step={2}
                  value={overlayEval.rotation}
                  onChange={(e) =>
                    updateOverlayTransform({
                      rotation: Number(e.target.value),
                    })
                  }
                  className="w-full accent-indigo-400"
                />
              </div>

              <div className="space-y-1 text-xs text-zinc-300">
                <div className="flex items-center justify-between">
                  <span>Скругление</span>
                  <ScrubNumberField
                    compact
                    accent="indigo"
                    value={selectedClip.borderRadius ?? 20}
                    min={0}
                    max={120}
                    step={1}
                    suffix="px"
                    ariaLabel="Скругление углов"
                    onChange={(px) =>
                      onUpdateClip(selectedClip.id, {borderRadius: px})
                    }
                  />
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
              </div>

              <div className="space-y-1 text-xs text-zinc-300">
                <div className="flex items-center justify-between">
                  <span>Рамка</span>
                  <ScrubNumberField
                    compact
                    accent="indigo"
                    value={selectedClip.borderWidth ?? 0}
                    min={0}
                    max={24}
                    step={1}
                    suffix="px"
                    ariaLabel="Толщина рамки"
                    onChange={(px) =>
                      onUpdateClip(selectedClip.id, {borderWidth: px})
                    }
                  />
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
              </div>

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
   TEXT PANEL (re-exported from TextPanel.tsx)
   ========================================================================= */

export {TextPanel} from './TextPanel.tsx';
export type {TextColorField} from './TextPanel.tsx';

/* =========================================================================
   EFFECTS PANEL
   ========================================================================= */

interface EffectsPanelProps {
  selectedClip: Clip | null;
  onUpdateClip: (clipId: string, patch: Partial<Clip>) => void;
  onAddAdjustmentLayer?: () => void;
}

const FILTER_PRESETS: Array<{id: FilterPreset; label: string}> = [
  {id: 'none', label: 'Оригинал'},
  {id: 'bw', label: 'Ч/Б'},
  {id: 'sepia', label: 'Сепия'},
  {id: 'cool', label: 'Холодный'},
  {id: 'warm', label: 'Тёплый'},
  {id: 'cinema', label: 'Кино'},
  {id: 'invert', label: 'Инверсия'},
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
  onAddAdjustmentLayer,
}) => {
  if (!selectedClip || selectedClip.track === 'audio') {
    return (
      <div className="space-y-3">
        {onAddAdjustmentLayer && (
          <button
            type="button"
            onClick={onAddAdjustmentLayer}
            className="flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-violet-400/50 bg-violet-500/20 px-3 text-xs font-semibold text-violet-200 hover:bg-violet-500/30 active:scale-[0.99]"
          >
            <Sparkles className="h-4 w-4 text-violet-300" />
            + Корректирующий слой (3с)
          </button>
        )}
        <div className="rounded-xl border border-white/10 bg-zinc-900/60 p-4 text-center text-xs text-zinc-400">
          Добавьте корректирующий слой или выберите клип на таймлайне, чтобы настроить фильтры и анимацию.
        </div>
      </div>
    );
  }

  const isAdjustment =
    selectedClip.track === 'adjustment' || selectedClip.kind === 'adjustment';
  const availTransitions = isAdjustment
    ? TRANSITIONS.filter((t) => t.id === 'none' || t.id === 'fade')
    : TRANSITIONS;

  return (
    <div className="space-y-4">
      {onAddAdjustmentLayer && !isAdjustment && (
        <button
          type="button"
          onClick={onAddAdjustmentLayer}
          className="flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-violet-400/45 bg-violet-500/15 px-3 text-xs font-semibold text-violet-200 hover:bg-violet-500/25 active:scale-[0.99]"
        >
          <Sparkles className="h-4 w-4 text-violet-300" />
          + Корректирующий слой (3с)
        </button>
      )}
      {isAdjustment && (
        <div className="rounded-xl border border-violet-400/35 bg-violet-500/10 p-2.5 text-[11px] text-violet-200">
          Корректирующий слой применяет цвет, размытие и фильтры ко всем слоям выше на таймлайне, не затрагивая слои ниже.
        </div>
      )}
      <div>
        <p className="mb-2 text-xs font-medium text-zinc-400">Цветовой фильтр</p>
        <div className="flex flex-wrap gap-1.5">
          {FILTER_PRESETS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => {
                const preset = findBuiltinPreset(f.id);
                if (preset) {
                  onUpdateClip(
                    selectedClip.id,
                    applyFilterPresetToClipPatch(preset)
                  );
                } else {
                  onUpdateClip(selectedClip.id, {filter: f.id});
                }
              }}
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
        <p className="mb-2 text-xs font-medium text-zinc-400">
          {isAdjustment ? 'Плавное появление' : 'Переход в начале'}
        </p>
        <div
          className={`grid gap-1.5 ${
            availTransitions.length === 2 ? 'grid-cols-2' : 'grid-cols-4'
          }`}
        >
          {availTransitions.map((t) => (
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
        <p className="mb-2 text-xs font-medium text-zinc-400">
          {isAdjustment ? 'Плавное затухание' : 'Переход в конце'}
        </p>
        <div
          className={`grid gap-1.5 ${
            availTransitions.length === 2 ? 'grid-cols-2' : 'grid-cols-4'
          }`}
        >
          {availTransitions.map((t) => (
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

      {!isAdjustment &&
        (selectedClip.track === 'video' || selectedClip.track === 'overlay') && (
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
        <div className="space-y-1 text-xs text-zinc-400">
          <div className="flex items-center justify-between gap-1">
            <span>Яркость</span>
            <ScrubNumberField
              compact
              accent="cyan"
              value={Math.round(selectedClip.brightness * 100)}
              min={25}
              max={200}
              step={1}
              suffix="%"
              ariaLabel="Яркость"
              onChange={(pct) =>
                onUpdateClip(selectedClip.id, {brightness: pct / 100})
              }
            />
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
        </div>

        <div className="space-y-1 text-xs text-zinc-400">
          <div className="flex items-center justify-between gap-1">
            <span>Контраст</span>
            <ScrubNumberField
              compact
              accent="cyan"
              value={Math.round(selectedClip.contrast * 100)}
              min={25}
              max={200}
              step={1}
              suffix="%"
              ariaLabel="Контраст"
              onChange={(pct) =>
                onUpdateClip(selectedClip.id, {contrast: pct / 100})
              }
            />
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
        </div>

        <div className="space-y-1 text-xs text-zinc-400">
          <div className="flex items-center justify-between gap-1">
            <span>Насыщенность</span>
            <ScrubNumberField
              compact
              accent="cyan"
              value={Math.round(selectedClip.saturate * 100)}
              min={0}
              max={250}
              step={1}
              suffix="%"
              ariaLabel="Насыщенность"
              onChange={(pct) =>
                onUpdateClip(selectedClip.id, {saturate: pct / 100})
              }
            />
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
        </div>

        <div className="space-y-1 text-xs text-zinc-400">
          <div className="flex items-center justify-between gap-1">
            <span>Прозрачность</span>
            <ScrubNumberField
              compact
              accent="cyan"
              value={Math.round(selectedClip.opacity * 100)}
              min={0}
              max={100}
              step={1}
              suffix="%"
              ariaLabel="Прозрачность"
              onChange={(pct) =>
                onUpdateClip(selectedClip.id, {opacity: pct / 100})
              }
            />
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
        </div>

        <div className="space-y-1 text-xs text-zinc-400">
          <div className="flex items-center justify-between gap-1">
            <span>Размытие</span>
            <ScrubNumberField
              compact
              accent="cyan"
              value={selectedClip.blur ?? 0}
              min={0}
              max={32}
              step={1}
              suffix="px"
              ariaLabel="Размытие"
              onChange={(px) => onUpdateClip(selectedClip.id, {blur: px})}
            />
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
        </div>

        <div className="space-y-1 text-xs text-zinc-400">
          <div className="flex items-center justify-between gap-1">
            <span>Виньетка</span>
            <ScrubNumberField
              compact
              accent="cyan"
              value={Math.round((selectedClip.vignette ?? 0) * 100)}
              min={0}
              max={100}
              step={1}
              suffix="%"
              ariaLabel="Виньетка"
              onChange={(pct) =>
                onUpdateClip(selectedClip.id, {vignette: pct / 100})
              }
            />
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
  pingMs?: number | null;
  ktorStatus?: KtorServerStatus;
  downloadQueue?: DownloadQueueItem[];
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
  onForceSyncProject?: () => void;
  onRetryDownload?: (clipId: string) => void;
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
  pingMs = null,
  ktorStatus,
  downloadQueue = [],
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
  onForceSyncProject,
  onRetryDownload,
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

  const activeDownloadCount = downloadQueue.filter(
    (d) => d.status === 'DOWNLOADING'
  ).length;
  const errorDownloadItems = downloadQueue.filter((d) => d.status === 'ERROR');
  const ktorLabel =
    ktorStatus?.state === 'port_error'
      ? `Ошибка порта (${ktorStatus.port})`
      : ktorStatus?.state === 'running'
        ? `Ktor запущен :${ktorStatus.port}`
        : ktorStatus?.state === 'web'
          ? `HTTP :${ktorStatus.port} · OK`
          : 'Ktor остановлен';
  const ktorBadgeClass =
    ktorStatus?.state === 'port_error'
      ? 'border-rose-500/40 bg-rose-500/15 text-rose-300'
      : ktorStatus?.state === 'running' || ktorStatus?.state === 'web'
        ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-300'
        : 'border-zinc-700 bg-zinc-900 text-zinc-400';

  return (
    <div className="space-y-4">
      {/* Compact Connection & Sync Diagnostics Bar */}
      <div className="space-y-2 rounded-xl border border-cyan-500/30 bg-zinc-950/90 p-2.5">
        <div className="flex flex-wrap items-center justify-between gap-1.5 text-[11px]">
          <div className="flex items-center gap-1.5">
            <Activity
              className={`h-3.5 w-3.5 ${
                status === 'connected'
                  ? 'text-emerald-400'
                  : status === 'reconnecting'
                    ? 'text-amber-400 animate-pulse'
                    : 'text-rose-400'
              }`}
            />
            <span className="font-mono font-semibold text-white">
              Пинг: {pingMs !== null ? `${pingMs} мс` : status === 'reconnecting' ? 'Повтор...' : '—'}
            </span>
          </div>

          <span
            className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold ${ktorBadgeClass}`}
            title={ktorStatus?.error || ktorLabel}
          >
            {ktorLabel}
          </span>

          <span
            className={`flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-semibold ${
              errorDownloadItems.length > 0
                ? 'border-rose-500/40 bg-rose-500/15 text-rose-300'
                : activeDownloadCount > 0
                  ? 'border-cyan-500/40 bg-cyan-500/15 text-cyan-300'
                  : 'border-white/10 bg-zinc-900 text-zinc-400'
            }`}
          >
            <Download className="h-3 w-3" />
            <span>
              Очередь: {activeDownloadCount}
              {errorDownloadItems.length > 0
                ? ` · Ошибок: ${errorDownloadItems.length}`
                : ''}
            </span>
          </span>
        </div>

        {errorDownloadItems.length > 0 && (
          <div className="space-y-1 rounded-lg border border-rose-500/30 bg-rose-950/30 p-2">
            {errorDownloadItems.map((item) => (
              <div
                key={item.layerId}
                className="flex items-center justify-between gap-2 text-[10px] text-rose-200"
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <AlertTriangle className="h-3 w-3 shrink-0 text-rose-400" />
                  <span className="truncate">
                    {item.fileName}: {item.error || 'Сбой сети'}
                  </span>
                </div>
                {onRetryDownload && (
                  <button
                    type="button"
                    onClick={() => onRetryDownload(item.layerId)}
                    className="shrink-0 rounded bg-rose-500 px-2 py-0.5 font-semibold text-white hover:bg-rose-400"
                  >
                    Перекачать
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {onForceSyncProject && (
          <button
            type="button"
            onClick={onForceSyncProject}
            disabled={status === 'offline'}
            className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-cyan-500/35 bg-cyan-500/10 text-[11px] font-semibold text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-45"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>Принудительно синхронизировать проект</span>
          </button>
        )}
      </div>

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
              className="h-10 min-w-0 flex-1 rounded-lg border border-white/15 bg-zinc-950 px-2.5 font-mono text-xs text-white placeholder:text-zinc-500 focus:border-cyan-400 focus:outline-none"
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
            className="h-10 min-w-0 flex-1 rounded-lg border border-white/10 bg-zinc-950 px-3 text-xs text-white placeholder:text-zinc-500 focus:border-cyan-400 focus:outline-none"
          />
          <button
            type="submit"
            aria-label="Отправить сообщение"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-cyan-500 text-zinc-950 hover:bg-cyan-400"
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

interface CompressPreset {
  id: string;
  label: string;
  desc: string;
  height: number;
  bitrate: number;
}

const COMPRESS_PRESETS: CompressPreset[] = [
  {
    id: '720p',
    label: '720p (HD)',
    desc: '2.2 Мбит/с · Хорошее качество',
    height: 720,
    bitrate: 2_200_000,
  },
  {
    id: '480p',
    label: '480p (SD)',
    desc: '1.1 Мбит/с · Оптимально для сети',
    height: 480,
    bitrate: 1_100_000,
  },
  {
    id: '360p-low',
    label: '360p · Низкий битрейт',
    desc: '550 кбит/с · Минимальный вес для P2P',
    height: 360,
    bitrate: 550_000,
  },
];

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '—';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

interface CompressMediaModalProps {
  clip: Clip;
  onApplyCompressed: (result: CompressedMediaResult) => void;
  onClose: () => void;
}

export const CompressMediaModal: React.FC<CompressMediaModalProps> = ({
  clip,
  onApplyCompressed,
  onClose,
}) => {
  const [selectedPresetId, setSelectedPresetId] = useState<string>('480p');
  const [customBitrateKbps, setCustomBitrateKbps] = useState<number>(1100);
  const [compressing, setCompressing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [result, setResult] = useState<CompressedMediaResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const selectedPreset =
    COMPRESS_PRESETS.find((p) => p.id === selectedPresetId) ??
    COMPRESS_PRESETS[1];
  const isNativeMedia3 = isNativeMedia3Available() && clip.kind === 'video';

  useEffect(() => {
    setCustomBitrateKbps(Math.round(selectedPreset.bitrate / 1000));
  }, [selectedPreset.id, selectedPreset.bitrate]);

  const handleStart = async () => {
    if (!clip.src || (clip.kind !== 'video' && clip.kind !== 'image')) return;
    setCompressing(true);
    setProgress(0);
    setErrorMsg(null);
    setResult(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await compressClipMedia({
        layerId: clip.id,
        kind: clip.kind,
        sourceUrl: clip.src,
        fileName: clip.mediaFileName || clip.name || 'clip.mp4',
        targetHeight: selectedPreset.height,
        targetBitrate: customBitrateKbps * 1000,
        onProgress: (pct) => setProgress(pct),
        signal: controller.signal,
      });
      setResult(res);
      onApplyCompressed(res);
    } catch (err) {
      if (!controller.signal.aborted) {
        setErrorMsg(
          err instanceof Error ? err.message : 'Не удалось сжать медиафайл'
        );
      }
    } finally {
      setCompressing(false);
      abortRef.current = null;
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
    void cancelNativeVideoCompression(clip.id);
    setCompressing(false);
  };

  const savedPercent =
    result && result.originalSizeBytes > 0
      ? Math.max(
          0,
          Math.round(
            (1 - result.compressedSizeBytes / result.originalSizeBytes) * 100
          )
        )
      : null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 p-0 backdrop-blur-xs sm:items-center sm:p-4">
      <div className="w-full max-w-md space-y-4 rounded-t-3xl border border-white/15 bg-[#141418] p-5 shadow-2xl sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Minimize2 className="h-4 w-4 shrink-0 text-cyan-400" />
              <h3 className="truncate text-base font-semibold text-white">
                Сжать исходник (Качество)
              </h3>
            </div>
            <p className="mt-0.5 truncate text-xs text-zinc-400">
              {clip.name} ·{' '}
              {isNativeMedia3
                ? 'Media3 Transformer (H.264 / AAC)'
                : 'Локальное перекодирование'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              if (compressing) handleCancel();
              onClose();
            }}
            aria-label="Закрыть диалог сжатия"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-zinc-300 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium text-zinc-400">
            Выберите разрешение и профиль сжатия
          </p>
          <div className="space-y-2">
            {COMPRESS_PRESETS.map((preset) => {
              const active = preset.id === selectedPresetId;
              return (
                <button
                  key={preset.id}
                  type="button"
                  disabled={compressing}
                  onClick={() => setSelectedPresetId(preset.id)}
                  className={`flex w-full items-center justify-between rounded-xl border px-3.5 py-2.5 text-left transition ${
                    active
                      ? 'border-cyan-400 bg-cyan-500/15'
                      : 'border-white/10 bg-zinc-900/80 hover:border-white/25'
                  } disabled:opacity-60`}
                >
                  <div>
                    <p
                      className={`text-xs font-semibold ${
                        active ? 'text-cyan-200' : 'text-white'
                      }`}
                    >
                      {preset.label}
                    </p>
                    <p className="text-[11px] text-zinc-400">{preset.desc}</p>
                  </div>
                  {active && <Check className="h-4 w-4 shrink-0 text-cyan-400" />}
                </button>
              );
            })}
          </div>
        </div>

        <label className="block space-y-1.5 rounded-xl border border-white/10 bg-zinc-900/60 p-3 text-xs text-zinc-300">
          <div className="flex items-center justify-between">
            <span>Целевой битрейт</span>
            <span className="font-mono font-semibold tabular-nums text-cyan-300">
              {customBitrateKbps >= 1000
                ? `${(customBitrateKbps / 1000).toFixed(1)} Мбит/с`
                : `${customBitrateKbps} кбит/с`}
            </span>
          </div>
          <input
            type="range"
            min={350}
            max={4000}
            step={50}
            disabled={compressing}
            value={customBitrateKbps}
            onChange={(e) => setCustomBitrateKbps(Number(e.target.value))}
            className="w-full accent-cyan-400"
          />
        </label>

        {compressing && (
          <div className="space-y-2 rounded-xl border border-cyan-500/30 bg-cyan-500/10 p-3">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-cyan-200">
                Перекодирование исходника...
              </span>
              <span className="font-mono tabular-nums text-white">
                {progress}%
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
              <div
                style={{width: `${progress}%`}}
                className="h-full bg-cyan-400 transition-all duration-150"
              />
            </div>
          </div>
        )}

        {errorMsg && (
          <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
            {errorMsg}
          </p>
        )}

        {result && (
          <div className="space-y-1 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs">
            <p className="font-semibold text-emerald-300">
              Исходник сжат и обновлён в клипе
            </p>
            <p className="font-mono text-[11px] text-zinc-200">
              {formatBytes(result.originalSizeBytes)} →{' '}
              {formatBytes(result.compressedSizeBytes)}
              {savedPercent !== null ? ` (−${savedPercent}%)` : ''}
            </p>
          </div>
        )}

        <div className="flex gap-2 pt-1">
          {compressing ? (
            <button
              type="button"
              onClick={handleCancel}
              className="h-11 flex-1 rounded-xl border border-rose-500/40 bg-rose-500/15 text-xs font-semibold text-rose-300 hover:bg-rose-500/25"
            >
              Отменить сжатие
            </button>
          ) : result ? (
            <button
              type="button"
              onClick={onClose}
              className="h-11 flex-1 rounded-xl bg-emerald-500 text-xs font-semibold text-zinc-950 hover:bg-emerald-400"
            >
              Готово
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                className="h-11 rounded-xl border border-white/10 bg-zinc-900 px-4 text-xs font-medium text-zinc-300 hover:bg-zinc-800"
              >
                Закрыть
              </button>
              <button
                type="button"
                onClick={() => void handleStart()}
                className="h-11 flex-1 rounded-xl bg-cyan-500 text-xs font-semibold text-zinc-950 hover:bg-cyan-400 active:scale-[0.99]"
              >
                Сжать и применить
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export const TOOL_TABS: Array<{
  id: ActiveToolTab;
  label: string;
  icon: React.FC<{className?: string}>;
}> = [
  {id: 'edit', label: 'Изменить', icon: Scissors},
  {id: 'audio', label: 'Звук', icon: Music},
  {id: 'text', label: 'Текст', icon: Type},
  {id: 'overlay', label: 'Наложение', icon: Layers},
  {id: 'effects', label: 'Эффекты', icon: Sparkles},
  {id: 'settings', label: 'Настройки', icon: Settings},
  {id: 'team', label: 'Чат/Сеть', icon: Users},
];
