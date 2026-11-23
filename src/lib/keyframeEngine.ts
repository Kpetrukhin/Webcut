import type {
  Clip,
  ClipKeyframe,
  ClipWarp,
  KeyframeEasing,
} from '../shared/types.ts';
import {cloneWarp, interpolateWarp} from './warpEngine.ts';

export interface EvaluatedTransform {
  x: number;
  y: number;
  scale: number;
  scaleX: number;
  scaleY: number;
  flipHorizontal: boolean;
  flipVertical: boolean;
  rotation: number;
  opacity: number;
  warp?: ClipWarp;
}

export function applyEasing(t: number, easing: KeyframeEasing): number {
  const x = Math.max(0, Math.min(1, t));
  switch (easing) {
    case 'ease-in':
      return x * x * x;
    case 'ease-out':
      return 1 - Math.pow(1 - x, 3);
    case 'ease-in-out':
      return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    case 'bounce': {
      const n1 = 7.5625;
      const d1 = 2.75;
      if (x < 1 / d1) {
        return n1 * x * x;
      }
      if (x < 2 / d1) {
        const p = x - 1.5 / d1;
        return n1 * p * p + 0.75;
      }
      if (x < 2.5 / d1) {
        const p = x - 2.25 / d1;
        return n1 * p * p + 0.9375;
      }
      const p = x - 2.625 / d1;
      return n1 * p * p + 0.984375;
    }
    case 'linear':
    default:
      return x;
  }
}

export function getBaseClipTransform(clip: Clip): EvaluatedTransform {
  if (clip.track === 'text') {
    return {
      x: clip.textStyle?.x ?? 0.5,
      y: clip.textStyle?.y ?? 0.76,
      scale: clip.mediaScale ?? 1,
      scaleX: clip.scaleX ?? 1,
      scaleY: clip.scaleY ?? 1,
      flipHorizontal: Boolean(clip.flipHorizontal),
      flipVertical: Boolean(clip.flipVertical),
      rotation: clip.rotation ?? 0,
      opacity: clip.opacity ?? 1,
      warp: clip.warp,
    };
  }
  return {
    x: clip.mediaX ?? (clip.track === 'overlay' ? 0.72 : 0.5),
    y: clip.mediaY ?? (clip.track === 'overlay' ? 0.26 : 0.5),
    scale: clip.mediaScale ?? (clip.track === 'overlay' ? 0.42 : 1),
    scaleX: clip.scaleX ?? 1,
    scaleY: clip.scaleY ?? 1,
    flipHorizontal: Boolean(clip.flipHorizontal),
    flipVertical: Boolean(clip.flipVertical),
    rotation: clip.rotation ?? 0,
    opacity: clip.opacity ?? 1,
    warp: clip.warp,
  };
}

export function evaluateClipTransform(
  clip: Clip,
  globalTime: number
): EvaluatedTransform {
  const base = getBaseClipTransform(clip);
  const kfs = clip.keyframes;
  if (!kfs || kfs.length === 0) {
    return base;
  }

  const sorted = [...kfs].sort((a, b) => a.timeOffset - b.timeOffset);
  const localTime = Math.max(
    0,
    Math.min(clip.duration, globalTime - clip.start)
  );

  if (localTime <= sorted[0].timeOffset) {
    const first = sorted[0];
    return {
      x: first.x,
      y: first.y,
      scale: first.scale,
      scaleX: first.scaleX ?? base.scaleX,
      scaleY: first.scaleY ?? base.scaleY,
      flipHorizontal: first.flipHorizontal ?? base.flipHorizontal,
      flipVertical: first.flipVertical ?? base.flipVertical,
      rotation: first.rotation,
      opacity: first.opacity,
      warp: first.warp ?? clip.warp,
    };
  }

  const last = sorted[sorted.length - 1];
  if (localTime >= last.timeOffset) {
    return {
      x: last.x,
      y: last.y,
      scale: last.scale,
      scaleX: last.scaleX ?? base.scaleX,
      scaleY: last.scaleY ?? base.scaleY,
      flipHorizontal: last.flipHorizontal ?? base.flipHorizontal,
      flipVertical: last.flipVertical ?? base.flipVertical,
      rotation: last.rotation,
      opacity: last.opacity,
      warp: last.warp ?? clip.warp,
    };
  }

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (localTime >= a.timeOffset && localTime <= b.timeOffset) {
      const span = Math.max(0.001, b.timeOffset - a.timeOffset);
      const rawT = (localTime - a.timeOffset) / span;
      const easedT = applyEasing(rawT, b.easing || a.easing || 'ease-in-out');
      const aScaleX = a.scaleX ?? base.scaleX;
      const bScaleX = b.scaleX ?? base.scaleX;
      const aScaleY = a.scaleY ?? base.scaleY;
      const bScaleY = b.scaleY ?? base.scaleY;
      const aFlipH = a.flipHorizontal ?? base.flipHorizontal;
      const bFlipH = b.flipHorizontal ?? base.flipHorizontal;
      const aFlipV = a.flipVertical ?? base.flipVertical;
      const bFlipV = b.flipVertical ?? base.flipVertical;
      const atEndOfSegment = localTime >= b.timeOffset - 1e-6;
      const warpA = a.warp ?? clip.warp;
      const warpB = b.warp ?? clip.warp;
      return {
        x: a.x + (b.x - a.x) * easedT,
        y: a.y + (b.y - a.y) * easedT,
        scale: a.scale + (b.scale - a.scale) * easedT,
        scaleX: aScaleX + (bScaleX - aScaleX) * easedT,
        scaleY: aScaleY + (bScaleY - aScaleY) * easedT,
        flipHorizontal: atEndOfSegment ? bFlipH : aFlipH,
        flipVertical: atEndOfSegment ? bFlipV : aFlipV,
        rotation: a.rotation + (b.rotation - a.rotation) * easedT,
        opacity: a.opacity + (b.opacity - a.opacity) * easedT,
        warp:
          warpA || warpB ? interpolateWarp(warpA, warpB, easedT) : undefined,
      };
    }
  }

  return base;
}

