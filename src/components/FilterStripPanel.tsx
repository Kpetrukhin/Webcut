import React from 'react';
import {Plus, Sliders, Sparkles, X} from 'lucide-react';
import type {Clip, ColorFilterPreset} from '../shared/types.ts';
import {
  applyFilterPresetToClipPatch,
  buildCssFilterPreview,
  BUILTIN_COLOR_PRESETS,
  deleteCustomColorPreset,
} from '../lib/colorPresets.ts';

interface FilterStripPanelProps {
  clip: Clip;
  customPresets: ColorFilterPreset[];
  previewFallbackSrc?: string;
  onUpdateClip: (clipId: string, patch: Partial<Clip>) => void;
  onOpenAdjust: () => void;
  onPresetsChanged: (next: ColorFilterPreset[]) => void;
}

export const FilterStripPanel: React.FC<FilterStripPanelProps> = ({
  clip,
  customPresets,
  previewFallbackSrc,
  onUpdateClip,
  onOpenAdjust,
  onPresetsChanged,
}) => {
  const allPresets = [...BUILTIN_COLOR_PRESETS, ...customPresets];

  const handleSelectPreset = (preset: ColorFilterPreset) => {
    onUpdateClip(clip.id, applyFilterPresetToClipPatch(preset));
  };

  const handleDeleteCustom = (e: React.MouseEvent, presetId: string) => {
    e.stopPropagation();
    const next = deleteCustomColorPreset(presetId);
    onPresetsChanged(next);
    if (clip.filter === presetId) {
      onUpdateClip(clip.id, {filter: 'none'});
    }
  };

  const previewImgSrc =
    clip.kind === 'image' && clip.src ? clip.src : previewFallbackSrc;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs text-zinc-400">
        <span>Пресеты цветокоррекции</span>
        <button
          type="button"
          onClick={onOpenAdjust}
          className="flex items-center gap-1 font-medium text-cyan-400 hover:text-cyan-300"
        >
          <Sliders className="h-3.5 w-3.5" />
          Настроить
        </button>
      </div>

      {/* Horizontal scrollable preset strip */}
      <div className="studio-scrollbar flex items-stretch gap-2.5 overflow-x-auto pb-2">
        {/* First button: + Create Custom */}
        <button
          type="button"
          onClick={onOpenAdjust}
          className="flex w-[74px] shrink-0 flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-cyan-500/50 bg-cyan-500/10 p-1.5 text-center transition hover:border-cyan-400 hover:bg-cyan-500/15 active:scale-95"
        >
          <div className="flex h-12 w-full items-center justify-center rounded-lg bg-zinc-900/70 text-cyan-300">
            <Plus className="h-5 w-5" />
          </div>
          <span className="line-clamp-2 text-[10px] font-semibold leading-tight text-cyan-200">
            Создать свой
          </span>
        </button>

        {allPresets.map((preset) => {
          const active = clip.filter === preset.id;
          const cssFilter = buildCssFilterPreview(preset);
          const isCustom = !preset.isBuiltin;
          return (
            <div key={preset.id} className="relative shrink-0">
              <button
                type="button"
                onClick={() => handleSelectPreset(preset)}
                className={`flex w-[74px] flex-col items-center gap-1.5 rounded-xl border p-1.5 text-center transition active:scale-95 ${
                  active
                    ? 'border-cyan-400 bg-cyan-500/15 shadow-[0_0_0_1px_rgba(34,211,238,0.35)]'
                    : 'border-white/10 bg-zinc-900/80 hover:border-white/25'
                }`}
              >
                <div className="relative h-12 w-full overflow-hidden rounded-lg bg-zinc-800">
                  {previewImgSrc ? (
                    <img
                      src={previewImgSrc}
                      alt={preset.name}
                      style={{filter: cssFilter}}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div
                      style={{
                        filter: cssFilter,
                        background:
                          'linear-gradient(135deg, #0ea5e9 0%, #f59e0b 55%, #18181b 100%)',
                      }}
                      className="flex h-full w-full items-center justify-center"
                    >
                      <Sparkles className="h-4 w-4 text-white/80 drop-shadow" />
                    </div>
                  )}
                  {isCustom && (
                    <span className="absolute bottom-0.5 left-0.5 rounded bg-black/75 px-1 py-0.2 text-[8px] font-bold uppercase text-amber-300">
                      Свой
                    </span>
                  )}
                </div>
                <span
                  className={`w-full truncate text-[11px] font-medium ${
                    active ? 'text-cyan-200' : 'text-zinc-200'
                  }`}
                >
                  {preset.name}
                </span>
              </button>

              {isCustom && (
                <button
                  type="button"
                  onClick={(e) => handleDeleteCustom(e, preset.id)}
                  aria-label={`Удалить фильтр ${preset.name}`}
                  className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-white/20 bg-zinc-900 text-zinc-400 shadow hover:border-rose-400 hover:bg-rose-500 hover:text-white"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          );
        })}
      </div>

      <p className="text-[10px] text-zinc-500">
        Выбор фильтра подставляет его значения в панель «Настроить», где их можно дополнительно доработать.
      </p>
    </div>
  );
};
