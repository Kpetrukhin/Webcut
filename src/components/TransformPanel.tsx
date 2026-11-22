import React from 'react';
import {
  FlipHorizontal2,
  FlipVertical2,
  Move,
  RotateCcw,
} from 'lucide-react';
import type {Clip} from '../shared/types.ts';
import {ScrubNumberField} from './ScrubNumberField.tsx';

interface TransformPanelProps {
  clip: Clip;
  onUpdateClip: (
    clipId: string,
    patch: Partial<Clip>,
    opts?: {skipUndo?: boolean; skipSync?: boolean}
  ) => void;
  onOpenTrackpad?: () => void;
  trackpadActive?: boolean;
}

export const TransformPanel: React.FC<TransformPanelProps> = ({
  clip,
  onUpdateClip,
  onOpenTrackpad,
  trackpadActive = false,
}) => {
  const scaleX = clip.scaleX ?? 1;
  const scaleY = clip.scaleY ?? 1;
  const flipH = Boolean(clip.flipHorizontal);
  const flipV = Boolean(clip.flipVertical);

  const hasChanges =
    flipH ||
    flipV ||
    Math.abs(scaleX - 1) > 0.005 ||
    Math.abs(scaleY - 1) > 0.005;

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
            onClick={() =>
              onUpdateClip(clip.id, {
                flipHorizontal: false,
                flipVertical: false,
                scaleX: 1,
                scaleY: 1,
              })
            }
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
