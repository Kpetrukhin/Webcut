import React, {useEffect, useRef, useState} from 'react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Diamond,
  Eye,
  EyeOff,
  Italic,
  Move,
  Pipette,
  Plus,
  RotateCcw,
  Smile,
  Sparkles,
  Spline,
  Trash2,
  Type,
  Underline,
  Upload,
} from 'lucide-react';
import {
  BUILTIN_FONTS,
  loadCustomFont,
  sanitizeFontFamilyName,
} from '../lib/fontLoader.ts';
import {uploadFileForP2P} from '../lib/lanSyncBridge.ts';
import {
  buildPresetCurvePoints,
  colorToHex,
  createDefaultCurvePoints,
  measureBaseTextHalfWidth,
  normalizeTextStyle,
} from '../lib/textRenderer.ts';
import type {
  Clip,
  ProjectFont,
  TextAnimationType,
  TextBgMode,
  TextCurveMode,
  TextCurvePoint,
  TextStyle,
} from '../shared/types.ts';
import {UnityNumberField} from './UnityNumberField.tsx';

export type TextSubTab = 'font' | 'style' | 'spacing' | 'curve' | 'anim';
export type TextColorField = 'color' | 'strokeColor' | 'shadowColor' | 'bgColor';

interface TextPanelProps {
  selectedClip: Clip | null;
  clips?: Clip[];
  customFonts: ProjectFont[];
  currentTime: number;
  autoFocusTrigger?: number;
  activeColorPickerField?: TextColorField | null;
  onRequestColorPicker?: (field: TextColorField | null) => void;
  curveEditActive?: boolean;
  onSetCurveEditActive?: (active: boolean) => void;
  selectedCurvePointId?: string | null;
  onSelectCurvePoint?: (pointId: string | null) => void;
  onSelectClip?: (clipId: string) => void;
  onAddText: (text: string, forceNewTrack: boolean) => void;
  onUpdateClip: (
    clipId: string,
    patch: Partial<Clip>,
    opts?: {skipUndo?: boolean; skipSync?: boolean}
  ) => void;
  onAddCustomFont: (font: ProjectFont) => void;
  onOpenTrackpad?: () => void;
  onAddKeyframe?: () => void;
  hasKeyframeAtPlayhead?: boolean;
  onOpenStickers?: () => void;
  compactLayout?: boolean;
}

const TEXT_PALETTE = [
  '#ffffff',
  '#09090b',
  '#22d3ee',
  '#facc15',
  '#fb7185',
  '#34d399',
  '#a78bfa',
  '#f97316',
];

const BG_MODE_OPTIONS: Array<{id: TextBgMode; label: string; desc: string}> = [
  {id: 'none', label: 'Нет', desc: 'Без фона'},
  {id: 'chars', label: 'По буквам', desc: 'Скруглённая плашка на символ'},
  {id: 'lines', label: 'Построчно', desc: 'Плашка по ширине строки'},
  {id: 'block', label: 'Блок', desc: 'Единый прямоугольник'},
];

const CURVE_MODE_OPTIONS: Array<{
  id: TextCurveMode;
  label: string;
  svgPath: string;
}> = [
  {id: 'none', label: 'Нет', svgPath: 'M3 12 L21 12'},
  {id: 'arc', label: 'Дуга', svgPath: 'M3 16 Q12 4 21 16'},
  {id: 'wave', label: 'Волна', svgPath: 'M3 12 Q7.5 4 12 12 T21 12'},
  {id: 'zigzag', label: 'Зигзаг', svgPath: 'M3 15 L7.5 7 L12 15 L16.5 7 L21 15'},
  {
    id: 'custom',
    label: 'Точки',
    svgPath: 'M3 15 C8 4, 15 20, 21 8',
  },
];

const TEXT_ANIMATION_OPTIONS: Array<{
  id: TextAnimationType;
  label: string;
  desc: string;
}> = [
  {id: 'none', label: 'Нет', desc: 'Без анимации'},
  {id: 'fade', label: 'Плавное появление', desc: 'Fade прозрачности'},
  {id: 'slide-up', label: 'Выезд снизу', desc: 'Slide вверх/вниз'},
  {id: 'slide-left', label: 'Выезд слева', desc: 'Горизонтальный сдвиг'},
  {id: 'slide-right', label: 'Выезд справа', desc: 'Горизонтальный сдвиг'},
  {id: 'scale-pop', label: 'Увеличение / Поп-ап', desc: 'Scale Pop эффект'},
  {id: 'typewriter', label: 'Печатная машинка', desc: 'Появление по буквам'},
  {id: 'blur-spin', label: 'Размытие / Вращение', desc: 'Blur + Spin переход'},
];

interface ColorPickerRowProps {
  label: string;
  value: string;
  field: TextColorField;
  activePickerField?: TextColorField | null;
  onRequestPicker?: (field: TextColorField | null) => void;
  onChange: (hex: string) => void;
}

const ColorPickerRow: React.FC<ColorPickerRowProps> = ({
  label,
  value,
  field,
  activePickerField,
  onRequestPicker,
  onChange,
}) => {
  const hex = colorToHex(value, '#ffffff');
  const isPicking = activePickerField === field;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-zinc-300">{label}</span>
        <span className="font-mono text-[10px] uppercase text-zinc-400">
          {hex}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {TEXT_PALETTE.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onChange(c)}
            style={{backgroundColor: c}}
            aria-label={`${label}: ${c}`}
            className={`h-7 w-7 rounded-full border-2 transition ${
              hex.toLowerCase() === c.toLowerCase()
                ? 'border-cyan-400 scale-110 shadow-[0_0_0_2px_rgba(34,211,238,0.25)]'
                : 'border-white/20 hover:border-white/50'
            }`}
          />
        ))}

        <label
          title="Выбрать произвольный цвет"
          className="relative flex h-7 w-7 cursor-pointer items-center justify-center overflow-hidden rounded-full border border-white/25 bg-gradient-to-tr from-rose-500 via-amber-400 to-cyan-400"
        >
          <input
            type="color"
            value={hex}
            onChange={(e) => onChange(e.target.value)}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />
        </label>

        {onRequestPicker && (
          <button
            type="button"
            onClick={() => onRequestPicker(isPicking ? null : field)}
            title="Пипетка с холста"
            aria-label={`Пипетка для: ${label}`}
            className={`flex h-7 items-center gap-1 rounded-lg border px-2 text-[11px] font-medium transition active:scale-95 ${
              isPicking
                ? 'border-cyan-400 bg-cyan-500/25 text-cyan-200'
                : 'border-white/15 bg-zinc-900 text-zinc-200 hover:border-cyan-400/60'
            }`}
          >
            <Pipette className="h-3.5 w-3.5 text-cyan-400" />
            <span>Пипетка</span>
          </button>
        )}
      </div>
    </div>
  );
};

