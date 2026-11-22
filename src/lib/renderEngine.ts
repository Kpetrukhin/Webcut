import type {
  AspectRatio,
  Clip,
  Collaborator,
  FilterPreset,
  ProjectFont,
  Track,
} from '../shared/types.ts';
import type {StudioAudioEngine} from './audioEngine.ts';
import {applyChromaKeyShader, rgbToHex} from './chromaKeyShader.ts';
import {applyColorGradeShader} from './colorGradeShader.ts';
import {getClipEffectiveAdjustments} from './colorPresets.ts';
import {loadCustomFont, preloadProjectFonts} from './fontLoader.ts';
import {evaluateClipTransform} from './keyframeEngine.ts';
import {applyMaskToCanvas, drawMaskInteractiveGuide} from './maskEngine.ts';
import {resolveMediaSrc} from './serverConfig.ts';

let clipScratchCanvas: HTMLCanvasElement | null = null;
function getClipScratchCtx(cw: number, ch: number): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} | null {
  if (!clipScratchCanvas) {
    clipScratchCanvas = document.createElement('canvas');
  }
  if (clipScratchCanvas.width !== cw || clipScratchCanvas.height !== ch) {
    clipScratchCanvas.width = cw;
    clipScratchCanvas.height = ch;
  }
  const sctx = clipScratchCanvas.getContext('2d');
  if (!sctx) return null;
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.globalAlpha = 1;
  sctx.globalCompositeOperation = 'source-over';
  sctx.filter = 'none';
  sctx.clearRect(0, 0, cw, ch);
  return {canvas: clipScratchCanvas, ctx: sctx};
}

export function getCanvasDimensions(aspect: AspectRatio): {
  width: number;
  height: number;
} {
  switch (aspect) {
    case '16:9':
      return {width: 1280, height: 720};
    case '1:1':
      return {width: 1080, height: 1080};
    case '4:5':
      return {width: 1080, height: 1350};
    case '9:16':
    default:
      return {width: 720, height: 1280};
  }
}

export class MediaPool {
  private images = new Map<string, HTMLImageElement>();
  private videos = new Map<string, HTMLVideoElement>();
  private onAssetReady?: () => void;

  public setOnAssetReady(cb?: () => void) {
    this.onAssetReady = cb;
  }

  public getImage(src: string): HTMLImageElement | null {
    const resolved = resolveMediaSrc(src) || src;
    let img = this.images.get(resolved);
    if (!img) {
      img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        this.onAssetReady?.();
      };
      img.onerror = () => {
        this.onAssetReady?.();
      };
      img.src = resolved;
      this.images.set(resolved, img);
    }
    return img.complete && img.naturalWidth > 0 ? img : null;
  }

  public getVideo(src: string): HTMLVideoElement {
    const resolved = resolveMediaSrc(src) || src;
    let vid = this.videos.get(resolved);
    if (!vid) {
      vid = document.createElement('video');
      vid.crossOrigin = 'anonymous';
      vid.playsInline = true;
      vid.muted = true;
      vid.preload = 'auto';
      vid.onloadeddata = () => {
        this.onAssetReady?.();
      };
      vid.onseeked = () => {
        this.onAssetReady?.();
      };
      vid.src = resolved;
      this.videos.set(resolved, vid);
    }
    return vid;
  }

  public syncVideos(
    clips: Clip[],
    time: number,
    isPlaying: boolean,
    tracks?: Track[]
  ) {
    const hiddenIds = new Set(
      (tracks ?? []).filter((t) => t.hidden).map((t) => t.id)
    );
    const mutedIds = new Set(
      (tracks ?? []).filter((t) => t.muted).map((t) => t.id)
    );
    const activeVideos = new Map<string, Clip>();
    for (const c of clips) {
      if (
        c.kind === 'video' &&
        c.src &&
        !hiddenIds.has(c.trackId) &&
        time >= c.start &&
        time < c.start + c.duration
      ) {
        const resolved = resolveMediaSrc(c.src) || c.src;
        activeVideos.set(resolved, c);
      }
    }

    for (const [src, vid] of this.videos.entries()) {
      const activeClip = activeVideos.get(src);
      if (!activeClip) {
        if (!vid.paused) vid.pause();
        continue;
      }

      const targetTime =
        activeClip.trimStart +
        (time - activeClip.start) * (activeClip.speed || 1);
      vid.playbackRate = activeClip.speed || 1;
      const isMuted =
        mutedIds.has(activeClip.trackId) || activeClip.volume <= 0.01;
      vid.muted = isMuted;
      vid.volume = isMuted ? 0 : Math.max(0, Math.min(1, activeClip.volume));

      if (vid.readyState >= 1) {
        const clampedTarget = Math.min(
          Math.max(0, targetTime),
          Math.max(0, (vid.duration || 60) - 0.05)
        );
        if (
          Math.abs(vid.currentTime - clampedTarget) > (isPlaying ? 0.3 : 0.08)
        ) {
          vid.currentTime = clampedTarget;
        }
      }

      if (isPlaying && vid.paused) {
        void vid.play().catch(() => {});
      } else if (!isPlaying && !vid.paused) {
        vid.pause();
      }
    }
  }
}

