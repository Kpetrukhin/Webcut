import type {
  Clip,
  Collaborator,
  TextAnimationType,
  TextBgMode,
  TextCurveMode,
  TextCurvePoint,
  TextStyle,
} from '../shared/types.ts';
import {applyColorGradeShader} from './colorGradeShader.ts';
import {
  getClipEffectiveAdjustments,
  isNeutralColorGrade,
} from './colorPresets.ts';
import {loadCustomFont} from './fontLoader.ts';
import {evaluateClipTransform} from './keyframeEngine.ts';
import {applyMaskToCanvas} from './maskEngine.ts';
import {
  getWarpedOutlinePolygon,
  isIdentityWarp,
  pointInPolygon,
  renderWarpedLayer,
} from './warpEngine.ts';

export interface NormalizedTextStyle {
  fontSize: number;
  color: string;
  bgColor: string;
  bgMode: TextBgMode;
  bgOpacity: number;
  fontWeight: 'normal' | 'bold';
  fontStyle: 'normal' | 'italic';
  underline: boolean;
  fontFamily: string;
  fontSrc?: string;
  shadow: boolean;
  shadowColor: string;
  shadowOffsetX: number;
  shadowOffsetY: number;
  shadowBlur: number;
  strokeColor: string;
  strokeWidth: number;
  letterSpacing: number;
  lineHeight: number;
  spaceWidth: number;
  curveMode: TextCurveMode;
  curveAmplitude: number;
  curveFrequency: number;
  curvePoints: TextCurvePoint[];
  curveSmoothness: number;
  animIn: TextAnimationType;
  animInDuration: number;
  animOut: TextAnimationType;
  animOutDuration: number;
  x: number;
  y: number;
  align: 'left' | 'center' | 'right';
}

export function parseRgbaParts(color: string): {
  r: number;
  g: number;
  b: number;
  a: number;
} | null {
  const c = (color || '').trim();
  if (!c || c === 'transparent') return null;

  if (c.startsWith('#')) {
    const hex = c.slice(1);
    if (hex.length === 3) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      if ([r, g, b].every(Number.isFinite)) return {r, g, b, a: 1};
    } else if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      if ([r, g, b, a].every(Number.isFinite)) return {r, g, b, a};
    }
  }

  const m = c.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i
  );
  if (m) {
    return {
      r: Math.max(0, Math.min(255, Math.round(Number(m[1])))),
      g: Math.max(0, Math.min(255, Math.round(Number(m[2])))),
      b: Math.max(0, Math.min(255, Math.round(Number(m[3])))),
      a: m[4] !== undefined ? Math.max(0, Math.min(1, Number(m[4]))) : 1,
    };
  }
  return null;
}

export function colorToHex(color: string, fallback = '#09090b'): string {
  const parts = parseRgbaParts(color);
  if (!parts) return fallback;
  const toH = (n: number) => n.toString(16).padStart(2, '0');
  return `#${toH(parts.r)}${toH(parts.g)}${toH(parts.b)}`;
}

export function colorWithOpacity(color: string, opacity: number): string {
  const parts = parseRgbaParts(color);
  if (!parts) return 'transparent';
  const a = Math.max(0, Math.min(1, opacity));
  return `rgba(${parts.r}, ${parts.g}, ${parts.b}, ${a.toFixed(3)})`;
}

export function normalizeTextStyle(
  raw?: Partial<TextStyle>
): NormalizedTextStyle {
  const bgRaw = raw?.bgColor ?? 'rgba(9, 9, 11, 0.72)';
  const parsedBg = parseRgbaParts(bgRaw);
  const inferredMode: TextBgMode = raw?.bgMode
    ? raw.bgMode
    : !bgRaw || bgRaw === 'transparent'
      ? 'none'
      : 'block';
  const inferredBgOpacity =
    raw?.bgOpacity !== undefined
      ? Math.max(0, Math.min(1, raw.bgOpacity))
      : parsedBg
        ? parsedBg.a
        : 0.75;

  const strokeWidth =
    raw?.strokeWidth !== undefined
      ? Math.max(0, raw.strokeWidth)
      : raw?.outline
        ? 4
        : 0;

  return {
    fontSize: raw?.fontSize ?? 48,
    color: raw?.color ?? '#ffffff',
    bgColor: bgRaw === 'transparent' ? '#09090b' : colorToHex(bgRaw, '#09090b'),
    bgMode: inferredMode,
    bgOpacity: inferredBgOpacity,
    fontWeight: raw?.fontWeight ?? 'bold',
    fontStyle: raw?.fontStyle ?? 'normal',
    underline: Boolean(raw?.underline),
    fontFamily: raw?.fontFamily || 'Plus Jakarta Sans',
    fontSrc: raw?.fontSrc,
    shadow: raw?.shadow !== false,
    shadowColor: raw?.shadowColor || '#000000',
    shadowOffsetX: raw?.shadowOffsetX ?? 0,
    shadowOffsetY: raw?.shadowOffsetY ?? 4,
    shadowBlur: raw?.shadowBlur ?? 10,
    strokeColor: raw?.strokeColor || '#09090b',
    strokeWidth,
    letterSpacing: raw?.letterSpacing ?? 0,
    lineHeight: raw?.lineHeight ?? 1.25,
    spaceWidth: raw?.spaceWidth ?? 1.0,
    curveMode: raw?.curveMode ?? 'none',
    curveAmplitude: raw?.curveAmplitude ?? 0,
    curveFrequency: raw?.curveFrequency ?? 2,
    curvePoints: Array.isArray(raw?.curvePoints) ? raw.curvePoints : [],
    curveSmoothness:
      raw?.curveSmoothness !== undefined
        ? Math.max(0, Math.min(100, raw.curveSmoothness))
        : 100,
    animIn: raw?.animIn ?? 'none',
    animInDuration:
      raw?.animInDuration !== undefined && Number.isFinite(raw.animInDuration)
        ? Math.max(0.1, Math.min(3.0, raw.animInDuration))
        : 0.5,
    animOut: raw?.animOut ?? 'none',
    animOutDuration:
      raw?.animOutDuration !== undefined && Number.isFinite(raw.animOutDuration)
        ? Math.max(0.1, Math.min(3.0, raw.animOutDuration))
        : 0.5,
    x: raw?.x ?? 0.5,
    y: raw?.y ?? 0.76,
    align: raw?.align ?? 'center',
  };
}

function mapLegacyTransitionToTextAnim(
  t: Clip['transitionIn'] | Clip['transitionOut'] | undefined,
  phase: 'in' | 'out'
): TextAnimationType {
  if (t === 'fade') return 'fade';
  if (t === 'zoom') return 'scale-pop';
  if (t === 'slide') return phase === 'in' ? 'slide-left' : 'slide-right';
  return 'none';
}

