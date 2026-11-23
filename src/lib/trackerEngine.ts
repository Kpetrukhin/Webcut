import type {
  Clip,
  ClipKeyframe,
  MotionTrackerBeacon,
  PolygonPoint,
  TrackerKeyframe,
} from '../shared/types.ts';
import {evaluateClipTransform} from './keyframeEngine.ts';
import type {TrackBbox, TrackPointResult} from './webcutAi.ts';

export const TRACKER_BEACON_COLORS = [
  '#22d3ee',
  '#f472b6',
  '#facc15',
  '#a78bfa',
  '#34d399',
  '#fb923c',
];

export function getDefaultPolygonPoints(): PolygonPoint[] {
  return [
    {id: 'pt-1', x: 0.5, y: 0.34},
    {id: 'pt-2', x: 0.68, y: 0.64},
    {id: 'pt-3', x: 0.32, y: 0.64},
  ];
}

export function clonePolygonPoints(points?: PolygonPoint[]): PolygonPoint[] {
  if (!points || points.length === 0) return getDefaultPolygonPoints();
  return points.map((p) => ({...p}));
}

export function interpolatePolygonPoints(
  a?: PolygonPoint[],
  b?: PolygonPoint[],
  t = 0
): PolygonPoint[] | undefined {
  if (!a && !b) return undefined;
  if (!a) return clonePolygonPoints(b);
  if (!b) return clonePolygonPoints(a);
  if (t <= 0) return clonePolygonPoints(a);
  if (t >= 1) return clonePolygonPoints(b);

  const bById = new Map(b.map((p) => [p.id, p]));
  return a.map((pa, idx) => {
    const pb = bById.get(pa.id) ?? (idx < b.length ? b[idx] : undefined);
    if (!pb) return {...pa};
    return {
      id: pa.id,
      x: pa.x + (pb.x - pa.x) * t,
      y: pa.y + (pb.y - pa.y) * t,
      trackerId: pa.trackerId ?? pb.trackerId,
    };
  });
}

export function evaluateTrackerAtTime(
  tracker: MotionTrackerBeacon,
  globalTime: number
): {x: number; y: number; scale: number; w?: number; h?: number} | null {
  const pts = tracker.points;
  if (!pts || pts.length === 0) return null;

  if (globalTime <= pts[0].time) {
    const p = pts[0];
    return {x: p.x, y: p.y, scale: p.scale ?? 1, w: p.w, h: p.h};
  }
  const last = pts[pts.length - 1];
  if (globalTime >= last.time) {
    return {x: last.x, y: last.y, scale: last.scale ?? 1, w: last.w, h: last.h};
  }

  // Binary search for segment
  let lo = 0;
  let hi = pts.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].time <= globalTime) lo = mid;
    else hi = mid;
  }

  const a = pts[lo];
  const b = pts[hi];
  const span = Math.max(1e-5, b.time - a.time);
  const t = Math.max(0, Math.min(1, (globalTime - a.time) / span));
  const sa = a.scale ?? 1;
  const sb = b.scale ?? 1;

  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    scale: sa + (sb - sa) * t,
    w: a.w !== undefined && b.w !== undefined ? a.w + (b.w - a.w) * t : a.w,
    h: a.h !== undefined && b.h !== undefined ? a.h + (b.h - a.h) * t : a.h,
  };
}

/**
 * Resolves the effective polygon vertices [0..1] in canvas coordinates for a 'points' shape clip
 * at [globalTime], combining keyframed manual vertex positions and bound MotionTrackerBeacons.
 */
export function evaluateShapePoints(
  clip: Clip,
  globalTime: number,
  trackers?: MotionTrackerBeacon[]
): PolygonPoint[] {
  const kf = evaluateClipTransform(clip, globalTime);
  const basePts =
    kf.shapePoints && kf.shapePoints.length >= 2
      ? kf.shapePoints
      : clip.shapeStyle?.points && clip.shapeStyle.points.length >= 2
        ? clip.shapeStyle.points
        : getDefaultPolygonPoints();

  if (!trackers || trackers.length === 0) {
    return basePts.map((p) => ({...p}));
  }

  const trackerMap = new Map(trackers.map((t) => [t.id, t]));
  return basePts.map((pt) => {
    if (!pt.trackerId) return {...pt};
    const beacon = trackerMap.get(pt.trackerId);
    if (!beacon) return {...pt};
    const evaluated = evaluateTrackerAtTime(beacon, globalTime);
    if (!evaluated) return {...pt};
    return {
      ...pt,
      x: evaluated.x,
      y: evaluated.y,
    };
  });
}

