import React from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Diamond,
  FlipHorizontal2,
  FlipVertical2,
  Grid3X3,
  Move,
  RotateCcw,
  Scan,
} from 'lucide-react';
import type {Clip, ClipWarp, WarpMode} from '../shared/types.ts';
import {
  evaluateClipTransform,
  upsertKeyframeAtTime,
} from '../lib/keyframeEngine.ts';
import {
  createDefaultWarp,
  isIdentityWarp,
  normalizeWarp,
  resampleMeshGrid,
} from '../lib/warpEngine.ts';
import {ScrubNumberField} from './ScrubNumberField.tsx';

export interface ClipTransformPatch {
  x?: number;
  y?: number;
  scale?: number;
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
  flipHorizontal?: boolean;
  flipVertical?: boolean;
  warp?: ClipWarp;
}

interface TransformPanelProps {
  clip: Clip;
  currentTime?: number;
  onSeek?: (time: number) => void;
  onUpdateClip: (
    clipId: string,
    patch: Partial<Clip>,
    opts?: {skipUndo?: boolean; skipSync?: boolean}
  ) => void;
  onUpdateTransform?: (
    clipId: string,
    patch: ClipTransformPatch,
    opts?: {skipUndo?: boolean; skipSync?: boolean}
  ) => void;
  onUpdateWarp?: (clipId: string, warp: ClipWarp, commit: boolean) => void;
  onOpenTrackpad?: () => void;
  trackpadActive?: boolean;
}