export const TextPanel: React.FC<TextPanelProps> = ({
  selectedClip,
  clips = [],
  customFonts,
  currentTime,
  autoFocusTrigger = 0,
  activeColorPickerField = null,
  onRequestColorPicker,
  curveEditActive = false,
  onSetCurveEditActive,
  selectedCurvePointId = null,
  onSelectCurvePoint,
  onSelectClip,
  onAddText,
  onUpdateClip,
  onAddCustomFont,
  onOpenTrackpad,
  onAddKeyframe,
  hasKeyframeAtPlayhead = false,
  onOpenStickers,
  compactLayout = false,
}) => {
  const [subTab, setSubTab] = useState<TextSubTab>('style');
  const [animPhase, setAnimPhase] = useState<'in' | 'out'>('in');
  const [forceNewTrack, setForceNewTrack] = useState(true);
  const [uploadingFont, setUploadingFont] = useState(false);
  const [fontError, setFontError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const isTextSelected = selectedClip?.track === 'text';
  const style = normalizeTextStyle(
    isTextSelected ? selectedClip?.textStyle : undefined
  );

  useEffect(() => {
    if (autoFocusTrigger > 0 && isTextSelected) {
      const timer = setTimeout(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.select();
        }
      }, 60);
      return () => clearTimeout(timer);
    }
  }, [autoFocusTrigger, isTextSelected]);

  const updateStyle = (
    patch: Partial<TextStyle>,
    opts?: {skipUndo?: boolean; skipSync?: boolean}
  ) => {
    if (!selectedClip || !isTextSelected) return;
    const next: TextStyle = {
      ...style,
      ...patch,
    };
    onUpdateClip(selectedClip.id, {textStyle: next}, opts);
  };

  const handleFontUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingFont(true);
    setFontError(null);
    try {
      const prepared = await uploadFileForP2P(file, 'font');
      const family = sanitizeFontFamilyName(prepared.name);
      await loadCustomFont(family, prepared.localSrc, {
        fileName: prepared.fileName,
        fileSize: prepared.fileSize,
        fileHash: prepared.fileHash,
      });
      const sharedSrc = prepared.shareUrl || prepared.localSrc;
      const newFont: ProjectFont = {
        id: `font-${Math.random().toString(36).slice(2, 8)}`,
        name: family,
        fontFamily: family,
        src: sharedSrc,
        fileName: prepared.fileName,
        fileSize: prepared.fileSize,
        fileHash: prepared.fileHash,
      };
      onAddCustomFont(newFont);
      if (isTextSelected && selectedClip) {
        updateStyle({fontFamily: family, fontSrc: sharedSrc});
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

  const textClipsAtPlayhead = clips.filter(
    (c) =>
      c.track === 'text' &&
      currentTime >= c.start - 0.02 &&
      currentTime <= c.start + c.duration + 0.02
  );

  if (!isTextSelected || !selectedClip) {
    return (
      <div className="space-y-4">
        <div className={onOpenStickers ? 'grid grid-cols-2 gap-2' : 'space-y-2'}>
          <button
            type="button"
            onClick={() => onAddText('НОВЫЙ ТЕКСТ', forceNewTrack)}
            className="flex h-12 w-full items-center justify-center gap-1.5 rounded-xl bg-cyan-500 px-3 text-xs font-bold text-zinc-950 shadow-lg shadow-cyan-500/20 transition hover:bg-cyan-400 active:scale-[0.98] sm:text-sm"
          >
            <Plus className="h-4 w-4 shrink-0" />
            <span className="truncate">Добавить текст</span>
          </button>

          {onOpenStickers && (
            <button
              type="button"
              onClick={onOpenStickers}
              className="flex h-12 w-full items-center justify-center gap-1.5 rounded-xl border border-amber-400/40 bg-amber-500/15 px-3 text-xs font-bold text-amber-200 shadow-lg shadow-amber-500/10 transition hover:bg-amber-500/25 active:scale-[0.98] sm:text-sm"
            >
              <Smile className="h-4 w-4 shrink-0 text-amber-400" />
              <span className="truncate">Стикеры</span>
            </button>
          )}
        </div>

        <label className="flex cursor-pointer items-center justify-between rounded-xl border border-white/10 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-300">
          <span>Создавать новую дорожку текста</span>
          <input
            type="checkbox"
            checked={forceNewTrack}
            onChange={(e) => setForceNewTrack(e.target.checked)}
            className="h-4 w-4 accent-cyan-400"
          />
        </label>

        {textClipsAtPlayhead.length > 0 && onSelectClip && (
          <div className="space-y-2 rounded-xl border border-white/10 bg-zinc-900/50 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
              Текстовые слои на текущем кадре
            </p>
            <div className="space-y-1.5">
              {textClipsAtPlayhead.map((tc) => (
                <button
                  key={tc.id}
                  type="button"
                  onClick={() => onSelectClip(tc.id)}
                  className="flex w-full items-center justify-between gap-2 rounded-lg border border-white/10 bg-zinc-950/80 px-3 py-2 text-left hover:border-cyan-400/60"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <Type className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                    <span className="truncate text-xs font-medium text-white">
                      {tc.text || tc.name}
                    </span>
                  </div>
                  <span className="shrink-0 text-[10px] font-semibold text-cyan-400">
                    Изменить
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="rounded-xl border border-white/10 bg-zinc-900/40 p-3 text-xs leading-relaxed text-zinc-400">
          Нажмите «Добавить текст», чтобы создать текстовый слой на позиции
          плейхеда, сразу ввести текст с клавиатуры и настроить шрифт, обводку,
          тень, подложку, отступы или изгиб по кривой.
        </div>
      </div>
    );
  }

  return (
    <div
      className={`flex flex-col ${
        compactLayout ? 'h-full min-h-0' : 'space-y-3'
      }`}
    >
      {/* Top Text Input + Quick Actions */}
      <div className="shrink-0 space-y-2 pb-2">
        <div className="flex items-start gap-2">
          <textarea
            ref={textareaRef}
            rows={2}
            value={selectedClip.text ?? ''}
            onChange={(e) => {
              const val = e.target.value;
              onUpdateClip(selectedClip.id, {
                text: val,
                name: val.trim().replace(/\s+/g, ' ').slice(0, 20) || 'Текст',
              });
            }}
            placeholder="Введите текст..."
            className="studio-scrollbar min-h-[48px] flex-1 resize-none rounded-xl border border-white/15 bg-zinc-900 px-3 py-2 text-sm text-white placeholder:text-zinc-500 focus:border-cyan-400 focus:outline-none"
          />
          <div className="flex shrink-0 flex-col gap-1.5">
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => onAddText('НОВЫЙ ТЕКСТ', forceNewTrack)}
                title="Добавить ещё один текстовый слой"
                className="flex h-8 items-center gap-1 rounded-lg bg-cyan-500 px-2.5 text-[11px] font-bold text-zinc-950 hover:bg-cyan-400 active:scale-95"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Новый</span>
              </button>
              {onOpenStickers && (
                <button
                  type="button"
                  onClick={onOpenStickers}
                  title="Открыть стикеры Giphy"
                  aria-label="Стикеры"
                  className="flex h-8 items-center gap-1 rounded-lg border border-amber-400/40 bg-amber-500/15 px-2 text-[11px] font-bold text-amber-200 hover:bg-amber-500/25 active:scale-95"
                >
                  <Smile className="h-3.5 w-3.5 text-amber-400" />
                  <span>Стикеры</span>
                </button>
              )}
            </div>
            <div className="flex gap-1">
              {onAddKeyframe && (
                <button
                  type="button"
                  onClick={onAddKeyframe}
                  title="Ключевой кадр в точке плейхеда"
                  className={`flex h-7 flex-1 items-center justify-center rounded-lg border transition active:scale-95 ${
                    hasKeyframeAtPlayhead
                      ? 'border-amber-400 bg-amber-500/20 text-amber-300'
                      : 'border-white/10 bg-zinc-900 text-zinc-300 hover:border-amber-400/50'
                  }`}
                >
                  <Diamond className="h-3.5 w-3.5" />
                </button>
              )}
              {onOpenTrackpad && (
                <button
                  type="button"
                  onClick={onOpenTrackpad}
                  title="Открыть трекпад трансформации"
                  className="flex h-7 flex-1 items-center justify-center rounded-lg border border-white/10 bg-zinc-900 text-cyan-400 hover:border-cyan-400/60 active:scale-95"
                >
                  <Move className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Scrollable Sub-Tab Content */}
      <div
        className={`studio-scrollbar space-y-3 ${
          compactLayout ? 'min-h-0 flex-1 overflow-y-auto pr-0.5 pb-2' : ''
        }`}
      >
        {/* 1. ШРИФТ */}
        {subTab === 'font' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-zinc-300">
                Системные и проектные шрифты
              </span>
              <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/15 px-2.5 py-1.5 text-[11px] font-semibold text-cyan-200 hover:bg-cyan-500/25 active:scale-95">
                <Upload className="h-3.5 w-3.5 text-cyan-400" />
                <span>
                  {uploadingFont ? 'Загрузка...' : 'Загрузить свой'}
                </span>
                <input
                  type="file"
                  accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/*,application/font-sfnt,application/x-font-ttf"
                  disabled={uploadingFont}
                  onChange={handleFontUpload}
                  className="hidden"
                />
              </label>
            </div>

            {fontError && (
              <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-[11px] text-rose-300">
                {fontError}
              </p>
            )}

            {customFonts.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-300/90">
                  Шрифты проекта (.ttf / .otf)
                </p>
                <div className="grid grid-cols-2 gap-1.5">
                  {customFonts.map((cf) => {
                    const active = style.fontFamily === cf.fontFamily;
                    return (
                      <button
                        key={cf.id}
                        type="button"
                        onClick={() =>
                          updateStyle({
                            fontFamily: cf.fontFamily,
                            fontSrc: cf.src,
                          })
                        }
                        style={{fontFamily: `"${cf.fontFamily}", sans-serif`}}
                        className={`flex h-10 items-center justify-between rounded-xl border px-3 text-left text-xs transition ${
                          active
                            ? 'border-amber-400 bg-amber-500/20 text-amber-100'
                            : 'border-amber-500/25 bg-zinc-900 text-amber-200/90 hover:border-amber-400/50'
                        }`}
                      >
                        <span className="truncate">{cf.name}</span>
                        <span className="ml-1 shrink-0 text-[10px] opacity-75">
                          Aa
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-1.5">
              {BUILTIN_FONTS.map((f) => {
                const active = style.fontFamily === f.family && !style.fontSrc;
                return (
                  <button
                    key={f.family}
                    type="button"
                    onClick={() =>
                      updateStyle({
                        fontFamily: f.family,
                        fontSrc: undefined,
                      })
                    }
                    style={{fontFamily: f.css}}
                    className={`flex h-10 items-center justify-between rounded-xl border px-3 text-left text-xs transition ${
                      active
                        ? 'border-cyan-400 bg-cyan-500/20 text-cyan-100'
                        : 'border-white/10 bg-zinc-900 text-zinc-200 hover:border-white/25'
                    }`}
                  >
                    <span className="truncate">{f.name}</span>
                    <span className="ml-1 shrink-0 text-xs opacity-70">Aa</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* 2. СТИЛЬ И НАЧЕРТАНИЕ (СПЕЦ) */}
        {subTab === 'style' && (
          <div className="space-y-3">
            {/* Bold / Italic / Underline + Alignment */}
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-zinc-900/60 p-2">
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() =>
                    updateStyle({
                      fontWeight:
                        style.fontWeight === 'bold' ? 'normal' : 'bold',
                    })
                  }
                  aria-label="Жирный"
                  className={`flex h-9 w-9 items-center justify-center rounded-lg border transition ${
                    style.fontWeight === 'bold'
                      ? 'border-cyan-400 bg-cyan-500/20 text-cyan-200'
                      : 'border-white/10 bg-zinc-900 text-zinc-400 hover:text-white'
                  }`}
                >
                  <Bold className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    updateStyle({
                      fontStyle:
                        style.fontStyle === 'italic' ? 'normal' : 'italic',
                    })
                  }
                  aria-label="Курсив"
                  className={`flex h-9 w-9 items-center justify-center rounded-lg border transition ${
                    style.fontStyle === 'italic'
                      ? 'border-cyan-400 bg-cyan-500/20 text-cyan-200'
                      : 'border-white/10 bg-zinc-900 text-zinc-400 hover:text-white'
                  }`}
                >
                  <Italic className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => updateStyle({underline: !style.underline})}
                  aria-label="Подчёркивание"
                  className={`flex h-9 w-9 items-center justify-center rounded-lg border transition ${
                    style.underline
                      ? 'border-cyan-400 bg-cyan-500/20 text-cyan-200'
                      : 'border-white/10 bg-zinc-900 text-zinc-400 hover:text-white'
                  }`}
                >
                  <Underline className="h-4 w-4" />
                </button>
              </div>

              <div className="flex gap-1">
                {(
                  [
                    {id: 'left', icon: AlignLeft, label: 'По левому краю'},
                    {id: 'center', icon: AlignCenter, label: 'По центру'},
                    {id: 'right', icon: AlignRight, label: 'По правому краю'},
                  ] as const
                ).map((al) => {
                  const Icon = al.icon;
                  return (
                    <button
                      key={al.id}
                      type="button"
                      onClick={() => updateStyle({align: al.id})}
                      aria-label={al.label}
                      className={`flex h-9 w-9 items-center justify-center rounded-lg border transition ${
                        style.align === al.id
                          ? 'border-cyan-400 bg-cyan-500/20 text-cyan-200'
                          : 'border-white/10 bg-zinc-900 text-zinc-400 hover:text-white'
                      }`}
                    >
                      <Icon className="h-4 w-4" />
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Color & Size (UnityNumberField) */}
            <div className="space-y-3 rounded-xl border border-white/10 bg-zinc-900/60 p-3">
              <ColorPickerRow
                label="Цвет текста"
                value={style.color}
                field="color"
                activePickerField={activeColorPickerField}
                onRequestPicker={onRequestColorPicker}
                onChange={(hex) => updateStyle({color: hex})}
              />

              <div className="space-y-1.5 border-t border-white/10 pt-2.5">
                <UnityNumberField
                  label="Размер текста"
                  compact
                  accent="cyan"
                  value={style.fontSize}
                  min={10}
                  max={220}
                  step={1}
                  decimals={0}
                  suffix="px"
                  ariaLabel="Размер текста"
                  onChange={(px) =>
                    updateStyle({fontSize: px}, {skipUndo: true, skipSync: true})
                  }
                  onCommit={(px) => updateStyle({fontSize: px})}
                />
                <input
                  type="range"
                  min={14}
                  max={150}
                  step={1}
                  value={Math.min(150, Math.max(14, style.fontSize))}
                  onChange={(e) =>
                    updateStyle(
                      {fontSize: Number(e.target.value)},
                      {skipUndo: true, skipSync: true}
                    )
                  }
                  onPointerUp={(e) =>
                    updateStyle({
                      fontSize: Number((e.target as HTMLInputElement).value),
                    })
                  }
                  onTouchEnd={(e) =>
                    updateStyle({
                      fontSize: Number((e.target as HTMLInputElement).value),
                    })
                  }
                  className="h-2 w-full cursor-pointer accent-cyan-400"
                />
              </div>
            </div>

            {/* Обводка (Stroke) */}
            <div className="space-y-2.5 rounded-xl border border-white/10 bg-zinc-900/60 p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-white">
                  Обводка (Stroke)
                </span>
                <button
                  type="button"
                  onClick={() =>
                    updateStyle({
                      strokeWidth: style.strokeWidth > 0 ? 0 : 4,
                      outline: style.strokeWidth <= 0,
                    })
                  }
                  className={`rounded-md px-2 py-0.5 text-[10px] font-bold ${
                    style.strokeWidth > 0
                      ? 'bg-cyan-500/20 text-cyan-300'
                      : 'bg-white/10 text-zinc-400'
                  }`}
                >
                  {style.strokeWidth > 0 ? 'ВКЛ' : 'ВЫКЛ'}
                </button>
              </div>

              <UnityNumberField
                label="Толщина обводки"
                compact
                accent="cyan"
                value={style.strokeWidth}
                min={0}
                max={40}
                step={0.5}
                decimals={1}
                suffix="px"
                ariaLabel="Толщина обводки"
                onChange={(w) =>
                  updateStyle(
                    {strokeWidth: w, outline: w > 0},
                    {skipUndo: true, skipSync: true}
                  )
                }
                onCommit={(w) =>
                  updateStyle({strokeWidth: w, outline: w > 0})
                }
              />

              {style.strokeWidth > 0 && (
                <ColorPickerRow
                  label="Цвет обводки"
                  value={style.strokeColor}
                  field="strokeColor"
                  activePickerField={activeColorPickerField}
                  onRequestPicker={onRequestColorPicker}
                  onChange={(hex) => updateStyle({strokeColor: hex})}
                />
              )}
            </div>

            {/* Тень (Shadow) */}
            <div className="space-y-2.5 rounded-xl border border-white/10 bg-zinc-900/60 p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-white">
                  Тень (Shadow)
                </span>
                <button
                  type="button"
                  onClick={() => updateStyle({shadow: !style.shadow})}
                  className={`rounded-md px-2 py-0.5 text-[10px] font-bold ${
                    style.shadow
                      ? 'bg-cyan-500/20 text-cyan-300'
                      : 'bg-white/10 text-zinc-400'
                  }`}
                >
                  {style.shadow ? 'ВКЛ' : 'ВЫКЛ'}
                </button>
              </div>

              {style.shadow && (
                <div className="space-y-2.5 border-t border-white/10 pt-2">
                  <ColorPickerRow
                    label="Цвет тени"
                    value={style.shadowColor}
                    field="shadowColor"
                    activePickerField={activeColorPickerField}
                    onRequestPicker={onRequestColorPicker}
                    onChange={(hex) => updateStyle({shadowColor: hex})}
                  />

                  <UnityNumberField
                    label="Смещение X"
                    compact
                    accent="cyan"
                    value={style.shadowOffsetX}
                    min={-60}
                    max={60}
                    step={1}
                    decimals={0}
                    suffix="px"
                    ariaLabel="Смещение тени X"
                    onChange={(v) =>
                      updateStyle(
                        {shadowOffsetX: v},
                        {skipUndo: true, skipSync: true}
                      )
                    }
                    onCommit={(v) => updateStyle({shadowOffsetX: v})}
                  />

                  <UnityNumberField
                    label="Смещение Y"
                    compact
                    accent="cyan"
                    value={style.shadowOffsetY}
                    min={-60}
                    max={60}
                    step={1}
                    decimals={0}
                    suffix="px"
                    ariaLabel="Смещение тени Y"
                    onChange={(v) =>
                      updateStyle(
                        {shadowOffsetY: v},
                        {skipUndo: true, skipSync: true}
                      )
                    }
                    onCommit={(v) => updateStyle({shadowOffsetY: v})}
                  />

                  <UnityNumberField
                    label="Размытие"
                    compact
                    accent="cyan"
                    value={style.shadowBlur}
                    min={0}
                    max={60}
                    step={1}
                    decimals={0}
                    suffix="px"
                    ariaLabel="Размытие тени"
                    onChange={(v) =>
                      updateStyle(
                        {shadowBlur: v},
                        {skipUndo: true, skipSync: true}
                      )
                    }
                    onCommit={(v) => updateStyle({shadowBlur: v})}
                  />
                </div>
              )}
            </div>

            {/* Фон текста (3 режима на выбор + Нет) */}
            <div className="space-y-2.5 rounded-xl border border-white/10 bg-zinc-900/60 p-3">
              <p className="text-xs font-semibold text-white">
                Фон текста (Плашка)
              </p>
              <div className="grid grid-cols-4 gap-1.5">
                {BG_MODE_OPTIONS.map((m) => {
                  const active = style.bgMode === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => updateStyle({bgMode: m.id})}
                      title={m.desc}
                      className={`rounded-lg border px-1.5 py-2 text-[11px] font-medium transition ${
                        active
                          ? 'border-cyan-400 bg-cyan-500/20 text-cyan-200'
                          : 'border-white/10 bg-zinc-950/70 text-zinc-300 hover:border-white/25'
                      }`}
                    >
                      {m.label}
                    </button>
                  );
                })}
              </div>

              {style.bgMode !== 'none' && (
                <div className="space-y-2.5 border-t border-white/10 pt-2">
                  <ColorPickerRow
                    label="Цвет плашки"
                    value={style.bgColor}
                    field="bgColor"
                    activePickerField={activeColorPickerField}
                    onRequestPicker={onRequestColorPicker}
                    onChange={(hex) => updateStyle({bgColor: hex})}
                  />

                  <div className="space-y-1">
                    <UnityNumberField
                      label="Прозрачность плашки"
                      compact
                      accent="cyan"
                      value={Math.round(style.bgOpacity * 100)}
                      min={0}
                      max={100}
                      step={1}
                      decimals={0}
                      suffix="%"
                      ariaLabel="Прозрачность фона текста"
                      onChange={(pct) =>
                        updateStyle(
                          {bgOpacity: pct / 100},
                          {skipUndo: true, skipSync: true}
                        )
                      }
                      onCommit={(pct) =>
                        updateStyle({bgOpacity: pct / 100})
                      }
                    />
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={Math.round(style.bgOpacity * 100)}
                      onChange={(e) =>
                        updateStyle(
                          {bgOpacity: Number(e.target.value) / 100},
                          {skipUndo: true, skipSync: true}
                        )
                      }
                      onPointerUp={(e) =>
                        updateStyle({
                          bgOpacity:
                            Number((e.target as HTMLInputElement).value) / 100,
                        })
                      }
                      onTouchEnd={(e) =>
                        updateStyle({
                          bgOpacity:
                            Number((e.target as HTMLInputElement).value) / 100,
                        })
                      }
                      className="h-2 w-full cursor-pointer accent-cyan-400"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 3. ОТСТУПЫ (ИНТЕРВАЛЫ) */}
        {subTab === 'spacing' && (
          <div className="space-y-3 rounded-xl border border-white/10 bg-zinc-900/60 p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-white">
                Интервалы текста
              </span>
              <button
                type="button"
                onClick={() =>
                  updateStyle({
                    letterSpacing: 0,
                    lineHeight: 1.25,
                    spaceWidth: 1.0,
                  })
                }
                className="flex items-center gap-1 rounded-lg border border-white/10 bg-zinc-950 px-2 py-1 text-[10px] font-medium text-zinc-300 hover:border-white/25"
              >
                <RotateCcw className="h-3 w-3" />
                Сброс
              </button>
            </div>

            <div className="space-y-1.5">
              <UnityNumberField
                label="Межбуквенный интервал"
                compact
                accent="cyan"
                value={style.letterSpacing}
                min={-15}
                max={60}
                step={0.5}
                decimals={1}
                suffix="px"
                ariaLabel="Межбуквенный интервал"
                onChange={(v) =>
                  updateStyle(
                    {letterSpacing: v},
                    {skipUndo: true, skipSync: true}
                  )
                }
                onCommit={(v) => updateStyle({letterSpacing: v})}
              />
              <input
                type="range"
                min={-10}
                max={40}
                step={0.5}
                value={Math.max(-10, Math.min(40, style.letterSpacing))}
                onChange={(e) =>
                  updateStyle(
                    {letterSpacing: Number(e.target.value)},
                    {skipUndo: true, skipSync: true}
                  )
                }
                onPointerUp={(e) =>
                  updateStyle({
                    letterSpacing: Number((e.target as HTMLInputElement).value),
                  })
                }
                onTouchEnd={(e) =>
                  updateStyle({
                    letterSpacing: Number((e.target as HTMLInputElement).value),
                  })
                }
                className="h-2 w-full cursor-pointer accent-cyan-400"
              />
            </div>

            <div className="space-y-1.5 border-t border-white/10 pt-2.5">
              <UnityNumberField
                label="Межстрочный интервал"
                compact
                accent="cyan"
                value={style.lineHeight}
                min={0.6}
                max={3.0}
                step={0.05}
                decimals={2}
                suffix="x"
                ariaLabel="Межстрочный интервал"
                onChange={(v) =>
                  updateStyle({lineHeight: v}, {skipUndo: true, skipSync: true})
                }
                onCommit={(v) => updateStyle({lineHeight: v})}
              />
              <input
                type="range"
                min={0.7}
                max={2.5}
                step={0.05}
                value={Math.max(0.7, Math.min(2.5, style.lineHeight))}
                onChange={(e) =>
                  updateStyle(
                    {lineHeight: Number(e.target.value)},
                    {skipUndo: true, skipSync: true}
                  )
                }
                onPointerUp={(e) =>
                  updateStyle({
                    lineHeight: Number((e.target as HTMLInputElement).value),
                  })
                }
                onTouchEnd={(e) =>
                  updateStyle({
                    lineHeight: Number((e.target as HTMLInputElement).value),
                  })
                }
                className="h-2 w-full cursor-pointer accent-cyan-400"
              />
            </div>

            <div className="space-y-1.5 border-t border-white/10 pt-2.5">
              <UnityNumberField
                label="Ширина пробела"
                compact
                accent="cyan"
                value={style.spaceWidth}
                min={0.2}
                max={4.0}
                step={0.05}
                decimals={2}
                suffix="x"
                ariaLabel="Ширина пробела"
                onChange={(v) =>
                  updateStyle({spaceWidth: v}, {skipUndo: true, skipSync: true})
                }
                onCommit={(v) => updateStyle({spaceWidth: v})}
              />
              <input
                type="range"
                min={0.25}
                max={3.0}
                step={0.05}
                value={Math.max(0.25, Math.min(3.0, style.spaceWidth))}
                onChange={(e) =>
                  updateStyle(
                    {spaceWidth: Number(e.target.value)},
                    {skipUndo: true, skipSync: true}
                  )
                }
                onPointerUp={(e) =>
                  updateStyle({
                    spaceWidth: Number((e.target as HTMLInputElement).value),
                  })
                }
                onTouchEnd={(e) =>
                  updateStyle({
                    spaceWidth: Number((e.target as HTMLInputElement).value),
                  })
                }
                className="h-2 w-full cursor-pointer accent-cyan-400"
              />
            </div>
          </div>
        )}

        {/* 4. КРИВАЯ (ИСКРИВЛЕНИЕ ТЕКСТА) */}
        {subTab === 'curve' && (
          <div className="space-y-3 rounded-xl border border-white/10 bg-zinc-900/60 p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-white">
                Искривление текста
              </span>
              {style.curveMode !== 'none' && (
                <button
                  type="button"
                  onClick={() => {
                    onSetCurveEditActive?.(false);
                    onSelectCurvePoint?.(null);
                    updateStyle({
                      curveMode: 'none',
                      curveAmplitude: 0,
                      curveFrequency: 2,
                    });
                  }}
                  className="flex items-center gap-1 rounded-lg border border-white/10 bg-zinc-950 px-2 py-1 text-[10px] font-medium text-zinc-300 hover:border-white/25"
                >
                  <RotateCcw className="h-3 w-3" />
                  Сброс
                </button>
              )}
            </div>

            <div className="grid grid-cols-5 gap-1">
              {CURVE_MODE_OPTIONS.map((cm) => {
                const active = style.curveMode === cm.id;
                return (
                  <button
                    key={cm.id}
                    type="button"
                    onClick={() => {
                      if (cm.id === 'custom') {
                        const existingPts = style.curvePoints;
                        const nextPts =
                          existingPts.length >= 2
                            ? existingPts
                            : buildPresetCurvePoints(
                                selectedClip.text ?? selectedClip.name ?? '',
                                style
                              );
                        updateStyle({
                          curveMode: 'custom',
                          curvePoints: nextPts,
                          curveSmoothness: style.curveSmoothness ?? 100,
                        });
                        onSelectCurvePoint?.(nextPts[Math.floor(nextPts.length / 2)]?.id ?? nextPts[0]?.id ?? null);
                        onSetCurveEditActive?.(true);
                      } else {
                        onSetCurveEditActive?.(false);
                        updateStyle({
                          curveMode: cm.id,
                          curveAmplitude:
                            cm.id !== 'none' &&
                            Math.abs(style.curveAmplitude) < 5
                              ? 45
                              : style.curveAmplitude,
                        });
                      }
                    }}
                    className={`flex flex-col items-center justify-center gap-1 rounded-xl border py-2 px-0.5 text-[10px] font-medium transition ${
                      active
                        ? 'border-cyan-400 bg-cyan-500/20 text-cyan-200'
                        : 'border-white/10 bg-zinc-950/70 text-zinc-300 hover:border-white/25'
                    }`}
                  >
                    <svg viewBox="0 0 24 24" className="h-4 w-4 sm:h-5 sm:w-5">
                      <path
                        d={cm.svgPath}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <span className="truncate max-w-full">{cm.label}</span>
                  </button>
                );
              })}
            </div>

            {style.curveMode === 'custom' ? (
              <div className="space-y-3 border-t border-white/10 pt-2.5">
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => onSetCurveEditActive?.(!curveEditActive)}
                    className={`flex flex-1 h-9 items-center justify-center gap-1.5 rounded-xl border text-xs font-semibold transition active:scale-[0.98] ${
                      curveEditActive
                        ? 'border-cyan-400 bg-cyan-500/20 text-cyan-200'
                        : 'border-white/15 bg-zinc-950 text-zinc-300 hover:border-cyan-400/60'
                    }`}
                  >
                    {curveEditActive ? (
                      <Eye className="h-3.5 w-3.5 text-cyan-400" />
                    ) : (
                      <EyeOff className="h-3.5 w-3.5 text-zinc-500" />
                    )}
                    <span>
                      {curveEditActive
                        ? 'Линия на холсте: ВКЛ'
                        : 'Показать линию на холсте'}
                    </span>
                  </button>
                </div>

                <p className="rounded-lg border border-cyan-500/25 bg-cyan-500/10 px-2.5 py-2 text-[11px] leading-snug text-cyan-100/90">
                  Нажмите в любом месте на линию поверх текста, чтобы создать точку, и двигайте точки пальцем/мышью. Двойной тап по точке удаляет её.
                </p>

                <div className="grid grid-cols-3 gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      const pts =
                        style.curvePoints.length >= 2
                          ? style.curvePoints
                          : createDefaultCurvePoints(
                              measureBaseTextHalfWidth(
                                selectedClip.text ?? selectedClip.name ?? '',
                                style
                              )
                            );
                      let bestIdx = 0;
                      let bestLen = -1;
                      for (let i = 0; i < pts.length - 1; i++) {
                        const d = Math.hypot(
                          pts[i + 1].x - pts[i].x,
                          pts[i + 1].y - pts[i].y
                        );
                        if (d > bestLen) {
                          bestLen = d;
                          bestIdx = i;
                        }
                      }
                      const a = pts[bestIdx];
                      const b = pts[bestIdx + 1];
                      const newPt: TextCurvePoint = {
                        id: `pt-${Math.random().toString(36).slice(2, 7)}`,
                        x: Math.round(((a.x + b.x) / 2) * 10) / 10,
                        y: Math.round(((a.y + b.y) / 2) * 10) / 10,
                      };
                      const nextPts = [
                        ...pts.slice(0, bestIdx + 1),
                        newPt,
                        ...pts.slice(bestIdx + 1),
                      ];
                      updateStyle({curvePoints: nextPts});
                      onSelectCurvePoint?.(newPt.id);
                      onSetCurveEditActive?.(true);
                    }}
                    className="flex h-8 items-center justify-center gap-1 rounded-lg border border-cyan-500/40 bg-cyan-500/15 px-2 text-[11px] font-semibold text-cyan-200 hover:bg-cyan-500/25"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Точка
                  </button>
                  <button
                    type="button"
                    disabled={style.curvePoints.length <= 2}
                    onClick={() => {
                      if (style.curvePoints.length <= 2) return;
                      const targetId =
                        selectedCurvePointId &&
                        style.curvePoints.some((p) => p.id === selectedCurvePointId)
                          ? selectedCurvePointId
                          : style.curvePoints[style.curvePoints.length - 1]?.id;
                      const idx = style.curvePoints.findIndex(
                        (p) => p.id === targetId
                      );
                      const nextPts = style.curvePoints.filter(
                        (p) => p.id !== targetId
                      );
                      updateStyle({curvePoints: nextPts});
                      onSelectCurvePoint?.(
                        nextPts[Math.max(0, Math.min(nextPts.length - 1, idx))]?.id ??
                          null
                      );
                    }}
                    className="flex h-8 items-center justify-center gap-1 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2 text-[11px] font-medium text-rose-300 hover:border-rose-400 disabled:opacity-35"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Удалить
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const nextPts = createDefaultCurvePoints(
                        measureBaseTextHalfWidth(
                          selectedClip.text ?? selectedClip.name ?? '',
                          style
                        )
                      );
                      updateStyle({curvePoints: nextPts});
                      onSelectCurvePoint?.(nextPts[1]?.id ?? null);
                      onSetCurveEditActive?.(true);
                    }}
                    className="flex h-8 items-center justify-center gap-1 rounded-lg border border-white/10 bg-zinc-950 px-2 text-[11px] font-medium text-zinc-300 hover:border-white/25"
                  >
                    <RotateCcw className="h-3 w-3" />
                    Прямая
                  </button>
                </div>

                {/* Point selector + fine XY adjustment */}
                {style.curvePoints.length >= 2 && (
                  <div className="space-y-2 border-t border-white/10 pt-2">
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="mr-1 text-[10px] font-medium text-zinc-400">
                        Точки ({style.curvePoints.length}):
                      </span>
                      {style.curvePoints.map((pt, idx) => {
                        const active = pt.id === selectedCurvePointId;
                        return (
                          <button
                            key={pt.id}
                            type="button"
                            onClick={() => {
                              onSelectCurvePoint?.(pt.id);
                              onSetCurveEditActive?.(true);
                            }}
                            className={`h-6 min-w-[26px] rounded-md border px-1.5 font-mono text-[10px] font-bold transition ${
                              active
                                ? 'border-amber-400 bg-amber-500/25 text-amber-200'
                                : 'border-white/10 bg-zinc-950 text-zinc-300 hover:border-cyan-400/50'
                            }`}
                          >
                            {idx + 1}
                          </button>
                        );
                      })}
                    </div>

                    {(() => {
                      const activePt =
                        style.curvePoints.find(
                          (p) => p.id === selectedCurvePointId
                        ) ?? style.curvePoints[0];
                      if (!activePt) return null;
                      const updatePointCoords = (
                        nx: number,
                        ny: number,
                        commit: boolean
                      ) => {
                        const nextPts = style.curvePoints.map((p) =>
                          p.id === activePt.id ? {...p, x: nx, y: ny} : p
                        );
                        updateStyle(
                          {curvePoints: nextPts},
                          commit ? undefined : {skipUndo: true, skipSync: true}
                        );
                      };
                      return (
                        <div className="grid grid-cols-2 gap-2">
                          <UnityNumberField
                            label="Точка X"
                            compact
                            accent="amber"
                            value={Math.round(activePt.x)}
                            min={-600}
                            max={600}
                            step={1}
                            decimals={0}
                            ariaLabel="Позиция точки X"
                            onChange={(vx) =>
                              updatePointCoords(vx, activePt.y, false)
                            }
                            onCommit={(vx) =>
                              updatePointCoords(vx, activePt.y, true)
                            }
                          />
                          <UnityNumberField
                            label="Точка Y"
                            compact
                            accent="amber"
                            value={Math.round(activePt.y)}
                            min={-600}
                            max={600}
                            step={1}
                            decimals={0}
                            ariaLabel="Позиция точки Y"
                            onChange={(vy) =>
                              updatePointCoords(activePt.x, vy, false)
                            }
                            onCommit={(vy) =>
                              updatePointCoords(activePt.x, vy, true)
                            }
                          />
                        </div>
                      );
                    })()}
                  </div>
                )}

                <div className="space-y-1.5 border-t border-white/10 pt-2">
                  <UnityNumberField
                    label="Сглаживание линии"
                    compact
                    accent="cyan"
                    value={style.curveSmoothness}
                    min={0}
                    max={100}
                    step={1}
                    decimals={0}
                    suffix="%"
                    ariaLabel="Сглаживание линии"
                    onChange={(v) =>
                      updateStyle(
                        {curveSmoothness: v},
                        {skipUndo: true, skipSync: true}
                      )
                    }
                    onCommit={(v) => updateStyle({curveSmoothness: v})}
                  />
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={style.curveSmoothness}
                    onChange={(e) =>
                      updateStyle(
                        {curveSmoothness: Number(e.target.value)},
                        {skipUndo: true, skipSync: true}
                      )
                    }
                    onPointerUp={(e) =>
                      updateStyle({
                        curveSmoothness: Number(
                          (e.target as HTMLInputElement).value
                        ),
                      })
                    }
                    onTouchEnd={(e) =>
                      updateStyle({
                        curveSmoothness: Number(
                          (e.target as HTMLInputElement).value
                        ),
                      })
                    }
                    className="h-2 w-full cursor-pointer accent-cyan-400"
                  />
                </div>
              </div>
            ) : (
              <>
                <div className="space-y-1.5 border-t border-white/10 pt-2.5">
                  <UnityNumberField
                    label="Сила изгиба / Амплитуда"
                    compact
                    accent="cyan"
                    disabled={style.curveMode === 'none'}
                    value={style.curveAmplitude}
                    min={-100}
                    max={100}
                    step={1}
                    decimals={0}
                    suffix="%"
                    ariaLabel="Сила изгиба / Амплитуда"
                    onChange={(v) =>
                      updateStyle(
                        {curveAmplitude: v},
                        {skipUndo: true, skipSync: true}
                      )
                    }
                    onCommit={(v) => updateStyle({curveAmplitude: v})}
                  />
                  <input
                    type="range"
                    min={-100}
                    max={100}
                    step={1}
                    disabled={style.curveMode === 'none'}
                    value={style.curveAmplitude}
                    onChange={(e) =>
                      updateStyle(
                        {curveAmplitude: Number(e.target.value)},
                        {skipUndo: true, skipSync: true}
                      )
                    }
                    onPointerUp={(e) =>
                      updateStyle({
                        curveAmplitude: Number(
                          (e.target as HTMLInputElement).value
                        ),
                      })
                    }
                    onTouchEnd={(e) =>
                      updateStyle({
                        curveAmplitude: Number(
                          (e.target as HTMLInputElement).value
                        ),
                      })
                    }
                    className="h-2 w-full cursor-pointer accent-cyan-400 disabled:opacity-40"
                  />
                  {style.curveMode === 'arc' && (
                    <p className="text-[10px] text-zinc-400">
                      Положительные значения изгибают дугой вверх, отрицательные
                      — вниз.
                    </p>
                  )}
                </div>

                <div className="space-y-1.5 border-t border-white/10 pt-2.5">
                  <UnityNumberField
                    label="Частота (волна / зигзаг)"
                    compact
                    accent="cyan"
                    disabled={
                      style.curveMode !== 'wave' && style.curveMode !== 'zigzag'
                    }
                    value={style.curveFrequency}
                    min={0.5}
                    max={8.0}
                    step={0.1}
                    decimals={1}
                    suffix="x"
                    ariaLabel="Частота кривой"
                    onChange={(v) =>
                      updateStyle(
                        {curveFrequency: v},
                        {skipUndo: true, skipSync: true}
                      )
                    }
                    onCommit={(v) => updateStyle({curveFrequency: v})}
                  />
                  <input
                    type="range"
                    min={0.5}
                    max={8}
                    step={0.1}
                    disabled={
                      style.curveMode !== 'wave' && style.curveMode !== 'zigzag'
                    }
                    value={style.curveFrequency}
                    onChange={(e) =>
                      updateStyle(
                        {curveFrequency: Number(e.target.value)},
                        {skipUndo: true, skipSync: true}
                      )
                    }
                    onPointerUp={(e) =>
                      updateStyle({
                        curveFrequency: Number(
                          (e.target as HTMLInputElement).value
                        ),
                      })
                    }
                    onTouchEnd={(e) =>
                      updateStyle({
                        curveFrequency: Number(
                          (e.target as HTMLInputElement).value
                        ),
                      })
                    }
                    className="h-2 w-full cursor-pointer accent-cyan-400 disabled:opacity-40"
                  />
                </div>

                {style.curveMode !== 'none' && (
                  <button
                    type="button"
                    onClick={() => {
                      const pts = buildPresetCurvePoints(
                        selectedClip.text ?? selectedClip.name ?? '',
                        style
                      );
                      updateStyle({
                        curveMode: 'custom',
                        curvePoints: pts,
                        curveSmoothness: style.curveMode === 'zigzag' ? 0 : 100,
                      });
                      onSelectCurvePoint?.(pts[Math.floor(pts.length / 2)]?.id ?? null);
                      onSetCurveEditActive?.(true);
                    }}
                    className="flex h-9 w-full items-center justify-center gap-1.5 rounded-xl border border-cyan-500/40 bg-cyan-500/10 text-xs font-semibold text-cyan-200 hover:bg-cyan-500/20"
                  >
                    <Spline className="h-3.5 w-3.5" />
                    <span>Преобразовать в линию с точками</span>
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {/* 5. АНИМАЦИЯ (Ввод / Вывод) */}
        {subTab === 'anim' && (() => {
          const isIn = animPhase === 'in';
          const currentAnimType: TextAnimationType = isIn
            ? style.animIn
            : style.animOut;
          const currentAnimDur = isIn
            ? style.animInDuration
            : style.animOutDuration;
          const inOpt = TEXT_ANIMATION_OPTIONS.find((o) => o.id === style.animIn);
          const outOpt = TEXT_ANIMATION_OPTIONS.find((o) => o.id === style.animOut);

          const setPhaseType = (nextType: TextAnimationType) => {
            if (isIn) {
              updateStyle({animIn: nextType});
            } else {
              updateStyle({animOut: nextType});
            }
          };

          const setPhaseDuration = (
            nextDur: number,
            opts?: {skipUndo?: boolean; skipSync?: boolean}
          ) => {
            const clamped = Math.max(
              0.1,
              Math.min(3.0, Math.round(nextDur * 10) / 10)
            );
            if (isIn) {
              updateStyle({animInDuration: clamped}, opts);
            } else {
              updateStyle({animOutDuration: clamped}, opts);
            }
          };

          return (
            <div className="space-y-3 rounded-xl border border-white/10 bg-zinc-900/50 p-3">
              {/* Sub-tabs: Ввод (In) | Вывод (Out) */}
              <div className="grid grid-cols-2 gap-1.5 rounded-xl border border-white/10 bg-zinc-950 p-1">
                <button
                  type="button"
                  onClick={() => setAnimPhase('in')}
                  className={`flex flex-col items-center justify-center rounded-lg px-2 py-1.5 transition ${
                    isIn
                      ? 'bg-cyan-500/20 text-cyan-200 ring-1 ring-cyan-400/60'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  <span className="text-[11px] font-bold">Ввод (In)</span>
                  <span className="max-w-full truncate text-[9px] opacity-80">
                    {style.animIn === 'none'
                      ? 'Нет'
                      : `${inOpt?.label ?? ''} · ${style.animInDuration.toFixed(1)}с`}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setAnimPhase('out')}
                  className={`flex flex-col items-center justify-center rounded-lg px-2 py-1.5 transition ${
                    !isIn
                      ? 'bg-violet-500/20 text-violet-200 ring-1 ring-violet-400/60'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  <span className="text-[11px] font-bold">Вывод (Out)</span>
                  <span className="max-w-full truncate text-[9px] opacity-80">
                    {style.animOut === 'none'
                      ? 'Нет'
                      : `${outOpt?.label ?? ''} · ${style.animOutDuration.toFixed(1)}с`}
                  </span>
                </button>
              </div>

              {/* Duration Slider + UnityNumberField */}
              <div className="space-y-1.5 rounded-xl border border-white/10 bg-zinc-950/70 p-2.5">
                <UnityNumberField
                  label={isIn ? 'Длительность ввода' : 'Длительность вывода'}
                  compact
                  accent={isIn ? 'cyan' : 'indigo'}
                  disabled={currentAnimType === 'none'}
                  value={currentAnimDur}
                  min={0.1}
                  max={3.0}
                  step={0.1}
                  decimals={1}
                  suffix="с"
                  ariaLabel={
                    isIn
                      ? 'Длительность анимации ввода'
                      : 'Длительность анимации вывода'
                  }
                  onChange={(v) =>
                    setPhaseDuration(v, {skipUndo: true, skipSync: true})
                  }
                  onCommit={(v) => setPhaseDuration(v)}
                />
                <input
                  type="range"
                  min={0.1}
                  max={3.0}
                  step={0.1}
                  disabled={currentAnimType === 'none'}
                  value={currentAnimDur}
                  onChange={(e) =>
                    setPhaseDuration(Number(e.target.value), {
                      skipUndo: true,
                      skipSync: true,
                    })
                  }
                  onPointerUp={(e) =>
                    setPhaseDuration(
                      Number((e.target as HTMLInputElement).value)
                    )
                  }
                  onTouchEnd={(e) =>
                    setPhaseDuration(
                      Number((e.target as HTMLInputElement).value)
                    )
                  }
                  className={`h-2 w-full cursor-pointer disabled:opacity-40 ${
                    isIn ? 'accent-cyan-400' : 'accent-violet-400'
                  }`}
                />
                <div className="flex items-center justify-between text-[10px] text-zinc-500">
                  <span>0.1 с</span>
                  <span>
                    Длина клипа: {selectedClip.duration.toFixed(1)} с
                  </span>
                  <span>3.0 с</span>
                </div>
              </div>

              {/* Animation Presets Grid */}
              <div className="grid grid-cols-2 gap-1.5">
                {TEXT_ANIMATION_OPTIONS.map((opt) => {
                  const active = currentAnimType === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setPhaseType(opt.id)}
                      className={`flex flex-col items-start rounded-xl border px-2.5 py-2 text-left transition active:scale-[0.98] ${
                        active
                          ? isIn
                            ? 'border-cyan-400 bg-cyan-500/20 text-cyan-100'
                            : 'border-violet-400 bg-violet-500/20 text-violet-100'
                          : 'border-white/10 bg-zinc-950/70 text-zinc-200 hover:border-white/25'
                      }`}
                    >
                      <div className="flex w-full items-center justify-between gap-1">
                        <span className="truncate text-[11px] font-semibold">
                          {opt.label}
                        </span>
                        {opt.id !== 'none' && (
                          <Sparkles
                            className={`h-3 w-3 shrink-0 ${
                              active
                                ? isIn
                                  ? 'text-cyan-300'
                                  : 'text-violet-300'
                                : 'text-zinc-500'
                            }`}
                          />
                        )}
                      </div>
                      <span className="mt-0.5 truncate text-[9px] text-zinc-400">
                        {opt.desc}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })()}
      </div>

      {/* Bottom Settings Tabs (Шрифт · Стиль · Отступы · Кривая · Анимация) */}
      <div className="mt-auto grid shrink-0 grid-cols-5 gap-1 border-t border-white/10 bg-[#111116] pt-2">
        {(
          [
            {id: 'font', label: 'Шрифт'},
            {id: 'style', label: 'Стиль'},
            {id: 'spacing', label: 'Отступы'},
            {id: 'curve', label: 'Кривая'},
            {id: 'anim', label: 'Анимация'},
          ] as const
        ).map((tab) => {
          const active = subTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                setSubTab(tab.id);
                if (tab.id === 'curve' && style.curveMode === 'custom') {
                  onSetCurveEditActive?.(true);
                }
              }}
              className={`flex h-9 items-center justify-center rounded-lg border px-1 text-[10px] font-semibold transition sm:text-[11px] ${
                active
                  ? 'border-cyan-400 bg-cyan-500/20 text-cyan-200'
                  : 'border-white/10 bg-zinc-900 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <span className="truncate">{tab.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
