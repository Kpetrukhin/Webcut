import type {
  Clip,
  ColorAdjustments,
  ColorCurves,
  ColorFilterPreset,
  CurvePoint,
} from '../shared/types.ts';

const CUSTOM_PRESETS_STORAGE_KEY = 'cutsync_custom_color_presets';

export function createIdentityCurve(): CurvePoint[] {
  return [
    {x: 0, y: 0},
    {x: 1, y: 1},
  ];
}

export function createIdentityCurves(): ColorCurves {
  return {
    rgb: createIdentityCurve(),
    r: createIdentityCurve(),
    g: createIdentityCurve(),
    b: createIdentityCurve(),
  };
}

export function cloneCurves(curves?: ColorCurves): ColorCurves {
  if (!curves) return createIdentityCurves();
  return {
    rgb: (curves.rgb?.length ? curves.rgb : createIdentityCurve()).map((p) => ({
      x: p.x,
      y: p.y,
    })),
    r: (curves.r?.length ? curves.r : createIdentityCurve()).map((p) => ({
      x: p.x,
      y: p.y,
    })),
    g: (curves.g?.length ? curves.g : createIdentityCurve()).map((p) => ({
      x: p.x,
      y: p.y,
    })),
    b: (curves.b?.length ? curves.b : createIdentityCurve()).map((p) => ({
      x: p.x,
      y: p.y,
    })),
  };
}

export const DEFAULT_COLOR_ADJUSTMENTS: ColorAdjustments = {
  sharpness: 0,
  shadows: 0,
  hue: 0,
  temperature: 0,
  fade: 0,
  grain: 0,
  invert: 0,
  curves: createIdentityCurves(),
};

export const BUILTIN_COLOR_PRESETS: ColorFilterPreset[] = [
  {
    id: 'none',
    name: 'Оригинал',
    isBuiltin: true,
    brightness: 1,
    contrast: 1,
    saturate: 1,
    adjustments: {
      sharpness: 0,
      shadows: 0,
      hue: 0,
      temperature: 0,
      fade: 0,
      grain: 0,
      curves: createIdentityCurves(),
    },
  },
  {
    id: 'bw',
    name: 'Ч/Б',
    isBuiltin: true,
    brightness: 1.02,
    contrast: 1.18,
    saturate: 0,
    adjustments: {
      sharpness: 12,
      shadows: -12,
      hue: 0,
      temperature: 0,
      fade: 8,
      grain: 14,
      curves: {
        rgb: [
          {x: 0, y: 0.02},
          {x: 0.25, y: 0.21},
          {x: 0.75, y: 0.79},
          {x: 1, y: 0.98},
        ],
        r: createIdentityCurve(),
        g: createIdentityCurve(),
        b: createIdentityCurve(),
      },
    },
  },
  {
    id: 'sepia',
    name: 'Сепия',
    isBuiltin: true,
    brightness: 1.02,
    contrast: 1.06,
    saturate: 0.22,
    adjustments: {
      sharpness: 0,
      shadows: 8,
      hue: -4,
      temperature: 52,
      fade: 18,
      grain: 15,
      curves: {
        rgb: createIdentityCurve(),
        r: [
          {x: 0, y: 0.05},
          {x: 0.5, y: 0.57},
          {x: 1, y: 0.97},
        ],
        g: [
          {x: 0, y: 0.01},
          {x: 0.5, y: 0.49},
          {x: 1, y: 0.92},
        ],
        b: [
          {x: 0, y: 0},
          {x: 0.5, y: 0.37},
          {x: 1, y: 0.79},
        ],
      },
    },
  },
  {
    id: 'cool',
    name: 'Холодный',
    isBuiltin: true,
    brightness: 1,
    contrast: 1.08,
    saturate: 0.92,
    adjustments: {
      sharpness: 8,
      shadows: 10,
      hue: 6,
      temperature: -44,
      fade: 6,
      grain: 0,
      curves: {
        rgb: createIdentityCurve(),
        r: [
          {x: 0, y: 0},
          {x: 0.5, y: 0.46},
          {x: 1, y: 0.95},
        ],
        g: createIdentityCurve(),
        b: [
          {x: 0, y: 0.04},
          {x: 0.5, y: 0.56},
          {x: 1, y: 1},
        ],
      },
    },
  },
  {
    id: 'warm',
    name: 'Тёплый',
    isBuiltin: true,
    brightness: 1.04,
    contrast: 1.05,
    saturate: 1.16,
    adjustments: {
      sharpness: 4,
      shadows: 12,
      hue: -4,
      temperature: 38,
      fade: 4,
      grain: 0,
      curves: {
        rgb: createIdentityCurve(),
        r: [
          {x: 0, y: 0.02},
          {x: 0.5, y: 0.54},
          {x: 1, y: 1},
        ],
        g: createIdentityCurve(),
        b: [
          {x: 0, y: 0},
          {x: 0.5, y: 0.45},
          {x: 1, y: 0.92},
        ],
      },
    },
  },
  {
    id: 'cinema',
    name: 'Кино',
    isBuiltin: true,
    brightness: 0.98,
    contrast: 1.16,
    saturate: 0.88,
    adjustments: {
      sharpness: 18,
      shadows: -14,
      hue: 0,
      temperature: -10,
      fade: 14,
      grain: 12,
      curves: {
        rgb: [
          {x: 0, y: 0.04},
          {x: 0.25, y: 0.22},
          {x: 0.75, y: 0.78},
          {x: 1, y: 0.96},
        ],
        r: [
          {x: 0, y: 0},
          {x: 0.25, y: 0.21},
          {x: 0.75, y: 0.79},
          {x: 1, y: 1},
        ],
        g: createIdentityCurve(),
        b: [
          {x: 0, y: 0.05},
          {x: 0.3, y: 0.31},
          {x: 0.75, y: 0.72},
          {x: 1, y: 0.92},
        ],
      },
    },
  },
  {
    id: 'invert',
    name: 'Инверсия',
    isBuiltin: true,
    brightness: 1,
    contrast: 1,
    saturate: 1,
    adjustments: {
      sharpness: 0,
      shadows: 0,
      hue: 0,
      temperature: 0,
      fade: 0,
      grain: 0,
      invert: 100,
      curves: createIdentityCurves(),
    },
  },
];

