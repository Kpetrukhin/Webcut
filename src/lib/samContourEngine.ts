import type {Clip, PolygonPoint, ShapeStyle} from '../shared/types.ts';

export const SAM_MAGIC_WAND_FILL_HEX = '#00bfff';
export const SAM_MAGIC_WAND_FILL_OPACITY = 0.3;

export interface SamContourExtractionResult {
  points: PolygonPoint[];
  tintedPreviewDataUrl: string | null;
}

/**
 * Downsamples an alpha mask grid cleanly if larger than maxSide so contour tracing stays sub-3ms.
 */
function downsampleAlphaGrid(
  alpha: Uint8Array,
  width: number,
  height: number,
  maxSide: number
): {grid: Uint8Array; w: number; h: number} {
  if (width <= maxSide && height <= maxSide) {
    return {grid: alpha, w: width, h: height};
  }
  const scale = maxSide / Math.max(width, height);
  const w = Math.max(8, Math.round(width * scale));
  const h = Math.max(8, Math.round(height * scale));
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(height - 1, Math.floor(((y + 0.5) * height) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(width - 1, Math.floor(((x + 0.5) * width) / w));
      out[y * w + x] = alpha[sy * width + sx];
    }
  }
  return {grid: out, w, h};
}

function perpDistSq(
  p: {x: number; y: number},
  a: {x: number; y: number},
  b: {x: number; y: number}
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-12) {
    const px = p.x - a.x;
    const py = p.y - a.y;
    return px * px + py * py;
  }
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  const rx = p.x - projX;
  const ry = p.y - projY;
  return rx * rx + ry * ry;
}

function rdpOpen(
  pts: Array<{x: number; y: number}>,
  epsSq: number
): Array<{x: number; y: number}> {
  if (pts.length <= 2) return pts;
  let maxDistSq = -1;
  let splitIdx = -1;
  const first = pts[0];
  const last = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) {
    const dSq = perpDistSq(pts[i], first, last);
    if (dSq > maxDistSq) {
      maxDistSq = dSq;
      splitIdx = i;
    }
  }
  if (splitIdx !== -1 && maxDistSq > epsSq) {
    const left = rdpOpen(pts.slice(0, splitIdx + 1), epsSq);
    const right = rdpOpen(pts.slice(splitIdx), epsSq);
    return [...left.slice(0, -1), ...right];
  }
  return [first, last];
}

function simplifyClosedContour(
  pts: Array<{x: number; y: number}>,
  maxPoints: number,
  minPoints: number
): Array<{x: number; y: number}> {
  if (pts.length <= 3) return pts;

  // Find antipodal anchor split so closed-loop RDP preserves both sides evenly
  let anchorA = 0;
  let anchorB = Math.floor(pts.length / 2);
  let bestDistSq = -1;
  const step = Math.max(1, Math.floor(pts.length / 64));
  for (let i = 0; i < pts.length; i += step) {
    for (let j = i + 1; j < pts.length; j += step) {
      const dx = pts[i].x - pts[j].x;
      const dy = pts[i].y - pts[j].y;
      const d = dx * dx + dy * dy;
      if (d > bestDistSq) {
        bestDistSq = d;
        anchorA = i;
        anchorB = j;
      }
    }
  }
  if (anchorA > anchorB) {
    const tmp = anchorA;
    anchorA = anchorB;
    anchorB = tmp;
  }

  const runClosedRdp = (eps: number): Array<{x: number; y: number}> => {
    const epsSq = eps * eps;
    const arc1 = pts.slice(anchorA, anchorB + 1);
    const arc2 = [...pts.slice(anchorB), ...pts.slice(0, anchorA + 1)];
    const s1 = rdpOpen(arc1, epsSq);
    const s2 = rdpOpen(arc2, epsSq);
    return [...s1.slice(0, -1), ...s2.slice(0, -1)];
  };

  let eps = 0.0022;
  let simplified = runClosedRdp(eps);
  let iter = 0;
  while (simplified.length > maxPoints && iter < 18) {
    eps *= 1.38;
    const next = runClosedRdp(eps);
    if (next.length < minPoints && simplified.length >= minPoints) {
      break;
    }
    simplified = next;
    iter++;
  }

  // If still slightly above maxPoints, evenly thin while keeping shape fidelity
  if (simplified.length > maxPoints) {
    const stride = simplified.length / maxPoints;
    const thinned: Array<{x: number; y: number}> = [];
    for (let i = 0; i < maxPoints; i++) {
      thinned.push(simplified[Math.floor(i * stride)]);
    }
    simplified = thinned;
  }

  return simplified;
}