export function getTextAnimationSpec(clip: Clip): {
  inType: TextAnimationType;
  outType: TextAnimationType;
  inDuration: number;
  outDuration: number;
} {
  const style = normalizeTextStyle(clip.textStyle);
  const inType =
    style.animIn !== 'none'
      ? style.animIn
      : mapLegacyTransitionToTextAnim(clip.transitionIn, 'in');
  const outType =
    style.animOut !== 'none'
      ? style.animOut
      : mapLegacyTransitionToTextAnim(clip.transitionOut, 'out');

  const rawIn = inType !== 'none' ? style.animInDuration : 0;
  const rawOut = outType !== 'none' ? style.animOutDuration : 0;
  const dur = Math.max(0.1, clip.duration || 0.1);
  const sum = rawIn + rawOut;
  const factor = sum > dur && sum > 0.001 ? dur / sum : 1;

  return {
    inType,
    outType,
    inDuration: rawIn * factor,
    outDuration: rawOut * factor,
  };
}

function easeOutCubic(t: number): number {
  const u = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - u, 3);
}

function easeInCubic(t: number): number {
  const u = Math.max(0, Math.min(1, t));
  return u * u * u;
}

function easeOutBack(t: number): number {
  const u = Math.max(0, Math.min(1, t));
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(u - 1, 3) + c1 * Math.pow(u - 1, 2);
}

export interface EvaluatedTextAnimation {
  alphaMul: number;
  scaleMul: number;
  offsetX: number;
  offsetY: number;
  rotDeg: number;
  blurPx: number;
  typewriterRatio: number; // 0..1
}

export function evaluateTextClipAnimation(
  clip: Clip,
  time: number,
  sf: number
): EvaluatedTextAnimation {
  const spec = getTextAnimationSpec(clip);
  const elapsed = Math.max(0, time - clip.start);
  const remaining = Math.max(0, clip.start + clip.duration - time);

  let alphaMul = 1;
  let scaleMul = 1;
  let offsetX = 0;
  let offsetY = 0;
  let rotDeg = 0;
  let blurPx = 0;
  let typewriterRatio = 1;

  if (spec.inType !== 'none' && spec.inDuration > 0.005 && elapsed < spec.inDuration) {
    const p = Math.max(0, Math.min(1, elapsed / spec.inDuration));
    const e = easeOutCubic(p);
    switch (spec.inType) {
      case 'fade':
        alphaMul *= e;
        break;
      case 'slide-up':
        offsetY += (1 - e) * 95 * sf;
        alphaMul *= Math.min(1, p * 3.5);
        break;
      case 'slide-left':
        offsetX -= (1 - e) * 180 * sf;
        alphaMul *= Math.min(1, p * 3.5);
        break;
      case 'slide-right':
        offsetX += (1 - e) * 180 * sf;
        alphaMul *= Math.min(1, p * 3.5);
        break;
      case 'scale-pop':
        scaleMul *= Math.max(0.05, 0.25 + 0.75 * easeOutBack(p));
        alphaMul *= Math.min(1, p * 4);
        break;
      case 'typewriter':
        typewriterRatio = Math.min(typewriterRatio, p);
        break;
      case 'blur-spin':
        alphaMul *= e;
        scaleMul *= 0.65 + 0.35 * e;
        rotDeg += (1 - e) * -32;
        blurPx += (1 - e) * 16 * sf;
        break;
    }
  }

  if (spec.outType !== 'none' && spec.outDuration > 0.005 && remaining < spec.outDuration) {
    const p = Math.max(0, Math.min(1, remaining / spec.outDuration)); // 1 -> 0 as exiting
    const outProgress = 1 - p; // 0 -> 1 as exiting
    const eOut = easeInCubic(outProgress);
    switch (spec.outType) {
      case 'fade':
        alphaMul *= easeOutCubic(p);
        break;
      case 'slide-up':
        offsetY += eOut * 95 * sf;
        alphaMul *= Math.min(1, p * 3.5);
        break;
      case 'slide-left':
        offsetX -= eOut * 180 * sf;
        alphaMul *= Math.min(1, p * 3.5);
        break;
      case 'slide-right':
        offsetX += eOut * 180 * sf;
        alphaMul *= Math.min(1, p * 3.5);
        break;
      case 'scale-pop':
        scaleMul *= Math.max(0.05, 1 - eOut * 0.85);
        alphaMul *= Math.min(1, p * 3.5);
        break;
      case 'typewriter':
        typewriterRatio = Math.min(typewriterRatio, p);
        break;
      case 'blur-spin':
        alphaMul *= easeOutCubic(p);
        scaleMul *= 1 - eOut * 0.35;
        rotDeg += eOut * 32;
        blurPx += eOut * 16 * sf;
        break;
    }
  }

  return {
    alphaMul,
    scaleMul,
    offsetX,
    offsetY,
    rotDeg,
    blurPx,
    typewriterRatio,
  };
}

export function createDefaultCurvePoints(halfSpan = 160): TextCurvePoint[] {
  const h = Math.max(60, Math.round(halfSpan));
  return [
    {id: `pt-${Math.random().toString(36).slice(2, 7)}`, x: -h, y: 0},
    {id: `pt-${Math.random().toString(36).slice(2, 7)}`, x: 0, y: 0},
    {id: `pt-${Math.random().toString(36).slice(2, 7)}`, x: h, y: 0},
  ];
}

export function measureBaseTextHalfWidth(
  text: string,
  rawStyle?: Partial<TextStyle>
): number {
  const style = normalizeTextStyle(rawStyle);
  const canvas =
    typeof document !== 'undefined' ? document.createElement('canvas') : null;
  const ctx = canvas?.getContext('2d');
  if (!ctx) {
    return Math.max(90, Math.min(280, (text?.length || 6) * style.fontSize * 0.3));
  }
  ctx.font = buildCanvasFontString(style, style.fontSize);
  const baseSpaceW = Math.max(2, ctx.measureText(' ').width);
  const spaceMultiplier = Math.max(0.15, style.spaceWidth);
  const lines = (text || ' ').split('\n');
  let maxW = 0;
  for (const line of lines) {
    const chars = Array.from(line);
    let lw = 0;
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const w =
        ch === ' ' || ch === '\t'
          ? baseSpaceW * spaceMultiplier
          : Math.max(1, ctx.measureText(ch).width);
      lw += w + (i < chars.length - 1 ? style.letterSpacing : 0);
    }
    maxW = Math.max(maxW, lw);
  }
  return Math.max(80, Math.round(maxW / 2));
}

