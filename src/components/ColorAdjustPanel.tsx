import React, {useMemo, useRef, useState} from 'react';
import {
  BookmarkPlus,
  Check,
  RotateCcw,
  Sliders,
  Spline,
  Trash2,
  X,
} from 'lucide-react';
import type {
  Clip,
  ColorCurves,
  ColorFilterPreset,
  CurvePoint,
} from '../shared/types.ts';
import {
  cloneCurves,
  createIdentityCurve,
  createIdentityCurves,
  createSplineEvaluator,
  getClipEffectiveAdjustments,
  saveCustomColorPreset,
} from '../lib/colorPresets.ts';
import {ScrubNumberField} from './ScrubNumberField.tsx';

interface ColorAdjustPanelProps {
  clip: Clip;
  onUpdateClip: (
    clipId: string,
    patch: Partial<Clip>,
    opts?: {skipUndo?: boolean; skipSync?: boolean}
  ) => void;
  onPresetsChanged?: (presets: ColorFilterPreset[]) => void;
}

type CurveChannel = keyof ColorCurves;

const CURVE_CHANNELS: Array<{
  id: CurveChannel;
  label: string;
  stroke: string;
  activeCls: string;
}> = [
  {
    id: 'rgb',
    label: 'RGB',
    stroke: '#f4f4f5',
    activeCls: 'border-white/70 bg-white/15 text-white',
  },
  {
    id: 'r',
    label: 'R',
    stroke: '#fb7185',
    activeCls: 'border-rose-400 bg-rose-500/20 text-rose-200',
  },
  {
    id: 'g',
    label: 'G',
    stroke: '#34d399',
    activeCls: 'border-emerald-400 bg-emerald-500/20 text-emerald-200',
  },
  {
    id: 'b',
    label: 'B',
    stroke: '#38bdf8',
    activeCls: 'border-sky-400 bg-sky-500/20 text-sky-200',
  },
];

interface SliderSpec {
  key:
    | 'brightness'
    | 'contrast'
    | 'saturate'
    | 'sharpness'
    | 'shadows'
    | 'hue'
    | 'temperature'
    | 'fade'
    | 'grain'
    | 'blur'
    | 'invert';
  label: string;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  trackGradient?: string;
}

const SLIDER_SPECS: SliderSpec[] = [
  {key: 'brightness', label: 'Яркость', min: -100, max: 100, step: 1},
  {key: 'contrast', label: 'Контрастность', min: -100, max: 100, step: 1},
  {key: 'saturate', label: 'Насыщенность', min: -100, max: 100, step: 1},
  {key: 'blur', label: 'Размытие (Blur)', min: 0, max: 60, step: 1, suffix: 'px'},
  {key: 'invert', label: 'Инверсия цвета', min: 0, max: 100, step: 1, suffix: '%'},
  {key: 'sharpness', label: 'Резкость', min: 0, max: 100, step: 1},
  {key: 'shadows', label: 'Тени', min: -100, max: 100, step: 1},
  {
    key: 'hue',
    label: 'Тон (Hue)',
    min: -180,
    max: 180,
    step: 1,
    suffix: '°',
    trackGradient:
      'linear-gradient(to right, #ef4444, #eab308, #22c55e, #06b6d4, #3b82f6, #a855f7, #ef4444)',
  },
  {
    key: 'temperature',
    label: 'Температура',
    min: -100,
    max: 100,
    step: 1,
    trackGradient: 'linear-gradient(to right, #38bdf8, #a1a1aa, #f59e0b)',
  },
  {key: 'fade', label: 'Выцветание (Fade)', min: 0, max: 100, step: 1},
  {key: 'grain', label: 'Зернистость (Grain)', min: 0, max: 100, step: 1},
];