export function buildFilterString(
  preset: FilterPreset,
  brightness: number,
  contrast: number,
  saturate: number,
  blur?: number
): string {
  const parts: string[] = [];
  if (brightness !== 1) parts.push(`brightness(${brightness})`);
  if (contrast !== 1) parts.push(`contrast(${contrast})`);
  if (saturate !== 1) parts.push(`saturate(${saturate})`);
  if (blur && blur > 0) parts.push(`blur(${blur}px)`);

  switch (preset) {
    case 'cinema':
      parts.push('contrast(1.12) saturate(0.92) sepia(0.12)');
      break;
    case 'warm':
      parts.push('sepia(0.24) saturate(1.18) brightness(1.03)');
      break;
    case 'cool':
      parts.push('hue-rotate(14deg) saturate(0.95) contrast(1.06)');
      break;
    case 'bw':
      parts.push('grayscale(1) contrast(1.16)');
      break;
    case 'sepia':
      parts.push('sepia(0.75) contrast(1.05)');
      break;
    case 'vintage':
      parts.push('sepia(0.45) contrast(0.92) brightness(1.04)');
      break;
    case 'vivid':
      parts.push('saturate(1.38) contrast(1.08)');
      break;
    case 'none':
    default:
      break;
  }
  return parts.length > 0 ? parts.join(' ') : 'none';
}

function getSourceDims(
  source: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement
): {w: number; h: number} {
  if (source instanceof HTMLVideoElement) {
    return {w: source.videoWidth, h: source.videoHeight};
  }
  if (source instanceof HTMLImageElement) {
    return {w: source.naturalWidth, h: source.naturalHeight};
  }
  return {w: source.width, h: source.height};
}