export function buildPresetCurvePoints(
  text: string,
  rawStyle?: Partial<TextStyle>
): TextCurvePoint[] {
  const style = normalizeTextStyle(rawStyle);
  const halfW = measureBaseTextHalfWidth(text, rawStyle);
  const mode = style.curveMode;
  const amp = style.curveAmplitude;
  const freq = Math.max(0.25, style.curveFrequency);

  if (
    mode === 'none' ||
    mode === 'custom' ||
    Math.abs(amp) < 2
  ) {
    return createDefaultCurvePoints(halfW);
  }

  const lineW = halfW * 2;
  const count = mode === 'arc' ? 3 : 5;
  const pts: TextCurvePoint[] = [];

  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const s = (t - 0.5) * lineW;
    let px = s;
    let py = 0;

    if (mode === 'arc') {
      const strength = Math.max(-1, Math.min(1, amp / 100));
      const maxAngle = Math.max(0.02, Math.abs(strength) * Math.PI * 1.15);
      const arcLen = Math.max(lineW, style.fontSize * 2.2);
      const radius = arcLen / maxAngle;
      const theta = s / radius;
      px = radius * Math.sin(theta);
      py =
        strength > 0
          ? radius * (1 - Math.cos(theta)) - radius * (1 - Math.cos(maxAngle * 0.5)) * 0.5
          : -radius * (1 - Math.cos(theta)) + radius * (1 - Math.cos(maxAngle * 0.5)) * 0.5;
    } else if (mode === 'wave') {
      const ampPx = (amp / 100) * style.fontSize * 1.25;
      const span = Math.max(style.fontSize * 4.5, lineW);
      const k = (freq * Math.PI * 2) / span;
      py = -ampPx * Math.sin(s * k);
    } else if (mode === 'zigzag') {
      const ampPx = (amp / 100) * style.fontSize * 1.25;
      const span = Math.max(style.fontSize * 4.5, lineW);
      const u = (s / span) * freq + 0.25;
      const frac = u - Math.floor(u);
      const tri = frac < 0.5 ? 4 * frac - 1 : 3 - 4 * frac;
      py = -ampPx * tri;
    }

    pts.push({
      id: `pt-${Math.random().toString(36).slice(2, 7)}`,
      x: Math.round(px * 10) / 10,
      y: Math.round(py * 10) / 10,
    });
  }

  return pts;
}

export interface SplineSample {
  x: number;
  y: number;
  dist: number;
  segIdx: number;
  u: number;
}

export interface SplineLut {
  samples: SplineSample[];
  totalLen: number;
}

export function buildSplineLut(
  points: Array<{x: number; y: number}>,
  smoothness01 = 1,
  stepsPerSeg = 26
): SplineLut {
  if (points.length === 0) {
    return {samples: [], totalLen: 0};
  }
  if (points.length === 1) {
    return {
      samples: [{x: points[0].x, y: points[0].y, dist: 0, segIdx: 0, u: 0}],
      totalLen: 0,
    };
  }

  const s = Math.max(0, Math.min(1, smoothness01));
  const n = points.length;
  const samples: SplineSample[] = [];
  let totalDist = 0;

  for (let i = 0; i < n - 1; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];
    const p0 =
      i > 0 ? points[i - 1] : {x: 2 * p1.x - p2.x, y: 2 * p1.y - p2.y};
    const p3 =
      i + 2 < n ? points[i + 2] : {x: 2 * p2.x - p1.x, y: 2 * p2.y - p1.y};

    const startStep = i === 0 ? 0 : 1;
    for (let step = startStep; step <= stepsPerSeg; step++) {
      const u = step / stepsPerSeg;
      const u2 = u * u;
      const u3 = u2 * u;

      const cx =
        0.5 *
        (2 * p1.x +
          (-p0.x + p2.x) * u +
          (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * u2 +
          (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * u3);
      const cy =
        0.5 *
        (2 * p1.y +
          (-p0.y + p2.y) * u +
          (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * u2 +
          (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * u3);

      const lx = p1.x + (p2.x - p1.x) * u;
      const ly = p1.y + (p2.y - p1.y) * u;

      const x = lx + (cx - lx) * s;
      const y = ly + (cy - ly) * s;

      if (samples.length > 0) {
        const prev = samples[samples.length - 1];
        totalDist += Math.hypot(x - prev.x, y - prev.y);
      }

      samples.push({x, y, dist: totalDist, segIdx: i, u});
    }
  }

  return {samples, totalLen: totalDist};
}

export function sampleSplineAtArcDist(
  lut: SplineLut,
  dist: number
): {x: number; y: number; angle: number} {
  const {samples, totalLen} = lut;
  if (samples.length === 0) return {x: 0, y: 0, angle: 0};
  if (samples.length === 1 || totalLen < 0.001) {
    return {x: samples[0].x, y: samples[0].y, angle: 0};
  }

  const getSegAngle = (idxA: number, idxB: number) => {
    const a = samples[idxA];
    const b = samples[idxB];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (Math.hypot(dx, dy) < 1e-4) return 0;
    return Math.atan2(dy, dx);
  };

  if (dist <= 0) {
    let nextIdx = 1;
    while (nextIdx < samples.length - 1 && samples[nextIdx].dist < 1) {
      nextIdx++;
    }
    const angle = getSegAngle(0, nextIdx);
    return {
      x: samples[0].x + Math.cos(angle) * dist,
      y: samples[0].y + Math.sin(angle) * dist,
      angle,
    };
  }

  if (dist >= totalLen) {
    const last = samples.length - 1;
    let prevIdx = last - 1;
    while (prevIdx > 0 && totalLen - samples[prevIdx].dist < 1) {
      prevIdx--;
    }
    const angle = getSegAngle(prevIdx, last);
    const extra = dist - totalLen;
    return {
      x: samples[last].x + Math.cos(angle) * extra,
      y: samples[last].y + Math.sin(angle) * extra,
      angle,
    };
  }

  let lo = 0;
  let hi = samples.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].dist <= dist) lo = mid;
    else hi = mid;
  }

  const a = samples[lo];
  const b = samples[hi];
  const segDist = Math.max(1e-5, b.dist - a.dist);
  const t = (dist - a.dist) / segDist;

  // Compute smooth tangent across a small neighborhood
  const tPrev = samples[Math.max(0, lo - 1)];
  const tNext = samples[Math.min(samples.length - 1, hi + 1)];
  const angle = Math.atan2(tNext.y - tPrev.y, tNext.x - tPrev.x);

  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    angle,
  };
}

interface PositionedGlyph {
  ch: string;
  isSpace: boolean;
  w: number;
  advance: number;
  x: number;
  y: number;
  angle: number;
}