export const ColorAdjustPanel: React.FC<ColorAdjustPanelProps> = ({
  clip,
  onUpdateClip,
  onPresetsChanged,
}) => {
  const [subTab, setSubTab] = useState<'sliders' | 'curves'>('sliders');
  const [curveChannel, setCurveChannel] = useState<CurveChannel>('rgb');
  const [selectedPointIdx, setSelectedPointIdx] = useState<number | null>(null);
  const [showSavePrompt, setShowSavePrompt] = useState(false);
  const [presetNameDraft, setPresetNameDraft] = useState('');
  const [savedToast, setSavedToast] = useState<string | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{
    pointIndex: number;
    isStartEndpoint: boolean;
    isEndEndpoint: boolean;
    points: CurvePoint[];
  } | null>(null);

  const effective = useMemo(() => getClipEffectiveAdjustments(clip), [clip]);

  const getSliderUiValue = (key: SliderSpec['key']): number => {
    switch (key) {
      case 'brightness':
        return Math.round((effective.brightness - 1) * 100);
      case 'contrast':
        return Math.round((effective.contrast - 1) * 100);
      case 'saturate':
        return Math.round((effective.saturate - 1) * 100);
      case 'blur':
        return Math.round(clip.blur ?? 0);
      case 'invert':
        return Math.round(effective.invert ?? 0);
      case 'sharpness':
        return Math.round(effective.sharpness);
      case 'shadows':
        return Math.round(effective.shadows);
      case 'hue':
        return Math.round(effective.hue);
      case 'temperature':
        return Math.round(effective.temperature);
      case 'fade':
        return Math.round(effective.fade);
      case 'grain':
        return Math.round(effective.grain);
    }
  };

  const applySliderUpdate = (
    key: SliderSpec['key'],
    uiVal: number,
    commit: boolean
  ) => {
    const patch: Partial<Clip> = {};
    const nextAdj = {
      sharpness: effective.sharpness,
      shadows: effective.shadows,
      hue: effective.hue,
      temperature: effective.temperature,
      fade: effective.fade,
      grain: effective.grain,
      invert: effective.invert,
      curves: cloneCurves(effective.curves),
    };

    if (key === 'brightness') {
      patch.brightness = Math.max(0, Math.min(2, 1 + uiVal / 100));
    } else if (key === 'contrast') {
      patch.contrast = Math.max(0, Math.min(2, 1 + uiVal / 100));
    } else if (key === 'saturate') {
      patch.saturate = Math.max(0, Math.min(2, 1 + uiVal / 100));
    } else if (key === 'blur') {
      patch.blur = Math.max(0, Math.min(60, Math.round(uiVal)));
    } else {
      nextAdj[key] = uiVal;
    }

    patch.colorAdjustments = nextAdj;
    onUpdateClip(clip.id, patch, {
      skipUndo: !commit,
    });
  };

  const handleResetAll = () => {
    onUpdateClip(clip.id, {
      filter: 'none',
      brightness: 1,
      contrast: 1,
      saturate: 1,
      blur: 0,
      vignette: 0,
      colorAdjustments: {
        sharpness: 0,
        shadows: 0,
        hue: 0,
        temperature: 0,
        fade: 0,
        grain: 0,
        invert: 0,
        curves: createIdentityCurves(),
      },
    });
    setSelectedPointIdx(null);
  };

  const updateChannelPoints = (
    channel: CurveChannel,
    points: CurvePoint[],
    commit: boolean
  ) => {
    const nextCurves = cloneCurves(effective.curves);
    nextCurves[channel] = points;
    onUpdateClip(
      clip.id,
      {
        brightness: effective.brightness,
        contrast: effective.contrast,
        saturate: effective.saturate,
        colorAdjustments: {
          sharpness: effective.sharpness,
          shadows: effective.shadows,
          hue: effective.hue,
          temperature: effective.temperature,
          fade: effective.fade,
          grain: effective.grain,
          invert: effective.invert,
          curves: nextCurves,
        },
      },
      {skipUndo: !commit}
    );
  };

  const activePoints = effective.curves[curveChannel];
  const activeChannelMeta =
    CURVE_CHANNELS.find((c) => c.id === curveChannel) ?? CURVE_CHANNELS[0];

  const curvePathD = useMemo(() => {
    const evalFn = createSplineEvaluator(activePoints);
    const cmds: string[] = [];
    const steps = 64;
    for (let i = 0; i <= steps; i++) {
      const x = i / steps;
      const y = evalFn(x);
      const px = x * 256;
      const py = (1 - y) * 256;
      cmds.push(`${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`);
    }
    return cmds.join(' ');
  }, [activePoints]);

  const clientToNorm = (
    clientX: number,
    clientY: number
  ): {x: number; y: number} | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height));
    return {x, y};
  };

  const handleCurvePointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const pt = clientToNorm(e.clientX, e.clientY);
    if (!pt) return;
    e.currentTarget.setPointerCapture(e.pointerId);

    const pts = [...activePoints].sort((a, b) => a.x - b.x);
    let hitIdx = -1;
    let bestDist = 0.085;
    pts.forEach((p, i) => {
      const d = Math.hypot(p.x - pt.x, p.y - pt.y);
      if (d < bestDist) {
        bestDist = d;
        hitIdx = i;
      }
    });

    if (hitIdx !== -1) {
      setSelectedPointIdx(hitIdx);
      dragRef.current = {
        pointIndex: hitIdx,
        isStartEndpoint: hitIdx === 0,
        isEndEndpoint: hitIdx === pts.length - 1,
        points: pts,
      };
      return;
    }

    if (pts.length >= 12) return;
    const newPt: CurvePoint = {
      x: Math.max(0.03, Math.min(0.97, Number(pt.x.toFixed(3)))),
      y: Math.max(0, Math.min(1, Number(pt.y.toFixed(3)))),
    };
    const next = [...pts, newPt].sort((a, b) => a.x - b.x);
    const newIdx = next.findIndex(
      (p) => Math.abs(p.x - newPt.x) < 0.001 && Math.abs(p.y - newPt.y) < 0.001
    );
    setSelectedPointIdx(newIdx);
    updateChannelPoints(curveChannel, next, false);
    dragRef.current = {
      pointIndex: newIdx,
      isStartEndpoint: false,
      isEndEndpoint: false,
      points: next,
    };
  };

  const handleCurvePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const pt = clientToNorm(e.clientX, e.clientY);
    if (!pt) return;

    const pts = drag.points.map((p) => ({...p}));
    const idx = drag.pointIndex;
    const clampedY = Math.max(0, Math.min(1, Number(pt.y.toFixed(3))));

    if (drag.isStartEndpoint) {
      pts[idx] = {x: 0, y: clampedY};
    } else if (drag.isEndEndpoint) {
      pts[idx] = {x: 1, y: clampedY};
    } else {
      const prevX = idx > 0 ? pts[idx - 1].x + 0.025 : 0.025;
      const nextX =
        idx < pts.length - 1 ? pts[idx + 1].x - 0.025 : 0.975;
      const clampedX = Math.max(prevX, Math.min(nextX, pt.x));
      pts[idx] = {
        x: Number(clampedX.toFixed(3)),
        y: clampedY,
      };
    }
    drag.points = pts;
    updateChannelPoints(curveChannel, pts, false);
  };

  const handleCurvePointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    dragRef.current = null;
    updateChannelPoints(curveChannel, drag.points, true);
  };

  const handleRemoveSelectedPoint = () => {
    if (
      selectedPointIdx === null ||
      selectedPointIdx <= 0 ||
      selectedPointIdx >= activePoints.length - 1
    ) {
      return;
    }
    const next = activePoints.filter((_, i) => i !== selectedPointIdx);
    setSelectedPointIdx(null);
    updateChannelPoints(curveChannel, next, true);
  };

  const handleSaveAsFilter = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = presetNameDraft.trim();
    if (!clean) return;
    const updatedList = saveCustomColorPreset(clean, effective);
    const created = updatedList[0];
    if (created) {
      onUpdateClip(clip.id, {filter: created.id});
    }
    onPresetsChanged?.(updatedList);
    setShowSavePrompt(false);
    setPresetNameDraft('');
    setSavedToast(`Фильтр «${clean}» сохранён`);
    setTimeout(() => setSavedToast(null), 2200);
  };

  return (
    <div className="space-y-3">
      {/* Sub-mode switcher: Sliders vs RGB Curves */}
      <div className="grid grid-cols-2 gap-1 rounded-xl border border-white/10 bg-zinc-900 p-1">
        <button
          type="button"
          onClick={() => setSubTab('sliders')}
          className={`flex h-8 items-center justify-center gap-1.5 rounded-lg text-xs font-semibold transition ${
            subTab === 'sliders'
              ? 'bg-cyan-500 text-zinc-950'
              : 'text-zinc-300 hover:text-white'
          }`}
        >
          <Sliders className="h-3.5 w-3.5" />
          Параметры
        </button>
        <button
          type="button"
          onClick={() => setSubTab('curves')}
          className={`flex h-8 items-center justify-center gap-1.5 rounded-lg text-xs font-semibold transition ${
            subTab === 'curves'
              ? 'bg-cyan-500 text-zinc-950'
              : 'text-zinc-300 hover:text-white'
          }`}
        >
          <Spline className="h-3.5 w-3.5" />
          RGB-кривые
        </button>
      </div>

      {subTab === 'sliders' ? (
        <div className="space-y-2.5">
          {SLIDER_SPECS.map((spec) => {
            const val = getSliderUiValue(spec.key);
            const isModified = val !== 0;
            return (
              <div
                key={spec.key}
                className="space-y-1 rounded-xl border border-white/5 bg-zinc-900/60 px-2.5 py-2"
              >
                <div className="flex items-center justify-between gap-2 text-xs">
                  <button
                    type="button"
                    onDoubleClick={() => applySliderUpdate(spec.key, 0, true)}
                    title="Двойной клик — сбросить параметр"
                    className="flex items-center gap-1.5 text-left font-medium text-zinc-200 hover:text-white"
                  >
                    <span>{spec.label}</span>
                    {isModified && (
                      <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
                    )}
                  </button>
                  <div className="flex items-center gap-1">
                    {isModified && (
                      <button
                        type="button"
                        onClick={() => applySliderUpdate(spec.key, 0, true)}
                        aria-label={`Сбросить ${spec.label}`}
                        className="flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:bg-white/10 hover:text-white"
                      >
                        <RotateCcw className="h-3 w-3" />
                      </button>
                    )}
                    <ScrubNumberField
                      compact
                      accent="cyan"
                      value={val}
                      min={spec.min}
                      max={spec.max}
                      step={spec.step}
                      suffix={spec.suffix}
                      ariaLabel={spec.label}
                      onChange={(next) =>
                        applySliderUpdate(spec.key, next, false)
                      }
                      onCommit={(next) =>
                        applySliderUpdate(spec.key, next, true)
                      }
                    />
                  </div>
                </div>
                <input
                  type="range"
                  min={spec.min}
                  max={spec.max}
                  step={spec.step}
                  value={val}
                  style={
                    spec.trackGradient
                      ? {background: spec.trackGradient}
                      : undefined
                  }
                  onChange={(e) =>
                    applySliderUpdate(spec.key, Number(e.target.value), false)
                  }
                  onPointerUp={(e) =>
                    applySliderUpdate(
                      spec.key,
                      Number((e.target as HTMLInputElement).value),
                      true
                    )
                  }
                  onTouchEnd={(e) =>
                    applySliderUpdate(
                      spec.key,
                      Number((e.target as HTMLInputElement).value),
                      true
                    )
                  }
                  className={`w-full cursor-pointer accent-cyan-400 ${
                    spec.trackGradient ? 'h-1.5 appearance-none rounded-full' : ''
                  }`}
                />
              </div>
            );
          })}
        </div>
      ) : (
        <div className="space-y-3 rounded-xl border border-white/10 bg-zinc-900/70 p-3">
          {/* Channel tabs */}
          <div className="flex items-center justify-between gap-2">
            <div className="grid flex-1 grid-cols-4 gap-1">
              {CURVE_CHANNELS.map((ch) => (
                <button
                  key={ch.id}
                  type="button"
                  onClick={() => {
                    setCurveChannel(ch.id);
                    setSelectedPointIdx(null);
                  }}
                  className={`h-8 rounded-lg border text-xs font-bold transition ${
                    curveChannel === ch.id
                      ? ch.activeCls
                      : 'border-white/10 bg-zinc-950 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {ch.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => {
                setSelectedPointIdx(null);
                updateChannelPoints(
                  curveChannel,
                  createIdentityCurve(),
                  true
                );
              }}
              title="Сбросить кривую канала"
              className="flex h-8 items-center gap-1 rounded-lg border border-white/10 bg-zinc-950 px-2.5 text-[11px] font-medium text-zinc-300 hover:border-white/25 hover:text-white"
            >
              <RotateCcw className="h-3 w-3" />
              Сброс
            </button>
          </div>

          {/* Interactive SVG Curve Graph */}
          <div className="relative mx-auto aspect-square w-full max-w-[260px] overflow-hidden rounded-xl border border-white/15 bg-[#0b0b0f]">
            <svg
              ref={svgRef}
              viewBox="0 0 256 256"
              onPointerDown={handleCurvePointerDown}
              onPointerMove={handleCurvePointerMove}
              onPointerUp={handleCurvePointerUp}
              onPointerCancel={handleCurvePointerUp}
              className="h-full w-full touch-none select-none cursor-crosshair"
            >
              {/* Subtle 4x4 grid */}
              {[64, 128, 192].map((pos) => (
                <g key={pos}>
                  <line
                    x1={pos}
                    y1={0}
                    x2={pos}
                    y2={256}
                    stroke="rgba(255,255,255,0.08)"
                    strokeWidth="1"
                  />
                  <line
                    x1={0}
                    y1={pos}
                    x2={256}
                    y2={pos}
                    stroke="rgba(255,255,255,0.08)"
                    strokeWidth="1"
                  />
                </g>
              ))}

              {/* Diagonal y = x baseline */}
              <line
                x1={0}
                y1={256}
                x2={256}
                y2={0}
                stroke="rgba(255,255,255,0.16)"
                strokeWidth="1"
                strokeDasharray="4 4"
              />

              {/* Spline Curve */}
              <path
                d={curvePathD}
                fill="none"
                stroke={activeChannelMeta.stroke}
                strokeWidth="2.5"
                strokeLinecap="round"
              />

              {/* Control Points */}
              {activePoints.map((p, idx) => {
                const cx = p.x * 256;
                const cy = (1 - p.y) * 256;
                const isSelected = selectedPointIdx === idx;
                return (
                  <g key={`${idx}-${p.x.toFixed(3)}`}>
                    <circle
                      cx={cx}
                      cy={cy}
                      r={isSelected ? 10 : 7}
                      fill={isSelected ? activeChannelMeta.stroke : '#09090b'}
                      stroke={activeChannelMeta.stroke}
                      strokeWidth="2.5"
                    />
                  </g>
                );
              })}
            </svg>
          </div>

          <div className="flex items-center justify-between gap-2 text-[11px] text-zinc-400">
            <span>Нажмите на график, чтобы добавить точку</span>
            {selectedPointIdx !== null &&
              selectedPointIdx > 0 &&
              selectedPointIdx < activePoints.length - 1 && (
                <button
                  type="button"
                  onClick={handleRemoveSelectedPoint}
                  className="flex items-center gap-1 rounded-md border border-rose-500/40 bg-rose-500/15 px-2 py-1 text-[11px] font-medium text-rose-300 hover:bg-rose-500/25"
                >
                  <Trash2 className="h-3 w-3" />
                  Удалить точку
                </button>
              )}
          </div>
        </div>
      )}

      {savedToast && (
        <div className="flex items-center gap-1.5 rounded-xl border border-emerald-500/40 bg-emerald-500/15 px-3 py-2 text-xs font-medium text-emerald-300">
          <Check className="h-3.5 w-3.5 shrink-0" />
          <span>{savedToast}</span>
        </div>
      )}

      {showSavePrompt ? (
        <form
          onSubmit={handleSaveAsFilter}
          className="space-y-2 rounded-xl border border-cyan-500/40 bg-cyan-500/10 p-2.5"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-cyan-200">
              Название нового фильтра
            </span>
            <button
              type="button"
              onClick={() => setShowSavePrompt(false)}
              className="text-zinc-400 hover:text-white"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex gap-1.5">
            <input
              type="text"
              autoFocus
              value={presetNameDraft}
              onChange={(e) => setPresetNameDraft(e.target.value)}
              placeholder="Например: Ночной неон"
              maxLength={32}
              className="h-9 flex-1 rounded-lg border border-white/15 bg-zinc-950 px-2.5 text-xs text-white placeholder:text-zinc-500 focus:border-cyan-400 focus:outline-none"
            />
            <button
              type="submit"
              disabled={!presetNameDraft.trim()}
              className="h-9 shrink-0 rounded-lg bg-cyan-500 px-3 text-xs font-semibold text-zinc-950 hover:bg-cyan-400 disabled:opacity-40"
            >
              Сохранить
            </button>
          </div>
        </form>
      ) : (
        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={handleResetAll}
            className="flex h-10 items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-zinc-900 px-3 text-xs font-medium text-zinc-300 hover:border-white/25 hover:text-white"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Сбросить
          </button>
          <button
            type="button"
            onClick={() => {
              setPresetNameDraft('');
              setShowSavePrompt(true);
            }}
            className="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl bg-cyan-500 px-3 text-xs font-semibold text-zinc-950 hover:bg-cyan-400 active:scale-[0.99]"
          >
            <BookmarkPlus className="h-4 w-4" />
            Сохранить как фильтр
          </button>
        </div>
      )}
    </div>
  );
};