const LEGACY_PRESET_MAP: Record<string, ColorFilterPreset> = {
  vintage: {
    id: 'vintage',
    name: 'Винтаж',
    isBuiltin: true,
    brightness: 1.04,
    contrast: 0.94,
    saturate: 0.78,
    adjustments: {
      sharpness: 0,
      shadows: 14,
      hue: -4,
      temperature: 26,
      fade: 24,
      grain: 18,
      curves: createIdentityCurves(),
    },
  },
  vivid: {
    id: 'vivid',
    name: 'Яркий',
    isBuiltin: true,
    brightness: 1.03,
    contrast: 1.1,
    saturate: 1.38,
    adjustments: {
      sharpness: 14,
      shadows: 6,
      hue: 0,
      temperature: 6,
      fade: 0,
      grain: 0,
      curves: createIdentityCurves(),
    },
  },
};

export function findBuiltinPreset(id: string): ColorFilterPreset | undefined {
  return (
    BUILTIN_COLOR_PRESETS.find((p) => p.id === id) ?? LEGACY_PRESET_MAP[id]
  );
}

export interface EffectiveColorGrade {
  brightness: number; // 0..2 (default 1)
  contrast: number; // 0..2 (default 1)
  saturate: number; // 0..2 (default 1)
  sharpness: number; // 0..100
  shadows: number; // -100..100
  hue: number; // -180..180
  temperature: number; // -100..100
  fade: number; // 0..100
  grain: number; // 0..100
  invert: number; // 0..100
  curves: ColorCurves;
}

export function getClipEffectiveAdjustments(clip: Clip): EffectiveColorGrade {
  if (clip.colorAdjustments) {
    return {
      brightness: clip.brightness ?? 1,
      contrast: clip.contrast ?? 1,
      saturate: clip.saturate ?? 1,
      sharpness: clip.colorAdjustments.sharpness ?? 0,
      shadows: clip.colorAdjustments.shadows ?? 0,
      hue: clip.colorAdjustments.hue ?? 0,
      temperature: clip.colorAdjustments.temperature ?? 0,
      fade: clip.colorAdjustments.fade ?? 0,
      grain: clip.colorAdjustments.grain ?? 0,
      invert: clip.colorAdjustments.invert ?? 0,
      curves: cloneCurves(clip.colorAdjustments.curves),
    };
  }

  // Fallback for starter / legacy clips that only set clip.filter
  const legacyPreset = clip.filter ? findBuiltinPreset(clip.filter) : undefined;
  if (legacyPreset && legacyPreset.id !== 'none') {
    return {
      brightness: clip.brightness ?? legacyPreset.brightness,
      contrast: clip.contrast ?? legacyPreset.contrast,
      saturate: clip.saturate ?? legacyPreset.saturate,
      sharpness: legacyPreset.adjustments.sharpness,
      shadows: legacyPreset.adjustments.shadows,
      hue: legacyPreset.adjustments.hue,
      temperature: legacyPreset.adjustments.temperature,
      fade: legacyPreset.adjustments.fade,
      grain: legacyPreset.adjustments.grain,
      invert: legacyPreset.adjustments.invert ?? 0,
      curves: cloneCurves(legacyPreset.adjustments.curves),
    };
  }

  return {
    brightness: clip.brightness ?? 1,
    contrast: clip.contrast ?? 1,
    saturate: clip.saturate ?? 1,
    sharpness: 0,
    shadows: 0,
    hue: 0,
    temperature: 0,
    fade: 0,
    grain: 0,
    invert: 0,
    curves: createIdentityCurves(),
  };
}