export const TransformPanel: React.FC<TransformPanelProps> = ({
  clip,
  currentTime = 0,
  onSeek,
  onUpdateClip,
  onUpdateTransform,
  onUpdateWarp,
  onOpenTrackpad,
  trackpadActive = false,
}) => {
  const evaluated = evaluateClipTransform(clip, currentTime);
  const scaleX = evaluated.scaleX;
  const scaleY = evaluated.scaleY;
  const flipH = evaluated.flipHorizontal;
  const flipV = evaluated.flipVertical;
  const currentWarp = normalizeWarp(evaluated.warp ?? clip.warp);

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
  const prevKf = [...keyframes]
    .reverse()
    .find((k) => k.timeOffset < localTime - 0.12);
  const nextKf = keyframes.find((k) => k.timeOffset > localTime + 0.12);

  const defaultX = clip.track === 'overlay' ? 0.72 : 0.5;
  const defaultY =
    clip.track === 'overlay' ? 0.26 : clip.track === 'text' ? 0.76 : 0.5;
  const defaultScale = clip.track === 'overlay' ? 0.42 : 1;

  const hasChanges =
    flipH ||
    flipV ||
    Math.abs(scaleX - 1) > 0.005 ||
    Math.abs(scaleY - 1) > 0.005 ||
    Math.abs(evaluated.scale - defaultScale) > 0.01 ||
    Math.abs(evaluated.rotation) > 0.5 ||
    Math.abs(evaluated.x - defaultX) > 0.01 ||
    Math.abs(evaluated.y - defaultY) > 0.01 ||
    !isIdentityWarp(currentWarp);

  const applyTransformPatch = (
    patch: ClipTransformPatch,
    commit: boolean
  ) => {
    const opts = {skipUndo: !commit, skipSync: !commit};
    if (onUpdateTransform) {
      onUpdateTransform(clip.id, patch, opts);
      return;
    }

    if (clip.keyframes && clip.keyframes.length > 0) {
      const {keyframes: next} = upsertKeyframeAtTime(clip, currentTime, patch);
      onUpdateClip(clip.id, {keyframes: next}, opts);
      return;
    }

    const basePatch: Partial<Clip> = {};
    if (patch.scaleX !== undefined) basePatch.scaleX = patch.scaleX;
    if (patch.scaleY !== undefined) basePatch.scaleY = patch.scaleY;
    if (patch.flipHorizontal !== undefined) {
      basePatch.flipHorizontal = patch.flipHorizontal;
    }
    if (patch.flipVertical !== undefined) {
      basePatch.flipVertical = patch.flipVertical;
    }
    if (patch.scale !== undefined) basePatch.mediaScale = patch.scale;
    if (patch.rotation !== undefined) basePatch.rotation = patch.rotation;
    if (patch.warp !== undefined) basePatch.warp = patch.warp;
    if (patch.x !== undefined || patch.y !== undefined) {
      if (clip.track === 'text' && clip.textStyle) {
        basePatch.textStyle = {
          ...clip.textStyle,
          ...(patch.x !== undefined ? {x: patch.x} : {}),
          ...(patch.y !== undefined ? {y: patch.y} : {}),
        };
      } else {
        if (patch.x !== undefined) basePatch.mediaX = patch.x;
        if (patch.y !== undefined) basePatch.mediaY = patch.y;
      }
    }
    onUpdateClip(clip.id, basePatch, opts);
  };

  const commitWarp = (next: ClipWarp) => {
    if (onUpdateWarp) {
      onUpdateWarp(clip.id, next, true);
    } else {
      applyTransformPatch({warp: next}, true);
    }
  };

  const handleToggleKeyframe = () => {
    if (activeKf) {
      const remaining = keyframes.filter((k) => k.id !== activeKf.id);
      onUpdateClip(clip.id, {keyframes: remaining});
      return;
    }
    const {keyframes: next} = upsertKeyframeAtTime(clip, currentTime);
    onUpdateClip(clip.id, {keyframes: next});
  };

  const handleSelectWarpMode = (mode: WarpMode) => {
    if (currentWarp.mode === mode) return;
    if (mode === 'none') {
      commitWarp(createDefaultWarp('none', currentWarp.meshSize));
      return;
    }
    commitWarp({
      ...currentWarp,
      mode,
    });
  };

  const handleSelectMeshSize = (nextSize: 3 | 4) => {
    if (currentWarp.meshSize === nextSize && currentWarp.mode === 'mesh') return;
    const resampled = resampleMeshGrid(
      currentWarp.meshPoints,
      currentWarp.meshSize,
      nextSize
    );
    commitWarp({
      ...currentWarp,
      mode: 'mesh',
      meshSize: nextSize,
      meshPoints: resampled,
    });
  };

  const updateAxisScale = (
    axis: 'scaleX' | 'scaleY',
    value: number,
    commit: boolean
  ) => {
    const clamped = Math.max(0.1, Math.min(3, Math.round(value * 100) / 100));
    applyTransformPatch({[axis]: clamped}, commit);
  };

  const updateUniformScale = (value: number, commit: boolean) => {
    const clamped = Math.max(0.1, Math.min(2.5, Math.round(value * 100) / 100));
    applyTransformPatch({scale: clamped}, commit);
  };

  const updateRotation = (deg: number, commit: boolean) => {
    const clamped = Math.max(-180, Math.min(180, Math.round(deg)));
    applyTransformPatch({rotation: clamped}, commit);
  };

  const updatePosition = (axis: 'x' | 'y', value: number, commit: boolean) => {
    const clamped = Math.max(-2, Math.min(3, Math.round(value * 1000) / 1000));
    applyTransformPatch({[axis]: clamped}, commit);
  };

  return (
    <div className="space-y-3">
      {/* Keyframe Bar for Animating Transform */}
      <div className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <Diamond
              className={`h-3.5 w-3.5 shrink-0 ${
                activeKf
                  ? 'fill-amber-400 text-amber-300'
                  : keyframes.length > 0
                    ? 'text-amber-400'
                    : 'text-zinc-400'
              }`}
            />
            <span className="truncate text-xs font-semibold text-amber-200">
              Ключи анимации ({keyframes.length})
            </span>
          </div>
          <div className="flex items-center gap-1">
            {onSeek && keyframes.length > 0 && (
              <>
                <button
                  type="button"
                  disabled={!prevKf}
                  onClick={() => prevKf && onSeek(clip.start + prevKf.timeOffset)}
                  title="Предыдущий ключ"
                  aria-label="Предыдущий ключ"
                  className="flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 bg-zinc-900 text-zinc-300 hover:border-amber-400/50 disabled:opacity-35"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  disabled={!nextKf}
                  onClick={() => nextKf && onSeek(clip.start + nextKf.timeOffset)}
                  title="Следующий ключ"
                  aria-label="Следующий ключ"
                  className="flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 bg-zinc-900 text-zinc-300 hover:border-amber-400/50 disabled:opacity-35"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </>
            )}
            <button
              type="button"
              onClick={handleToggleKeyframe}
              className={`flex h-7 items-center gap-1 rounded-lg px-2.5 text-[11px] font-semibold transition active:scale-95 ${
                activeKf
                  ? 'border border-rose-500/40 bg-rose-500/20 text-rose-200 hover:bg-rose-500/30'
                  : 'bg-amber-400 text-zinc-950 hover:bg-amber-300'
              }`}
            >
              <Diamond className="h-3 w-3" />
              <span>{activeKf ? 'Удалить ключ' : '+ Ключ'}</span>
            </button>
          </div>
        </div>
        <p className="text-[10px] leading-snug text-zinc-400">
          {keyframes.length > 0
            ? 'Любое изменение трансформации, масштаба или деформации на текущей точке времени создаёт или обновляет ключ — объект будет плавно меняться между ключами.'
            : 'Нажмите «+ Ключ», затем переместите ползунок времени и измените форму, масштаб или позицию объекта.'}
        </p>
      </div>

      {/* Position, Scale & Rotation */}
      <div className="space-y-2.5 rounded-xl border border-white/10 bg-zinc-900/60 p-3">
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[11px] text-zinc-300">
              <span>Позиция X</span>
              <ScrubNumberField
                compact
                accent="cyan"
                value={Math.round(evaluated.x * 100)}
                min={-150}
                max={250}
                step={1}
                suffix="%"
                ariaLabel="Позиция X"
                onChange={(pct) => updatePosition('x', pct / 100, false)}
                onCommit={(pct) => updatePosition('x', pct / 100, true)}
              />
            </div>
            <input
              type="range"
              min={-0.5}
              max={1.5}
              step={0.01}
              value={Math.max(-0.5, Math.min(1.5, evaluated.x))}
              onChange={(e) => updatePosition('x', Number(e.target.value), false)}
              onPointerUp={(e) =>
                updatePosition(
                  'x',
                  Number((e.target as HTMLInputElement).value),
                  true
                )
              }
              onTouchEnd={(e) =>
                updatePosition(
                  'x',
                  Number((e.target as HTMLInputElement).value),
                  true
                )
              }
              className="h-2 w-full cursor-pointer accent-cyan-400"
            />
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between text-[11px] text-zinc-300">
              <span>Позиция Y</span>
              <ScrubNumberField
                compact
                accent="cyan"
                value={Math.round(evaluated.y * 100)}
                min={-150}
                max={250}
                step={1}
                suffix="%"
                ariaLabel="Позиция Y"
                onChange={(pct) => updatePosition('y', pct / 100, false)}
                onCommit={(pct) => updatePosition('y', pct / 100, true)}
              />
            </div>
            <input
              type="range"
              min={-0.5}
              max={1.5}
              step={0.01}
              value={Math.max(-0.5, Math.min(1.5, evaluated.y))}
              onChange={(e) => updatePosition('y', Number(e.target.value), false)}
              onPointerUp={(e) =>
                updatePosition(
                  'y',
                  Number((e.target as HTMLInputElement).value),
                  true
                )
              }
              onTouchEnd={(e) =>
                updatePosition(
                  'y',
                  Number((e.target as HTMLInputElement).value),
                  true
                )
              }
              className="h-2 w-full cursor-pointer accent-cyan-400"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[11px] text-zinc-300">
              <span>Масштаб</span>
              <ScrubNumberField
                compact
                accent="cyan"
                value={Math.round(evaluated.scale * 100)}
                min={10}
                max={250}
                step={1}
                suffix="%"
                ariaLabel="Масштаб"
                onChange={(pct) => updateUniformScale(pct / 100, false)}
                onCommit={(pct) => updateUniformScale(pct / 100, true)}
              />
            </div>
            <input
              type="range"
              min={0.1}
              max={2.5}
              step={0.01}
              value={Math.max(0.1, Math.min(2.5, evaluated.scale))}
              onChange={(e) => updateUniformScale(Number(e.target.value), false)}
              onPointerUp={(e) =>
                updateUniformScale(
                  Number((e.target as HTMLInputElement).value),
                  true
                )
              }
              onTouchEnd={(e) =>
                updateUniformScale(
                  Number((e.target as HTMLInputElement).value),
                  true
                )
              }
              className="h-2 w-full cursor-pointer accent-cyan-400"
            />
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between text-[11px] text-zinc-300">
              <span>Поворот</span>
              <ScrubNumberField
                compact
                accent="cyan"
                value={Math.round(evaluated.rotation)}
                min={-180}
                max={180}
                step={1}
                suffix="°"
                ariaLabel="Поворот"
                onChange={(deg) => updateRotation(deg, false)}
                onCommit={(deg) => updateRotation(deg, true)}
              />
            </div>
            <input
              type="range"
              min={-180}
              max={180}
              step={1}
              value={Math.max(-180, Math.min(180, evaluated.rotation))}
              onChange={(e) => updateRotation(Number(e.target.value), false)}
              onPointerUp={(e) =>
                updateRotation(
                  Number((e.target as HTMLInputElement).value),
                  true
                )
              }
              onTouchEnd={(e) =>
                updateRotation(
                  Number((e.target as HTMLInputElement).value),
                  true
                )
              }
              className="h-2 w-full cursor-pointer accent-cyan-400"
            />
          </div>
        </div>
      </div>

      {/* Flip Buttons */}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => applyTransformPatch({flipHorizontal: !flipH}, true)}
          className={`flex h-10 items-center justify-center gap-1.5 rounded-xl border px-2.5 text-xs font-medium transition active:scale-95 ${
            flipH
              ? 'border-cyan-400 bg-cyan-500/20 text-cyan-200'
              : 'border-white/10 bg-zinc-900 text-zinc-200 hover:border-cyan-400/50'
          }`}
        >
          <FlipHorizontal2 className="h-4 w-4 text-cyan-400" />
          <span className="truncate">По горизонтали</span>
        </button>

        <button
          type="button"
          onClick={() => applyTransformPatch({flipVertical: !flipV}, true)}
          className={`flex h-10 items-center justify-center gap-1.5 rounded-xl border px-2.5 text-xs font-medium transition active:scale-95 ${
            flipV
              ? 'border-cyan-400 bg-cyan-500/20 text-cyan-200'
              : 'border-white/10 bg-zinc-900 text-zinc-200 hover:border-cyan-400/50'
          }`}
        >
          <FlipVertical2 className="h-4 w-4 text-cyan-400" />
          <span className="truncate">По вертикали</span>
        </button>
      </div>

      {/* Independent Scale X & Scale Y */}
      <div className="space-y-2.5 rounded-xl border border-white/10 bg-zinc-900/60 p-3">
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs text-zinc-300">
            <span>Scale X (ширина)</span>
            <ScrubNumberField
              compact
              accent="cyan"
              value={Math.round(scaleX * 100)}
              min={10}
              max={300}
              step={1}
              suffix="%"
              ariaLabel="Растяжение Scale X"
              onChange={(pct) => updateAxisScale('scaleX', pct / 100, false)}
              onCommit={(pct) => updateAxisScale('scaleX', pct / 100, true)}
            />
          </div>
          <input
            type="range"
            min={0.1}
            max={3}
            step={0.01}
            value={scaleX}
            onChange={(e) =>
              updateAxisScale('scaleX', Number(e.target.value), false)
            }
            onPointerUp={(e) =>
              updateAxisScale(
                'scaleX',
                Number((e.target as HTMLInputElement).value),
                true
              )
            }
            onTouchEnd={(e) =>
              updateAxisScale(
                'scaleX',
                Number((e.target as HTMLInputElement).value),
                true
              )
            }
            className="h-2 w-full cursor-pointer accent-cyan-400"
          />
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs text-zinc-300">
            <span>Scale Y (высота)</span>
            <ScrubNumberField
              compact
              accent="cyan"
              value={Math.round(scaleY * 100)}
              min={10}
              max={300}
              step={1}
              suffix="%"
              ariaLabel="Растяжение Scale Y"
              onChange={(pct) => updateAxisScale('scaleY', pct / 100, false)}
              onCommit={(pct) => updateAxisScale('scaleY', pct / 100, true)}
            />
          </div>
          <input
            type="range"
            min={0.1}
            max={3}
            step={0.01}
            value={scaleY}
            onChange={(e) =>
              updateAxisScale('scaleY', Number(e.target.value), false)
            }
            onPointerUp={(e) =>
              updateAxisScale(
                'scaleY',
                Number((e.target as HTMLInputElement).value),
                true
              )
            }
            onTouchEnd={(e) =>
              updateAxisScale(
                'scaleY',
                Number((e.target as HTMLInputElement).value),
                true
              )
            }
            className="h-2 w-full cursor-pointer accent-cyan-400"
          />
        </div>
      </div>

      {/* Ibis Paint Style Perspective & Mesh Distortion */}
      <div className="space-y-2.5 rounded-xl border border-blue-500/30 bg-blue-500/5 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-blue-200">
            Деформация (Ibis Paint)
          </span>
          {currentWarp.mode !== 'none' && (
            <button
              type="button"
              onClick={() =>
                commitWarp(
                  createDefaultWarp(currentWarp.mode, currentWarp.meshSize)
                )
              }
              className="flex items-center gap-1 rounded-lg border border-blue-400/40 bg-blue-500/15 px-2 py-0.5 text-[10px] font-medium text-blue-200 hover:bg-blue-500/25"
            >
              <RotateCcw className="h-3 w-3" />
              Сбросить узлы
            </button>
          )}
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          <button
            type="button"
            onClick={() => handleSelectWarpMode('none')}
            className={`flex h-9 items-center justify-center rounded-lg border text-[11px] font-medium transition ${
              currentWarp.mode === 'none'
                ? 'border-blue-400 bg-blue-500/20 text-blue-100'
                : 'border-white/10 bg-zinc-900 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Обычная
          </button>
          <button
            type="button"
            onClick={() => handleSelectWarpMode('perspective')}
            className={`flex h-9 items-center justify-center gap-1 rounded-lg border text-[11px] font-medium transition ${
              currentWarp.mode === 'perspective'
                ? 'border-blue-400 bg-blue-500 text-white'
                : 'border-white/10 bg-zinc-900 text-zinc-300 hover:border-blue-400/50'
            }`}
          >
            <Scan className="h-3.5 w-3.5" />
            <span>Перспектива</span>
          </button>
          <button
            type="button"
            onClick={() => handleSelectWarpMode('mesh')}
            className={`flex h-9 items-center justify-center gap-1 rounded-lg border text-[11px] font-medium transition ${
              currentWarp.mode === 'mesh'
                ? 'border-blue-400 bg-blue-500 text-white'
                : 'border-white/10 bg-zinc-900 text-zinc-300 hover:border-blue-400/50'
            }`}
          >
            <Grid3X3 className="h-3.5 w-3.5" />
            <span>Сетка</span>
          </button>
        </div>

        {currentWarp.mode === 'mesh' && (
          <div className="flex items-center justify-between gap-2 pt-0.5">
            <span className="text-[11px] text-zinc-400">Узлов сетки:</span>
            <div className="flex gap-1.5">
              {([3, 4] as const).map((sz) => (
                <button
                  key={sz}
                  type="button"
                  onClick={() => handleSelectMeshSize(sz)}
                  className={`rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition ${
                    currentWarp.meshSize === sz
                      ? 'border-blue-400 bg-blue-500/25 text-blue-100'
                      : 'border-white/10 bg-zinc-900 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {sz}×{sz} ({sz * sz})
                </button>
              ))}
            </div>
          </div>
        )}

        {currentWarp.mode !== 'none' && (
          <p className="text-[10px] leading-snug text-blue-200/80">
            {currentWarp.mode === 'perspective'
              ? 'Тяните синие углы или маркеры краёв прямо на предпросмотре для 3D-перспективы.'
              : 'Перетаскивайте синие узлы сетки на предпросмотре, чтобы плавно изогнуть слой.'}
          </p>
        )}
      </div>

      {/* Bottom Actions: Trackpad shortcut + Reset */}
      <div className="flex items-center gap-2">
        {onOpenTrackpad && (
          <button
            type="button"
            onClick={onOpenTrackpad}
            className={`flex h-9 flex-1 items-center justify-center gap-1.5 rounded-xl border text-xs font-medium transition active:scale-95 ${
              trackpadActive
                ? 'border-cyan-400 bg-cyan-500/20 text-cyan-200'
                : 'border-white/10 bg-zinc-900 text-zinc-200 hover:border-cyan-400/50'
            }`}
          >
            <Move className="h-3.5 w-3.5 text-cyan-400" />
            <span>{trackpadActive ? 'Скрыть трекпад' : 'Открыть трекпад'}</span>
          </button>
        )}
        {hasChanges && (
          <button
            type="button"
            onClick={() => {
              const resetWarp = createDefaultWarp('none', currentWarp.meshSize);
              applyTransformPatch(
                {
                  x: defaultX,
                  y: defaultY,
                  scale: defaultScale,
                  rotation: 0,
                  flipHorizontal: false,
                  flipVertical: false,
                  scaleX: 1,
                  scaleY: 1,
                  warp: resetWarp,
                },
                true
              );
            }}
            className="flex h-9 items-center justify-center gap-1 rounded-xl border border-white/10 bg-zinc-900 px-3 text-xs font-medium text-zinc-300 hover:border-white/25 hover:text-white active:scale-95"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>Сброс</span>
          </button>
        )}
      </div>
    </div>
  );
};