function getNormalizedCrop(clip: Clip): {
  x: number;
  y: number;
  width: number;
  height: number;
  isCropped: boolean;
} {
  const c = clip.crop;
  if (!c) return {x: 0, y: 0, width: 1, height: 1, isCropped: false};
  const x = Math.max(0, Math.min(0.95, c.x));
  const y = Math.max(0, Math.min(0.95, c.y));
  const width = Math.max(0.05, Math.min(1 - x, c.width));
  const height = Math.max(0.05, Math.min(1 - y, c.height));
  const isCropped =
    x > 0.002 || y > 0.002 || width < 0.998 || height < 0.998;
  return {x, y, width, height, isCropped};
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

function drawDownloadingStub(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  clip: Clip,
  sf: number
) {
  ctx.save();
  ctx.fillStyle = 'rgba(24, 24, 27, 0.92)';
  ctx.fillRect(-w / 2, -h / 2, w, h);

  ctx.strokeStyle = 'rgba(34, 211, 238, 0.5)';
  ctx.lineWidth = 2 * sf;
  ctx.setLineDash([8 * sf, 6 * sf]);
  ctx.strokeRect(-w / 2 + 4 * sf, -h / 2 + 4 * sf, w - 8 * sf, h - 8 * sf);
  ctx.setLineDash([]);

  const pct = Math.max(0, Math.min(100, Math.round(clip.downloadProgress ?? 0)));
  ctx.fillStyle = '#e4e4e7';
  ctx.font = `600 ${Math.max(12, Math.round(16 * sf))}px "Plus Jakarta Sans", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(
    clip.name.slice(0, 22),
    0,
    -14 * sf,
    Math.max(40, w - 24 * sf)
  );

  ctx.fillStyle = '#22d3ee';
  ctx.font = `700 ${Math.max(11, Math.round(14 * sf))}px monospace`;
  ctx.fillText(`Загрузка P2P... ${pct}%`, 0, 8 * sf);

  const barW = Math.min(w * 0.72, 240 * sf);
  const barH = 6 * sf;
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.beginPath();
  ctx.roundRect(-barW / 2, 24 * sf, barW, barH, 3 * sf);
  ctx.fill();

  ctx.fillStyle = '#22d3ee';
  ctx.beginPath();
  ctx.roundRect(-barW / 2, 24 * sf, (barW * pct) / 100, barH, 3 * sf);
  ctx.fill();
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

function drawCoverMedia(
  ctx: CanvasRenderingContext2D,
  media: HTMLImageElement | HTMLVideoElement | null,
  cw: number,
  ch: number,
  clip: Clip,
  time: number,
  progress: number,
  selectedClipId: string | null,
  collaborators: Collaborator[],
  currentUserId?: string
) {
  const mw =
    media instanceof HTMLVideoElement
      ? media.videoWidth
      : media instanceof HTMLImageElement
        ? media.naturalWidth
        : cw;
  const mh =
    media instanceof HTMLVideoElement
      ? media.videoHeight
      : media instanceof HTMLImageElement
        ? media.naturalHeight
        : ch;
  if (!mw || !mh) return;

  const crop = getNormalizedCrop(clip);
  const effW = Math.max(1, mw * crop.width);
  const effH = Math.max(1, mh * crop.height);

  const kf = evaluateClipTransform(clip, time);
  const baseScale = crop.isCropped
    ? Math.min(cw / effW, ch / effH)
    : Math.max(cw / effW, ch / effH);
  let zoom = kf.scale;
  let offsetX = 0;
  const offsetY = 0;

  if (clip.motionEffect === 'kenburns-in') {
    zoom *= 1 + progress * 0.14;
  } else if (clip.motionEffect === 'kenburns-out') {
    zoom *= 1.14 - progress * 0.14;
  } else if (clip.motionEffect === 'pan-left') {
    zoom *= 1.12;
    offsetX = (0.5 - progress) * cw * 0.08;
  } else if (clip.motionEffect === 'pan-right') {
    zoom *= 1.12;
    offsetX = (progress - 0.5) * cw * 0.08;
  }

  const elapsed = progress * clip.duration;
  const remaining = (1 - progress) * clip.duration;
  const transDur = Math.min(0.45, clip.duration * 0.4);
  let transAlpha = kf.opacity;

  if (elapsed < transDur && clip.transitionIn !== 'none') {
    const t = Math.max(0, Math.min(1, elapsed / transDur));
    const eased = 1 - Math.pow(1 - t, 3);
    if (clip.transitionIn === 'fade') {
      transAlpha *= eased;
    } else if (clip.transitionIn === 'zoom') {
      zoom *= 1.25 - 0.25 * eased;
    } else if (clip.transitionIn === 'slide') {
      offsetX += (1 - eased) * cw * 0.35;
    }
  }

  if (
    remaining < transDur &&
    clip.transitionOut &&
    clip.transitionOut !== 'none'
  ) {
    const t = Math.max(0, Math.min(1, remaining / transDur));
    const eased = 1 - Math.pow(1 - t, 3);
    if (clip.transitionOut === 'fade') {
      transAlpha *= eased;
    } else if (clip.transitionOut === 'zoom') {
      zoom *= 1.25 - 0.25 * eased;
    } else if (clip.transitionOut === 'slide') {
      offsetX -= (1 - eased) * cw * 0.35;
    }
  }

  const sxFactor = clip.scaleX ?? 1;
  const syFactor = clip.scaleY ?? 1;
  const drawW = effW * baseScale * zoom * sxFactor;
  const drawH = effH * baseScale * zoom * syFactor;
  const centerX = cw * kf.x + offsetX;
  const centerY = ch * kf.y + offsetY;
  const sf = cw / 720;

  const drawContent = (targetCtx: CanvasRenderingContext2D, alpha: number, composite: GlobalCompositeOperation) => {
    targetCtx.save();
    targetCtx.globalAlpha = Math.max(0, Math.min(1, alpha));
    targetCtx.globalCompositeOperation = composite;
    targetCtx.translate(centerX, centerY);
    if (kf.rotation) targetCtx.rotate((kf.rotation * Math.PI) / 180);

    if (clip.mediaStatus === 'DOWNLOADING' || !media) {
      drawDownloadingStub(targetCtx, drawW, drawH, clip, sf);
    } else {
      let sourceToDraw: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement =
        clip.chromaKeyEnabled &&
        clip.chromaKeyColor &&
        (clip.chromaKeyIntensity ?? 0) > 0
          ? applyChromaKeyShader(
              media,
              mw,
              mh,
              clip.chromaKeyColor,
              clip.chromaKeyIntensity ?? 0,
              clip.chromaKeySmoothness ?? 0.1
            )
          : media;

      const dimsAfterChroma = getSourceDims(sourceToDraw);
      sourceToDraw = applyColorGradeShader(
        sourceToDraw,
        dimsAfterChroma.w || mw,
        dimsAfterChroma.h || mh,
        getClipEffectiveAdjustments(clip),
        time
      );

      const srcDims = getSourceDims(sourceToDraw);
      const sx = crop.x * srcDims.w;
      const sy = crop.y * srcDims.h;
      const sw = crop.width * srcDims.w;
      const sh = crop.height * srcDims.h;

      targetCtx.filter =
        clip.blur && clip.blur > 0 ? `blur(${clip.blur}px)` : 'none';
      if (clip.flipHorizontal || clip.flipVertical) {
        targetCtx.scale(clip.flipHorizontal ? -1 : 1, clip.flipVertical ? -1 : 1);
      }
      targetCtx.drawImage(
        sourceToDraw,
        sx,
        sy,
        sw,
        sh,
        -drawW / 2,
        -drawH / 2,
        drawW,
        drawH
      );
    }
    targetCtx.restore();
  };

  if (clip.mask) {
    const scratch = getClipScratchCtx(cw, ch);
    if (scratch) {
      drawContent(scratch.ctx, 1, 'source-over');
      applyMaskToCanvas(scratch.canvas, cw, ch, clip.mask);
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, transAlpha));
      ctx.globalCompositeOperation = clip.blendMode ?? 'source-over';
      ctx.drawImage(scratch.canvas, 0, 0);
      ctx.restore();
    } else {
      drawContent(ctx, transAlpha, clip.blendMode ?? 'source-over');
    }
  } else {
    drawContent(ctx, transAlpha, clip.blendMode ?? 'source-over');
  }

  if (clip.vignette && clip.vignette > 0 && media) {
    ctx.save();
    const grad = ctx.createRadialGradient(
      cw / 2,
      ch / 2,
      Math.min(cw, ch) * 0.25,
      cw / 2,
      ch / 2,
      Math.max(cw, ch) * 0.72
    );
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, `rgba(0,0,0,${Math.min(0.85, clip.vignette)})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, cw, ch);
    ctx.restore();
  }

  const peerLock = getClipPeerLock(clip, collaborators, currentUserId);
  if (clip.id === selectedClipId || peerLock) {
    const strokeCol = peerLock ? peerLock.color : '#22d3ee';
    ctx.save();
    ctx.translate(centerX, centerY);
    if (kf.rotation) ctx.rotate((kf.rotation * Math.PI) / 180);
    ctx.strokeStyle = strokeCol;
    ctx.lineWidth = (peerLock ? 3 : 2.5) * sf;
    ctx.strokeRect(
      -drawW / 2 + 2 * sf,
      -drawH / 2 + 2 * sf,
      drawW - 4 * sf,
      drawH - 4 * sf
    );
    if (peerLock) {
      drawLockBadge(
        ctx,
        -drawW / 2 + 8 * sf,
        -drawH / 2 + 28 * sf,
        peerLock.name,
        peerLock.color,
        sf
      );
    }
    ctx.restore();
  }
}

