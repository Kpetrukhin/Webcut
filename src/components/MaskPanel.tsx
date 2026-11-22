import React from 'react';
import {Ban, RotateCcw} from 'lucide-react';
import type {Clip, ClipMask, MaskMode, MaskShape} from '../shared/types.ts';
import {createDefaultMask, MASK_SHAPE_OPTIONS} from '../lib/maskEngine.ts';
import {ScrubNumberField} from './ScrubNumberField.tsx';

interface MaskPanelProps {
  clip: Clip;
  currentTime: number;
  onUpdateClip: (
    clipId: string,
    patch: Partial<Clip>,
    opts?: {skipUndo?: boolean; skipSync?: boolean}
  ) => void;
}

const MaskShapeIcon: React.FC<{shape: MaskShape; active: boolean}> = ({
  shape,
  active,
}) => {
  const stroke = active ? '#22d3ee' : 'currentColor';
  switch (shape) {
    case 'horizon':
      return (
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none">
          <path
            d="M3 13h18"
            stroke={stroke}
            strokeWidth="2"
            strokeLinecap="round"
          />
          <rect
            x="4"
            y="4"
            width="16"
            height="9"
            rx="1.5"
            fill={stroke}
            fillOpacity="0.25"
          />
        </svg>
      );
    case 'mirror':
      return (
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none">
          <path
            d="M3 8h18M3 16h18"
            stroke={stroke}
            strokeWidth="2"
            strokeLinecap="round"
          />
          <rect
            x="4"
            y="8"
            width="16"
            height="8"
            fill={stroke}
            fillOpacity="0.25"
          />
        </svg>
      );
    case 'circle':
      return (
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none">
          <circle
            cx="12"
            cy="12"
            r="7.5"
            stroke={stroke}
            strokeWidth="2"
            fill={stroke}
            fillOpacity="0.2"
          />
        </svg>
      );
    case 'rectangle':
      return (
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none">
          <rect
            x="4"
            y="6"
            width="16"
            height="12"
            rx="1.5"
            stroke={stroke}
            strokeWidth="2"
            fill={stroke}
            fillOpacity="0.2"
          />
        </svg>
      );
    case 'heart':
      return (
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none">
          <path
            d="M12 20s-7-4.5-8.5-9A4.8 4.8 0 0 1 12 6.8 4.8 4.8 0 0 1 20.5 11C19 15.5 12 20 12 20z"
            stroke={stroke}
            strokeWidth="2"
            strokeLinejoin="round"
            fill={stroke}
            fillOpacity="0.2"
          />
        </svg>
      );
    case 'star':
      return (
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none">
          <path
            d="M12 3.5l2.5 5.2 5.7.8-4.1 4 1 5.7-5.1-2.7-5.1 2.7 1-5.7-4.1-4 5.7-.8L12 3.5z"
            stroke={stroke}
            strokeWidth="2"
            strokeLinejoin="round"
            fill={stroke}
            fillOpacity="0.2"
          />
        </svg>
      );
  }
};

