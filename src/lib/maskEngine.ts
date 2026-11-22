import type {Clip, ClipMask, MaskShape} from '../shared/types.ts';
import {evaluateClipTransform} from './keyframeEngine.ts';

export const MASK_SHAPE_OPTIONS: Array<{
  id: MaskShape;
  label: string;
}> = [
  {id: 'horizon', label: 'Горизонт'},
  {id: 'mirror', label: 'Отразить'},
  {id: 'circle', label: 'Круг'},
  {id: 'rectangle', label: 'Прямоуг.'},
  {id: 'heart', label: 'Сердце'},
  {id: 'star', label: 'Звезда'},
];

export function createDefaultMask(
  shape: MaskShape,
  clip: Clip,
  currentTime: number
): ClipMask {
  const tr = evaluateClipTransform(clip, currentTime);
  const isOverlay = clip.track === 'overlay';
  return {
    shape,
    mode: 'inside',
    x: isOverlay ? tr.x : 0.5,
    y: isOverlay ? tr.y : 0.5,
    scale:
      shape === 'mirror'
        ? isOverlay
          ? Math.max(0.2, tr.scale * 0.65)
          : 0.35
        : isOverlay
          ? Math.max(0.22, tr.scale * 0.85)
          : 0.65,
    rotation: 0,
    feather: 0,
  };
}

function traceHeartPath(ctx: CanvasRenderingContext2D, radius: number) {
  const s = Math.max(6, radius);
  const oy = -0.12 * s;
  ctx.moveTo(0, -0.32 * s + oy);
  ctx.bezierCurveTo(
    0.22 * s,
    -0.92 * s + oy,
    1.15 * s,
    -0.82 * s + oy,
    1.05 * s,
    -0.08 * s + oy
  );
  ctx.bezierCurveTo(
    0.96 * s,
    0.42 * s + oy,
    0.38 * s,
    0.68 * s + oy,
    0,
    0.92 * s + oy
  );
  ctx.bezierCurveTo(
    -0.38 * s,
    0.68 * s + oy,
    -0.96 * s,
    0.42 * s + oy,
    -1.05 * s,
    -0.08 * s + oy
  );
  ctx.bezierCurveTo(
    -1.15 * s,
    -0.82 * s + oy,
    -0.22 * s,
    -0.92 * s + oy,
    0,
    -0.32 * s + oy
  );
  ctx.closePath();
}