interface PositionedLine {
  glyphs: PositionedGlyph[];
  lineW: number;
  lineStartX: number;
  baseY: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface TextLayout {
  style: NormalizedTextStyle;
  fontString: string;
  fontSizePx: number;
  lineHeightPx: number;
  sf: number;
  lines: PositionedLine[];
  boxX: number;
  boxY: number;
  boxW: number;
  boxH: number;
}

export function buildCanvasFontString(
  style: NormalizedTextStyle,
  fontSizePx: number
): string {
  const fStyle = style.fontStyle === 'italic' ? 'italic' : 'normal';
  const fWeight = style.fontWeight === 'bold' ? '700' : '400';
  const family = style.fontFamily
    ? `"${style.fontFamily}", "Plus Jakarta Sans", sans-serif`
    : '"Plus Jakarta Sans", sans-serif';
  return `${fStyle} ${fWeight} ${fontSizePx}px ${family}`;
}

export function computeTextLayout(
  ctx: CanvasRenderingContext2D,
  cw: number,
  text: string,
  rawStyle: Partial<TextStyle> | undefined,
  kfScale: number
): TextLayout {
  const style = normalizeTextStyle(rawStyle);
  const sf = cw / 720;
  const fontSizePx = Math.max(8, Math.round(style.fontSize * sf * kfScale));
  const fontString = buildCanvasFontString(style, fontSizePx);

  ctx.save();
  ctx.font = fontString;

  const rawLines = (text || ' ').split('\n');
  const lineHeightPx = fontSizePx * Math.max(0.5, style.lineHeight);
  const letterSpacingPx = style.letterSpacing * sf * kfScale;
  const baseSpaceW = Math.max(2, ctx.measureText(' ').width);
  const spaceMultiplier = Math.max(0.15, style.spaceWidth);

  const curveMode = style.curveMode;
  const amp = style.curveAmplitude;
  const freq = Math.max(0.25, style.curveFrequency);
  const customLut =
    curveMode === 'custom' && style.curvePoints.length >= 2
      ? buildSplineLut(
          style.curvePoints.map((p) => ({
            x: p.x * sf * kfScale,
            y: p.y * sf * kfScale,
          })),
          style.curveSmoothness / 100
        )
      : null;
  const hasCurve =
    customLut !== null || (curveMode !== 'none' && Math.abs(amp) >= 0.5);

  const positionedLines: PositionedLine[] = [];

  let globalMinX = Infinity;
  let globalMaxX = -Infinity;
  let globalMinY = Infinity;
  let globalMaxY = -Infinity;

  const halfGlyphH = fontSizePx * 0.58;

  for (let li = 0; li < rawLines.length; li++) {
    const chars = Array.from(rawLines[li]);
    const baseY = -((rawLines.length - 1) * lineHeightPx) / 2 + li * lineHeightPx;

    const widths: number[] = [];
    const advances: number[] = [];
    let lineW = 0;

    for (let ci = 0; ci < chars.length; ci++) {
      const ch = chars[ci];
      const isSpace = ch === ' ' || ch === '\t';
      const w = isSpace
        ? baseSpaceW * spaceMultiplier
        : Math.max(1, ctx.measureText(ch).width);
      widths.push(w);
      const adv = ci < chars.length - 1 ? w + letterSpacingPx : w;
      advances.push(adv);
      lineW += adv;
    }

    const effectiveLineW = Math.max(fontSizePx * 0.4, lineW);
    let lineStartX = -lineW / 2;
    if (style.align === 'left') lineStartX = 0;
    else if (style.align === 'right') lineStartX = -lineW;
    const midX = lineStartX + lineW / 2;

    const glyphs: PositionedGlyph[] = [];
    let cursorX = lineStartX;

    let lineMinX = Infinity;
    let lineMaxX = -Infinity;
    let lineMinY = Infinity;
    let lineMaxY = -Infinity;

    for (let ci = 0; ci < chars.length; ci++) {
      const ch = chars[ci];
      const w = widths[ci];
      const adv = advances[ci];
      const cxLocal = cursorX - lineStartX + w / 2;
      const gx = cursorX + w / 2;
      cursorX += adv;

      let px = gx;
      let py = baseY;
      let angle = 0;

      if (hasCurve) {
        if (customLut) {
          let targetDist: number;
          if (style.align === 'left') {
            targetDist = cxLocal;
          } else if (style.align === 'right') {
            targetDist = customLut.totalLen - (lineW - cxLocal);
          } else {
            targetDist = customLut.totalLen / 2 + (cxLocal - lineW / 2);
          }
          const sp = sampleSplineAtArcDist(customLut, targetDist);
          px = sp.x - Math.sin(sp.angle) * baseY;
          py = sp.y + Math.cos(sp.angle) * baseY;
          angle = sp.angle;
        } else {
          const s = gx - midX;
          if (curveMode === 'arc') {
            const strength = Math.max(-1, Math.min(1, amp / 100));
            const maxAngle = Math.max(
              0.02,
              Math.abs(strength) * Math.PI * 1.35
            );
            const arcLen = Math.max(effectiveLineW, fontSizePx * 2.2);
            const radius = arcLen / maxAngle;
            const theta = s / radius;
            if (strength > 0) {
              px = midX + radius * Math.sin(theta);
              py = baseY + radius * (1 - Math.cos(theta));
              angle = theta;
            } else {
              px = midX + radius * Math.sin(theta);
              py = baseY - radius * (1 - Math.cos(theta));
              angle = -theta;
            }
          } else if (curveMode === 'wave') {
            const ampPx = (amp / 100) * fontSizePx * 1.25;
            const span = Math.max(fontSizePx * 4.5, effectiveLineW);
            const k = (freq * Math.PI * 2) / span;
            const phase = s * k;
            px = gx;
            py = baseY - ampPx * Math.sin(phase);
            const slope = -ampPx * k * Math.cos(phase);
            angle = Math.max(-1.25, Math.min(1.25, Math.atan(slope)));
          } else if (curveMode === 'zigzag') {
            const ampPx = (amp / 100) * fontSizePx * 1.25;
            const span = Math.max(fontSizePx * 4.5, effectiveLineW);
            const t = (s / span) * freq + 0.25;
            const frac = t - Math.floor(t);
            const tri = frac < 0.5 ? 4 * frac - 1 : 3 - 4 * frac;
            const slopeDir = frac < 0.5 ? 1 : -1;
            px = gx;
            py = baseY - ampPx * tri;
            const slope = -ampPx * slopeDir * ((4 * freq) / span);
            angle = Math.max(-1.25, Math.min(1.25, Math.atan(slope)));
          }
        }
      }

      const cosA = Math.abs(Math.cos(angle));
      const sinA = Math.abs(Math.sin(angle));
      const rx = (w / 2) * cosA + halfGlyphH * sinA;
      const ry = (w / 2) * sinA + halfGlyphH * cosA;

      lineMinX = Math.min(lineMinX, px - rx);
      lineMaxX = Math.max(lineMaxX, px + rx);
      lineMinY = Math.min(lineMinY, py - ry);
      lineMaxY = Math.max(lineMaxY, py + ry);

      glyphs.push({
        ch,
        isSpace: ch === ' ' || ch === '\t',
        w,
        advance: adv,
        x: px,
        y: py,
        angle,
      });
    }

    if (chars.length === 0) {
      lineMinX = lineStartX - fontSizePx * 0.2;
      lineMaxX = lineStartX + fontSizePx * 0.2;
      lineMinY = baseY - halfGlyphH;
      lineMaxY = baseY + halfGlyphH;
    }

    globalMinX = Math.min(globalMinX, lineMinX);
    globalMaxX = Math.max(globalMaxX, lineMaxX);
    globalMinY = Math.min(globalMinY, lineMinY);
    globalMaxY = Math.max(globalMaxY, lineMaxY);

    positionedLines.push({
      glyphs,
      lineW: effectiveLineW,
      lineStartX,
      baseY,
      minX: lineMinX,
      maxX: lineMaxX,
      minY: lineMinY,
      maxY: lineMaxY,
    });
  }

  ctx.restore();

  if (!Number.isFinite(globalMinX)) {
    globalMinX = -fontSizePx;
    globalMaxX = fontSizePx;
    globalMinY = -halfGlyphH;
    globalMaxY = halfGlyphH;
  }

  const strokeExpand = style.strokeWidth * sf * kfScale;
  const padX = fontSizePx * 0.36 + strokeExpand;
  const padY = fontSizePx * 0.24 + strokeExpand;

  return {
    style,
    fontString,
    fontSizePx,
    lineHeightPx,
    sf,
    lines: positionedLines,
    boxX: globalMinX - padX,
    boxY: globalMinY - padY,
    boxW: globalMaxX - globalMinX + padX * 2,
    boxH: globalMaxY - globalMinY + padY * 2,
  };
}

function drawLockBadge(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  name: string,
  color: string,
  sf: number
) {
  ctx.save();
  ctx.font = `700 ${Math.round(13 * sf)}px "Plus Jakarta Sans", sans-serif`;
  const label = `🔒 ${name}`;
  const metrics = ctx.measureText(label);
  const bw = metrics.width + 14 * sf;
  const bh = 22 * sf;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x, y - bh - 4 * sf, bw, bh, 6 * sf);
  ctx.fill();
  ctx.fillStyle = '#09090b';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + 7 * sf, y - bh / 2 - 4 * sf);
  ctx.restore();
}