function drawOverlayClip(
  ctx: CanvasRenderingContext2D,
  cw: number,
  ch: number,
  clip: Clip,
  time: number,
  pool: MediaPool,
  selectedClipId: string | null,
  collaborators: Collaborator[],
  currentUserId?: string
) {
  const media =
    clip.mediaStatus === 'DOWNLOADING'
      ? null
      : clip.kind === 'video' && clip.src
        ? pool.getVideo(clip.src)
        : clip.src
          ? pool.getImage(clip.src)
          : null;

  const mw =
    media instanceof HTMLVideoElement
      ? media.videoWidth
      : media instanceof HTMLImageElement
        ? media.naturalWidth
        : 0;
  const mh =
    media instanceof HTMLVideoElement
      ? media.videoHeight
      : media instanceof HTMLImageElement
        ? media.naturalHeight
        : 0;

  const crop = getNormalizedCrop(clip);
  const effW = mw * crop.width;
  const effH = mh * crop.height;

  const kf = evaluateClipTransform(clip, time);
  const scale = kf.scale;
  const aspect = effW && effH ? effW / effH : 9 / 16;
  const sxFactor = clip.scaleX ?? 1;
  const syFactor = clip.scaleY ?? 1;
  const pipW = cw * scale * sxFactor;
  const pipH = (cw * scale / aspect) * syFactor;
  const cx = cw * kf.x;
  const cy = ch * kf.y;
  const sf = cw / 720;

  const elapsed = time - clip.start;
  const remaining = clip.start + clip.duration - time;
  const transDur = Math.min(0.4, clip.duration * 0.35);
  let alpha = kf.opacity;
  let animScale = 1;
  if (elapsed < transDur && clip.transitionIn !== 'none') {
    const t = Math.max(0, elapsed / transDur);
    if (clip.transitionIn === 'fade') alpha *= t;
    if (clip.transitionIn === 'zoom') animScale = 0.75 + 0.25 * t;
  }
  if (
    remaining < transDur &&
    clip.transitionOut &&
    clip.transitionOut !== 'none'
  ) {
    const t = Math.max(0, remaining / transDur);
    if (clip.transitionOut === 'fade') alpha *= t;
  }

  const radius = (clip.borderRadius ?? 20) * sf;
  const rotRad = (kf.rotation * Math.PI) / 180;

  const drawOverlayContent = (
    targetCtx: CanvasRenderingContext2D,
    layerAlpha: number,
    composite: GlobalCompositeOperation
  ) => {
    targetCtx.save();
    targetCtx.translate(cx, cy);
    if (rotRad !== 0) targetCtx.rotate(rotRad);
    if (animScale !== 1) targetCtx.scale(animScale, animScale);
    targetCtx.globalAlpha = Math.max(0, Math.min(1, layerAlpha));
    targetCtx.globalCompositeOperation = composite;

    targetCtx.beginPath();
    targetCtx.roundRect(-pipW / 2, -pipH / 2, pipW, pipH, radius);
    targetCtx.clip();

    if (clip.mediaStatus === 'DOWNLOADING' || !media) {
      drawDownloadingStub(targetCtx, pipW, pipH, clip, sf);
    } else if (
      (media instanceof HTMLImageElement || media.readyState >= 2) &&
      mw &&
      mh
    ) {
      let sourceToDraw: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement =
        clip.chromaKeyEnabled &&
        clip.chromaKeyColor &&
        (clip.chromaKeyIntensity ?? 0) > 0
          ? applyChromaKeyShader(
              media,
              mw,
              mh,
              clip.chromaKeyColor,
              clip.chromaKeyIntensity ?? 0,
              clip.chromaKeySmoothness ?? 0.1
            )
          : media;

      const dimsAfterChroma = getSourceDims(sourceToDraw);
      sourceToDraw = applyColorGradeShader(
        sourceToDraw,
        dimsAfterChroma.w || mw,
        dimsAfterChroma.h || mh,
        getClipEffectiveAdjustments(clip),
        time
      );

      const srcDims = getSourceDims(sourceToDraw);
      const sx = crop.x * srcDims.w;
      const sy = crop.y * srcDims.h;
      const sw = crop.width * srcDims.w;
      const sh = crop.height * srcDims.h;

      targetCtx.save();
      if (clip.flipHorizontal || clip.flipVertical) {
        targetCtx.scale(clip.flipHorizontal ? -1 : 1, clip.flipVertical ? -1 : 1);
      }
      targetCtx.filter =
        clip.blur && clip.blur > 0 ? `blur(${clip.blur}px)` : 'none';
      targetCtx.drawImage(
        sourceToDraw,
        sx,
        sy,
        sw,
        sh,
        -pipW / 2,
        -pipH / 2,
        pipW,
        pipH
      );
      targetCtx.restore();
    }
    targetCtx.restore();

    if (clip.borderWidth && clip.borderWidth > 0) {
      targetCtx.save();
      targetCtx.translate(cx, cy);
      if (rotRad !== 0) targetCtx.rotate(rotRad);
      if (animScale !== 1) targetCtx.scale(animScale, animScale);
      targetCtx.globalAlpha = Math.max(0, Math.min(1, layerAlpha));
      targetCtx.strokeStyle = clip.borderColor || '#ffffff';
      targetCtx.lineWidth = clip.borderWidth * sf;
      targetCtx.beginPath();
      targetCtx.roundRect(-pipW / 2, -pipH / 2, pipW, pipH, radius);
      targetCtx.stroke();
      targetCtx.restore();
    }
  };

  if (clip.mask) {
    const scratch = getClipScratchCtx(cw, ch);
    if (scratch) {
      drawOverlayContent(scratch.ctx, 1, 'source-over');
      applyMaskToCanvas(scratch.canvas, cw, ch, clip.mask);
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      ctx.globalCompositeOperation = clip.blendMode ?? 'source-over';
      ctx.drawImage(scratch.canvas, 0, 0);
      ctx.restore();
    } else {
      drawOverlayContent(ctx, alpha, clip.blendMode ?? 'source-over');
    }
  } else {
    drawOverlayContent(ctx, alpha, clip.blendMode ?? 'source-over');
  }

  const peerLock = getClipPeerLock(clip, collaborators, currentUserId);
  if (clip.id === selectedClipId || peerLock) {
    const strokeCol = peerLock ? peerLock.color : '#22d3ee';
    ctx.save();
    ctx.translate(cx, cy);
    if (rotRad !== 0) ctx.rotate(rotRad);
    ctx.strokeStyle = strokeCol;
    ctx.lineWidth = (peerLock ? 3 : 2.5) * sf;
    ctx.beginPath();
    ctx.roundRect(-pipW / 2, -pipH / 2, pipW, pipH, radius);
    ctx.stroke();

    const corners = [
      [-pipW / 2, -pipH / 2],
      [pipW / 2, -pipH / 2],
      [-pipW / 2, pipH / 2],
      [pipW / 2, pipH / 2],
    ];
    ctx.fillStyle = strokeCol;
    for (const [hx, hy] of corners) {
      ctx.beginPath();
      ctx.arc(hx, hy, 5 * sf, 0, Math.PI * 2);
      ctx.fill();
    }
    if (peerLock) {
      drawLockBadge(ctx, -pipW / 2, -pipH / 2, peerLock.name, peerLock.color, sf);
    }
    ctx.restore();
  }
}

