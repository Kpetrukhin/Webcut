import React from 'react';
import {
  Blend,
  PaintBucket,
  Plus,
  Sliders,
  Sparkles,
} from 'lucide-react';
import type {
  BlendMode,
  Clip,
  ShapeStyle,
  ShapeType,
} from '../shared/types.ts';
import {
  getDefaultShapeStyle,
  normalizeShapeStyle,
  SHAPE_CATALOG,
} from '../lib/shapeEngine.ts';
import {ScrubNumberField} from './ScrubNumberField.tsx';

interface ShapesPanelProps {
  selectedClip: Clip | null;
  onAddShape: (shapeType: ShapeType) => void;
  onUpdateClip: (
    clipId: string,
    patch: Partial<Clip>,
    opts?: {skipUndo?: boolean; skipSync?: boolean}
  ) => void;
  onOpenAdjust?: () => void;
  onClose?: () => void;
}

const FILL_SWATCHES = [
  '#22d3ee',
  '#ffffff',
  '#09090b',
  '#f43f5e',
  '#f59e0b',
  '#10b981',
  '#6366f1',
  '#a855f7',
];

const BLEND_MODES: Array<{id: BlendMode; label: string}> = [
  {id: 'source-over', label: 'Обычный'},
  {id: 'screen', label: 'Экран'},
  {id: 'multiply', label: 'Умножение'},
  {id: 'overlay', label: 'Перекрытие'},
  {id: 'lighten', label: 'Светлее'},
];