export const MaskPanel: React.FC<MaskPanelProps> = ({
  clip,
  currentTime,
  onUpdateClip,
}) => {
  const mask = clip.mask;

  const selectShape = (shape: MaskShape | 'none') => {
    if (shape === 'none') {
      onUpdateClip(clip.id, {mask: undefined});
      return;
    }
    if (mask) {
      onUpdateClip(clip.id, {mask: {...mask, shape}});
    } else {
      onUpdateClip(clip.id, {mask: createDefaultMask(shape, clip, currentTime)});
    }
  };

  const patchMask = (patch: Partial<ClipMask>, commit: boolean) => {
    if (!mask) return;
    onUpdateClip(
      clip.id,
      {mask: {...mask, ...patch}},
      {skipUndo: !commit, skipSync: !commit}
    );
  };

  return (
    <div className="space-y-3">
      {/* Shape Grid */}
      <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-4">
        <button
          type="button"
          onClick={() => selectShape('none')}
          className={`flex h-14 flex-col items-center justify-center gap-1 rounded-xl border px-1 text-[10px] font-medium transition active:scale-95 ${
            !mask
              ? 'border-cyan-400 bg-cyan-500/20 text-cyan-200'
              : 'border-white/10 bg-zinc-900 text-zinc-300 hover:border-white/25'
          }`}
        >
          <Ban className="h-4 w-4" />
          <span>Нет</span>
        </button>

        {MASK_SHAPE_OPTIONS.map((opt) => {
          const active = mask?.shape === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => selectShape(opt.id)}
              className={`flex h-14 flex-col items-center justify-center gap-1 rounded-xl border px-1 text-[10px] font-medium transition active:scale-95 ${
                active
                  ? 'border-cyan-400 bg-cyan-500/20 text-cyan-200'
                  : 'border-white/10 bg-zinc-900 text-zinc-300 hover:border-cyan-400/50'
              }`}
            >
              <MaskShapeIcon shape={opt.id} active={active} />
              <span className="truncate max-w-full">{opt.label}</span>
            </button>
          );
        })}
      </div>

      {mask ? (
        <div className="space-y-3 rounded-xl border border-white/10 bg-zinc-900/60 p-3">
          {/* Inside / Outside Toggle */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-zinc-400">
                Режим маски
              </span>
              <button
                type="button"
                onClick={() =>
                  onUpdateClip(clip.id, {
                    mask: createDefaultMask(mask.shape, clip, currentTime),
                  })
                }
                className="flex items-center gap-1 text-[11px] text-zinc-400 hover:text-cyan-300"
                title="Сбросить положение и размер маски"
              >
                <RotateCcw className="h-3 w-3" />
                <span>Сброс</span>
              </button>
            </div>
            <div className="grid grid-cols-2 gap-1.5 rounded-lg border border-white/10 bg-zinc-950 p-1">
              {(
                [
                  {id: 'inside', label: 'Внутри'},
                  {id: 'outside', label: 'Снаружи'},
                ] as Array<{id: MaskMode; label: string}>
              ).map((m) => {
                const active = mask.mode === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => patchMask({mode: m.id}, true)}
                    className={`h-8 rounded-md text-xs font-semibold transition ${
                      active
                        ? m.id === 'outside'
                          ? 'bg-amber-400 text-zinc-950'
                          : 'bg-cyan-500 text-zinc-950'
                        : 'text-zinc-300 hover:text-white'
                    }`}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Feather Slider */}
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs text-zinc-300">
              <span>Растушёвка краёв</span>
              <ScrubNumberField
                compact
                accent="cyan"
                value={Math.round(mask.feather)}
                min={0}
                max={100}
                step={1}
                suffix="%"
                ariaLabel="Растушёвка краёв маски"
                onChange={(v) => patchMask({feather: v}, false)}
                onCommit={(v) => patchMask({feather: v}, true)}
              />
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={mask.feather}
              onChange={(e) =>
                patchMask({feather: Number(e.target.value)}, false)
              }
              onPointerUp={(e) =>
                patchMask(
                  {feather: Number((e.target as HTMLInputElement).value)},
                  true
                )
              }
              onTouchEnd={(e) =>
                patchMask(
                  {feather: Number((e.target as HTMLInputElement).value)},
                  true
                )
              }
              className="h-2 w-full cursor-pointer accent-cyan-400"
            />
          </div>

          {/* Scale & Rotation fine controls (complementing direct canvas gestures) */}
          <div className="grid grid-cols-2 gap-3 border-t border-white/10 pt-2.5">
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[11px] text-zinc-300">
                <span>Размер</span>
                <ScrubNumberField
                  compact
                  accent="cyan"
                  value={Math.round(mask.scale * 100)}
                  min={8}
                  max={250}
                  step={1}
                  suffix="%"
                  ariaLabel="Размер маски"
                  onChange={(pct) => patchMask({scale: pct / 100}, false)}
                  onCommit={(pct) => patchMask({scale: pct / 100}, true)}
                />
              </div>
              <input
                type="range"
                min={0.08}
                max={2.5}
                step={0.01}
                value={mask.scale}
                onChange={(e) =>
                  patchMask({scale: Number(e.target.value)}, false)
                }
                onPointerUp={(e) =>
                  patchMask(
                    {scale: Number((e.target as HTMLInputElement).value)},
                    true
                  )
                }
                onTouchEnd={(e) =>
                  patchMask(
                    {scale: Number((e.target as HTMLInputElement).value)},
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
                  value={Math.round(mask.rotation)}
                  min={-180}
                  max={180}
                  step={1}
                  suffix="°"
                  ariaLabel="Поворот маски"
                  onChange={(deg) => patchMask({rotation: deg}, false)}
                  onCommit={(deg) => patchMask({rotation: deg}, true)}
                />
              </div>
              <input
                type="range"
                min={-180}
                max={180}
                step={1}
                value={mask.rotation}
                onChange={(e) =>
                  patchMask({rotation: Number(e.target.value)}, false)
                }
                onPointerUp={(e) =>
                  patchMask(
                    {rotation: Number((e.target as HTMLInputElement).value)},
                    true
                  )
                }
                onTouchEnd={(e) =>
                  patchMask(
                    {rotation: Number((e.target as HTMLInputElement).value)},
                    true
                  )
                }
                className="h-2 w-full cursor-pointer accent-cyan-400"
              />
            </div>
          </div>

          <p className="text-[10px] leading-snug text-cyan-300/80">
            Жесты на холсте: 1 палец двигает маску · 2 пальца или колесо масштабируют и крутят фигуру отдельно от видео.
          </p>
        </div>
      ) : (
        <p className="text-xs text-zinc-400">
          Выберите фигуру маски, чтобы двигать, масштабировать и крутить её жестами на холсте отдельно от видео/фото.
        </p>
      )}
    </div>
  );
};
