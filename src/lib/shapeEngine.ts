import type {ShapeStyle, ShapeType} from '../shared/types.ts';

export interface ShapeCatalogItem {
  id: ShapeType;
  label: string;
  aspect: number; // default width / height ratio
  defaultCornerRadius: number;
  defaultStrokeWidth: number;
}

export const SHAPE_CATALOG: ShapeCatalogItem[] = [
  {
    id: 'circle',
    label: 'Круг',
    aspect: 1,
    defaultCornerRadius: 0,
    defaultStrokeWidth: 0,
  },
  {
    id: 'ellipse',
    label: 'Эллипс',
    aspect: 1.5,
    defaultCornerRadius: 0,
    defaultStrokeWidth: 0,
  },
  {
    id: 'rectangle',
    label: 'Прямоуг.',
    aspect: 1.5,
    defaultCornerRadius: 0,
    defaultStrokeWidth: 0,
  },
  {
    id: 'rounded_square',
    label: 'Скругл. кв.',
    aspect: 1,
    defaultCornerRadius: 28,
    defaultStrokeWidth: 0,
  },
  {
    id: 'triangle',
    label: 'Треуг.',
    aspect: 1.15,
    defaultCornerRadius: 8,
    defaultStrokeWidth: 0,
  },
  {
    id: 'star',
    label: 'Звезда',
    aspect: 1,
    defaultCornerRadius: 4,
    defaultStrokeWidth: 0,
  },
  {
    id: 'arrow',
    label: 'Стрелка',
    aspect: 1.65,
    defaultCornerRadius: 4,
    defaultStrokeWidth: 0,
  },
  {
    id: 'line',
    label: 'Линия',
    aspect: 3.4,
    defaultCornerRadius: 999,
    defaultStrokeWidth: 0,
  },
  {
    id: 'points',
    label: 'По точкам',
    aspect: 1,
    defaultCornerRadius: 0,
    defaultStrokeWidth: 6,
  },
];

export function getShapeCatalogItem(shapeType: ShapeType): ShapeCatalogItem {
  return (
    SHAPE_CATALOG.find((s) => s.id === shapeType) ?? SHAPE_CATALOG[0]
  );
}

export function getDefaultShapeStyle(shapeType: ShapeType): ShapeStyle {
  const meta = getShapeCatalogItem(shapeType);
  return {
    shapeType,
    fillColor: '#22d3ee',
    fillOpacity: 1,
    fillGradient:
      shapeType === 'points'
        ? {enabled: false, color2: '#a855f7', angle: 135}
        : undefined,
    strokeColor: '#ffffff',
    strokeWidth: meta.defaultStrokeWidth,
    cornerRadius: meta.defaultCornerRadius,
    points:
      shapeType === 'points'
        ? [
            {id: 'pt-1', x: 0.5, y: 0.34},
            {id: 'pt-2', x: 0.68, y: 0.64},
            {id: 'pt-3', x: 0.32, y: 0.64},
          ]
        : undefined,
  };
}

export function normalizeShapeStyle(raw?: Partial<ShapeStyle>): ShapeStyle {
  const shapeType: ShapeType = raw?.shapeType ?? 'circle';
  const meta = getShapeCatalogItem(shapeType);
  return {
    shapeType,
    fillColor: raw?.fillColor || '#22d3ee',
    fillOpacity:
      raw?.fillOpacity !== undefined
        ? Math.max(0, Math.min(1, raw.fillOpacity))
        : 1,
    fillGradient: raw?.fillGradient
      ? {
          enabled: Boolean(raw.fillGradient.enabled),
          color2: raw.fillGradient.color2 || '#a855f7',
          angle: raw.fillGradient.angle ?? 135,
        }
      : undefined,
    strokeColor: raw?.strokeColor || '#ffffff',
    strokeWidth:
      raw?.strokeWidth !== undefined
        ? Math.max(0, Math.min(36, raw.strokeWidth))
        : meta.defaultStrokeWidth,
    cornerRadius:
      raw?.cornerRadius !== undefined
        ? Math.max(0, raw.cornerRadius)
        : meta.defaultCornerRadius,
    points: raw?.points?.map((p) => ({...p})),
  };
}