function traceStarPath(ctx: CanvasRenderingContext2D, radius: number) {
  const outer = Math.max(6, radius);
  const inner = outer * 0.42;
  const points = 5;
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const angle = -Math.PI / 2 + (i * Math.PI) / points;
    const px = Math.cos(angle) * r;
    const py = Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

export function traceMaskFillPath(
  ctx: CanvasRenderingContext2D,
  cw: number,
  ch: number,
  mask: ClipMask,
  extraPad = 0
) {
  const minDim = Math.min(cw, ch);
  const base = Math.max(8, minDim * 0.44 * mask.scale);
  const big = Math.max(cw, ch) * 3 + extraPad * 2;

  ctx.beginPath();
  switch (mask.shape) {
    case 'horizon': {
      ctx.rect(-big, -big, big * 2, big);
      break;
    }
    case 'mirror': {
      const halfBand = Math.max(6, minDim * 0.36 * mask.scale);
      ctx.rect(-big, -halfBand, big * 2, halfBand * 2);
      break;
    }
    case 'circle': {
      ctx.arc(0, 0, base, 0, Math.PI * 2);
      break;
    }
    case 'rectangle': {
      const rw = base * 2.05;
      const rh = base * 1.42;
      ctx.rect(-rw / 2, -rh / 2, rw, rh);
      break;
    }
    case 'heart': {
      traceHeartPath(ctx, base);
      break;
    }
    case 'star': {
      traceStarPath(ctx, base);
      break;
    }
  }
}

let maskWorkCanvas: HTMLCanvasElement | null = null;

export function applyMaskToCanvas(
  clipCanvas: HTMLCanvasElement,
  cw: number,
  ch: number,
  mask: ClipMask
) {
  const clipCtx = clipCanvas.getContext('2d');
  if (!clipCtx) return;

  const minDim = Math.min(cw, ch);
  const featherRatio = Math.max(0, Math.min(100, mask.feather)) / 100;
  const featherPx = featherRatio * minDim * 0.14;
  const pad = featherPx > 0.5 ? Math.ceil(featherPx * 2.6) : 0;
  const workW = cw + pad * 2;
  const workH = ch + pad * 2;

  if (!maskWorkCanvas) {
    maskWorkCanvas = document.createElement('canvas');
  }
  if (maskWorkCanvas.width !== workW || maskWorkCanvas.height !== workH) {
    maskWorkCanvas.width = workW;
    maskWorkCanvas.height = workH;
  }

  const mctx = maskWorkCanvas.getContext('2d');
  if (!mctx) return;

  mctx.save();
  mctx.setTransform(1, 0, 0, 1, 0, 0);
  mctx.globalAlpha = 1;
  mctx.globalCompositeOperation = 'source-over';
  mctx.filter = 'none';
  mctx.clearRect(0, 0, workW, workH);

  mctx.translate(pad + cw * mask.x, pad + ch * mask.y);
  if (mask.rotation) {
    mctx.rotate((mask.rotation * Math.PI) / 180);
  }

  if (featherPx > 0.5 && typeof mctx.filter === 'string') {
    mctx.filter = `blur(${featherPx.toFixed(1)}px)`;
  }

  mctx.fillStyle = '#ffffff';
  traceMaskFillPath(mctx, cw, ch, mask, pad);
  mctx.fill();
  mctx.restore();

  clipCtx.save();
  clipCtx.setTransform(1, 0, 0, 1, 0, 0);
  clipCtx.filter = 'none';
  clipCtx.globalAlpha = 1;
  clipCtx.globalCompositeOperation =
    mask.mode === 'outside' ? 'destination-out' : 'destination-in';
  clipCtx.drawImage(maskWorkCanvas, pad, pad, cw, ch, 0, 0, cw, ch);
  clipCtx.restore();
}

export function drawMaskInteractiveGuide(
  ctx: CanvasRenderingContext2D,
  cw: number,
  ch: number,
  mask: ClipMask
) {
  const sf = cw / 720;
  const minDim = Math.min(cw, ch);
  const base = Math.max(8, minDim * 0.44 * mask.scale);
  const lineSpan = Math.max(cw, ch) * 1.8;

  ctx.save();
  ctx.translate(cw * mask.x, ch * mask.y);
  if (mask.rotation) {
    ctx.rotate((mask.rotation * Math.PI) / 180);
  }

  const drawGuideStroke = (trace: () => void) => {
    ctx.beginPath();
    trace();
    ctx.strokeStyle = 'rgba(9, 9, 11, 0.75)';
    ctx.lineWidth = 4.5 * sf;
    ctx.setLineDash([]);
    ctx.stroke();

    ctx.beginPath();
    trace();
    ctx.strokeStyle = mask.mode === 'outside' ? '#fbbf24' : '#22d3ee';
    ctx.lineWidth = 2.2 * sf;
    ctx.setLineDash([8 * sf, 5 * sf]);
    ctx.stroke();
    ctx.setLineDash([]);
  };

  switch (mask.shape) {
    case 'horizon': {
      drawGuideStroke(() => {
        ctx.moveTo(-lineSpan, 0);
        ctx.lineTo(lineSpan, 0);
      });
      // Small directional arrow showing kept side
      const dir = mask.mode === 'outside' ? 1 : -1;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, dir * 24 * sf);
      ctx.moveTo(-7 * sf, dir * 16 * sf);
      ctx.lineTo(0, dir * 24 * sf);
      ctx.lineTo(7 * sf, dir * 16 * sf);
      ctx.strokeStyle = mask.mode === 'outside' ? '#fbbf24' : '#22d3ee';
      ctx.lineWidth = 2.5 * sf;
      ctx.stroke();
      break;
    }
    case 'mirror': {
      const halfBand = Math.max(6, minDim * 0.36 * mask.scale);
      drawGuideStroke(() => {
        ctx.moveTo(-lineSpan, -halfBand);
        ctx.lineTo(lineSpan, -halfBand);
        ctx.moveTo(-lineSpan, halfBand);
        ctx.lineTo(lineSpan, halfBand);
      });
      break;
    }
    case 'circle': {
      drawGuideStroke(() => {
        ctx.arc(0, 0, base, 0, Math.PI * 2);
      });
      break;
    }
    case 'rectangle': {
      const rw = base * 2.05;
      const rh = base * 1.42;
      drawGuideStroke(() => {
        ctx.rect(-rw / 2, -rh / 2, rw, rh);
      });
      break;
    }
    case 'heart': {
      drawGuideStroke(() => {
        traceHeartPath(ctx, base);
      });
      break;
    }
    case 'star': {
      drawGuideStroke(() => {
        traceStarPath(ctx, base);
      });
      break;
    }
  }

  // Center pivot handle
  ctx.fillStyle = '#09090b';
  ctx.beginPath();
  ctx.arc(0, 0, 7 * sf, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = mask.mode === 'outside' ? '#fbbf24' : '#22d3ee';
  ctx.beginPath();
  ctx.arc(0, 0, 4.5 * sf, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}