export function upsertKeyframeAtTime(
  clip: Clip,
  globalTime: number,
  override?: Partial<ClipKeyframe>
): {keyframes: ClipKeyframe[]; activeKeyframeId: string} {
  const localOffset = Math.round(
    Math.max(0, Math.min(clip.duration, globalTime - clip.start)) * 20
  ) / 20;
  const current = evaluateClipTransform(clip, globalTime);
  const existing = [...(clip.keyframes ?? [])];
  const nearIdx = existing.findIndex(
    (k) => Math.abs(k.timeOffset - localOffset) <= 0.12
  );

  if (nearIdx !== -1) {
    const resolvedWarp =
      override?.warp ?? existing[nearIdx].warp ?? current.warp ?? clip.warp;
    const updated: ClipKeyframe = {
      ...existing[nearIdx],
      x: override?.x ?? current.x,
      y: override?.y ?? current.y,
      scale: override?.scale ?? current.scale,
      scaleX: override?.scaleX ?? existing[nearIdx].scaleX ?? current.scaleX,
      scaleY: override?.scaleY ?? existing[nearIdx].scaleY ?? current.scaleY,
      flipHorizontal:
        override?.flipHorizontal ??
        existing[nearIdx].flipHorizontal ??
        current.flipHorizontal,
      flipVertical:
        override?.flipVertical ??
        existing[nearIdx].flipVertical ??
        current.flipVertical,
      rotation: override?.rotation ?? current.rotation,
      opacity: override?.opacity ?? current.opacity,
      warp: resolvedWarp ? cloneWarp(resolvedWarp) : undefined,
      easing: override?.easing ?? existing[nearIdx].easing,
    };
    existing[nearIdx] = updated;
    return {
      keyframes: existing.sort((a, b) => a.timeOffset - b.timeOffset),
      activeKeyframeId: updated.id,
    };
  }

  const resolvedWarp = override?.warp ?? current.warp ?? clip.warp;
  const created: ClipKeyframe = {
    id: `kf-${Math.random().toString(36).slice(2, 8)}`,
    timeOffset: localOffset,
    x: override?.x ?? current.x,
    y: override?.y ?? current.y,
    scale: override?.scale ?? current.scale,
    scaleX: override?.scaleX ?? current.scaleX,
    scaleY: override?.scaleY ?? current.scaleY,
    flipHorizontal: override?.flipHorizontal ?? current.flipHorizontal,
    flipVertical: override?.flipVertical ?? current.flipVertical,
    rotation: override?.rotation ?? current.rotation,
    opacity: override?.opacity ?? current.opacity,
    warp: resolvedWarp ? cloneWarp(resolvedWarp) : undefined,
    easing: override?.easing ?? 'ease-in-out',
  };
  existing.push(created);
  return {
    keyframes: existing.sort((a, b) => a.timeOffset - b.timeOffset),
    activeKeyframeId: created.id,
  };
}