function drawTextClip(
  ctx: CanvasRenderingContext2D,
  cw: number,
  ch: number,
  clip: Clip,
  time: number,
  selectedClipId: string | null,
  collaborators: Collaborator[],
  currentUserId?: string
) {
  const style = clip.textStyle ?? {
    fontSize: 48,
    color: '#ffffff',
    bgColor: 'rgba(9,9,11,0.72)',
    fontWeight: 'bold',
    x: 0.5,
    y: 0.78,
    align: 'center',
  };

  if (style.fontFamily && style.fontSrc) {
    void loadCustomFont(style.fontFamily, style.fontSrc);
  }

  const kf = evaluateClipTransform(clip, time);
  const textVal = clip.text ?? clip.name;
  const elapsed = time - clip.start;
  const remaining = clip.start + clip.duration - time;
  const transDur = Math.min(0.35, clip.duration * 0.3);
  let alpha = kf.opacity;
  if (clip.transitionIn === 'fade' && elapsed < transDur) {
    alpha *= Math.max(0, elapsed / transDur);
  }
  if (clip.transitionOut === 'fade' && remaining < transDur) {
    alpha *= Math.max(0, remaining / transDur);
  }

  const scaleFactor = cw / 720;
  const fontSize = Math.round(style.fontSize * scaleFactor * kf.scale);
  const fontFamily = style.fontFamily
    ? `"${style.fontFamily}", "Plus Jakarta Sans", sans-serif`
    : '"Plus Jakarta Sans", sans-serif';

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.font = `${style.fontWeight === 'bold' ? '700' : '500'} ${fontSize}px ${fontFamily}`;
  ctx.textAlign = style.align;
  ctx.textBaseline = 'middle';

  const lines = textVal.split('\n');
  const lineHeight = fontSize * 1.25;
  let maxLineW = 0;
  for (const line of lines) {
    const m = ctx.measureText(line);
    if (m.width > maxLineW) maxLineW = m.width;
  }

  const padX = fontSize * 0.45;
  const padY = fontSize * 0.28;
  const boxW = maxLineW + padX * 2;
  const boxH = lines.length * lineHeight + padY * 2;
  const anchorX = cw * kf.x;
  const anchorY = ch * kf.y;

  let localBoxX = -boxW / 2;
  if (style.align === 'left') localBoxX = -padX;
  if (style.align === 'right') localBoxX = -boxW + padX;
  const localBoxY = -boxH / 2;

  const sxFactor = (clip.scaleX ?? 1) * (clip.flipHorizontal ? -1 : 1);
  const syFactor = (clip.scaleY ?? 1) * (clip.flipVertical ? -1 : 1);

  const drawTextBody = (targetCtx: CanvasRenderingContext2D, layerAlpha: number) => {
    targetCtx.save();
    targetCtx.globalAlpha = Math.max(0, Math.min(1, layerAlpha));
    targetCtx.font = `${style.fontWeight === 'bold' ? '700' : '500'} ${fontSize}px ${fontFamily}`;
    targetCtx.textAlign = style.align;
    targetCtx.textBaseline = 'middle';

    targetCtx.translate(anchorX, anchorY);
    if (kf.rotation !== 0) {
      targetCtx.rotate((kf.rotation * Math.PI) / 180);
    }
    if (sxFactor !== 1 || syFactor !== 1) {
      targetCtx.scale(sxFactor, syFactor);
    }

    if (style.bgColor && style.bgColor !== 'transparent') {
      targetCtx.fillStyle = style.bgColor;
      targetCtx.beginPath();
      targetCtx.roundRect(localBoxX, localBoxY, boxW, boxH, 16 * scaleFactor);
      targetCtx.fill();
    }

    targetCtx.fillStyle = style.color;
    if (style.shadow !== false) {
      targetCtx.shadowColor = 'rgba(0,0,0,0.65)';
      targetCtx.shadowBlur = 10 * scaleFactor;
    }

    lines.forEach((line, i) => {
      const ly = -((lines.length - 1) * lineHeight) / 2 + i * lineHeight;
      if (style.outline) {
        targetCtx.lineWidth = Math.max(2, fontSize * 0.08);
        targetCtx.strokeStyle = '#09090b';
        targetCtx.strokeText(line, 0, ly);
      }
      targetCtx.fillText(line, 0, ly);
    });
    targetCtx.restore();
  };

  if (clip.mask) {
    const scratch = getClipScratchCtx(cw, ch);
    if (scratch) {
      drawTextBody(scratch.ctx, 1);
      applyMaskToCanvas(scratch.canvas, cw, ch, clip.mask);
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      ctx.drawImage(scratch.canvas, 0, 0);
      ctx.restore();
    } else {
      drawTextBody(ctx, alpha);
    }
  } else {
    drawTextBody(ctx, alpha);
  }

  const peerLock = getClipPeerLock(clip, collaborators, currentUserId);
  if (clip.id === selectedClipId || peerLock) {
    ctx.save();
    ctx.translate(anchorX, anchorY);
    if (kf.rotation !== 0) {
      ctx.rotate((kf.rotation * Math.PI) / 180);
    }
    if (sxFactor !== 1 || syFactor !== 1) {
      ctx.scale(sxFactor, syFactor);
    }
    ctx.strokeStyle = peerLock ? peerLock.color : '#22d3ee';
    ctx.lineWidth = (peerLock ? 3 : 2.5) * scaleFactor;
    ctx.strokeRect(
      localBoxX - 6 * scaleFactor,
      localBoxY - 6 * scaleFactor,
      boxW + 12 * scaleFactor,
      boxH + 12 * scaleFactor
    );
    if (peerLock) {
      drawLockBadge(
        ctx,
        localBoxX - 6 * scaleFactor,
        localBoxY - 6 * scaleFactor,
        peerLock.name,
        peerLock.color,
        scaleFactor
      );
    }
    ctx.restore();
  }

  ctx.restore();
}