/**
 * Pure alpha-grid contour extractor (unit-testable in Node without DOM Canvas).
 * Traces the outer boundary of the largest connected foreground component (`alpha >= threshold`)
 * via Moore-Neighbor tracing and simplifies it into normalized `[0..1]` PolygonPoint vertices.
 */
export function extractContourPolygonPointsFromAlphaGrid(
  alpha: Uint8Array,
  width: number,
  height: number,
  options?: {
    threshold?: number;
    maxPoints?: number;
    minPoints?: number;
  }
): PolygonPoint[] {
  const threshold = options?.threshold ?? 128;
  const maxPoints = Math.max(4, options?.maxPoints ?? 44);
  const minPoints = Math.max(3, Math.min(maxPoints, options?.minPoints ?? 6));

  if (width <= 0 || height <= 0 || alpha.length < width * height) {
    return [];
  }

  const {grid, w, h} = downsampleAlphaGrid(alpha, width, height, 200);
  const total = w * h;
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);

  let bestLabelPixels: number[] = [];
  let minFgX = w;
  let minFgY = h;
  let maxFgX = -1;
  let maxFgY = -1;

  for (let i = 0; i < total; i++) {
    if (grid[i] < threshold || visited[i]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = i;
    visited[i] = 1;
    const comp: number[] = [];

    while (head < tail) {
      const cur = queue[head++];
      comp.push(cur);
      const cx = cur % w;
      const cy = (cur / w) | 0;

      if (cx > 0) {
        const nb = cur - 1;
        if (!visited[nb] && grid[nb] >= threshold) {
          visited[nb] = 1;
          queue[tail++] = nb;
        }
      }
      if (cx + 1 < w) {
        const nb = cur + 1;
        if (!visited[nb] && grid[nb] >= threshold) {
          visited[nb] = 1;
          queue[tail++] = nb;
        }
      }
      if (cy > 0) {
        const nb = cur - w;
        if (!visited[nb] && grid[nb] >= threshold) {
          visited[nb] = 1;
          queue[tail++] = nb;
        }
      }
      if (cy + 1 < h) {
        const nb = cur + w;
        if (!visited[nb] && grid[nb] >= threshold) {
          visited[nb] = 1;
          queue[tail++] = nb;
        }
      }
    }

    if (comp.length > bestLabelPixels.length) {
      bestLabelPixels = comp;
    }
  }

  if (bestLabelPixels.length === 0) {
    return [];
  }

  // Isolate ONLY the largest connected component so stray noise never confuses boundary tracing
  const mask = new Uint8Array(total);
  let startIdx = bestLabelPixels[0];
  let startX = w;
  let startY = h;
  for (const idx of bestLabelPixels) {
    mask[idx] = 1;
    const x = idx % w;
    const y = (idx / w) | 0;
    if (x < minFgX) minFgX = x;
    if (y < minFgY) minFgY = y;
    if (x > maxFgX) maxFgX = x;
    if (y > maxFgY) maxFgY = y;
    if (y < startY || (y === startY && x < startX)) {
      startX = x;
      startY = y;
      startIdx = idx;
    }
  }

  const bboxFallback = (): PolygonPoint[] => {
    const x0 = Math.max(0.002, (minFgX + 0.25) / w);
    const y0 = Math.max(0.002, (minFgY + 0.25) / h);
    const x1 = Math.min(0.998, (maxFgX + 0.75) / w);
    const y1 = Math.min(0.998, (maxFgY + 0.75) / h);
    const dx = Math.max(0.01, x1 - x0);
    const dy = Math.max(0.01, y1 - y0);
    return [
      {id: 'sam-pt-0', x: roundNorm(x0), y: roundNorm(y0)},
      {id: 'sam-pt-1', x: roundNorm(Math.min(0.998, x0 + dx)), y: roundNorm(y0)},
      {
        id: 'sam-pt-2',
        x: roundNorm(Math.min(0.998, x0 + dx)),
        y: roundNorm(Math.min(0.998, y0 + dy)),
      },
      {id: 'sam-pt-3', x: roundNorm(x0), y: roundNorm(Math.min(0.998, y0 + dy))},
    ];
  };

  if (bestLabelPixels.length < 4) {
    return bboxFallback();
  }

  // Moore-Neighbor clockwise offsets: N, NE, E, SE, S, SW, W, NW
  const dX = [0, 1, 1, 1, 0, -1, -1, -1];
  const dY = [-1, -1, 0, 1, 1, 1, 0, -1];

  const perimeter: Array<{x: number; y: number}> = [];
  let cx = startX;
  let cy = startY;
  // Came from West (background pixel at startX - 1, startY), so first clockwise check is NW/N
  let enterDir = 6; // W
  let firstNextIdx = -1;
  const maxSteps = Math.min(total * 4, bestLabelPixels.length * 8 + 16);

  perimeter.push({x: (cx + 0.5) / w, y: (cy + 0.5) / h});

  for (let step = 0; step < maxSteps; step++) {
    let found = false;
    const prevIdx = cy * w + cx;
    const startSearch = (enterDir + 1) & 7;
    for (let k = 0; k < 8; k++) {
      const dir = (startSearch + k) & 7;
      const nx = cx + dX[dir];
      const ny = cy + dY[dir];
      if (nx >= 0 && nx < w && ny >= 0 && ny < h && mask[ny * w + nx] === 1) {
        const nextIdx = ny * w + nx;
        if (firstNextIdx === -1) {
          firstNextIdx = nextIdx;
        } else if (prevIdx === startIdx && nextIdx === firstNextIdx) {
          return finishContour(perimeter, maxPoints, minPoints, bboxFallback);
        }

        const oldX = cx;
        const oldY = cy;
        cx = nx;
        cy = ny;
        enterDir = (dir + 4) & 7;
        const prevEmpty = (dir + 7) & 7;
        const px = oldX + dX[prevEmpty];
        const py = oldY + dY[prevEmpty];
        for (let b = 0; b < 8; b++) {
          if (cx + dX[b] === px && cy + dY[b] === py) {
            enterDir = b;
            break;
          }
        }
        found = true;
        break;
      }
    }

    if (!found) break;
    if (cy * w + cx === startIdx && perimeter.length > 2 && firstNextIdx === -1) {
      break;
    }
    perimeter.push({x: (cx + 0.5) / w, y: (cy + 0.5) / h});
  }

  return finishContour(perimeter, maxPoints, minPoints, bboxFallback);
}