export function generateKeyframePreset(
  clip: Clip,
  preset: 'slide-in' | 'spin-zoom' | 'float' | 'bounce-in'
): ClipKeyframe[] {
  const base = getBaseClipTransform(clip);
  const d = Math.max(0.6, clip.duration);
  const common = () => ({
    scaleX: base.scaleX,
    scaleY: base.scaleY,
    flipHorizontal: base.flipHorizontal,
    flipVertical: base.flipVertical,
    ...(base.warp ? {warp: cloneWarp(base.warp)} : {}),
  });

  switch (preset) {
    case 'slide-in':
      return [
        {
          id: `kf-${Math.random().toString(36).slice(2, 8)}`,
          timeOffset: 0,
          x: 0.08,
          y: base.y,
          scale: base.scale * 0.85,
          ...common(),
          rotation: -8,
          opacity: 0,
          easing: 'linear',
        },
        {
          id: `kf-${Math.random().toString(36).slice(2, 8)}`,
          timeOffset: Math.round(Math.min(0.8, d * 0.4) * 100) / 100,
          x: base.x,
          y: base.y,
          scale: base.scale,
          ...common(),
          rotation: 0,
          opacity: 1,
          easing: 'ease-out',
        },
      ];
    case 'spin-zoom':
      return [
        {
          id: `kf-${Math.random().toString(36).slice(2, 8)}`,
          timeOffset: 0,
          x: base.x,
          y: base.y,
          scale: Math.max(0.15, base.scale * 0.45),
          ...common(),
          rotation: -24,
          opacity: 0.2,
          easing: 'linear',
        },
        {
          id: `kf-${Math.random().toString(36).slice(2, 8)}`,
          timeOffset: Math.round(d * 0.65 * 100) / 100,
          x: base.x,
          y: base.y,
          scale: Math.min(1, base.scale * 1.15),
          ...common(),
          rotation: 4,
          opacity: 1,
          easing: 'ease-in-out',
        },
        {
          id: `kf-${Math.random().toString(36).slice(2, 8)}`,
          timeOffset: Math.round(d * 100) / 100,
          x: base.x,
          y: base.y,
          scale: base.scale,
          ...common(),
          rotation: 0,
          opacity: 1,
          easing: 'ease-out',
        },
      ];
    case 'float':
      return [
        {
          id: `kf-${Math.random().toString(36).slice(2, 8)}`,
          timeOffset: 0,
          x: base.x,
          y: Math.max(0.1, base.y - 0.05),
          scale: base.scale,
          ...common(),
          rotation: -3,
          opacity: base.opacity,
          easing: 'linear',
        },
        {
          id: `kf-${Math.random().toString(36).slice(2, 8)}`,
          timeOffset: Math.round(d * 0.5 * 100) / 100,
          x: Math.min(0.9, base.x + 0.04),
          y: Math.min(0.9, base.y + 0.05),
          scale: base.scale * 1.06,
          ...common(),
          rotation: 3,
          opacity: base.opacity,
          easing: 'ease-in-out',
        },
        {
          id: `kf-${Math.random().toString(36).slice(2, 8)}`,
          timeOffset: Math.round(d * 100) / 100,
          x: base.x,
          y: Math.max(0.1, base.y - 0.05),
          scale: base.scale,
          ...common(),
          rotation: -3,
          opacity: base.opacity,
          easing: 'ease-in-out',
        },
      ];
    case 'bounce-in':
      return [
        {
          id: `kf-${Math.random().toString(36).slice(2, 8)}`,
          timeOffset: 0,
          x: base.x,
          y: 0.08,
          scale: Math.max(0.15, base.scale * 0.75),
          ...common(),
          rotation: 0,
          opacity: 0.2,
          easing: 'linear',
        },
        {
          id: `kf-${Math.random().toString(36).slice(2, 8)}`,
          timeOffset: Math.round(Math.min(1.1, d * 0.55) * 100) / 100,
          x: base.x,
          y: base.y,
          scale: base.scale,
          ...common(),
          rotation: 0,
          opacity: 1,
          easing: 'bounce',
        },
      ];
  }
}