let sampleCanvas: HTMLCanvasElement | null = null;
export function sampleClipColorAtNormalizedPoint(
  clip: Clip,
  nx: number,
  ny: number,
  cw: number,
  ch: number,
  time: number,
  pool: MediaPool
): string | null {
  if (clip.kind !== 'image' && clip.kind !== 'video') return null;
  if (!clip.src) return null;

  const media =
    clip.kind === 'video' ? pool.getVideo(clip.src) : pool.getImage(clip.src);
  if (!media) return null;
  if (media instanceof HTMLVideoElement && media.readyState < 2) return null;

  const mw =
    media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth;
  const mh =
    media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight;
  if (!mw || !mh) return null;

  if (!sampleCanvas) {
    sampleCanvas = document.createElement('canvas');
    sampleCanvas.width = 1;
    sampleCanvas.height = 1;
  }
  const sctx = sampleCanvas.getContext('2d', {willReadFrequently: true});
  if (!sctx) return null;

  sctx.clearRect(0, 0, 1, 1);
  sctx.save();
  sctx.translate(-nx * cw, -ny * ch);

  const crop = getNormalizedCrop(clip);
  const effW = Math.max(1, mw * crop.width);
  const effH = Math.max(1, mh * crop.height);
  const sx = crop.x * mw;
  const sy = crop.y * mh;
  const sw = crop.width * mw;
  const sh = crop.height * mh;

  const kf = evaluateClipTransform(clip, time);
  const sxFactor = clip.scaleX ?? 1;
  const syFactor = clip.scaleY ?? 1;
  if (clip.track === 'overlay') {
    const aspect = effW / effH;
    const pipW = cw * kf.scale * sxFactor;
    const pipH = (cw * kf.scale / aspect) * syFactor;
    const cx = cw * kf.x;
    const cy = ch * kf.y;
    sctx.translate(cx, cy);
    if (kf.rotation) sctx.rotate((kf.rotation * Math.PI) / 180);
    if (clip.flipHorizontal || clip.flipVertical) {
      sctx.scale(clip.flipHorizontal ? -1 : 1, clip.flipVertical ? -1 : 1);
    }
    sctx.drawImage(media, sx, sy, sw, sh, -pipW / 2, -pipH / 2, pipW, pipH);
  } else {
    const baseScale = crop.isCropped
      ? Math.min(cw / effW, ch / effH)
      : Math.max(cw / effW, ch / effH);
    const drawW = effW * baseScale * kf.scale * sxFactor;
    const drawH = effH * baseScale * kf.scale * syFactor;
    const cx = cw * kf.x;
    const cy = ch * kf.y;
    sctx.translate(cx, cy);
    if (kf.rotation) sctx.rotate((kf.rotation * Math.PI) / 180);
    if (clip.flipHorizontal || clip.flipVertical) {
      sctx.scale(clip.flipHorizontal ? -1 : 1, clip.flipVertical ? -1 : 1);
    }
    sctx.drawImage(media, sx, sy, sw, sh, -drawW / 2, -drawH / 2, drawW, drawH);
  }
  sctx.restore();

  try {
    const pixel = sctx.getImageData(0, 0, 1, 1).data;
    if (pixel[3] < 10) return null;
    return rgbToHex(pixel[0], pixel[1], pixel[2]);
  } catch {
    return null;
  }
}