function finishContour(
  perimeter: Array<{x: number; y: number}>,
  maxPoints: number,
  minPoints: number,
  bboxFallback: () => PolygonPoint[]
): PolygonPoint[] {
  if (perimeter.length < 3) {
    return bboxFallback();
  }

  const simplified = simplifyClosedContour(perimeter, maxPoints, minPoints);
  if (simplified.length < 3) {
    return bboxFallback();
  }

  const nonce = Math.random().toString(36).slice(2, 6);
  return simplified.map((pt, idx) => ({
    id: `sam-${nonce}-${idx}`,
    x: roundNorm(Math.max(0.002, Math.min(0.998, pt.x))),
    y: roundNorm(Math.max(0.002, Math.min(0.998, pt.y))),
  }));
}

function roundNorm(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/**
 * Loads an encoded PNG mask Data URL (`data:image/png;base64,...`), extracts simplified
 * contour vertices in normalized canvas coords `[0..1]`, and generates a crisp
 * translucent sky-blue (`rgba(0, 191, 255, 0.3)`) bitmap preview overlay.
 */
export async function extractContourFromMaskDataUrl(
  maskDataUrl: string
): Promise<SamContourExtractionResult> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    return {points: [], tintedPreviewDataUrl: null};
  }

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('Не удалось загрузить маску SAM'));
    el.src = maskDataUrl;
  });

  const w = Math.max(1, img.naturalWidth || img.width);
  const h = Math.max(1, img.naturalHeight || img.height);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', {willReadFrequently: true});
  if (!ctx) {
    return {points: [], tintedPreviewDataUrl: null};
  }

  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const imageData = ctx.getImageData(0, 0, w, h);
  const rgba = imageData.data;
  const alphaGrid = new Uint8Array(w * h);

  // Build tinted rgba(0, 191, 255, 0.3) live overlay preview in one pass
  for (let i = 0, p = 0; i < alphaGrid.length; i++, p += 4) {
    const a = rgba[p + 3];
    const lum = Math.max(rgba[p], rgba[p + 1], rgba[p + 2]);
    const fg = a > 127 && lum > 16 ? 255 : 0;
    alphaGrid[i] = fg;
    if (fg > 0) {
      rgba[p] = 0;
      rgba[p + 1] = 191;
      rgba[p + 2] = 255;
      rgba[p + 3] = 77; // ~30% opacity (rgba(0, 191, 255, 0.3))
    } else {
      rgba[p + 3] = 0;
    }
  }
  ctx.putImageData(imageData, 0, 0);

  const points = extractContourPolygonPointsFromAlphaGrid(alphaGrid, w, h, {
    threshold: 128,
    maxPoints: 44,
    minPoints: 6,
  });

  return {
    points,
    tintedPreviewDataUrl: canvas.toDataURL('image/png'),
  };
}

