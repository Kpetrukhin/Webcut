import React from 'react';
import {
  FlipHorizontal2,
  FlipVertical2,
  Grid3X3,
  Move,
  RotateCcw,
  Scan,
} from 'lucide-react';
import type {Clip, ClipWarp, WarpMode} from '../shared/types.ts';
import {evaluateClipTransform} from '../lib/keyframeEngine.ts';
import {
  createDefaultWarp,
  isIdentityWarp,
  normalizeWarp,
  resampleMeshGrid,
} from '../lib/warpEngine.ts';
import {ScrubNumberField} from './ScrubNumberField.tsx';

interface TransformPanelProps {
  clip: Clip;
  currentTime?: number;
  onUpdateClip: (
    clipId: string,
    patch: Partial<Clip>,
    opts?: {skipUndo?: boolean; skipSync?: boolean}
  ) => void;
  onUpdateWarp?: (clipId: string, warp: ClipWarp, commit: boolean) => void;
  onOpenTrackpad?: () => void;
  trackpadActive?: boolean;
}

export const TransformPanel: React.FC<TransformPanelProps> = ({
  clip,
  currentTime = 0,
  onUpdateClip,
  onUpdateWarp,
  onOpenTrackpad,
  trackpadActive = false,
}) => {
  const scaleX = clip.scaleX ?? 1;
  const scaleY = clip.scaleY ?? 1;
  const flipH = Boolean(clip.flipHorizontal);
  const flipV = Boolean(clip.flipVertical);

  const evaluated = evaluateClipTransform(clip, currentTime);
  const currentWarp = normalizeWarp(evaluated.warp ?? clip.warp);

  const hasChanges =
    flipH ||
    flipV ||
    Math.abs(scaleX - 1) > 0.005 ||
    Math.abs(scaleY - 1) > 0.005 ||
    !isIdentityWarp(currentWarp);

  const commitWarp = (next: ClipWarp) => {
    if (onUpdateWarp) {
      onUpdateWarp(clip.id, next, true);
    } else {
      onUpdateClip(clip.id, {warp: next});
    }
  };

  const handleSelectWarpMode = (mode: WarpMode) => {
    if (currentWarp.mode === mode) return;
    if (mode === 'none') {
      commitWarp({...currentWarp, mode: 'none'});
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

  const updateScale = (
    axis: 'scaleX' | 'scaleY',
    value: number,
    commit: boolean
  ) => {
    const clamped = Math.max(0.1, Math.min(3, Math.round(value * 100) / 100));
    onUpdateClip(
      clip.id,
      {[axis]: clamped},
      {skipUndo: !commit, skipSync: !commit}
    );
  };

  return (
    <div className="space-y-3">
      {/* Flip Buttons */}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() =>
            onUpdateClip(clip.id, {flipHorizontal: !flipH})
          }
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
          onClick={() =>
            onUpdateClip(clip.id, {flipVertical: !flipV})
          }
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
              onChange={(pct) => updateScale('scaleX', pct / 100, false)}
              onCommit={(pct) => updateScale('scaleX', pct / 100, true)}
            />
          </div>
          <input
            type="range"
            min={0.1}
            max={3}
            step={0.01}
            value={scaleX}
            onChange={(e) =>
              updateScale('scaleX', Number(e.target.value), false)
            }
            onPointerUp={(e) =>
              updateScale(
                'scaleX',
                Number((e.target as HTMLInputElement).value),
                true
              )
            }
            onTouchEnd={(e) =>
              updateScale(
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
              onChange={(pct) => updateScale('scaleY', pct / 100, false)}
              onCommit={(pct) => updateScale('scaleY', pct / 100, true)}
            />
          </div>
          <input
            type="range"
            min={0.1}
            max={3}
            step={0.01}
            value={scaleY}
            onChange={(e) =>
              updateScale('scaleY', Number(e.target.value), false)
            }
            onPointerUp={(e) =>
              updateScale(
                'scaleY',
                Number((e.target as HTMLInputElement).value),
                true
              )
            }
            onTouchEnd={(e) =>
              updateScale(
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
              onUpdateClip(clip.id, {
                flipHorizontal: false,
                flipVertical: false,
                scaleX: 1,
                scaleY: 1,
                ...(onUpdateWarp
                  ? {}
                  : {warp: createDefaultWarp('none', currentWarp.meshSize)}),
              });
              if (onUpdateWarp) {
                onUpdateWarp(
                  clip.id,
                  createDefaultWarp('none', currentWarp.meshSize),
                  true
                );
              }
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