export function renderCompositeFrame(
  ctx: CanvasRenderingContext2D,
  cw: number,
  ch: number,
  clips: Clip[],
  time: number,
  pool: MediaPool,
  selectedClipId: string | null,
  collaborators: Collaborator[],
  tracks?: Track[],
  backgroundColor?: string,
  snapGuides?: {x: boolean; y: boolean},
  currentUserId?: string,
  maskEditClipId?: string | null
) {
  ctx.fillStyle = backgroundColor || '#09090b';
  ctx.fillRect(0, 0, cw, ch);

  const trackList = tracks ?? [];
  const hiddenTrackIds = new Set(
    trackList.filter((t) => t.hidden).map((t) => t.id)
  );

  const trackOrder = new Map<string, number>();
  trackList.forEach((t, i) => trackOrder.set(t.id, i));

  const fallbackRank = (type: Clip['track']) =>
    type === 'video' ? 0 : type === 'overlay' ? 1 : 2;

  const activeVisualClips = clips
    .filter(
      (c) =>
        c.track !== 'audio' &&
        !hiddenTrackIds.has(c.trackId) &&
        time >= c.start &&
        time < c.start + c.duration
    )
    .sort((a, b) => {
      const ta = trackOrder.get(a.trackId);
      const tb = trackOrder.get(b.trackId);
      if (ta !== undefined && tb !== undefined && ta !== tb) {
        return ta - tb;
      }
      if (ta !== undefined && tb === undefined) return -1;
      if (ta === undefined && tb !== undefined) return 1;
      const fa = fallbackRank(a.track);
      const fb = fallbackRank(b.track);
      if (fa !== fb) return fa - fb;
      return a.start - b.start;
    });

  // Render all visual layers from top track (lowest Z-index / background)
  // to bottom track (highest Z-index / foreground).
  for (const clip of activeVisualClips) {
    if (clip.track === 'video') {
      const progress = Math.max(
        0,
        Math.min(1, (time - clip.start) / Math.max(0.01, clip.duration))
      );
      if (clip.mediaStatus === 'DOWNLOADING') {
        drawCoverMedia(
          ctx,
          null,
          cw,
          ch,
          clip,
          time,
          progress,
          selectedClipId,
          collaborators,
          currentUserId
        );
      } else if (clip.kind === 'image' && clip.src) {
        const img = pool.getImage(clip.src);
        drawCoverMedia(
          ctx,
          img,
          cw,
          ch,
          clip,
          time,
          progress,
          selectedClipId,
          collaborators,
          currentUserId
        );
      } else if (clip.kind === 'video' && clip.src) {
        const vid = pool.getVideo(clip.src);
        drawCoverMedia(
          ctx,
          vid.readyState >= 2 ? vid : null,
          cw,
          ch,
          clip,
          time,
          progress,
          selectedClipId,
          collaborators,
          currentUserId
        );
      }
    } else if (clip.track === 'overlay') {
      drawOverlayClip(
        ctx,
        cw,
        ch,
        clip,
        time,
        pool,
        selectedClipId,
        collaborators,
        currentUserId
      );
    } else if (clip.track === 'text') {
      drawTextClip(
        ctx,
        cw,
        ch,
        clip,
        time,
        selectedClipId,
        collaborators,
        currentUserId
      );
    }
  }

  // Interactive Mask Guide Overlay (only while editing mask in preview)
  if (maskEditClipId) {
    const maskClip = activeVisualClips.find((c) => c.id === maskEditClipId);
    if (maskClip?.mask) {
      drawMaskInteractiveGuide(ctx, cw, ch, maskClip.mask);
    }
  }

  // 4. Magnetic Center Snap Guide Lines
  if (snapGuides && (snapGuides.x || snapGuides.y)) {
    const sf = cw / 720;
    ctx.save();
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 2 * sf;
    ctx.shadowColor = 'rgba(34, 211, 238, 0.7)';
    ctx.shadowBlur = 6 * sf;
    if (snapGuides.x) {
      ctx.beginPath();
      ctx.moveTo(cw / 2, 0);
      ctx.lineTo(cw / 2, ch);
      ctx.stroke();
    }
    if (snapGuides.y) {
      ctx.beginPath();
      ctx.moveTo(0, ch / 2);
      ctx.lineTo(cw, ch / 2);
      ctx.stroke();
    }
    ctx.restore();
  }
}

