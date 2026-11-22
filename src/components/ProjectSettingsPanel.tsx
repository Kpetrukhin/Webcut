import React, {useEffect, useState} from 'react';
import {
  Check,
  Droplet,
  ExternalLink,
  KeyRound,
  Monitor,
  Palette,
  Pipette,
  Sparkles,
  Trash2,
  User,
} from 'lucide-react';
import {
  ASPECT_RATIO_PRESETS,
  GRADIENT_BACKGROUND_PRESETS,
  SOLID_BACKGROUND_PRESETS,
} from '../shared/types.ts';
import type {
  AspectRatio,
  CanvasBackground,
  ProjectState,
} from '../shared/types.ts';
import {
  GIPHY_API_KEY,
  getCustomGiphyApiKey,
  getEffectiveGiphyApiKey,
  saveCustomGiphyApiKey,
} from '../lib/giphyApi.ts';
import {ScrubNumberField} from './ScrubNumberField.tsx';

const PROFILE_COLOR_PRESETS = [
  '#22d3ee',
  '#f97316',
  '#a78bfa',
  '#34d399',
  '#fb7185',
  '#facc15',
];

function normalizeHexInput(raw: string): string | null {
  const cleaned = raw.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(cleaned)) {
    return (
      '#' +
      cleaned
        .split('')
        .map((c) => c + c)
        .join('')
        .toLowerCase()
    );
  }
  if (/^[0-9a-fA-F]{6}$/.test(cleaned)) {
    return `#${cleaned.toLowerCase()}`;
  }
  return null;
}

interface ProjectSettingsPanelProps {
  aspectRatio: AspectRatio;
  backgroundColor: string;
  canvasBackground?: CanvasBackground;
  user: {id: string; name: string; color: string};
  bgColorPickerActive: boolean;
  onToggleBgColorPicker: (active: boolean) => void;
  onUpdateProjectMeta: (
    patch: Partial<
      Pick<ProjectState, 'aspectRatio' | 'backgroundColor' | 'canvasBackground'>
    >,
    options?: {skipSync?: boolean}
  ) => void;
  onUpdateProfile: (name: string, color: string) => void;
  onGiphyKeyChanged?: () => void;
  onNotify?: (msg: string) => void;
}

