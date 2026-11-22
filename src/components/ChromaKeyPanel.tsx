import React from 'react';
import type {Clip} from '../shared/types.ts';
import {ScrubNumberField} from './ScrubNumberField.tsx';

interface ChromaKeyPanelProps {
  clip: Clip;
  onUpdateChromaKey: (
    clipId: string,
    patch: Partial<
      Pick<
        Clip,
        | 'chromaKeyEnabled'
        | 'chromaKeyColor'
        | 'chromaKeyIntensity'
        | 'chromaKeySmoothness'
      >
    >,
    commit: boolean
  ) => void;
  onDone?: () => void;
}

export const ChromaKeyPanel: React.FC<ChromaKeyPanelProps> = ({
  clip,
  onUpdateChromaKey,
  onDone,
}) => {
  const keyColor = clip.chromaKeyColor || '#00ff00';
  const intensity = clip.chromaKeyIntensity ?? 0.35;
  const smoothness = clip.chromaKeySmoothness ?? 0.15;

  return (
    <div className="space-y-2.5 rounded-xl border border-emerald-500/30 bg-[#14171a] p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="h-6 w-6 shrink-0 rounded-full border-2 border-white/85 shadow-sm"
            style={{backgroundColor: keyColor}}
          />
          <div className="min-w-0 leading-tight">
            <p className="truncate text-[11px] font-semibold text-emerald-300">
              Пипетка на холсте · Хромакей
            </p>
            <p className="font-mono text-[10px] text-zinc-400">
              {keyColor.toUpperCase()}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() =>
              onUpdateChromaKey(
                clip.id,
                {
                  chromaKeyEnabled: !clip.chromaKeyEnabled,
                  chromaKeyColor: keyColor,
                  chromaKeyIntensity: intensity,
                  chromaKeySmoothness: smoothness,
                },
                true
              )
            }
            className={`rounded-md px-2 py-1 text-[10px] font-semibold ${
              clip.chromaKeyEnabled
                ? 'bg-emerald-500/20 text-emerald-300'
                : 'bg-white/10 text-zinc-400'
            }`}
          >
            {clip.chromaKeyEnabled ? 'ВКЛ' : 'ВЫКЛ'}
          </button>
          {onDone && (
            <button
              type="button"
              onClick={onDone}
              className="rounded-md bg-white/10 px-2 py-1 text-[10px] font-medium text-zinc-200 hover:bg-white/15"
            >
              Готово
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px] text-zinc-300">
            <span>Интенсивность</span>
            <ScrubNumberField
              compact
              accent="emerald"
              value={intensity}
              min={0}
              max={1}
              step={0.01}
              decimals={2}
              ariaLabel="Интенсивность хромакея"
              onChange={(val) =>
                onUpdateChromaKey(
                  clip.id,
                  {
                    chromaKeyEnabled: true,
                    chromaKeyColor: keyColor,
                    chromaKeyIntensity: val,
                  },
                  false
                )
              }
              onCommit={(val) =>
                onUpdateChromaKey(
                  clip.id,
                  {
                    chromaKeyEnabled: true,
                    chromaKeyColor: keyColor,
                    chromaKeyIntensity: val,
                  },
                  true
                )
              }
            />
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={intensity}
            onChange={(e) =>
              onUpdateChromaKey(
                clip.id,
                {
                  chromaKeyEnabled: true,
                  chromaKeyColor: keyColor,
                  chromaKeyIntensity: Number(e.target.value),
                },
                false
              )
            }
            onPointerUp={(e) =>
              onUpdateChromaKey(
                clip.id,
                {
                  chromaKeyIntensity: Number(
                    (e.target as HTMLInputElement).value
                  ),
                },
                true
              )
            }
            onTouchEnd={(e) =>
              onUpdateChromaKey(
                clip.id,
                {
                  chromaKeyIntensity: Number(
                    (e.target as HTMLInputElement).value
                  ),
                },
                true
              )
            }
            className="h-2 w-full cursor-pointer accent-emerald-400"
          />
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px] text-zinc-300">
            <span>Сглаживание</span>
            <ScrubNumberField
              compact
              accent="emerald"
              value={smoothness}
              min={0}
              max={1}
              step={0.01}
              decimals={2}
              ariaLabel="Сглаживание хромакея"
              onChange={(val) =>
                onUpdateChromaKey(
                  clip.id,
                  {
                    chromaKeyEnabled: true,
                    chromaKeyColor: keyColor,
                    chromaKeySmoothness: val,
                  },
                  false
                )
              }
              onCommit={(val) =>
                onUpdateChromaKey(
                  clip.id,
                  {
                    chromaKeyEnabled: true,
                    chromaKeyColor: keyColor,
                    chromaKeySmoothness: val,
                  },
                  true
                )
              }
            />
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={smoothness}
            onChange={(e) =>
              onUpdateChromaKey(
                clip.id,
                {
                  chromaKeyEnabled: true,
                  chromaKeyColor: keyColor,
                  chromaKeySmoothness: Number(e.target.value),
                },
                false
              )
            }
            onPointerUp={(e) =>
              onUpdateChromaKey(
                clip.id,
                {
                  chromaKeySmoothness: Number(
                    (e.target as HTMLInputElement).value
                  ),
                },
                true
              )
            }
            onTouchEnd={(e) =>
              onUpdateChromaKey(
                clip.id,
                {
                  chromaKeySmoothness: Number(
                    (e.target as HTMLInputElement).value
                  ),
                },
                true
              )
            }
            className="h-2 w-full cursor-pointer accent-emerald-400"
          />
        </div>
      </div>
    </div>
  );
};