export async function exportProjectToVideo(opts: {
  clips: Clip[];
  tracks: Track[];
  aspectRatio: AspectRatio;
  backgroundColor?: string;
  customFonts?: ProjectFont[];
  duration: number;
  pool: MediaPool;
  audioEngine: StudioAudioEngine;
  onProgress: (pct: number) => void;
}): Promise<{blob: Blob; ext: string}> {
  await preloadProjectFonts(opts.customFonts);
  for (const c of opts.clips) {
    if (c.textStyle?.fontFamily && c.textStyle?.fontSrc) {
      await loadCustomFont(c.textStyle.fontFamily, c.textStyle.fontSrc);
    }
  }

  const {width, height} = getCanvasDimensions(opts.aspectRatio);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Не удалось создать Canvas 2D контекст');

  const fps = 30;
  const stream = canvas.captureStream(fps);
  const audioStream = opts.audioEngine.getExportAudioStream(opts.clips);
  if (audioStream) {
    for (const track of audioStream.getAudioTracks()) {
      stream.addTrack(track);
    }
  }

  const mimeCandidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4',
  ];
  const mimeType =
    mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';

  const recorder = new MediaRecorder(
    stream,
    mimeType
      ? {mimeType, videoBitsPerSecond: 4_500_000}
      : {videoBitsPerSecond: 4_500_000}
  );
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  const donePromise = new Promise<Blob>((resolve) => {
    recorder.onstop = () => {
      resolve(new Blob(chunks, {type: mimeType || 'video/webm'}));
    };
  });

  recorder.start(200);
  const totalDuration = Math.max(1, opts.duration);
  const startWall = performance.now();

  await new Promise<void>((resolve) => {
    const tick = () => {
      const elapsedSec = (performance.now() - startWall) / 1000;
      const t = Math.min(totalDuration, elapsedSec);
      opts.pool.syncVideos(opts.clips, t, true, opts.tracks);
      opts.audioEngine.sync(opts.clips, t, true, opts.tracks);
      renderCompositeFrame(
        ctx,
        width,
        height,
        opts.clips,
        t,
        opts.pool,
        null,
        [],
        opts.tracks,
        opts.backgroundColor
      );
      opts.onProgress(Math.min(99, Math.round((t / totalDuration) * 100)));

      if (t >= totalDuration) {
        opts.audioEngine.stopAll();
        opts.audioEngine.clearExportDestination();
        opts.pool.syncVideos(opts.clips, 0, false, opts.tracks);
        resolve();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  recorder.stop();
  const blob = await donePromise;
  opts.onProgress(100);
  const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
  return {blob, ext};
}