function getClipPeerLock(
  clip: Clip,
  collaborators: Collaborator[],
  currentUserId?: string
): {color: string; name: string} | null {
  if (clip.lockedByUserId && clip.lockedByUserId !== currentUserId) {
    return {
      color: clip.lockedByUserColor || '#f97316',
      name: clip.lockedByUserName || 'Участник',
    };
  }
  const remoteOwner = collaborators.find((u) => u.selectedClipId === clip.id);
  if (remoteOwner) {
    return {color: remoteOwner.color, name: remoteOwner.name};
  }
  return null;
}

export function drawTextClipCanvas(
  ctx: CanvasRenderingContext2D,
  cw: number,
  ch: number,
  clip: Clip,
  time: number,
  selectedClipId: string | null,
  collaborators: Collaborator[],
  currentUserId: string | undefined,
  getScratchCtx: (
    w: number,
    h: number
  ) => {canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D} | null,
  maskOnly = false
) {
  const style = normalizeTextStyle(clip.textStyle);
  if (style.fontFamily && style.fontSrc) {
    void loadCustomFont(style.fontFamily, style.fontSrc);
  }

  const kf = evaluateClipTransform(clip, time);
  const textVal = clip.text ?? clip.name ?? '';
  const baseSf = cw / 720;
  const anim = evaluateTextClipAnimation(clip, time, baseSf);
  const alpha = kf.opacity * anim.alphaMul;

  const layout = computeTextLayout(
    ctx,
    cw,
    textVal,
    clip.textStyle,
    kf.scale * anim.scaleMul
  );
  const anchorX = cw * kf.x + anim.offsetX;
  const anchorY = ch * kf.y + anim.offsetY;
  const effectiveRotation = kf.rotation + anim.rotDeg;
  const sf = layout.sf;

  const totalGlyphCount = layout.lines.reduce(
    (sum, line) => sum + line.glyphs.length,
    0
  );
  const hasTypewriter = anim.typewriterRatio < 0.999;
  const exactVisible = hasTypewriter
    ? anim.typewriterRatio * totalGlyphCount
    : totalGlyphCount;
  const fullVisibleCount = Math.floor(exactVisible);
  const partialAlpha = Math.max(0, Math.min(1, exactVisible - fullVisibleCount));

  // Build visible slice per line when typewriter is active
  let globalIdx = 0;
  const visibleLines = layout.lines.map((line) => {
    if (!hasTypewriter) {
      return {
        line,
        glyphs: line.glyphs.map((g) => ({g, charAlpha: 1})),
      };
    }
    const items: Array<{g: PositionedGlyph; charAlpha: number}> = [];
    for (const g of line.glyphs) {
      if (globalIdx < fullVisibleCount) {
        items.push({g, charAlpha: 1});
      } else if (globalIdx === fullVisibleCount && partialAlpha > 0.02) {
        items.push({g, charAlpha: partialAlpha});
      }
      globalIdx++;
    }
    return {line, glyphs: items};
  });

  const sxFactor = (clip.scaleX ?? 1) * (clip.flipHorizontal ? -1 : 1);
  const syFactor = (clip.scaleY ?? 1) * (clip.flipVertical ? -1 : 1);

  const renderTextBodyToTarget = (
    targetCtx: CanvasRenderingContext2D,
    layerAlpha: number,
    customOrigin?: {x: number; y: number; applyRotation: boolean}
  ) => {
    targetCtx.save();
    targetCtx.globalAlpha = Math.max(0, Math.min(1, layerAlpha));
    targetCtx.font = layout.fontString;
    targetCtx.textAlign = 'center';
    targetCtx.textBaseline = 'middle';
    const totalBlur = anim.blurPx + (clip.blur ?? 0);
    if (totalBlur > 0.2 && !maskOnly) {
      targetCtx.filter = `blur(${totalBlur.toFixed(1)}px)`;
    }

    if (customOrigin) {
      targetCtx.translate(customOrigin.x, customOrigin.y);
      if (customOrigin.applyRotation && effectiveRotation !== 0) {
        targetCtx.rotate((effectiveRotation * Math.PI) / 180);
      }
    } else {
      targetCtx.translate(anchorX, anchorY);
      if (effectiveRotation !== 0) {
        targetCtx.rotate((effectiveRotation * Math.PI) / 180);
      }
    }
    if (sxFactor !== 1 || syFactor !== 1) {
      targetCtx.scale(sxFactor, syFactor);
    }

    const totalVisibleGlyphs = visibleLines.reduce(
      (s, l) => s + l.glyphs.length,
      0
    );

    if (
      style.bgMode !== 'none' &&
      style.bgOpacity > 0.01 &&
      (!hasTypewriter || totalVisibleGlyphs > 0)
    ) {
      targetCtx.save();
      targetCtx.shadowColor = 'transparent';
      targetCtx.shadowBlur = 0;
      targetCtx.shadowOffsetX = 0;
      targetCtx.shadowOffsetY = 0;
      targetCtx.fillStyle = maskOnly
        ? '#ffffff'
        : colorWithOpacity(style.bgColor, style.bgOpacity);

      if (style.bgMode === 'block') {
        targetCtx.fillRect(
          layout.boxX,
          layout.boxY,
          layout.boxW,
          layout.boxH
        );
      } else if (style.bgMode === 'lines') {
        const linePadX = layout.fontSizePx * 0.28;
        const linePadY = layout.fontSizePx * 0.16;
        const radius = Math.min(14 * sf, layout.fontSizePx * 0.28);
        for (const vl of visibleLines) {
          if (hasTypewriter && vl.glyphs.length === 0) continue;
          const minX = hasTypewriter
            ? Math.min(...vl.glyphs.map((it) => it.g.x - it.g.w / 2))
            : vl.line.minX;
          const maxX = hasTypewriter
            ? Math.max(...vl.glyphs.map((it) => it.g.x + it.g.w / 2))
            : vl.line.maxX;
          const minY = hasTypewriter
            ? Math.min(...vl.glyphs.map((it) => it.g.y - layout.fontSizePx * 0.58))
            : vl.line.minY;
          const maxY = hasTypewriter
            ? Math.max(...vl.glyphs.map((it) => it.g.y + layout.fontSizePx * 0.58))
            : vl.line.maxY;
          targetCtx.beginPath();
          targetCtx.roundRect(
            minX - linePadX,
            minY - linePadY,
            maxX - minX + linePadX * 2,
            maxY - minY + linePadY * 2,
            radius
          );
          targetCtx.fill();
        }
      } else if (style.bgMode === 'chars') {
        const charPadX = layout.fontSizePx * 0.16;
        const charPadY = layout.fontSizePx * 0.14;
        const radius = Math.min(10 * sf, layout.fontSizePx * 0.22);
        for (const vl of visibleLines) {
          for (const {g, charAlpha} of vl.glyphs) {
            if (g.isSpace || !g.ch.trim()) continue;
            targetCtx.save();
            if (charAlpha < 0.999) targetCtx.globalAlpha *= charAlpha;
            targetCtx.translate(g.x, g.y);
            if (g.angle !== 0) targetCtx.rotate(g.angle);
            targetCtx.beginPath();
            targetCtx.roundRect(
              -g.w / 2 - charPadX,
              -layout.fontSizePx * 0.56 - charPadY,
              g.w + charPadX * 2,
              layout.fontSizePx * 1.12 + charPadY * 2,
              radius
            );
            targetCtx.fill();
            targetCtx.restore();
          }
        }
      }
      targetCtx.restore();
    }

    const applyShadow = () => {
      if (style.shadow && !maskOnly) {
        targetCtx.shadowColor = style.shadowColor || 'rgba(0,0,0,0.65)';
        targetCtx.shadowOffsetX =
          style.shadowOffsetX * sf * kf.scale * anim.scaleMul;
        targetCtx.shadowOffsetY =
          style.shadowOffsetY * sf * kf.scale * anim.scaleMul;
        targetCtx.shadowBlur = Math.max(
          0,
          style.shadowBlur * sf * kf.scale * anim.scaleMul
        );
      } else {
        targetCtx.shadowColor = 'transparent';
        targetCtx.shadowBlur = 0;
        targetCtx.shadowOffsetX = 0;
        targetCtx.shadowOffsetY = 0;
      }
    };

    const clearShadow = () => {
      targetCtx.shadowColor = 'transparent';
      targetCtx.shadowBlur = 0;
      targetCtx.shadowOffsetX = 0;
      targetCtx.shadowOffsetY = 0;
    };

    const hasStroke = style.strokeWidth > 0.05;
    const strokePx = style.strokeWidth * 2 * sf * kf.scale * anim.scaleMul;
    const underlineThickness = Math.max(2 * sf, layout.fontSizePx * 0.065);
    const underlineY = layout.fontSizePx * 0.44;
    const isCurved =
      (style.curveMode === 'custom' && style.curvePoints.length >= 2) ||
      (style.curveMode !== 'none' && Math.abs(style.curveAmplitude) >= 0.5);

    if (hasStroke) {
      targetCtx.save();
      applyShadow();
      targetCtx.lineJoin = 'round';
      targetCtx.lineCap = 'round';
      targetCtx.miterLimit = 2;
      targetCtx.strokeStyle = maskOnly ? '#ffffff' : style.strokeColor;
      targetCtx.lineWidth = strokePx;

      for (const vl of visibleLines) {
        for (const {g, charAlpha} of vl.glyphs) {
          if (g.isSpace) continue;
          targetCtx.save();
          if (charAlpha < 0.999) targetCtx.globalAlpha *= charAlpha;
          targetCtx.translate(g.x, g.y);
          if (g.angle !== 0) targetCtx.rotate(g.angle);
          targetCtx.strokeText(g.ch, 0, 0);
          targetCtx.restore();
        }
        if (style.underline && vl.glyphs.length > 0) {
          if (!isCurved && !hasTypewriter) {
            targetCtx.beginPath();
            targetCtx.lineWidth = underlineThickness + strokePx;
            targetCtx.moveTo(vl.line.minX, vl.line.baseY + underlineY);
            targetCtx.lineTo(vl.line.maxX, vl.line.baseY + underlineY);
            targetCtx.stroke();
          } else {
            for (const {g, charAlpha} of vl.glyphs) {
              targetCtx.save();
              if (charAlpha < 0.999) targetCtx.globalAlpha *= charAlpha;
              targetCtx.translate(g.x, g.y);
              if (g.angle !== 0) targetCtx.rotate(g.angle);
              targetCtx.beginPath();
              targetCtx.lineWidth = underlineThickness + strokePx;
              targetCtx.moveTo(-g.advance / 2, underlineY);
              targetCtx.lineTo(g.advance / 2, underlineY);
              targetCtx.stroke();
              targetCtx.restore();
            }
          }
        }
      }
      targetCtx.restore();
    }

    targetCtx.save();
    if (hasStroke || maskOnly) {
      clearShadow();
    } else {
      applyShadow();
    }
    targetCtx.fillStyle = maskOnly ? '#ffffff' : style.color;
    targetCtx.strokeStyle = maskOnly ? '#ffffff' : style.color;
    targetCtx.lineCap = 'round';

    for (const vl of visibleLines) {
      for (const {g, charAlpha} of vl.glyphs) {
        if (g.isSpace) continue;
        targetCtx.save();
        if (charAlpha < 0.999) targetCtx.globalAlpha *= charAlpha;
        targetCtx.translate(g.x, g.y);
        if (g.angle !== 0) targetCtx.rotate(g.angle);
        targetCtx.fillText(g.ch, 0, 0);
        targetCtx.restore();
      }
      if (style.underline && vl.glyphs.length > 0) {
        if (!isCurved && !hasTypewriter) {
          targetCtx.beginPath();
          targetCtx.lineWidth = underlineThickness;
          targetCtx.moveTo(vl.line.minX, vl.line.baseY + underlineY);
          targetCtx.lineTo(vl.line.maxX, vl.line.baseY + underlineY);
          targetCtx.stroke();
        } else {
          for (const {g, charAlpha} of vl.glyphs) {
            targetCtx.save();
            if (charAlpha < 0.999) targetCtx.globalAlpha *= charAlpha;
            targetCtx.translate(g.x, g.y);
            if (g.angle !== 0) targetCtx.rotate(g.angle);
            targetCtx.beginPath();
            targetCtx.lineWidth = underlineThickness;
            targetCtx.moveTo(-g.advance / 2, underlineY);
            targetCtx.lineTo(g.advance / 2, underlineY);
            targetCtx.stroke();
            targetCtx.restore();
          }
        }
      }
    }

    targetCtx.restore();
    targetCtx.restore();
  };

  // Compute screen-aligned bounding box for warping & selection
  const boxCenterLocalX = (layout.boxX + layout.boxW / 2) * sxFactor;
  const boxCenterLocalY = (layout.boxY + layout.boxH / 2) * syFactor;
  const rotRad = (effectiveRotation * Math.PI) / 180;
  const cosR = Math.cos(rotRad);
  const sinR = Math.sin(rotRad);
  const boxCenterX = anchorX + (boxCenterLocalX * cosR - boxCenterLocalY * sinR);
  const boxCenterY = anchorY + (boxCenterLocalX * sinR + boxCenterLocalY * cosR);
  const boxW = Math.max(24, (layout.boxW + 12 * sf) * Math.abs(sxFactor));
  const boxH = Math.max(24, (layout.boxH + 12 * sf) * Math.abs(syFactor));

  const hasWarp = !isIdentityWarp(kf.warp);
  const grade = maskOnly ? null : getClipEffectiveAdjustments(clip);
  const needsOffscreenColorGrade = Boolean(grade && !isNeutralColorGrade(grade));

  const drawUnmasked = (targetCtx: CanvasRenderingContext2D, layerAlpha: number) => {
    if (!hasWarp && !needsOffscreenColorGrade) {
      renderTextBodyToTarget(targetCtx, layerAlpha);
      return;
    }

    // Render text centered in a tight local offscreen canvas aligned with (boxW, boxH)
    const texW = Math.max(4, Math.min(2048, Math.ceil(boxW)));
    const texH = Math.max(4, Math.min(2048, Math.ceil(boxH)));
    if (!textLayerScratchCanvas) {
      textLayerScratchCanvas = document.createElement('canvas');
    }
    textLayerScratchCanvas.width = texW;
    textLayerScratchCanvas.height = texH;
    const lctx = textLayerScratchCanvas.getContext('2d');
    if (!lctx) {
      renderTextBodyToTarget(targetCtx, layerAlpha);
      return;
    }
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.clearRect(0, 0, texW, texH);

    // Draw into local canvas without rotation (boxCenterLocal corresponds to texW/2, texH/2)
    lctx.save();
    lctx.translate(texW / 2 - boxCenterLocalX, texH / 2 - boxCenterLocalY);
    renderTextBodyToTarget(lctx, 1, {x: 0, y: 0, applyRotation: false});
    lctx.restore();

    let sourceCanvas: HTMLCanvasElement = textLayerScratchCanvas;
    if (needsOffscreenColorGrade && grade) {
      const graded = applyColorGradeShader(
        sourceCanvas,
        texW,
        texH,
        grade,
        time
      );
      if (graded instanceof HTMLCanvasElement) {
        sourceCanvas = graded;
      }
    }

    if (hasWarp && kf.warp) {
      const warped = renderWarpedLayer({
        source: sourceCanvas,
        centerX: boxCenterX,
        centerY: boxCenterY,
        layerW: boxW,
        layerH: boxH,
        rotationDeg: effectiveRotation,
        warp: kf.warp,
        cw,
        ch,
      });
      if (warped) {
        targetCtx.save();
        targetCtx.globalAlpha = Math.max(0, Math.min(1, layerAlpha));
        targetCtx.drawImage(
          warped.canvas,
          warped.outX,
          warped.outY,
          warped.outW,
          warped.outH
        );
        targetCtx.restore();
        return;
      }
    }

    targetCtx.save();
    targetCtx.globalAlpha = Math.max(0, Math.min(1, layerAlpha));
    targetCtx.translate(boxCenterX, boxCenterY);
    if (effectiveRotation !== 0) targetCtx.rotate(rotRad);
    targetCtx.drawImage(sourceCanvas, -boxW / 2, -boxH / 2, boxW, boxH);
    targetCtx.restore();
  };

  if (clip.mask) {
    const scratch = getScratchCtx(cw, ch);
    if (scratch) {
      drawUnmasked(scratch.ctx, 1);
      applyMaskToCanvas(scratch.canvas, cw, ch, clip.mask);
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, maskOnly ? 1 : alpha));
      if (!maskOnly && clip.blendMode) {
        ctx.globalCompositeOperation = clip.blendMode;
      }
      ctx.drawImage(scratch.canvas, 0, 0);
      ctx.restore();
    } else {
      drawUnmasked(ctx, maskOnly ? 1 : alpha);
    }
  } else {
    ctx.save();
    if (!maskOnly && clip.blendMode) {
      ctx.globalCompositeOperation = clip.blendMode;
    }
    drawUnmasked(ctx, maskOnly ? 1 : alpha);
    ctx.restore();
  }

  // 4. Selection outline & collaborative lock badge (skipped when drawing silhouette mask)
  if (maskOnly) return;

  const peerLock = getClipPeerLock(clip, collaborators, currentUserId);
  if (clip.id === selectedClipId || peerLock) {
    const strokeCol = peerLock
      ? peerLock.color
      : clip.adjustmentMask
        ? '#c084fc'
        : '#22d3ee';
    if (hasWarp && kf.warp) {
      const poly = getWarpedOutlinePolygon(
        boxCenterX,
        boxCenterY,
        boxW,
        boxH,
        effectiveRotation,
        kf.warp
      );
      ctx.save();
      ctx.strokeStyle = strokeCol;
      ctx.lineWidth = (peerLock ? 3 : 2.5) * sf;
      if (clip.adjustmentMask && !peerLock) ctx.setLineDash([7 * sf, 5 * sf]);
      ctx.beginPath();
      poly.forEach((p, idx) => {
        if (idx === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
      if (peerLock && poly[0]) {
        drawLockBadge(ctx, poly[0].x, poly[0].y, peerLock.name, peerLock.color, sf);
      }
      ctx.restore();
    } else {
      ctx.save();
      ctx.translate(anchorX, anchorY);
      if (effectiveRotation !== 0) {
        ctx.rotate((effectiveRotation * Math.PI) / 180);
      }
      if (sxFactor !== 1 || syFactor !== 1) {
        ctx.scale(sxFactor, syFactor);
      }
      ctx.strokeStyle = strokeCol;
      ctx.lineWidth = (peerLock ? 3 : 2.5) * sf;
      if (clip.adjustmentMask && !peerLock) ctx.setLineDash([7 * sf, 5 * sf]);
      ctx.strokeRect(
        layout.boxX - 6 * sf,
        layout.boxY - 6 * sf,
        layout.boxW + 12 * sf,
        layout.boxH + 12 * sf
      );
      ctx.setLineDash([]);
      if (peerLock) {
        drawLockBadge(
          ctx,
          layout.boxX - 6 * sf,
          layout.boxY - 6 * sf,
          peerLock.name,
          peerLock.color,
          sf
        );
      }
      ctx.restore();
    }
  }
}

let textLayerScratchCanvas: HTMLCanvasElement | null = null;

export function getTextClipUnwarpedBox(
  clip: Clip,
  cw: number,
  ch: number,
  time: number
): {
  centerX: number;
  centerY: number;
  layerW: number;
  layerH: number;
  rotationDeg: number;
} {
  if (!hitMeasureCanvas) {
    hitMeasureCanvas = document.createElement('canvas');
    hitMeasureCanvas.width = 4;
    hitMeasureCanvas.height = 4;
  }
  const mctx = hitMeasureCanvas.getContext('2d');
  const kf = evaluateClipTransform(clip, time);
  const sf = cw / 720;
  const anim = evaluateTextClipAnimation(clip, time, sf);
  const anchorX = cw * kf.x + anim.offsetX;
  const anchorY = ch * kf.y + anim.offsetY;
  const effectiveRotation = kf.rotation + anim.rotDeg;

  if (!mctx) {
    return {
      centerX: anchorX,
      centerY: anchorY,
      layerW: cw * 0.45 * kf.scale * Math.abs(clip.scaleX ?? 1),
      layerH: 80 * sf * kf.scale * Math.abs(clip.scaleY ?? 1),
      rotationDeg: effectiveRotation,
    };
  }

  const layout = computeTextLayout(
    mctx,
    cw,
    clip.text ?? clip.name ?? '',
    clip.textStyle,
    kf.scale * anim.scaleMul
  );
  const sxFactor = (clip.scaleX ?? 1) * (clip.flipHorizontal ? -1 : 1);
  const syFactor = (clip.scaleY ?? 1) * (clip.flipVertical ? -1 : 1);
  const localCx = (layout.boxX + layout.boxW / 2) * sxFactor;
  const localCy = (layout.boxY + layout.boxH / 2) * syFactor;
  const rad = (effectiveRotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  return {
    centerX: anchorX + (localCx * cos - localCy * sin),
    centerY: anchorY + (localCx * sin + localCy * cos),
    layerW: Math.max(24, (layout.boxW + 12 * layout.sf) * Math.abs(sxFactor)),
    layerH: Math.max(24, (layout.boxH + 12 * layout.sf) * Math.abs(syFactor)),
    rotationDeg: effectiveRotation,
  };
}

let hitMeasureCanvas: HTMLCanvasElement | null = null;

export function hitTestTextClip(
  clip: Clip,
  nx: number,
  ny: number,
  cw: number,
  ch: number,
  time: number
): boolean {
  if (!hitMeasureCanvas) {
    hitMeasureCanvas = document.createElement('canvas');
    hitMeasureCanvas.width = 4;
    hitMeasureCanvas.height = 4;
  }
  const ctx = hitMeasureCanvas.getContext('2d');
  const kf = evaluateClipTransform(clip, time);
  if (!isIdentityWarp(kf.warp) && kf.warp) {
    const box = getTextClipUnwarpedBox(clip, cw, ch, time);
    const poly = getWarpedOutlinePolygon(
      box.centerX,
      box.centerY,
      box.layerW,
      box.layerH,
      box.rotationDeg,
      kf.warp
    );
    if (pointInPolygon(nx * cw, ny * ch, poly)) {
      return true;
    }
  }
  if (!ctx) {
    return Math.abs(nx - kf.x) < 0.28 && Math.abs(ny - kf.y) < 0.12;
  }

  const layout = computeTextLayout(
    ctx,
    cw,
    clip.text ?? clip.name ?? '',
    clip.textStyle,
    kf.scale
  );

  const px = nx * cw - cw * kf.x;
  const py = ny * ch - ch * kf.y;
  const rad = (-kf.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rx = (px * cos - py * sin) / Math.max(0.1, Math.abs(clip.scaleX ?? 1));
  const ry = (px * sin + py * cos) / Math.max(0.1, Math.abs(clip.scaleY ?? 1));

  const hitPad = 14 * layout.sf;
  return (
    rx >= layout.boxX - hitPad &&
    rx <= layout.boxX + layout.boxW + hitPad &&
    ry >= layout.boxY - hitPad &&
    ry <= layout.boxY + layout.boxH + hitPad
  );
}

export interface TextCurveOverlayData {
  points: Array<{id: string; cx: number; cy: number; localX: number; localY: number}>;
  polyline: Array<{cx: number; cy: number; localX: number; localY: number; segIdx: number}>;
  pathD: string;
}

export function textLocalToCanvasPx(
  clip: Clip,
  localX: number,
  localY: number,
  cw: number,
  ch: number,
  time: number
): {cx: number; cy: number} {
  const kf = evaluateClipTransform(clip, time);
  const sf = cw / 720;
  const scalePx = sf * kf.scale;
  const sx = (clip.scaleX ?? 1) * (clip.flipHorizontal ? -1 : 1);
  const sy = (clip.scaleY ?? 1) * (clip.flipVertical ? -1 : 1);

  const px = localX * scalePx * sx;
  const py = localY * scalePx * sy;
  const rad = (kf.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  return {
    cx: cw * kf.x + (px * cos - py * sin),
    cy: ch * kf.y + (px * sin + py * cos),
  };
}

export function canvasNormToTextLocal(
  clip: Clip,
  nx: number,
  ny: number,
  cw: number,
  ch: number,
  time: number
): {localX: number; localY: number} {
  const kf = evaluateClipTransform(clip, time);
  const sf = cw / 720;
  const scalePx = Math.max(0.05, sf * kf.scale);
  const sx = (clip.scaleX ?? 1) * (clip.flipHorizontal ? -1 : 1);
  const sy = (clip.scaleY ?? 1) * (clip.flipVertical ? -1 : 1);

  const dx = nx * cw - cw * kf.x;
  const dy = ny * ch - ch * kf.y;
  const rad = (-kf.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const rx = dx * cos - dy * sin;
  const ry = dx * sin + dy * cos;

  return {
    localX: rx / (scalePx * (Math.abs(sx) < 0.05 ? 0.05 : sx)),
    localY: ry / (scalePx * (Math.abs(sy) < 0.05 ? 0.05 : sy)),
  };
}

export function getTextCurveOverlayData(
  clip: Clip,
  cw: number,
  ch: number,
  time: number
): TextCurveOverlayData | null {
  if (clip.track !== 'text') return null;
  const style = normalizeTextStyle(clip.textStyle);
  if (style.curveMode !== 'custom' || style.curvePoints.length < 2) {
    return null;
  }

  const points = style.curvePoints.map((pt) => {
    const pos = textLocalToCanvasPx(clip, pt.x, pt.y, cw, ch, time);
    return {
      id: pt.id,
      cx: pos.cx,
      cy: pos.cy,
      localX: pt.x,
      localY: pt.y,
    };
  });

  const lut = buildSplineLut(style.curvePoints, style.curveSmoothness / 100, 20);
  const polyline = lut.samples.map((s) => {
    const pos = textLocalToCanvasPx(clip, s.x, s.y, cw, ch, time);
    return {
      cx: pos.cx,
      cy: pos.cy,
      localX: s.x,
      localY: s.y,
      segIdx: s.segIdx,
    };
  });

  let pathD = '';
  for (let i = 0; i < polyline.length; i++) {
    const p = polyline[i];
    pathD += `${i === 0 ? 'M' : 'L'}${p.cx.toFixed(1)} ${p.cy.toFixed(1)} `;
  }

  return {points, polyline, pathD: pathD.trim()};
}