export function isIdentityCurve(pts: CurvePoint[]): boolean {
  if (!pts || pts.length !== 2) return false;
  return (
    Math.abs(pts[0].x) < 0.002 &&
    Math.abs(pts[0].y) < 0.002 &&
    Math.abs(pts[1].x - 1) < 0.002 &&
    Math.abs(pts[1].y - 1) < 0.002
  );
}

export function isNeutralColorGrade(g: EffectiveColorGrade): boolean {
  return (
    Math.abs(g.brightness - 1) < 0.004 &&
    Math.abs(g.contrast - 1) < 0.004 &&
    Math.abs(g.saturate - 1) < 0.004 &&
    Math.abs(g.sharpness) < 0.4 &&
    Math.abs(g.shadows) < 0.4 &&
    Math.abs(g.hue) < 0.4 &&
    Math.abs(g.temperature) < 0.4 &&
    Math.abs(g.fade) < 0.4 &&
    Math.abs(g.grain) < 0.4 &&
    Math.abs(g.invert) < 0.4 &&
    isIdentityCurve(g.curves.rgb) &&
    isIdentityCurve(g.curves.r) &&
    isIdentityCurve(g.curves.g) &&
    isIdentityCurve(g.curves.b)
  );
}

export function applyFilterPresetToClipPatch(
  preset: ColorFilterPreset
): Partial<Clip> {
  return {
    filter: preset.id,
    brightness: preset.brightness,
    contrast: preset.contrast,
    saturate: preset.saturate,
    colorAdjustments: {
      sharpness: preset.adjustments.sharpness,
      shadows: preset.adjustments.shadows,
      hue: preset.adjustments.hue,
      temperature: preset.adjustments.temperature,
      fade: preset.adjustments.fade,
      grain: preset.adjustments.grain,
      invert: preset.adjustments.invert ?? 0,
      curves: cloneCurves(preset.adjustments.curves),
    },
  };
}

export function getCustomColorPresets(): ColorFilterPreset[] {
  try {
    const raw = localStorage.getItem(CUSTOM_PRESETS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ColorFilterPreset[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p) => p && typeof p.id === 'string' && p.name);
  } catch {
    return [];
  }
}