const ShapePreviewSvg: React.FC<{shapeType: ShapeType; active?: boolean}> = ({
  shapeType,
  active = false,
}) => {
  const strokeColor = active ? '#67e8f9' : '#22d3ee';
  const fillColor = active
    ? 'rgba(34, 211, 238, 0.35)'
    : 'rgba(34, 211, 238, 0.16)';

  switch (shapeType) {
    case 'circle':
      return (
        <svg viewBox="0 0 36 36" className="h-7 w-7">
          <circle
            cx="18"
            cy="18"
            r="12"
            fill={fillColor}
            stroke={strokeColor}
            strokeWidth="2"
          />
        </svg>
      );
    case 'ellipse':
      return (
        <svg viewBox="0 0 36 36" className="h-7 w-7">
          <ellipse
            cx="18"
            cy="18"
            rx="14"
            ry="9"
            fill={fillColor}
            stroke={strokeColor}
            strokeWidth="2"
          />
        </svg>
      );
    case 'rectangle':
      return (
        <svg viewBox="0 0 36 36" className="h-7 w-7">
          <rect
            x="5"
            y="9"
            width="26"
            height="18"
            fill={fillColor}
            stroke={strokeColor}
            strokeWidth="2"
          />
        </svg>
      );
    case 'rounded_square':
      return (
        <svg viewBox="0 0 36 36" className="h-7 w-7">
          <rect
            x="6"
            y="6"
            width="24"
            height="24"
            rx="6"
            fill={fillColor}
            stroke={strokeColor}
            strokeWidth="2"
          />
        </svg>
      );
    case 'triangle':
      return (
        <svg viewBox="0 0 36 36" className="h-7 w-7">
          <polygon
            points="18,6 31,29 5,29"
            fill={fillColor}
            stroke={strokeColor}
            strokeWidth="2"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'star':
      return (
        <svg viewBox="0 0 36 36" className="h-7 w-7">
          <polygon
            points="18,4 21.8,13 31.5,13.8 24,20.2 26.3,29.8 18,24.6 9.7,29.8 12,20.2 4.5,13.8 14.2,13"
            fill={fillColor}
            stroke={strokeColor}
            strokeWidth="1.9"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'arrow':
      return (
        <svg viewBox="0 0 36 36" className="h-7 w-7">
          <polygon
            points="4,13 20,13 20,7 32,18 20,29 20,23 4,23"
            fill={fillColor}
            stroke={strokeColor}
            strokeWidth="1.9"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'line':
      return (
        <svg viewBox="0 0 36 36" className="h-7 w-7">
          <rect
            x="4"
            y="15"
            width="28"
            height="6"
            rx="3"
            fill={strokeColor}
          />
        </svg>
      );
  }
};

export const ShapesPanel: React.FC<ShapesPanelProps> = ({
  selectedClip,
  onAddShape,
  onUpdateClip,
  onOpenAdjust,
  onClose,
}) => {
  const isShapeSelected = selectedClip?.kind === 'shape';
  const style: ShapeStyle = normalizeShapeStyle(selectedClip?.shapeStyle);
  const isAdjustmentMask = Boolean(selectedClip?.adjustmentMask);

  const updateStyle = (patch: Partial<ShapeStyle>, commit = true) => {
    if (!selectedClip) return;
    const next: ShapeStyle = {
      ...style,
      ...patch,
    };
    onUpdateClip(
      selectedClip.id,
      {shapeStyle: next},
      {skipUndo: !commit, skipSync: !commit}
    );
  };

  return (
    <div className="space-y-4">
      {/* Quick Generator Grid */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-zinc-300">
            Добавить фигуру на холст
          </p>
          <span className="text-[10px] text-zinc-500">Векторный слой</span>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {SHAPE_CATALOG.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                onAddShape(item.id);
                onClose?.();
              }}
              className="group relative flex flex-col items-center justify-center gap-1 rounded-xl border border-white/10 bg-zinc-900/90 px-1.5 py-2.5 text-center transition hover:border-cyan-400/70 hover:bg-cyan-500/10 active:scale-95"
            >
              <ShapePreviewSvg shapeType={item.id} />
              <span className="w-full truncate text-[10px] font-medium text-zinc-200 group-hover:text-cyan-200">
                {item.label}
              </span>
              <span className="absolute top-1 right-1 opacity-0 transition group-hover:opacity-100">
                <Plus className="h-3 w-3 text-cyan-400" />
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Properties of Selected Shape */}
      {isShapeSelected && selectedClip && (
        <div className="space-y-3 rounded-xl border border-indigo-500/30 bg-indigo-500/5 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <PaintBucket className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
              <p className="truncate text-xs font-semibold text-white">
                Свойства: {selectedClip.name}
              </p>
            </div>
          </div>

          {/* Switch Shape Geometry */}
          <div className="space-y-1.5">
            <p className="text-[11px] font-medium text-zinc-400">Форма фигуры</p>
            <div className="grid grid-cols-4 gap-1.5">
              {SHAPE_CATALOG.map((item) => {
                const active = style.shapeType === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      const def = getDefaultShapeStyle(item.id);
                      onUpdateClip(selectedClip.id, {
                        name: item.label,
                        shapeStyle: {
                          ...style,
                          shapeType: item.id,
                          cornerRadius: def.cornerRadius,
                        },
                      });
                    }}
                    className={`flex flex-col items-center justify-center gap-0.5 rounded-lg border py-1.5 text-[10px] font-medium transition ${
                      active
                        ? 'border-cyan-400 bg-cyan-500/20 text-cyan-200'
                        : 'border-white/10 bg-zinc-900 text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    <ShapePreviewSvg shapeType={item.id} active={active} />
                    <span className="max-w-full truncate px-1">{item.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Adjustment Mask Mode Toggle */}
          <div className="space-y-2 rounded-xl border border-violet-500/35 bg-violet-500/10 p-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-xs font-semibold text-violet-200">
                  <Sparkles className="h-3.5 w-3.5 text-violet-300" />
                  Корректирующая маска
                </p>
                <p className="mt-0.5 text-[10px] leading-snug text-violet-200/75">
                  Скрывает заливку фигуры и применяет размытие/фильтры ко всем слоям под ней.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={isAdjustmentMask}
                onClick={() =>
                  onUpdateClip(selectedClip.id, {
                    adjustmentMask: !isAdjustmentMask,
                  })
                }
                className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                  isAdjustmentMask ? 'bg-violet-500' : 'bg-zinc-700'
                }`}
              >
                <span
                  className={`block h-5 w-5 translate-y-0.5 rounded-full bg-white shadow transition-transform ${
                    isAdjustmentMask ? 'translate-x-5.5' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>
            {isAdjustmentMask && onOpenAdjust && (
              <button
                type="button"
                onClick={onOpenAdjust}
                className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-violet-400/50 bg-violet-500/20 text-[11px] font-semibold text-violet-100 hover:bg-violet-500/30"
              >
                <Sliders className="h-3.5 w-3.5" />
                Настроить размытие / инверсию / цвет
              </button>
            )}
          </div>

          {/* Fill Color & Opacity */}
          <div
            className={`space-y-2 rounded-xl border border-white/10 bg-zinc-900/60 p-2.5 ${
              isAdjustmentMask ? 'opacity-50' : ''
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-zinc-300">
                Цвет заливки
              </span>
              <div className="flex items-center gap-1.5">
                {FILL_SWATCHES.map((hex) => (
                  <button
                    key={hex}
                    type="button"
                    onClick={() => updateStyle({fillColor: hex}, true)}
                    style={{backgroundColor: hex}}
                    aria-label={`Цвет ${hex}`}
                    className={`h-5 w-5 rounded-full border transition ${
                      style.fillColor.toLowerCase() === hex.toLowerCase()
                        ? 'scale-110 border-white ring-1 ring-cyan-400'
                        : 'border-white/25'
                    }`}
                  />
                ))}
                <input
                  type="color"
                  value={style.fillColor}
                  onChange={(e) => updateStyle({fillColor: e.target.value}, true)}
                  aria-label="Свой цвет заливки"
                  className="h-6 w-7 cursor-pointer rounded border border-white/20 bg-transparent p-0"
                />
              </div>
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between text-[11px] text-zinc-400">
                <span>Непрозрачность заливки</span>
                <ScrubNumberField
                  compact
                  accent="cyan"
                  value={Math.round(style.fillOpacity * 100)}
                  min={0}
                  max={100}
                  step={1}
                  suffix="%"
                  ariaLabel="Непрозрачность заливки"
                  onChange={(pct) => updateStyle({fillOpacity: pct / 100}, false)}
                  onCommit={(pct) => updateStyle({fillOpacity: pct / 100}, true)}
                />
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={style.fillOpacity}
                onChange={(e) =>
                  updateStyle({fillOpacity: Number(e.target.value)}, false)
                }
                onPointerUp={(e) =>
                  updateStyle(
                    {fillOpacity: Number((e.target as HTMLInputElement).value)},
                    true
                  )
                }
                onTouchEnd={(e) =>
                  updateStyle(
                    {fillOpacity: Number((e.target as HTMLInputElement).value)},
                    true
                  )
                }
                className="h-2 w-full cursor-pointer accent-cyan-400"
              />
            </div>
          </div>

          {/* Stroke & Corner Radius */}
          <div className="grid grid-cols-2 gap-2.5 rounded-xl border border-white/10 bg-zinc-900/60 p-2.5">
            <div className="space-y-1 text-xs text-zinc-300">
              <div className="flex items-center justify-between gap-1">
                <span>Обводка</span>
                <div className="flex items-center gap-1">
                  <input
                    type="color"
                    value={style.strokeColor}
                    onChange={(e) =>
                      updateStyle({strokeColor: e.target.value}, true)
                    }
                    aria-label="Цвет обводки"
                    className="h-5 w-6 cursor-pointer rounded border border-white/20 bg-transparent p-0"
                  />
                  <ScrubNumberField
                    compact
                    accent="cyan"
                    value={Math.round(style.strokeWidth)}
                    min={0}
                    max={36}
                    step={1}
                    suffix="px"
                    ariaLabel="Толщина обводки"
                    onChange={(px) => updateStyle({strokeWidth: px}, false)}
                    onCommit={(px) => updateStyle({strokeWidth: px}, true)}
                  />
                </div>
              </div>
              <input
                type="range"
                min={0}
                max={36}
                step={1}
                value={style.strokeWidth}
                onChange={(e) =>
                  updateStyle({strokeWidth: Number(e.target.value)}, false)
                }
                onPointerUp={(e) =>
                  updateStyle(
                    {strokeWidth: Number((e.target as HTMLInputElement).value)},
                    true
                  )
                }
                onTouchEnd={(e) =>
                  updateStyle(
                    {strokeWidth: Number((e.target as HTMLInputElement).value)},
                    true
                  )
                }
                className="h-2 w-full cursor-pointer accent-cyan-400"
              />
            </div>

            <div className="space-y-1 text-xs text-zinc-300">
              <div className="flex items-center justify-between gap-1">
                <span>Скругление</span>
                <ScrubNumberField
                  compact
                  accent="cyan"
                  value={Math.round(style.cornerRadius ?? 0)}
                  min={0}
                  max={120}
                  step={1}
                  suffix="px"
                  ariaLabel="Скругление углов фигуры"
                  onChange={(px) => updateStyle({cornerRadius: px}, false)}
                  onCommit={(px) => updateStyle({cornerRadius: px}, true)}
                />
              </div>
              <input
                type="range"
                min={0}
                max={120}
                step={1}
                value={style.cornerRadius ?? 0}
                onChange={(e) =>
                  updateStyle({cornerRadius: Number(e.target.value)}, false)
                }
                onPointerUp={(e) =>
                  updateStyle(
                    {cornerRadius: Number((e.target as HTMLInputElement).value)},
                    true
                  )
                }
                onTouchEnd={(e) =>
                  updateStyle(
                    {cornerRadius: Number((e.target as HTMLInputElement).value)},
                    true
                  )
                }
                className="h-2 w-full cursor-pointer accent-cyan-400"
              />
            </div>
          </div>

          {/* Blend Mode */}
          <div className="space-y-1.5">
            <p className="flex items-center gap-1 text-[11px] font-medium text-zinc-400">
              <Blend className="h-3 w-3 text-cyan-400" />
              Режим смешивания
            </p>
            <div className="flex flex-wrap gap-1.5">
              {BLEND_MODES.map((bm) => (
                <button
                  key={bm.id}
                  type="button"
                  onClick={() =>
                    onUpdateClip(selectedClip.id, {blendMode: bm.id})
                  }
                  className={`rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition ${
                    (selectedClip.blendMode ?? 'source-over') === bm.id
                      ? 'bg-cyan-500 text-zinc-950'
                      : 'border border-white/10 bg-zinc-900 text-zinc-300 hover:border-white/25'
                  }`}
                >
                  {bm.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