/**
 * Default ShapeStyle for a layer created by Magic Wand:
 * pure sky-blue fill (#00bfff) at 30% opacity (rgba(0, 191, 255, 0.3)), no stroke, no mask.
 */
export function createSamMagicWandShapeStyle(points: PolygonPoint[]): ShapeStyle {
  return {
    shapeType: 'points',
    fillColor: SAM_MAGIC_WAND_FILL_HEX,
    fillOpacity: SAM_MAGIC_WAND_FILL_OPACITY,
    fillGradient: {
      enabled: false,
      color2: '#38bdf8',
      angle: 135,
    },
    strokeColor: SAM_MAGIC_WAND_FILL_HEX,
    strokeWidth: 0,
    cornerRadius: 0,
    points: points.map((p) => ({...p})),
  };
}

export function createSamOverlayShapeClip(opts: {
  points: PolygonPoint[];
  start: number;
  duration?: number;
  name?: string;
}): Omit<Clip, 'trackId'> {
  return {
    id: `clip-${Math.random().toString(36).slice(2, 9)}`,
    track: 'overlay',
    kind: 'shape',
    name: opts.name ?? 'Выделение (Палочка)',
    start: Math.round(opts.start * 100) / 100,
    duration: opts.duration ?? 4.5,
    trimStart: 0,
    sourceDuration: 3600,
    speed: 1,
    volume: 0,
    opacity: 1,
    filter: 'none',
    brightness: 1,
    contrast: 1,
    saturate: 1,
    transitionIn: 'none',
    motionEffect: 'none',
    mediaScale: 1,
    mediaX: 0.5,
    mediaY: 0.5,
    rotation: 0,
    blendMode: 'source-over',
    adjustmentMask: false,
    shapeStyle: createSamMagicWandShapeStyle(opts.points),
  };
}