export function saveCustomColorPreset(
  name: string,
  grade: EffectiveColorGrade
): ColorFilterPreset[] {
  const cleanName = name.trim().slice(0, 32) || 'Мой фильтр';
  const preset: ColorFilterPreset = {
    id: `custom:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: cleanName,
    isBuiltin: false,
    brightness: grade.brightness,
    contrast: grade.contrast,
    saturate: grade.saturate,
    adjustments: {
      sharpness: grade.sharpness,
      shadows: grade.shadows,
      hue: grade.hue,
      temperature: grade.temperature,
      fade: grade.fade,
      grain: grade.grain,
      invert: grade.invert,
      curves: cloneCurves(grade.curves),
    },
    createdAt: Date.now(),
  };

  const current = getCustomColorPresets();
  const next = [preset, ...current].slice(0, 50);
  try {
    localStorage.setItem(CUSTOM_PRESETS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore storage quota errors
  }
  return next;
}

export function deleteCustomColorPreset(id: string): ColorFilterPreset[] {
  const next = getCustomColorPresets().filter((p) => p.id !== id);
  try {
    localStorage.setItem(CUSTOM_PRESETS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
  return next;
}

/**
 * Monotone cubic Hermite spline interpolation (Fritsch-Carlson) for smooth,
 * overshoot-free tone curves.
 */
export function createSplineEvaluator(
  rawPoints: CurvePoint[]
): (x: number) => number {
  const pts = [...(rawPoints?.length ? rawPoints : createIdentityCurve())]
    .map((p) => ({
      x: Math.max(0, Math.min(1, p.x)),
      y: Math.max(0, Math.min(1, p.y)),
    }))
    .sort((a, b) => a.x - b.x);

  // Deduplicate very close x values
  const sorted: CurvePoint[] = [];
  for (const p of pts) {
    if (
      sorted.length === 0 ||
      p.x - sorted[sorted.length - 1].x >= 0.002
    ) {
      sorted.push(p);
    } else {
      sorted[sorted.length - 1] = p;
    }
  }

  if (sorted.length === 0) return (x) => x;
  if (sorted.length === 1) return () => sorted[0].y;

  const n = sorted.length;
  const dx: number[] = [];
  const dy: number[] = [];
  const m: number[] = new Array(n).fill(0);

  for (let i = 0; i < n - 1; i++) {
    const h = Math.max(1e-5, sorted[i + 1].x - sorted[i].x);
    dx.push(h);
    dy.push((sorted[i + 1].y - sorted[i].y) / h);
  }

  m[0] = dy[0];
  m[n - 1] = dy[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (dy[i - 1] * dy[i] <= 0) {
      m[i] = 0;
    } else {
      m[i] = (dy[i - 1] + dy[i]) * 0.5;
    }
  }

  // Enforce monotonicity
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(dy[i]) < 1e-6) {
      m[i] = 0;
      m[i + 1] = 0;
    } else {
      const a = m[i] / dy[i];
      const b = m[i + 1] / dy[i];
      const s = a * a + b * b;
      if (s > 9) {
        const tau = 3 / Math.sqrt(s);
        m[i] = tau * a * dy[i];
        m[i + 1] = tau * b * dy[i];
      }
    }
  }

  return (x: number): number => {
    const clampedX = Math.max(0, Math.min(1, x));
    if (clampedX <= sorted[0].x) return sorted[0].y;
    if (clampedX >= sorted[n - 1].x) return sorted[n - 1].y;

    let seg = 0;
    for (let i = 0; i < n - 1; i++) {
      if (clampedX >= sorted[i].x && clampedX <= sorted[i + 1].x) {
        seg = i;
        break;
      }
    }

    const h = dx[seg];
    const t = (clampedX - sorted[seg].x) / h;
    const t2 = t * t;
    const t3 = t2 * t;

    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;

    const val =
      h00 * sorted[seg].y +
      h10 * h * m[seg] +
      h01 * sorted[seg + 1].y +
      h11 * h * m[seg + 1];
    return Math.max(0, Math.min(1, val));
  };
}

export function evaluateCurve256(points: CurvePoint[]): Uint8Array {
  const lut = new Uint8Array(256);
  const evalFn = createSplineEvaluator(points);
  for (let i = 0; i < 256; i++) {
    lut[i] = Math.round(evalFn(i / 255) * 255);
  }
  return lut;
}

/**
 * Builds a 256x1 RGBA LUT where:
 *   R(v) = R_curve(RGB_curve(v))
 *   G(v) = G_curve(RGB_curve(v))
 *   B(v) = B_curve(RGB_curve(v))
 */
export function buildRgbaCurveLut(curves?: ColorCurves): Uint8Array {
  const c = curves ?? createIdentityCurves();
  const evalRgb = createSplineEvaluator(c.rgb);
  const evalR = createSplineEvaluator(c.r);
  const evalG = createSplineEvaluator(c.g);
  const evalB = createSplineEvaluator(c.b);

  const rgba = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const master = evalRgb(i / 255);
    rgba[i * 4] = Math.round(evalR(master) * 255);
    rgba[i * 4 + 1] = Math.round(evalG(master) * 255);
    rgba[i * 4 + 2] = Math.round(evalB(master) * 255);
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

/**
 * Generates an approximate CSS filter string for lightweight preset thumbnail previews.
 */
export function buildCssFilterPreview(preset: ColorFilterPreset): string {
  const parts: string[] = [];
  if (preset.brightness !== 1) parts.push(`brightness(${preset.brightness})`);
  if (preset.contrast !== 1) parts.push(`contrast(${preset.contrast})`);
  if (preset.saturate !== 1) parts.push(`saturate(${preset.saturate})`);
  if (preset.adjustments.hue !== 0) {
    parts.push(`hue-rotate(${preset.adjustments.hue}deg)`);
  }
  if (preset.adjustments.temperature > 15) {
    parts.push(
      `sepia(${Math.min(0.85, preset.adjustments.temperature / 100).toFixed(2)})`
    );
  }
  if ((preset.adjustments.invert ?? 0) > 1) {
    parts.push(
      `invert(${Math.min(1, (preset.adjustments.invert ?? 0) / 100).toFixed(2)})`
    );
  }
  return parts.length > 0 ? parts.join(' ') : 'none';
}