export function getPolygonBoundsNorm(points: PolygonPoint[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  centerX: number;
  centerY: number;
  width: number;
  height: number;
} {
  if (points.length === 0) {
    return {
      minX: 0.35,
      minY: 0.35,
      maxX: 0.65,
      maxY: 0.65,
      centerX: 0.5,
      centerY: 0.5,
      width: 0.3,
      height: 0.3,
    };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const width = Math.max(0.04, maxX - minX);
  const height = Math.max(0.04, maxY - minY);
  return {
    minX,
    minY,
    maxX,
    maxY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    width,
    height,
  };
}

function getClipGeometryAtTime(
  clip: Clip,
  globalTime: number,
  cw: number,
  ch: number,
  videoWidth: number,
  videoHeight: number
) {
  const mw = Math.max(16, videoWidth || cw);
  const mh = Math.max(16, videoHeight || ch);
  const crop = clip.crop
    ? {
        x: Math.max(0, Math.min(0.95, clip.crop.x)),
        y: Math.max(0, Math.min(0.95, clip.crop.y)),
        width: Math.max(0.05, Math.min(1 - clip.crop.x, clip.crop.width)),
        height: Math.max(0.05, Math.min(1 - clip.crop.y, clip.crop.height)),
        isCropped:
          clip.crop.x > 0.001 ||
          clip.crop.y > 0.001 ||
          clip.crop.width < 0.999 ||
          clip.crop.height < 0.999,
      }
    : {x: 0, y: 0, width: 1, height: 1, isCropped: false};

  const effW = Math.max(1, mw * crop.width);
  const effH = Math.max(1, mh * crop.height);
  const kf = evaluateClipTransform(clip, globalTime);

  let layerW: number;
  let layerH: number;
  if (clip.track === 'overlay') {
    const aspect = effW / effH;
    layerW = Math.max(12, cw * kf.scale * kf.scaleX);
    layerH = Math.max(12, (cw * kf.scale / aspect) * kf.scaleY);
  } else {
    const baseScale = crop.isCropped
      ? Math.min(cw / effW, ch / effH)
      : Math.max(cw / effW, ch / effH);
    layerW = Math.max(12, effW * baseScale * kf.scale * kf.scaleX);
    layerH = Math.max(12, effH * baseScale * kf.scale * kf.scaleY);
  }

  return {
    crop,
    layerW,
    layerH,
    centerX: cw * kf.x,
    centerY: ch * kf.y,
    rotationRad: (kf.rotation * Math.PI) / 180,
    flipH: kf.flipHorizontal ? -1 : 1,
    flipV: kf.flipVertical ? -1 : 1,
  };
}

/**
 * Converts a normalized canvas bbox (top-left x, y, w, h in [0..1]) into source-video
 * normalized bbox coordinates expected by VitTrackEngine.
 */
export function mapCanvasBboxToVideoSource(
  clip: Clip,
  canvasBbox: TrackBbox,
  globalTime: number,
  cw: number,
  ch: number,
  videoWidth: number,
  videoHeight: number
): TrackBbox {
  const g = getClipGeometryAtTime(clip, globalTime, cw, ch, videoWidth, videoHeight);
  const cosR = Math.cos(g.rotationRad);
  const sinR = Math.sin(g.rotationRad);

  const mapPt = (nx: number, ny: number) => {
    const dx = nx * cw - g.centerX;
    const dy = ny * ch - g.centerY;
    const lx = dx * cosR + dy * sinR;
    const ly = -dx * sinR + dy * cosR;
    const u = lx / (g.layerW * g.flipH) + 0.5;
    const v = ly / (g.layerH * g.flipV) + 0.5;
    return {
      vx: Math.max(0, Math.min(1, g.crop.x + u * g.crop.width)),
      vy: Math.max(0, Math.min(1, g.crop.y + v * g.crop.height)),
    };
  };

  const corners = [
    mapPt(canvasBbox.x, canvasBbox.y),
    mapPt(canvasBbox.x + canvasBbox.w, canvasBbox.y),
    mapPt(canvasBbox.x + canvasBbox.w, canvasBbox.y + canvasBbox.h),
    mapPt(canvasBbox.x, canvasBbox.y + canvasBbox.h),
  ];

  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (const c of corners) {
    if (c.vx < minX) minX = c.vx;
    if (c.vy < minY) minY = c.vy;
    if (c.vx > maxX) maxX = c.vx;
    if (c.vy > maxY) maxY = c.vy;
  }
  const w = Math.max(0.03, Math.min(1, maxX - minX));
  const h = Math.max(0.03, Math.min(1, maxY - minY));
  return {
    x: Math.max(0, Math.min(1 - w, minX)),
    y: Math.max(0, Math.min(1 - h, minY)),
    w,
    h,
  };
}

/**
 * Converts a single source-video tracked point into canvas-normalized coordinates at its timeline timestamp.
 */
export function mapVideoPointToCanvas(
  clip: Clip,
  pt: TrackPointResult,
  cw: number,
  ch: number,
  videoWidth: number,
  videoHeight: number
): TrackerKeyframe {
  const speed = Math.max(0.1, clip.speed || 1);
  const globalTime = clip.start + (pt.timeMs / 1000 - clip.trimStart) / speed;
  const clampedTime = Math.max(clip.start, Math.min(clip.start + clip.duration, globalTime));
  const g = getClipGeometryAtTime(clip, clampedTime, cw, ch, videoWidth, videoHeight);

  const u = (pt.x - g.crop.x) / g.crop.width;
  const v = (pt.y - g.crop.y) / g.crop.height;
  const lx = (u - 0.5) * g.layerW * g.flipH;
  const ly = (v - 0.5) * g.layerH * g.flipV;
  const cosR = Math.cos(g.rotationRad);
  const sinR = Math.sin(g.rotationRad);
  const rx = lx * cosR - ly * sinR;
  const ry = lx * sinR + ly * cosR;

  const canvasX = (g.centerX + rx) / cw;
  const canvasY = (g.centerY + ry) / ch;
  const canvasW = ((pt.w / g.crop.width) * g.layerW) / cw;
  const canvasH = ((pt.h / g.crop.height) * g.layerH) / ch;

  return {
    time: Math.round(clampedTime * 1000) / 1000,
    x: Math.max(-0.5, Math.min(1.5, canvasX)),
    y: Math.max(-0.5, Math.min(1.5, canvasY)),
    scale: pt.scale,
    w: Math.max(0.01, Math.min(1.5, canvasW)),
    h: Math.max(0.01, Math.min(1.5, canvasH)),
    score: pt.score,
  };
}

export function buildTrackerBeaconFromVitTrack(
  name: string,
  sourceClip: Clip,
  rawPoints: TrackPointResult[],
  cw: number,
  ch: number,
  videoWidth: number,
  videoHeight: number,
  colorIndex = 0,
  trackScale = true
): MotionTrackerBeacon {
  const canvasPoints = rawPoints
    .map((pt) => {
      const mapped = mapVideoPointToCanvas(sourceClip, pt, cw, ch, videoWidth, videoHeight);
      return trackScale ? mapped : {...mapped, scale: 1};
    })
    .sort((a, b) => a.time - b.time);

  return {
    id: `trk-${Math.random().toString(36).slice(2, 8)}`,
    name: name.trim() || 'Маяк',
    color: TRACKER_BEACON_COLORS[colorIndex % TRACKER_BEACON_COLORS.length],
    sourceClipId: sourceClip.id,
    trackScale,
    createdAt: Date.now(),
    points: canvasPoints,
  };
}

/**
 * Generates ClipKeyframe[] on [targetClip] from canvas-space tracked points,
 * preserving targetClip's current base scale/rotation/opacity while animating (x, y)
 * and optionally scale when [applyScale] is true.
 */
export function buildClipKeyframesFromTracker(
  targetClip: Clip,
  trackerPoints: TrackerKeyframe[],
  applyScale = true
): ClipKeyframe[] {
  if (trackerPoints.length === 0) return targetClip.keyframes ?? [];
  const startTransform = evaluateClipTransform(targetClip, trackerPoints[0].time);
  const baseScale = startTransform.scale || 0.42;

  const minStep = trackerPoints.length > 70 ? 0.08 : 0.04;
  const sampled: TrackerKeyframe[] = [];
  for (let i = 0; i < trackerPoints.length; i++) {
    const pt = trackerPoints[i];
    if (
      i === 0 ||
      i === trackerPoints.length - 1 ||
      pt.time - sampled[sampled.length - 1].time >= minStep
    ) {
      sampled.push(pt);
    }
  }

  return sampled
    .filter(
      (pt) =>
        pt.time >= targetClip.start - 0.05 &&
        pt.time <= targetClip.start + targetClip.duration + 0.05
    )
    .map((pt) => {
      const timeOffset = Math.round(
        Math.max(0, Math.min(targetClip.duration, pt.time - targetClip.start)) * 100
      ) / 100;
      const evalAt = evaluateClipTransform(targetClip, targetClip.start + timeOffset);
      return {
        id: `kf-${Math.random().toString(36).slice(2, 8)}`,
        timeOffset,
        x: Math.max(0, Math.min(1, pt.x)),
        y: Math.max(0, Math.min(1, pt.y)),
        scale: applyScale
          ? Math.max(0.08, Math.min(3, baseScale * (pt.scale ?? 1)))
          : evalAt.scale,
        scaleX: evalAt.scaleX,
        scaleY: evalAt.scaleY,
        flipHorizontal: evalAt.flipHorizontal,
        flipVertical: evalAt.flipVertical,
        rotation: evalAt.rotation,
        opacity: evalAt.opacity,
        ...(evalAt.warp ? {warp: evalAt.warp} : {}),
        ...(evalAt.shapePoints ? {shapePoints: evalAt.shapePoints} : {}),
        easing: 'linear' as const,
      };
    });
}