export function generateAdjustmentKeyframePreset(
  clip: Clip,
  preset: 'fade-in' | 'fade-out' | 'fade-in-out' | 'pulse'
): ClipKeyframe[] {
  const base = getBaseClipTransform(clip);
  const d = Math.max(0.4, clip.duration);
  const fadeDur = Math.round(Math.min(0.8, d * 0.4) * 100) / 100;
  const inOutDur = Math.round(Math.min(0.6, d * 0.25) * 100) / 100;
  const common = () => ({
    scaleX: base.scaleX,
    scaleY: base.scaleY,
    flipHorizontal: base.flipHorizontal,
    flipVertical: base.flipVertical,
    ...(base.warp ? {warp: cloneWarp(base.warp)} : {}),
  });

  switch (preset) {
    case 'fade-in':
      return [
        {
          id: `kf-${Math.random().toString(36).slice(2, 8)}`,
          timeOffset: 0,
          x: base.x,
          y: base.y,
          scale: base.scale,
          ...common(),
          rotation: base.rotation,
          opacity: 0,
          easing: 'linear',
        },
        {
          id: `kf-${Math.random().toString(36).slice(2, 8)}`,
          timeOffset: fadeDur,
          x: base.x,
          y: base.y,
          scale: base.scale,
          ...common(),
          rotation: base.rotation,
          opacity: 1,
          easing: 'ease-out',
        },
      ];
    case 'fade-out':
      return [
        {
          id: `kf-${Math.random().toString(36).slice(2, 8)}`,
          timeOffset: Math.max(0, Math.round((d - fadeDur) * 100) / 100),
          x: base.x,
          y: base.y,
          scale: base.scale,
          ...common(),
          rotation: base.rotation,
          opacity: 1,
          easing: 'linear',
        },
        {
          id: `kf-${Math.random().toString(36).slice(2, 8)}`,
          timeOffset: Math.round(d * 100) / 100,
          x: base.x,
          y: base.y,
          scale: base.scale,
          ...common(),
          rotation: base.rotation,
          opacity: 0,
          easing: 'ease-in',
        },
      ];
    case 'fade-in-out':
      return [
        {
          id: `kf-${Math.random().toString(36).slice(2, 8)}`,
          timeOffset: 0,
          x: base.x,
          y: base.y,
          scale: base.scale,
          ...common(),
          rotation: base.rotation,
          opacity: 0,
          easing: 'linear',
        },
        {
          id: `kf-${Math.random().toString(36).slice(2, 8)}`,
          timeOffset: inOutDur,
          x: base.x,
          y: base.y,
          scale: base.scale,
          ...common(),
          rotation: base.rotation,
          opacity: 1,
          easing: 'ease-out',
        },
        {
          id: `kf-${Math.random().toString(36).slice(2, 8)}`,
          timeOffset: Math.max(
            inOutDur,
            Math.round((d - inOutDur) * 100) / 100
          ),
          x: base.x,
          y: base.y,
          scale: base.scale,
          ...common(),
          rotation: base.rotation,
          opacity: 1,
          easing: 'linear',
        },
        {
          id: `kf-${Math.random().toString(36).slice(2, 8)}`,
          timeOffset: Math.round(d * 100) / 100,
          x: base.x,
          y: base.y,
          scale: base.scale,
          ...common(),
          rotation: base.rotation,
          opacity: 0,
          easing: 'ease-in',
        },
      ];
    case 'pulse':
      return [
        {
          id: `kf-${Math.random().toString(36).slice(2, 8)}`,
          timeOffset: 0,
          x: base.x,
          y: base.y,
          scale: base.scale,
          ...common(),
          rotation: base.rotation,
          opacity: 0.2,
          easing: 'linear',
        },
        {
          id: `kf-${Math.random().toString(36).slice(2, 8)}`,
          timeOffset: Math.round(d * 0.5 * 100) / 100,
          x: base.x,
          y: base.y,
          scale: base.scale,
          ...common(),
          rotation: base.rotation,
          opacity: 1,
          easing: 'ease-in-out',
        },
        {
          id: `kf-${Math.random().toString(36).slice(2, 8)}`,
          timeOffset: Math.round(d * 100) / 100,
          x: base.x,
          y: base.y,
          scale: base.scale,
          ...common(),
          rotation: base.rotation,
          opacity: 0.2,
          easing: 'ease-in-out',
        },
      ];
  }
}

export const EASING_OPTIONS: Array<{
  id: KeyframeEasing;
  label: string;
  path: string;
}> = [
  {id: 'linear', label: 'Линия', path: 'M2 18 L18 2'},
  {id: 'ease-in', label: 'Разгон', path: 'M2 18 Q14 18 18 2'},
  {id: 'ease-out', label: 'Тормоз', path: 'M2 18 Q6 2 18 2'},
  {id: 'ease-in-out', label: 'S-кривая', path: 'M2 18 C10 18 10 2 18 2'},
  {id: 'bounce', label: 'Пружина', path: 'M2 18 Q8 1 12 8 T18 2'},
];