function traceRoundedPolygon(
  ctx: CanvasRenderingContext2D,
  pts: Array<{x: number; y: number}>,
  cornerRadius: number
) {
  const n = pts.length;
  if (n < 3) return;
  const rBase = Math.max(0, cornerRadius);
  ctx.beginPath();

  if (rBase <= 0.25) {
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < n; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    return;
  }

  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const curr = pts[i];
    const next = pts[(i + 1) % n];

    const v1x = prev.x - curr.x;
    const v1y = prev.y - curr.y;
    const v2x = next.x - curr.x;
    const v2y = next.y - curr.y;

    const len1 = Math.hypot(v1x, v1y);
    const len2 = Math.hypot(v2x, v2y);
    if (len1 < 1e-4 || len2 < 1e-4) continue;

    const maxTrim = Math.min(len1, len2) * 0.42;
    const trim = Math.min(rBase, maxTrim);

    const p1x = curr.x + (v1x / len1) * trim;
    const p1y = curr.y + (v1y / len1) * trim;
    const p2x = curr.x + (v2x / len2) * trim;
    const p2y = curr.y + (v2y / len2) * trim;

    if (i === 0) {
      ctx.moveTo(p1x, p1y);
    } else {
      ctx.lineTo(p1x, p1y);
    }
    ctx.quadraticCurveTo(curr.x, curr.y, p2x, p2y);
  }
  ctx.closePath();
}

/**
 * Traces the vector path for a ShapeStyle centered at (0, 0) inside [-w/2..w/2, -h/2..h/2].
 */
export function traceShapePath(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  style: ShapeStyle,
  sf: number
) {
  const hw = w / 2;
  const hh = h / 2;
  const minHalf = Math.min(hw, hh);
  const rPx = Math.max(0, (style.cornerRadius ?? 0) * sf);

  switch (style.shapeType) {
    case 'circle': {
      ctx.beginPath();
      ctx.ellipse(0, 0, hw, hh, 0, 0, Math.PI * 2);
      break;
    }
    case 'ellipse': {
      ctx.beginPath();
      ctx.ellipse(0, 0, hw, hh, 0, 0, Math.PI * 2);
      break;
    }
    case 'rectangle':
    case 'rounded_square': {
      const clampedR = Math.min(minHalf, rPx);
      ctx.beginPath();
      if (clampedR > 0.25) {
        ctx.roundRect(-hw, -hh, w, h, clampedR);
      } else {
        ctx.rect(-hw, -hh, w, h);
      }
      break;
    }
    case 'triangle': {
      const pts = [
        {x: 0, y: -hh},
        {x: hw, y: hh},
        {x: -hw, y: hh},
      ];
      traceRoundedPolygon(ctx, pts, rPx);
      break;
    }
    case 'star': {
      const pts: Array<{x: number; y: number}> = [];
      const spikes = 5;
      const innerScale = 0.44;
      for (let i = 0; i < spikes * 2; i++) {
        const angle = -Math.PI / 2 + (i * Math.PI) / spikes;
        const radScale = i % 2 === 0 ? 1 : innerScale;
        pts.push({
          x: Math.cos(angle) * hw * radScale,
          y: Math.sin(angle) * hh * radScale,
        });
      }
      traceRoundedPolygon(ctx, pts, rPx);
      break;
    }
    case 'arrow': {
      const shaftHalfH = hh * 0.38;
      const headStart = hw * 0.16;
      const pts = [
        {x: -hw, y: -shaftHalfH},
        {x: headStart, y: -shaftHalfH},
        {x: headStart, y: -hh},
        {x: hw, y: 0},
        {x: headStart, y: hh},
        {x: headStart, y: shaftHalfH},
        {x: -hw, y: shaftHalfH},
      ];
      traceRoundedPolygon(ctx, pts, rPx);
      break;
    }
    case 'line': {
      const thickness = Math.max(
        Math.min(h, Math.max(10 * sf, h * 0.28)),
        Math.min(h, (style.strokeWidth || 0) * sf + 12 * sf)
      );
      const lhh = thickness / 2;
      const clampedR = Math.min(lhh, rPx > 0 ? rPx : lhh);
      ctx.beginPath();
      ctx.roundRect(-hw, -lhh, w, thickness, clampedR);
      break;
    }
  }
}