export const ProjectSettingsPanel: React.FC<ProjectSettingsPanelProps> = ({
  aspectRatio,
  backgroundColor,
  canvasBackground,
  user,
  bgColorPickerActive,
  onToggleBgColorPicker,
  onUpdateProjectMeta,
  onUpdateProfile,
  onGiphyKeyChanged,
  onNotify,
}) => {
  const activeBgType: CanvasBackground['type'] =
    canvasBackground?.type ?? 'solid';
  const activeSolidColor =
    canvasBackground?.type === 'solid'
      ? canvasBackground.color
      : backgroundColor || '#09090b';
  const activeGradientColors =
    canvasBackground?.type === 'gradient' ? canvasBackground.colors : null;
  const activeBlurAmount =
    canvasBackground?.type === 'blur'
      ? (canvasBackground.blurAmount ?? 44)
      : 44;

  const [hexDraft, setHexDraft] = useState(activeSolidColor);
  const [nameDraft, setNameDraft] = useState(user.name);
  const [colorDraft, setColorDraft] = useState(user.color);
  const [profileSaved, setProfileSaved] = useState(false);

  const [giphyKeyInput, setGiphyKeyInput] = useState<string>(
    getCustomGiphyApiKey
  );
  const [giphySaved, setGiphySaved] = useState(false);

  useEffect(() => {
    setHexDraft(activeSolidColor);
  }, [activeSolidColor]);

  useEffect(() => {
    setNameDraft(user.name);
    setColorDraft(user.color);
  }, [user.name, user.color]);

  const effectiveGiphyKey = getEffectiveGiphyApiKey();
  const hasEnvKey = Boolean(GIPHY_API_KEY);
  const hasCustomKey = Boolean(giphyKeyInput.trim());

  const applySolidColor = (hex: string) => {
    const clean = normalizeHexInput(hex) || '#09090b';
    setHexDraft(clean);
    onUpdateProjectMeta({
      backgroundColor: clean,
      canvasBackground: {type: 'solid', color: clean},
    });
  };

  const applyGradient = (preset: {
    label: string;
    colors: [string, string];
    angle: number;
  }) => {
    onToggleBgColorPicker(false);
    onUpdateProjectMeta({
      backgroundColor: preset.colors[0],
      canvasBackground: {
        type: 'gradient',
        colors: preset.colors,
        angle: preset.angle,
        label: preset.label,
      },
    });
  };

  const applyBlurBackground = (blurAmount = activeBlurAmount) => {
    onToggleBgColorPicker(false);
    onUpdateProjectMeta({
      canvasBackground: {
        type: 'blur',
        blurAmount,
      },
    });
  };

  const handleHexChange = (value: string) => {
    setHexDraft(value);
    const parsed = normalizeHexInput(value);
    if (parsed) {
      onUpdateProjectMeta({
        backgroundColor: parsed,
        canvasBackground: {type: 'solid', color: parsed},
      });
    }
  };

  const handleSaveProfile = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = nameDraft.trim().slice(0, 24) || 'Монтажёр';
    setNameDraft(cleaned);
    onUpdateProfile(cleaned, colorDraft);
    setProfileSaved(true);
    onNotify?.(`Профиль обновлён: ${cleaned}`);
    setTimeout(() => setProfileSaved(false), 1500);
  };

  const handleSaveGiphyKey = (e: React.FormEvent) => {
    e.preventDefault();
    saveCustomGiphyApiKey(giphyKeyInput);
    onGiphyKeyChanged?.();
    setGiphySaved(true);
    onNotify?.('Ключ Giphy API сохранён');
    setTimeout(() => setGiphySaved(false), 1500);
  };

  const handleClearGiphyKey = () => {
    setGiphyKeyInput('');
    saveCustomGiphyApiKey('');
    onGiphyKeyChanged?.();
    onNotify?.('Пользовательский ключ Giphy удалён');
  };

  const activePresetMeta =
    ASPECT_RATIO_PRESETS.find((p) => p.id === aspectRatio) ??
    ASPECT_RATIO_PRESETS[0];

  return (
    <div className="space-y-4 pb-2">
      {/* 1. Aspect Ratio */}
      <section className="space-y-2.5 rounded-2xl border border-white/10 bg-zinc-900/60 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Monitor className="h-4 w-4 text-cyan-400" />
            <span className="text-xs font-semibold text-white">
              Соотношение сторон
            </span>
          </div>
          <span className="rounded-md bg-cyan-500/15 px-2 py-0.5 font-mono text-[10px] font-semibold text-cyan-300">
            {activePresetMeta.width}×{activePresetMeta.height}
          </span>
        </div>

        <div className="grid grid-cols-3 gap-2">
          {ASPECT_RATIO_PRESETS.map((opt) => {
            const isSelected = aspectRatio === opt.id;
            const maxFrame = 28;
            const ratio = opt.width / opt.height;
            const frameW =
              ratio >= 1 ? maxFrame : Math.max(10, Math.round(maxFrame * ratio));
            const frameH =
              ratio >= 1 ? Math.max(10, Math.round(maxFrame / ratio)) : maxFrame;

            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => {
                  onUpdateProjectMeta({aspectRatio: opt.id});
                  onNotify?.(
                    `Формат холста: ${opt.label} (${opt.width}×${opt.height})`
                  );
                }}
                className={`flex flex-col items-center justify-between rounded-xl border px-2 py-2.5 transition active:scale-95 ${
                  isSelected
                    ? 'border-cyan-400 bg-cyan-500/15 text-cyan-200 shadow-[0_0_16px_rgba(34,211,238,0.16)]'
                    : 'border-white/10 bg-zinc-950/70 text-zinc-300 hover:border-white/25'
                }`}
              >
                <div className="flex h-8 w-8 items-center justify-center">
                  <div
                    style={{width: `${frameW}px`, height: `${frameH}px`}}
                    className={`rounded-[3px] border-2 transition-all ${
                      isSelected
                        ? 'border-cyan-400 bg-cyan-400/20'
                        : 'border-zinc-500 bg-zinc-800/80'
                    }`}
                  />
                </div>
                <span className="mt-1 font-mono text-xs font-bold leading-none">
                  {opt.label}
                </span>
                <span className="mt-0.5 truncate max-w-full text-[9px] text-zinc-400">
                  {opt.hint}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* 2. Canvas Background */}
      <section className="space-y-3 rounded-2xl border border-white/10 bg-zinc-900/60 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Palette className="h-4 w-4 text-violet-400" />
            <span className="text-xs font-semibold text-white">
              Фон холста
            </span>
          </div>
          <span className="text-[10px] text-zinc-400">
            {activeBgType === 'blur'
              ? 'Размытое видео'
              : activeBgType === 'gradient'
                ? 'Градиент'
                : activeSolidColor.toUpperCase()}
          </span>
        </div>

        <div className="grid grid-cols-3 gap-1 rounded-xl border border-white/10 bg-zinc-950 p-1">
          <button
            type="button"
            onClick={() => applySolidColor(activeSolidColor)}
            className={`flex h-9 items-center justify-center gap-1 rounded-lg text-[11px] font-semibold transition ${
              activeBgType === 'solid'
                ? 'bg-cyan-500/20 text-cyan-300'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Droplet className="h-3.5 w-3.5" />
            <span>Цвет</span>
          </button>
          <button
            type="button"
            onClick={() => {
              const first =
                GRADIENT_BACKGROUND_PRESETS.find(
                  (g) =>
                    activeGradientColors &&
                    g.colors[0] === activeGradientColors[0] &&
                    g.colors[1] === activeGradientColors[1]
                ) ?? GRADIENT_BACKGROUND_PRESETS[1];
              applyGradient(first);
            }}
            className={`flex h-9 items-center justify-center gap-1 rounded-lg text-[11px] font-semibold transition ${
              activeBgType === 'gradient'
                ? 'bg-cyan-500/20 text-cyan-300'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Sparkles className="h-3.5 w-3.5" />
            <span>Градиент</span>
          </button>
          <button
            type="button"
            onClick={() => applyBlurBackground(activeBlurAmount)}
            className={`flex h-9 items-center justify-center gap-1 rounded-lg text-[11px] font-semibold transition ${
              activeBgType === 'blur'
                ? 'bg-cyan-500/20 text-cyan-300'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Sparkles className="h-3.5 w-3.5" />
            <span>Размытие</span>
          </button>
        </div>

        {activeBgType === 'solid' && (
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center gap-2">
              {SOLID_BACKGROUND_PRESETS.map((bg) => {
                const active =
                  activeSolidColor.toLowerCase() === bg.toLowerCase();
                return (
                  <button
                    key={bg}
                    type="button"
                    onClick={() => applySolidColor(bg)}
                    style={{backgroundColor: bg}}
                    aria-label={`Выбрать цвет ${bg}`}
                    className={`h-8 w-8 rounded-lg border-2 transition ${
                      active
                        ? 'scale-110 border-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.4)]'
                        : 'border-white/20 hover:border-white/50'
                    }`}
                  />
                );
              })}
              <input
                type="color"
                value={normalizeHexInput(activeSolidColor) ?? '#09090b'}
                onChange={(e) => applySolidColor(e.target.value)}
                aria-label="Системная палитра"
                className="h-8 w-8 cursor-pointer rounded-lg border border-white/20 bg-transparent p-0.5"
              />
            </div>

            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 font-mono text-xs text-zinc-500">
                  HEX
                </span>
                <input
                  type="text"
                  value={hexDraft}
                  onChange={(e) => handleHexChange(e.target.value)}
                  onBlur={() => {
                    const parsed = normalizeHexInput(hexDraft);
                    setHexDraft(parsed ?? activeSolidColor);
                  }}
                  placeholder="#09090b"
                  maxLength={7}
                  spellCheck={false}
                  autoCapitalize="none"
                  className="h-10 w-full rounded-xl border border-white/15 bg-zinc-950 pr-3 pl-11 font-mono text-xs uppercase text-white focus:border-cyan-400 focus:outline-none"
                />
              </div>

              <button
                type="button"
                onClick={() => onToggleBgColorPicker(!bgColorPickerActive)}
                className={`flex h-10 shrink-0 items-center gap-1.5 rounded-xl border px-3 text-xs font-semibold transition active:scale-95 ${
                  bgColorPickerActive
                    ? 'border-cyan-400 bg-cyan-500 text-zinc-950'
                    : 'border-white/15 bg-zinc-950 text-zinc-200 hover:border-cyan-400/60'
                }`}
              >
                <Pipette className="h-3.5 w-3.5" />
                <span>Пипетка</span>
              </button>
            </div>
          </div>
        )}

        {activeBgType === 'gradient' && (
          <div className="grid grid-cols-2 gap-2">
            {GRADIENT_BACKGROUND_PRESETS.map((preset) => {
              const active =
                activeGradientColors &&
                activeGradientColors[0].toLowerCase() ===
                  preset.colors[0].toLowerCase() &&
                activeGradientColors[1].toLowerCase() ===
                  preset.colors[1].toLowerCase();
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => applyGradient(preset)}
                  className={`flex items-center gap-2.5 rounded-xl border p-2 text-left transition active:scale-95 ${
                    active
                      ? 'border-cyan-400 bg-cyan-500/15 text-white'
                      : 'border-white/10 bg-zinc-950/70 text-zinc-300 hover:border-white/25'
                  }`}
                >
                  <span
                    className="h-8 w-8 shrink-0 rounded-lg border border-white/20"
                    style={{
                      backgroundImage: `linear-gradient(${preset.angle}deg, ${preset.colors[0]}, ${preset.colors[1]})`,
                    }}
                  />
                  <span className="truncate text-xs font-medium">
                    {preset.label}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {activeBgType === 'blur' && (
          <div className="space-y-2.5 rounded-xl border border-cyan-500/25 bg-cyan-500/5 p-3">
            <p className="text-[11px] leading-relaxed text-zinc-300">
              Задний план автоматически дублирует активный видеоклип или фото,
              растягивает его на весь кадр и применяет сильное размытие.
            </p>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-zinc-200">
                Сила размытия
              </span>
              <ScrubNumberField
                value={activeBlurAmount}
                onChange={(v) =>
                  applyBlurBackground(Math.max(12, Math.min(90, Math.round(v))))
                }
                min={12}
                max={90}
                step={2}
                suffix="px"
                ariaLabel="Сила размытия фона"
              />
            </div>
          </div>
        )}
      </section>

      {/* 3. Integrations & Network */}
      <section className="space-y-3 rounded-2xl border border-white/10 bg-zinc-900/60 p-3">
        <p className="text-xs font-semibold text-white">Интеграции и Сеть</p>

        {/* Collaborator Username & Color */}
        <form
          onSubmit={handleSaveProfile}
          className="space-y-2 rounded-xl border border-white/10 bg-zinc-950/70 p-2.5"
        >
          <div className="flex items-center gap-1.5">
            <User className="h-3.5 w-3.5 text-cyan-400" />
            <span className="text-xs font-medium text-zinc-200">
              Имя участника в сети и чате
            </span>
          </div>
          <p className="text-[10px] text-zinc-400">
            Отображается в чате команды и на бейдже заблокированных слоёв.
          </p>
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              maxLength={24}
              placeholder="Ваше имя"
              className="h-10 min-w-0 flex-1 rounded-xl border border-white/15 bg-zinc-900 px-3 text-xs text-white focus:border-cyan-400 focus:outline-none"
            />
            <button
              type="submit"
              className="flex h-10 shrink-0 items-center gap-1 rounded-xl bg-cyan-500 px-3 text-xs font-bold text-zinc-950 hover:bg-cyan-400 active:scale-95"
            >
              {profileSaved ? (
                <>
                  <Check className="h-3.5 w-3.5" />
                  <span>ОК</span>
                </>
              ) : (
                <span>Применить</span>
              )}
            </button>
          </div>
          <div className="flex items-center gap-2 pt-0.5">
            <span className="text-[10px] text-zinc-500">Цвет метки:</span>
            {PROFILE_COLOR_PRESETS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => {
                  setColorDraft(c);
                  onUpdateProfile(
                    nameDraft.trim().slice(0, 24) || 'Монтажёр',
                    c
                  );
                }}
                style={{backgroundColor: c}}
                aria-label={`Цвет участника ${c}`}
                className={`h-5 w-5 rounded-full border-2 transition ${
                  colorDraft === c
                    ? 'scale-110 border-white'
                    : 'border-transparent opacity-75 hover:opacity-100'
                }`}
              />
            ))}
          </div>
        </form>

        {/* Giphy API Key */}
        <form
          onSubmit={handleSaveGiphyKey}
          className="space-y-2 rounded-xl border border-white/10 bg-zinc-950/70 p-2.5"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <KeyRound className="h-3.5 w-3.5 text-amber-400" />
              <span className="text-xs font-medium text-zinc-200">
                Ключ Giphy API (стикеры)
              </span>
            </div>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                effectiveGiphyKey
                  ? 'border border-emerald-500/30 bg-emerald-500/15 text-emerald-300'
                  : 'border border-white/10 bg-zinc-800 text-zinc-400'
              }`}
            >
              {hasCustomKey
                ? 'Свой ключ'
                : hasEnvKey
                  ? 'Из .env'
                  : 'Не задан'}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={giphyKeyInput}
              onChange={(e) => setGiphyKeyInput(e.target.value)}
              placeholder={
                hasEnvKey
                  ? 'Переопределить ключ .env...'
                  : 'Вставьте свой Giphy API ключ...'
              }
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="h-10 min-w-0 flex-1 rounded-xl border border-white/15 bg-zinc-900 px-3 font-mono text-xs text-white placeholder:font-sans placeholder:text-zinc-500 focus:border-cyan-400 focus:outline-none"
            />
            {hasCustomKey && (
              <button
                type="button"
                onClick={handleClearGiphyKey}
                title="Очистить ключ Giphy"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-zinc-900 text-zinc-400 hover:border-rose-400/50 hover:text-rose-300"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
            <button
              type="submit"
              className="flex h-10 shrink-0 items-center gap-1 rounded-xl border border-amber-400/40 bg-amber-500/15 px-3 text-xs font-semibold text-amber-200 hover:bg-amber-500/25 active:scale-95"
            >
              {giphySaved ? <Check className="h-3.5 w-3.5" /> : 'Сохранить'}
            </button>
          </div>

          <a
            href="https://developers.giphy.com/dashboard/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[11px] font-medium text-cyan-400 hover:text-cyan-300"
          >
            <span>Получить бесплатный ключ Giphy</span>
            <ExternalLink className="h-3 w-3" />
          </a>
        </form>
      </section>
    </div>
  );
};