function resolveFillStyle(
  ctx: CanvasRenderingContext2D,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  style: ShapeStyle
): string | CanvasGradient {
  if (style.fillGradient?.enabled) {
    const angleDeg = style.fillGradient.angle ?? 135;
    const rad = ((angleDeg - 90) * Math.PI) / 180;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const w = Math.max(4, maxX - minX);
    const h = Math.max(4, maxY - minY);
    const halfSpan = (Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad))) / 2;
    const x0 = cx - Math.cos(rad) * halfSpan;
    const y0 = cy - Math.sin(rad) * halfSpan;
    const x1 = cx + Math.cos(rad) * halfSpan;
    const y1 = cy + Math.sin(rad) * halfSpan;
    const grad = ctx.createLinearGradient(x0, y0, x1, y1);
    grad.addColorStop(0, style.fillColor);
    grad.addColorStop(1, style.fillGradient.color2 || '#a855f7');
    return grad;
  }
  return style.fillColor;
}

/**
 * Draws the shape centered at (0, 0) in targetCtx.
 * If maskOnly is true, draws opaque white inside the shape silhouette (for Adjustment Masks).
 */
export function drawShapeGeometry(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  rawStyle: ShapeStyle | undefined,
  sf: number,
  maskOnly = false
) {
  const style = normalizeShapeStyle(rawStyle);
  traceShapePath(ctx, w, h, style, sf);

  if (maskOnly) {
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    if (style.strokeWidth > 0) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = style.strokeWidth * sf;
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
    return;
  }

  if (style.fillOpacity > 0.004) {
    ctx.save();
    ctx.globalAlpha = ctx.globalAlpha * style.fillOpacity;
    ctx.fillStyle = resolveFillStyle(ctx, -w / 2, -h / 2, w / 2, h / 2, style);
    ctx.fill();
    ctx.restore();
  }

  if (style.strokeWidth > 0.1) {
    ctx.save();
    ctx.strokeStyle = style.strokeColor;
    ctx.lineWidth = style.strokeWidth * sf;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * Renders a 2..N vertex polygon/segment shape in targetCtx using already-projected canvas pixel points.
 * - 2 vertices: open line segment rendered with strokeColor & strokeWidth
 * - 3+ vertices: closed polygon with solid/gradient fill, corner rounding, and optional stroke
 */
export function drawPolygonPointsGeometry(
  ctx: CanvasRenderingContext2D,
  pts: Array<{x: number; y: number}>,
  rawStyle: ShapeStyle | undefined,
  sf: number,
  maskOnly = false
) {
  if (pts.length < 2) return;
  const style = normalizeShapeStyle(rawStyle);

  if (pts.length === 2) {
    const strokePx = Math.max(
      maskOnly ? 8 * sf : 2 * sf,
      (style.strokeWidth > 0 ? style.strokeWidth : 6) * sf
    );
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    ctx.lineTo(pts[1].x, pts[1].y);
    ctx.strokeStyle = maskOnly ? '#ffffff' : style.strokeColor || style.fillColor;
    ctx.lineWidth = strokePx;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore();
    return;
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  traceRoundedPolygon(ctx, pts, (style.cornerRadius ?? 0) * sf);

  if (maskOnly) {
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    if (style.strokeWidth > 0) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = style.strokeWidth * sf;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
    }
    return;
  }

  if (style.fillOpacity > 0.004) {
    ctx.save();
    ctx.globalAlpha = ctx.globalAlpha * style.fillOpacity;
    ctx.fillStyle = resolveFillStyle(ctx, minX, minY, maxX, maxY, style);
    ctx.fill();
    ctx.restore();
  }

  if (style.strokeWidth > 0.1) {
    ctx.save();
    ctx.strokeStyle = style.strokeColor;
    ctx.lineWidth = style.strokeWidth * sf;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.restore();
  }
}
