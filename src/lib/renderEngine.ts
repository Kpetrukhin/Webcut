import type {
  AspectRatio,
  CanvasBackground,
  Clip,
  Collaborator,
  FilterPreset,
  ProjectFont,
  Track,
} from '../shared/types.ts';
import type {StudioAudioEngine} from './audioEngine.ts';
import {applyChromaKeyShader, rgbToHex} from './chromaKeyShader.ts';
import {applyColorGradeShader} from './colorGradeShader.ts';
import {
  getClipEffectiveAdjustments,
  isNeutralColorGrade,
} from './colorPresets.ts';
import {loadCustomFont, preloadProjectFonts} from './fontLoader.ts';
import {evaluateClipTransform} from './keyframeEngine.ts';
import {applyMaskToCanvas, drawMaskInteractiveGuide} from './maskEngine.ts';
import {resolveMediaSrc} from './serverConfig.ts';
import {
  drawShapeGeometry,
  getShapeCatalogItem,
  normalizeShapeStyle,
} from './shapeEngine.ts';
import {
  drawTextClipCanvas,
  getTextClipUnwarpedBox,
} from './textRenderer.ts';
import {
  getWarpedOutlinePolygon,
  isIdentityWarp,
  renderWarpedLayer,
} from './warpEngine.ts';

function createOrResizeScratch(
  existing: HTMLCanvasElement | null,
  cw: number,
  ch: number
): {
  owner: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} | null {
  const canvas = existing ?? document.createElement('canvas');
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  }
  const sctx = canvas.getContext('2d');
  if (!sctx) return null;
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.globalAlpha = 1;
  sctx.globalCompositeOperation = 'source-over';
  sctx.filter = 'none';
  sctx.clearRect(0, 0, cw, ch);
  return {owner: canvas, ctx: sctx};
}

let clipScratchCanvas: HTMLCanvasElement | null = null;
function getClipScratchCtx(cw: number, ch: number): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} | null {
  const res = createOrResizeScratch(clipScratchCanvas, cw, ch);
  if (!res) return null;
  clipScratchCanvas = res.owner;
  return {canvas: res.owner, ctx: res.ctx};
}

let adjMaskAlphaCanvas: HTMLCanvasElement | null = null;
function getAdjMaskAlphaCtx(cw: number, ch: number) {
  const res = createOrResizeScratch(adjMaskAlphaCanvas, cw, ch);
  if (!res) return null;
  adjMaskAlphaCanvas = res.owner;
  return {canvas: res.owner, ctx: res.ctx};
}

let adjMaskEffectCanvas: HTMLCanvasElement | null = null;
function getAdjMaskEffectCtx(cw: number, ch: number) {
  const res = createOrResizeScratch(adjMaskEffectCanvas, cw, ch);
  if (!res) return null;
  adjMaskEffectCanvas = res.owner;
  return {canvas: res.owner, ctx: res.ctx};
}

let layerOffscreenCanvas: HTMLCanvasElement | null = null;
function getLayerOffscreenCtx(cw: number, ch: number) {
  const res = createOrResizeScratch(layerOffscreenCanvas, cw, ch);
  if (!res) return null;
  layerOffscreenCanvas = res.owner;
  return {canvas: res.owner, ctx: res.ctx};
}

let blurPadCanvas: HTMLCanvasElement | null = null;
function drawEdgeSafeBlur(
  targetCtx: CanvasRenderingContext2D,
  src: HTMLCanvasElement,
  cw: number,
  ch: number,
  blurPx: number
) {
  if (blurPx <= 0.2) {
    targetCtx.drawImage(src, 0, 0, cw, ch);
    return;
  }
  const pad = Math.min(96, Math.max(8, Math.ceil(blurPx * 2)));
  const pw = cw + pad * 2;
  const ph = ch + pad * 2;
  if (!blurPadCanvas) {
    blurPadCanvas = document.createElement('canvas');
  }
  if (blurPadCanvas.width !== pw || blurPadCanvas.height !== ph) {
    blurPadCanvas.width = pw;
    blurPadCanvas.height = ph;
  }
  const pctx = blurPadCanvas.getContext('2d');
  if (!pctx) {
    targetCtx.save();
    targetCtx.filter = `blur(${blurPx}px)`;
    targetCtx.drawImage(src, 0, 0, cw, ch);
    targetCtx.restore();
    return;
  }
  pctx.setTransform(1, 0, 0, 1, 0, 0);
  pctx.clearRect(0, 0, pw, ph);
  // Center image + clamped 1px edge extensions so blur never darkens edges
  pctx.drawImage(src, 0, 0, cw, ch, pad, pad, cw, ch);
  pctx.drawImage(src, 0, 0, 1, ch, 0, pad, pad, ch);
  pctx.drawImage(src, cw - 1, 0, 1, ch, pad + cw, pad, pad, ch);
  pctx.drawImage(src, 0, 0, cw, 1, pad, 0, cw, pad);
  pctx.drawImage(src, 0, ch - 1, cw, 1, pad, pad + ch, cw, pad);
  pctx.drawImage(src, 0, 0, 1, 1, 0, 0, pad, pad);
  pctx.drawImage(src, cw - 1, 0, 1, 1, pad + cw, 0, pad, pad);
  pctx.drawImage(src, 0, ch - 1, 1, 1, 0, pad + ch, pad, pad);
  pctx.drawImage(src, cw - 1, ch - 1, 1, 1, pad + cw, pad + ch, pad, pad);

  targetCtx.save();
  targetCtx.filter = `blur(${blurPx}px)`;
  targetCtx.drawImage(blurPadCanvas, pad, pad, cw, ch, 0, 0, cw, ch);
  targetCtx.restore();
}

export interface ClipLayerBox {
  centerX: number;
  centerY: number;
  layerW: number;
  layerH: number;
  rotationDeg: number;
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
    case '3:4':
      return {width: 960, height: 1280};
    case '21:9':
      return {width: 1680, height: 720};
    case '9:16':
    default:
      return {width: 720, height: 1280};
  }
}

interface DecodedAnimFrame {
  bitmap: ImageBitmap;
  endTimeMs: number;
}

interface DecodedAnimEntry {
  status: 'loading' | 'animated' | 'static';
  frames: DecodedAnimFrame[];
  totalDurationMs: number;
  canvas: HTMLCanvasElement | null;
  lastFrameIdx: number;
}

interface WebCodecsDecodedResult {
  image: VideoFrame;
}

interface WebCodecsImageDecoder {
  completed: Promise<void>;
  tracks: {
    ready: Promise<void>;
    selectedTrack: {frameCount: number; repetitionCount?: number} | null;
  };
  decode(opts: {frameIndex: number}): Promise<WebCodecsDecodedResult>;
  close(): void;
}

interface WebCodecsImageDecoderCtor {
  new (init: {data: ArrayBuffer | Uint8Array; type: string}): WebCodecsImageDecoder;
  isTypeSupported?: (type: string) => Promise<boolean>;
}

export class MediaPool {
  private images = new Map<string, HTMLImageElement>();
  private videos = new Map<string, HTMLVideoElement>();
  private animatedImages = new Map<string, DecodedAnimEntry>();
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

  public getAnimatedImageSource(
    src: string,
    elapsedSec: number
  ): HTMLCanvasElement | HTMLImageElement | null {
    const resolved = resolveMediaSrc(src) || src;
    const fallbackImg = this.getImage(src);

    const DecoderCtor = (
      typeof window !== 'undefined'
        ? (window as unknown as {ImageDecoder?: WebCodecsImageDecoderCtor})
            .ImageDecoder
        : undefined
    );
    if (!DecoderCtor) {
      return fallbackImg;
    }

    let entry = this.animatedImages.get(resolved);
    if (!entry) {
      entry = {
        status: 'loading',
        frames: [],
        totalDurationMs: 0,
        canvas: null,
        lastFrameIdx: -1,
      };
      this.animatedImages.set(resolved, entry);
      void this.decodeAnimatedImage(resolved, entry, DecoderCtor);
    }

    if (entry.status !== 'animated' || entry.frames.length === 0) {
      return fallbackImg;
    }

    const loopMs = Math.max(100, entry.totalDurationMs);
    const modMs = ((elapsedSec * 1000) % loopMs + loopMs) % loopMs;
    let frameIdx = entry.frames.findIndex((f) => modMs < f.endTimeMs);
    if (frameIdx < 0) frameIdx = entry.frames.length - 1;

    const frame = entry.frames[frameIdx];
    if (!entry.canvas) {
      entry.canvas = document.createElement('canvas');
      entry.canvas.width = frame.bitmap.width;
      entry.canvas.height = frame.bitmap.height;
    }
    if (entry.lastFrameIdx !== frameIdx) {
      const cctx = entry.canvas.getContext('2d');
      if (cctx) {
        cctx.clearRect(0, 0, entry.canvas.width, entry.canvas.height);
        cctx.drawImage(frame.bitmap, 0, 0);
      }
      entry.lastFrameIdx = frameIdx;
    }

    return entry.canvas;
  }

  private async decodeAnimatedImage(
    resolvedUrl: string,
    entry: DecodedAnimEntry,
    DecoderCtor: WebCodecsImageDecoderCtor
  ) {
    let decoder: WebCodecsImageDecoder | null = null;
    try {
      const res = await fetch(resolvedUrl);
      if (!res.ok) {
        entry.status = 'static';
        return;
      }
      const contentType = res.headers.get('content-type')?.split(';')[0]?.trim();
      const buffer = await res.arrayBuffer();
      const guessedType =
        contentType && contentType.startsWith('image/')
          ? contentType
          : /\.gif(\?|#|$)/i.test(resolvedUrl)
            ? 'image/gif'
            : 'image/webp';

      if (DecoderCtor.isTypeSupported) {
        const supported = await DecoderCtor.isTypeSupported(guessedType);
        if (!supported) {
          entry.status = 'static';
          return;
        }
      }

      decoder = new DecoderCtor({data: buffer, type: guessedType});
      await decoder.tracks.ready;
      const frameCount = decoder.tracks.selectedTrack?.frameCount ?? 1;
      if (frameCount <= 1) {
        entry.status = 'static';
        return;
      }

      const maxFrames = Math.min(frameCount, 120);
      const frames: DecodedAnimFrame[] = [];
      let accumMs = 0;

      for (let i = 0; i < maxFrames; i++) {
        const result = await decoder.decode({frameIndex: i});
        const vf = result.image;
        const durUs = typeof vf.duration === 'number' && vf.duration > 0 ? vf.duration : 80_000;
        const durMs = Math.max(20, durUs / 1000);
        const bitmap = await createImageBitmap(vf);
        vf.close();
        accumMs += durMs;
        frames.push({bitmap, endTimeMs: accumMs});
      }

      if (frames.length > 1) {
        entry.frames = frames;
        entry.totalDurationMs = accumMs;
        entry.status = 'animated';
        this.onAssetReady?.();
      } else {
        for (const f of frames) f.bitmap.close();
        entry.status = 'static';
      }
    } catch {
      entry.status = 'static';
    } finally {
      try {
        decoder?.close();
      } catch {
        // ignore close errors
      }
    }
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
    tracks?: Track[],
    audioEngine?: StudioAudioEngine
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
        audioEngine?.syncVideoElementAudio(vid, undefined, false, true);
        continue;
      }

      const targetTime =
        activeClip.trimStart +
        (time - activeClip.start) * (activeClip.speed || 1);
      try {
        vid.playbackRate = Math.max(
          0.0625,
          Math.min(16, activeClip.speed || 1)
        );
      } catch {
        // Ignore unsupported browser playbackRate extremes
      }
      const trackMuted = mutedIds.has(activeClip.trackId);
      const isMuted = trackMuted || activeClip.volume <= 0.01;
      if (audioEngine) {
        audioEngine.syncVideoElementAudio(vid, activeClip, isPlaying, trackMuted);
      } else {
        vid.muted = isMuted;
        vid.volume = isMuted ? 0 : Math.max(0, Math.min(1, activeClip.volume));
      }

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

  const drawContent = (
    targetCtx: CanvasRenderingContext2D,
    alpha: number,
    composite: GlobalCompositeOperation,
    maskOnly = false
  ) => {
    const hasWarp = !isIdentityWarp(kf.warp);
    targetCtx.save();
    targetCtx.globalAlpha = Math.max(0, Math.min(1, alpha));
    targetCtx.globalCompositeOperation = composite;

    if (clip.mediaStatus === 'DOWNLOADING' || !media) {
      targetCtx.translate(centerX, centerY);
      if (kf.rotation) targetCtx.rotate((kf.rotation * Math.PI) / 180);
      drawDownloadingStub(targetCtx, drawW, drawH, clip, sf);
      targetCtx.restore();
      return;
    }

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

    if (!maskOnly) {
      const dimsAfterChroma = getSourceDims(sourceToDraw);
      sourceToDraw = applyColorGradeShader(
        sourceToDraw,
        dimsAfterChroma.w || mw,
        dimsAfterChroma.h || mh,
        getClipEffectiveAdjustments(clip),
        time
      );
    }

    const srcDims = getSourceDims(sourceToDraw);
    const sx = crop.x * srcDims.w;
    const sy = crop.y * srcDims.h;
    const sw = crop.width * srcDims.w;
    const sh = crop.height * srcDims.h;

    if (hasWarp && kf.warp) {
      const warped = renderWarpedLayer({
        source: sourceToDraw,
        cropRect: {x: crop.x, y: crop.y, w: crop.width, h: crop.height},
        flipH: Boolean(clip.flipHorizontal),
        flipV: Boolean(clip.flipVertical),
        centerX,
        centerY,
        layerW: drawW,
        layerH: drawH,
        rotationDeg: kf.rotation,
        warp: kf.warp,
        cw,
        ch,
      });
      if (warped) {
        if (!maskOnly && clip.blur && clip.blur > 0) {
          targetCtx.filter = `blur(${clip.blur}px)`;
        }
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

    targetCtx.translate(centerX, centerY);
    if (kf.rotation) targetCtx.rotate((kf.rotation * Math.PI) / 180);
    if (!maskOnly && clip.blur && clip.blur > 0) {
      targetCtx.filter = `blur(${clip.blur}px)`;
    }
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
    targetCtx.restore();
  };

  if (clip.adjustmentMask) {
    const maskBuf = getAdjMaskAlphaCtx(cw, ch);
    if (maskBuf) {
      drawContent(maskBuf.ctx, 1, 'source-over', true);
      if (clip.mask) {
        applyMaskToCanvas(maskBuf.canvas, cw, ch, clip.mask);
      }
      applyObjectAdjustmentMask(ctx, cw, ch, clip, time, maskBuf.canvas, transAlpha);
    }
  } else if (clip.mask) {
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

  if (!clip.adjustmentMask && clip.vignette && clip.vignette > 0 && media) {
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
    drawLayerSelectionOutline(
      ctx,
      centerX,
      centerY,
      drawW,
      drawH,
      kf.rotation,
      kf.warp,
      0,
      clip.adjustmentMask ? '#c084fc' : '#22d3ee',
      peerLock,
      sf,
      Boolean(clip.adjustmentMask)
    );
  }
}

function drawLayerSelectionOutline(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  layerW: number,
  layerH: number,
  rotationDeg: number,
  warp: Clip['warp'],
  cornerRadiusPx: number,
  defaultColor: string,
  peerLock: {color: string; name: string} | null,
  sf: number,
  dashed = false,
  drawCornerDots = false
) {
  const strokeCol = peerLock ? peerLock.color : defaultColor;
  if (!isIdentityWarp(warp) && warp) {
    const poly = getWarpedOutlinePolygon(
      centerX,
      centerY,
      layerW,
      layerH,
      rotationDeg,
      warp
    );
    ctx.save();
    ctx.strokeStyle = strokeCol;
    ctx.lineWidth = (peerLock ? 3 : 2.5) * sf;
    if (dashed && !peerLock) ctx.setLineDash([7 * sf, 5 * sf]);
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
    return;
  }

  ctx.save();
  ctx.translate(centerX, centerY);
  if (rotationDeg) ctx.rotate((rotationDeg * Math.PI) / 180);
  ctx.strokeStyle = strokeCol;
  ctx.lineWidth = (peerLock ? 3 : 2.5) * sf;
  if (dashed && !peerLock) ctx.setLineDash([7 * sf, 5 * sf]);
  ctx.beginPath();
  if (cornerRadiusPx > 0) {
    ctx.roundRect(-layerW / 2, -layerH / 2, layerW, layerH, cornerRadiusPx);
  } else {
    ctx.rect(-layerW / 2, -layerH / 2, layerW, layerH);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  if (drawCornerDots) {
    const corners = [
      [-layerW / 2, -layerH / 2],
      [layerW / 2, -layerH / 2],
      [-layerW / 2, layerH / 2],
      [layerW / 2, layerH / 2],
    ];
    ctx.fillStyle = strokeCol;
    for (const [hx, hy] of corners) {
      ctx.beginPath();
      ctx.arc(hx, hy, 5 * sf, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  if (peerLock) {
    drawLockBadge(
      ctx,
      -layerW / 2 + 6 * sf,
      -layerH / 2 + 24 * sf,
      peerLock.name,
      peerLock.color,
      sf
    );
  }
  ctx.restore();
}

function applyObjectAdjustmentMask(
  ctx: CanvasRenderingContext2D,
  cw: number,
  ch: number,
  clip: Clip,
  time: number,
  maskCanvas: HTMLCanvasElement,
  effectAlpha: number
) {
  const clampedAlpha = Math.max(0, Math.min(1, effectAlpha));
  if (clampedAlpha <= 0.001) return;

  const grade = getClipEffectiveAdjustments(clip);
  const hasGrade = !isNeutralColorGrade(grade);
  const blurPx = clip.blur ?? 0;
  const hasBlur = blurPx > 0.2;
  const hasVignette = Boolean(clip.vignette && clip.vignette > 0);
  if (!hasGrade && !hasBlur && !hasVignette) return;

  const effectBuf = getAdjMaskEffectCtx(cw, ch);
  if (!effectBuf) return;

  let gradedSource: HTMLCanvasElement = ctx.canvas;
  if (hasGrade) {
    const res = applyColorGradeShader(ctx.canvas, cw, ch, grade, time);
    if (res instanceof HTMLCanvasElement) {
      gradedSource = res;
    }
  }

  if (hasBlur) {
    drawEdgeSafeBlur(effectBuf.ctx, gradedSource, cw, ch, blurPx * (cw / 720));
  } else {
    effectBuf.ctx.drawImage(gradedSource, 0, 0, cw, ch);
  }

  if (hasVignette) {
    effectBuf.ctx.save();
    effectBuf.ctx.globalCompositeOperation = 'source-atop';
    const grad = effectBuf.ctx.createRadialGradient(
      cw / 2,
      ch / 2,
      Math.min(cw, ch) * 0.25,
      cw / 2,
      ch / 2,
      Math.max(cw, ch) * 0.72
    );
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, `rgba(0,0,0,${Math.min(0.85, clip.vignette ?? 0)})`);
    effectBuf.ctx.fillStyle = grad;
    effectBuf.ctx.fillRect(0, 0, cw, ch);
    effectBuf.ctx.restore();
  }

  // Clip effect to the object's silhouette alpha (saveLayer + SrcIn equivalent)
  effectBuf.ctx.save();
  effectBuf.ctx.setTransform(1, 0, 0, 1, 0, 0);
  effectBuf.ctx.globalAlpha = 1;
  effectBuf.ctx.globalCompositeOperation = 'destination-in';
  effectBuf.ctx.drawImage(maskCanvas, 0, 0, cw, ch);
  effectBuf.ctx.restore();

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = clampedAlpha;
  ctx.globalCompositeOperation = clip.blendMode ?? 'source-over';
  ctx.drawImage(effectBuf.canvas, 0, 0, cw, ch);
  ctx.restore();
}

function drawShapeClip(
  ctx: CanvasRenderingContext2D,
  cw: number,
  ch: number,
  clip: Clip,
  time: number,
  selectedClipId: string | null,
  collaborators: Collaborator[],
  currentUserId?: string
) {
  const style = normalizeShapeStyle(clip.shapeStyle);
  const meta = getShapeCatalogItem(style.shapeType);
  const kf = evaluateClipTransform(clip, time);
  const sxFactor = clip.scaleX ?? 1;
  const syFactor = clip.scaleY ?? 1;
  const layerW = Math.max(12, cw * kf.scale * sxFactor);
  const layerH = Math.max(12, (cw * kf.scale / meta.aspect) * syFactor);
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

  const drawW = layerW * animScale;
  const drawH = layerH * animScale;
  const rotRad = (kf.rotation * Math.PI) / 180;
  const hasWarp = !isIdentityWarp(kf.warp);
  const grade = getClipEffectiveAdjustments(clip);
  const hasGrade = !isNeutralColorGrade(grade);

  const renderShapeIntoTarget = (
    targetCtx: CanvasRenderingContext2D,
    layerAlpha: number,
    composite: GlobalCompositeOperation,
    maskOnly: boolean
  ) => {
    // Render crisp shape to local offscreen canvas when warped or color-graded
    if (hasWarp || (!maskOnly && hasGrade)) {
      const texW = Math.max(8, Math.min(2048, Math.ceil(drawW)));
      const texH = Math.max(8, Math.min(2048, Math.ceil(drawH)));
      const off = getLayerOffscreenCtx(texW, texH);
      if (off) {
        off.ctx.save();
        off.ctx.translate(texW / 2, texH / 2);
        if (clip.flipHorizontal || clip.flipVertical) {
          off.ctx.scale(
            clip.flipHorizontal ? -1 : 1,
            clip.flipVertical ? -1 : 1
          );
        }
        drawShapeGeometry(off.ctx, texW, texH, style, sf, maskOnly);
        off.ctx.restore();

        let srcCanvas: HTMLCanvasElement = off.canvas;
        if (!maskOnly && hasGrade) {
          const graded = applyColorGradeShader(srcCanvas, texW, texH, grade, time);
          if (graded instanceof HTMLCanvasElement) srcCanvas = graded;
        }

        if (hasWarp && kf.warp) {
          const warped = renderWarpedLayer({
            source: srcCanvas,
            centerX: cx,
            centerY: cy,
            layerW: drawW,
            layerH: drawH,
            rotationDeg: kf.rotation,
            warp: kf.warp,
            cw,
            ch,
          });
          if (warped) {
            targetCtx.save();
            targetCtx.globalAlpha = Math.max(0, Math.min(1, layerAlpha));
            targetCtx.globalCompositeOperation = composite;
            if (!maskOnly && clip.blur && clip.blur > 0) {
              targetCtx.filter = `blur(${clip.blur}px)`;
            }
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
        targetCtx.translate(cx, cy);
        if (rotRad !== 0) targetCtx.rotate(rotRad);
        targetCtx.globalAlpha = Math.max(0, Math.min(1, layerAlpha));
        targetCtx.globalCompositeOperation = composite;
        if (!maskOnly && clip.blur && clip.blur > 0) {
          targetCtx.filter = `blur(${clip.blur}px)`;
        }
        targetCtx.drawImage(srcCanvas, -drawW / 2, -drawH / 2, drawW, drawH);
        targetCtx.restore();
        return;
      }
    }

    targetCtx.save();
    targetCtx.translate(cx, cy);
    if (rotRad !== 0) targetCtx.rotate(rotRad);
    targetCtx.globalAlpha = Math.max(0, Math.min(1, layerAlpha));
    targetCtx.globalCompositeOperation = composite;
    if (!maskOnly && clip.blur && clip.blur > 0) {
      targetCtx.filter = `blur(${clip.blur}px)`;
    }
    if (clip.flipHorizontal || clip.flipVertical) {
      targetCtx.scale(clip.flipHorizontal ? -1 : 1, clip.flipVertical ? -1 : 1);
    }
    drawShapeGeometry(targetCtx, drawW, drawH, style, sf, maskOnly);
    targetCtx.restore();
  };

  if (clip.adjustmentMask) {
    const maskBuf = getAdjMaskAlphaCtx(cw, ch);
    if (maskBuf) {
      renderShapeIntoTarget(maskBuf.ctx, 1, 'source-over', true);
      if (clip.mask) {
        applyMaskToCanvas(maskBuf.canvas, cw, ch, clip.mask);
      }
      applyObjectAdjustmentMask(ctx, cw, ch, clip, time, maskBuf.canvas, alpha);
    }
  } else if (clip.mask) {
    const scratch = getClipScratchCtx(cw, ch);
    if (scratch) {
      renderShapeIntoTarget(scratch.ctx, 1, 'source-over', false);
      applyMaskToCanvas(scratch.canvas, cw, ch, clip.mask);
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      ctx.globalCompositeOperation = clip.blendMode ?? 'source-over';
      ctx.drawImage(scratch.canvas, 0, 0);
      ctx.restore();
    } else {
      renderShapeIntoTarget(ctx, alpha, clip.blendMode ?? 'source-over', false);
    }
  } else {
    renderShapeIntoTarget(ctx, alpha, clip.blendMode ?? 'source-over', false);
  }

  const peerLock = getClipPeerLock(clip, collaborators, currentUserId);
  if (clip.id === selectedClipId || peerLock) {
    drawLayerSelectionOutline(
      ctx,
      cx,
      cy,
      drawW,
      drawH,
      kf.rotation,
      kf.warp,
      style.shapeType === 'circle' || style.shapeType === 'ellipse'
        ? 0
        : (style.cornerRadius ?? 0) * sf,
      clip.adjustmentMask ? '#c084fc' : '#22d3ee',
      peerLock,
      sf,
      Boolean(clip.adjustmentMask),
      true
    );
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
  if (clip.kind === 'shape') {
    drawShapeClip(
      ctx,
      cw,
      ch,
      clip,
      time,
      selectedClipId,
      collaborators,
      currentUserId
    );
    return;
  }

  const isAnimatedStickerOrWebp =
    Boolean(clip.src) &&
    clip.kind === 'image' &&
    (Boolean(clip.isSticker) || /\.(webp|gif)(\?|#|$)/i.test(clip.src || ''));

  const media:
    | HTMLImageElement
    | HTMLVideoElement
    | HTMLCanvasElement
    | null =
    clip.mediaStatus === 'DOWNLOADING'
      ? null
      : clip.kind === 'video' && clip.src
        ? pool.getVideo(clip.src)
        : clip.src
          ? isAnimatedStickerOrWebp
            ? pool.getAnimatedImageSource(clip.src, Math.max(0, time - clip.start))
            : pool.getImage(clip.src)
          : null;

  const dims = media ? getSourceDims(media) : {w: 0, h: 0};
  const mw = dims.w;
  const mh = dims.h;

  const crop = getNormalizedCrop(clip);
  const effW = mw * crop.width;
  const effH = mh * crop.height;

  const kf = evaluateClipTransform(clip, time);
  const scale = kf.scale;
  const aspect = effW && effH ? effW / effH : clip.isSticker ? 1 : 9 / 16;
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

  const drawW = pipW * animScale;
  const drawH = pipH * animScale;
  const radius = (clip.borderRadius ?? (clip.isSticker ? 0 : 20)) * sf;
  const rotRad = (kf.rotation * Math.PI) / 180;
  const hasWarp = !isIdentityWarp(kf.warp);

  const drawOverlayContent = (
    targetCtx: CanvasRenderingContext2D,
    layerAlpha: number,
    composite: GlobalCompositeOperation,
    maskOnly = false
  ) => {
    if (
      hasWarp &&
      kf.warp &&
      media &&
      (media instanceof HTMLImageElement ||
        media instanceof HTMLCanvasElement ||
        media.readyState >= 2) &&
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

      if (!maskOnly) {
        const dimsAfterChroma = getSourceDims(sourceToDraw);
        sourceToDraw = applyColorGradeShader(
          sourceToDraw,
          dimsAfterChroma.w || mw,
          dimsAfterChroma.h || mh,
          getClipEffectiveAdjustments(clip),
          time
        );
      }

      // If rounded corners or border are present, bake them into offscreen canvas before warping
      let warpSource: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement =
        sourceToDraw;
      let warpCrop = {x: crop.x, y: crop.y, w: crop.width, h: crop.height};
      let bakeFlipH = Boolean(clip.flipHorizontal);
      let bakeFlipV = Boolean(clip.flipVertical);

      if (radius > 0.5 || (!maskOnly && clip.borderWidth && clip.borderWidth > 0)) {
        const texW = Math.max(8, Math.min(2048, Math.ceil(drawW)));
        const texH = Math.max(8, Math.min(2048, Math.ceil(drawH)));
        const off = getLayerOffscreenCtx(texW, texH);
        if (off) {
          const sDims = getSourceDims(sourceToDraw);
          off.ctx.save();
          if (radius > 0.5) {
            off.ctx.beginPath();
            off.ctx.roundRect(0, 0, texW, texH, radius);
            off.ctx.clip();
          }
          off.ctx.save();
          off.ctx.translate(texW / 2, texH / 2);
          if (bakeFlipH || bakeFlipV) {
            off.ctx.scale(bakeFlipH ? -1 : 1, bakeFlipV ? -1 : 1);
          }
          off.ctx.drawImage(
            sourceToDraw,
            crop.x * sDims.w,
            crop.y * sDims.h,
            crop.width * sDims.w,
            crop.height * sDims.h,
            -texW / 2,
            -texH / 2,
            texW,
            texH
          );
          off.ctx.restore();
          if (!maskOnly && clip.borderWidth && clip.borderWidth > 0) {
            off.ctx.strokeStyle = clip.borderColor || '#ffffff';
            off.ctx.lineWidth = clip.borderWidth * sf;
            off.ctx.beginPath();
            off.ctx.roundRect(0, 0, texW, texH, radius);
            off.ctx.stroke();
          }
          off.ctx.restore();
          warpSource = off.canvas;
          warpCrop = {x: 0, y: 0, w: 1, h: 1};
          bakeFlipH = false;
          bakeFlipV = false;
        }
      }

      const warped = renderWarpedLayer({
        source: warpSource,
        cropRect: warpCrop,
        flipH: bakeFlipH,
        flipV: bakeFlipV,
        centerX: cx,
        centerY: cy,
        layerW: drawW,
        layerH: drawH,
        rotationDeg: kf.rotation,
        warp: kf.warp,
        cw,
        ch,
      });

      if (warped) {
        targetCtx.save();
        targetCtx.globalAlpha = Math.max(0, Math.min(1, layerAlpha));
        targetCtx.globalCompositeOperation = composite;
        if (!maskOnly && clip.blur && clip.blur > 0) {
          targetCtx.filter = `blur(${clip.blur}px)`;
        }
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
    targetCtx.translate(cx, cy);
    if (rotRad !== 0) targetCtx.rotate(rotRad);
    if (animScale !== 1) targetCtx.scale(animScale, animScale);
    targetCtx.globalAlpha = Math.max(0, Math.min(1, layerAlpha));
    targetCtx.globalCompositeOperation = composite;

    if (radius > 0) {
      targetCtx.beginPath();
      targetCtx.roundRect(-pipW / 2, -pipH / 2, pipW, pipH, radius);
      targetCtx.clip();
    }

    if (clip.mediaStatus === 'DOWNLOADING' || !media) {
      drawDownloadingStub(targetCtx, pipW, pipH, clip, sf);
    } else if (
      (media instanceof HTMLImageElement ||
        media instanceof HTMLCanvasElement ||
        media.readyState >= 2) &&
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

      if (!maskOnly) {
        const dimsAfterChroma = getSourceDims(sourceToDraw);
        sourceToDraw = applyColorGradeShader(
          sourceToDraw,
          dimsAfterChroma.w || mw,
          dimsAfterChroma.h || mh,
          getClipEffectiveAdjustments(clip),
          time
        );
      }

      const srcDims = getSourceDims(sourceToDraw);
      const sx = crop.x * srcDims.w;
      const sy = crop.y * srcDims.h;
      const sw = crop.width * srcDims.w;
      const sh = crop.height * srcDims.h;

      targetCtx.save();
      if (clip.flipHorizontal || clip.flipVertical) {
        targetCtx.scale(clip.flipHorizontal ? -1 : 1, clip.flipVertical ? -1 : 1);
      }
      if (!maskOnly && clip.blur && clip.blur > 0) {
        targetCtx.filter = `blur(${clip.blur}px)`;
      }
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

    if (!maskOnly && clip.borderWidth && clip.borderWidth > 0) {
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

  if (clip.adjustmentMask) {
    const maskBuf = getAdjMaskAlphaCtx(cw, ch);
    if (maskBuf) {
      drawOverlayContent(maskBuf.ctx, 1, 'source-over', true);
      if (clip.mask) {
        applyMaskToCanvas(maskBuf.canvas, cw, ch, clip.mask);
      }
      applyObjectAdjustmentMask(ctx, cw, ch, clip, time, maskBuf.canvas, alpha);
    }
  } else if (clip.mask) {
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
    drawLayerSelectionOutline(
      ctx,
      cx,
      cy,
      drawW,
      drawH,
      kf.rotation,
      kf.warp,
      radius,
      clip.adjustmentMask ? '#c084fc' : '#22d3ee',
      peerLock,
      sf,
      Boolean(clip.adjustmentMask),
      true
    );
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
  if (clip.adjustmentMask) {
    const maskBuf = getAdjMaskAlphaCtx(cw, ch);
    if (maskBuf) {
      drawTextClipCanvas(
        maskBuf.ctx,
        cw,
        ch,
        clip,
        time,
        null,
        [],
        undefined,
        getClipScratchCtx,
        true
      );
      const kf = evaluateClipTransform(clip, time);
      applyObjectAdjustmentMask(ctx, cw, ch, clip, time, maskBuf.canvas, kf.opacity);
    }
    const peerLock = getClipPeerLock(clip, collaborators, currentUserId);
    if (clip.id === selectedClipId || peerLock) {
      const box = getTextClipUnwarpedBox(clip, cw, ch, time);
      const kf = evaluateClipTransform(clip, time);
      drawLayerSelectionOutline(
        ctx,
        box.centerX,
        box.centerY,
        box.layerW,
        box.layerH,
        box.rotationDeg,
        kf.warp,
        0,
        '#c084fc',
        peerLock,
        cw / 720,
        true
      );
    }
    return;
  }

  drawTextClipCanvas(
    ctx,
    cw,
    ch,
    clip,
    time,
    selectedClipId,
    collaborators,
    currentUserId,
    getClipScratchCtx,
    false
  );
}

function drawAdjustmentLayer(
  ctx: CanvasRenderingContext2D,
  cw: number,
  ch: number,
  clip: Clip,
  time: number,
  selectedClipId: string | null,
  collaborators: Collaborator[],
  currentUserId?: string
) {
  const kf = evaluateClipTransform(clip, time);
  const elapsed = time - clip.start;
  const remaining = clip.start + clip.duration - time;
  const transDur = Math.min(0.45, clip.duration * 0.4);
  let effectAlpha = kf.opacity;

  if (elapsed < transDur && clip.transitionIn === 'fade') {
    const t = Math.max(0, Math.min(1, elapsed / transDur));
    effectAlpha *= 1 - Math.pow(1 - t, 3);
  }
  if (remaining < transDur && clip.transitionOut === 'fade') {
    const t = Math.max(0, Math.min(1, remaining / transDur));
    effectAlpha *= 1 - Math.pow(1 - t, 3);
  }
  effectAlpha = Math.max(0, Math.min(1, effectAlpha));

  if (effectAlpha > 0.001) {
    const grade = getClipEffectiveAdjustments(clip);
    const hasGrade = !isNeutralColorGrade(grade);
    const blurPx = clip.blur ?? 0;
    const hasBlur = blurPx > 0.2;
    const hasVignette = Boolean(clip.vignette && clip.vignette > 0);

    if (hasGrade || hasBlur) {
      let graded: HTMLCanvasElement = hasGrade
        ? (applyColorGradeShader(ctx.canvas, cw, ch, grade, time) as HTMLCanvasElement)
        : ctx.canvas;

      if (graded === ctx.canvas) {
        const scratch = getClipScratchCtx(cw, ch);
        if (scratch) {
          scratch.ctx.drawImage(ctx.canvas, 0, 0);
          graded = scratch.canvas;
        }
      }

      if (graded !== ctx.canvas) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = effectAlpha;
        ctx.globalCompositeOperation = 'source-over';
        if (hasBlur) {
          drawEdgeSafeBlur(ctx, graded, cw, ch, blurPx * (cw / 720));
        } else {
          ctx.drawImage(graded, 0, 0, cw, ch);
        }
        ctx.restore();
      }
    }

    if (hasVignette) {
      ctx.save();
      ctx.globalAlpha = effectAlpha;
      const grad = ctx.createRadialGradient(
        cw / 2,
        ch / 2,
        Math.min(cw, ch) * 0.25,
        cw / 2,
        ch / 2,
        Math.max(cw, ch) * 0.72
      );
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(1, `rgba(0,0,0,${Math.min(0.85, clip.vignette ?? 0)})`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, cw, ch);
      ctx.restore();
    }
  }

  const peerLock = getClipPeerLock(clip, collaborators, currentUserId);
  if (clip.id === selectedClipId || peerLock) {
    const sf = cw / 720;
    const strokeCol = peerLock ? peerLock.color : '#c084fc';
    ctx.save();
    ctx.strokeStyle = strokeCol;
    ctx.lineWidth = (peerLock ? 3 : 2) * sf;
    ctx.setLineDash([8 * sf, 6 * sf]);
    ctx.strokeRect(4 * sf, 4 * sf, cw - 8 * sf, ch - 8 * sf);
    ctx.setLineDash([]);
    if (peerLock) {
      drawLockBadge(ctx, 12 * sf, 28 * sf, peerLock.name, peerLock.color, sf);
    }
    ctx.restore();
  }
}

export function getClipLayerBox(
  clip: Clip,
  cw: number,
  ch: number,
  time: number,
  pool: MediaPool
): ClipLayerBox | null {
  if (clip.track === 'audio' || clip.track === 'adjustment' || clip.kind === 'adjustment') {
    return null;
  }
  const kf = evaluateClipTransform(clip, time);
  const sxFactor = clip.scaleX ?? 1;
  const syFactor = clip.scaleY ?? 1;

  if (clip.track === 'text') {
    return getTextClipUnwarpedBox(clip, cw, ch, time);
  }

  if (clip.kind === 'shape') {
    const style = normalizeShapeStyle(clip.shapeStyle);
    const meta = getShapeCatalogItem(style.shapeType);
    return {
      centerX: cw * kf.x,
      centerY: ch * kf.y,
      layerW: Math.max(12, cw * kf.scale * sxFactor),
      layerH: Math.max(12, (cw * kf.scale / meta.aspect) * syFactor),
      rotationDeg: kf.rotation,
    };
  }

  const isAnimatedStickerOrWebp =
    Boolean(clip.src) &&
    clip.kind === 'image' &&
    (Boolean(clip.isSticker) || /\.(webp|gif)(\?|#|$)/i.test(clip.src || ''));
  const media =
    clip.src && clip.mediaStatus !== 'DOWNLOADING'
      ? clip.kind === 'video'
        ? pool.getVideo(clip.src)
        : isAnimatedStickerOrWebp
          ? pool.getAnimatedImageSource(clip.src, Math.max(0, time - clip.start))
          : pool.getImage(clip.src)
      : null;

  const dims = media ? getSourceDims(media) : {w: 0, h: 0};
  const mw = dims.w || cw;
  const mh = dims.h || ch;
  const crop = getNormalizedCrop(clip);
  const effW = Math.max(1, mw * crop.width);
  const effH = Math.max(1, mh * crop.height);

  if (clip.track === 'overlay') {
    const aspect = dims.w && dims.h ? effW / effH : clip.isSticker ? 1 : 9 / 16;
    return {
      centerX: cw * kf.x,
      centerY: ch * kf.y,
      layerW: Math.max(12, cw * kf.scale * sxFactor),
      layerH: Math.max(12, (cw * kf.scale / aspect) * syFactor),
      rotationDeg: kf.rotation,
    };
  }

  // Video cover track
  const baseScale = crop.isCropped
    ? Math.min(cw / effW, ch / effH)
    : Math.max(cw / effW, ch / effH);
  return {
    centerX: cw * kf.x,
    centerY: ch * kf.y,
    layerW: Math.max(12, effW * baseScale * kf.scale * sxFactor),
    layerH: Math.max(12, effH * baseScale * kf.scale * syFactor),
    rotationDeg: kf.rotation,
  };
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

let compositeSampleCanvas: HTMLCanvasElement | null = null;
export function sampleCompositeColorAtNormalizedPoint(
  nx: number,
  ny: number,
  cw: number,
  ch: number,
  clips: Clip[],
  time: number,
  pool: MediaPool,
  tracks?: Track[],
  backgroundColor?: string,
  canvasBackground?: CanvasBackground
): string | null {
  const sw = Math.max(180, Math.round(cw / 2));
  const sh = Math.max(180, Math.round(ch / 2));
  if (!compositeSampleCanvas) {
    compositeSampleCanvas = document.createElement('canvas');
  }
  if (
    compositeSampleCanvas.width !== sw ||
    compositeSampleCanvas.height !== sh
  ) {
    compositeSampleCanvas.width = sw;
    compositeSampleCanvas.height = sh;
  }
  const sctx = compositeSampleCanvas.getContext('2d', {
    willReadFrequently: true,
  });
  if (!sctx) return null;

  renderCompositeFrame(
    sctx,
    sw,
    sh,
    clips,
    time,
    pool,
    null,
    [],
    tracks,
    backgroundColor,
    undefined,
    undefined,
    undefined,
    canvasBackground
  );

  const px = Math.max(0, Math.min(sw - 1, Math.floor(nx * sw)));
  const py = Math.max(0, Math.min(sh - 1, Math.floor(ny * sh)));
  try {
    const pixel = sctx.getImageData(px, py, 1, 1).data;
    return rgbToHex(pixel[0], pixel[1], pixel[2]);
  } catch {
    return null;
  }
}

function drawCanvasBackground(
  ctx: CanvasRenderingContext2D,
  cw: number,
  ch: number,
  activeVisualClips: Clip[],
  pool: MediaPool,
  backgroundColor?: string,
  canvasBackground?: CanvasBackground
) {
  const bg = canvasBackground;
  if (bg?.type === 'gradient') {
    const angleDeg = bg.angle ?? 135;
    const rad = ((angleDeg - 90) * Math.PI) / 180;
    const cx = cw / 2;
    const cy = ch / 2;
    const halfSpan = (Math.abs(cw * Math.cos(rad)) + Math.abs(ch * Math.sin(rad))) / 2;
    const x0 = cx - Math.cos(rad) * halfSpan;
    const y0 = cy - Math.sin(rad) * halfSpan;
    const x1 = cx + Math.cos(rad) * halfSpan;
    const y1 = cy + Math.sin(rad) * halfSpan;
    const grad = ctx.createLinearGradient(x0, y0, x1, y1);
    grad.addColorStop(0, bg.colors[0] || '#09090b');
    grad.addColorStop(1, bg.colors[1] || '#27272a');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, cw, ch);
    return;
  }

  ctx.fillStyle =
    (bg?.type === 'solid' ? bg.color : undefined) || backgroundColor || '#09090b';
  ctx.fillRect(0, 0, cw, ch);

  if (bg?.type !== 'blur') return;

  // Pick the active video or photo layer for Blur Background
  const blurCandidate =
    activeVisualClips.find(
      (c) =>
        c.track === 'video' &&
        (c.kind === 'video' || c.kind === 'image') &&
        Boolean(c.src) &&
        c.mediaStatus !== 'DOWNLOADING'
    ) ??
    activeVisualClips.find(
      (c) =>
        c.track === 'overlay' &&
        (c.kind === 'video' || c.kind === 'image') &&
        Boolean(c.src) &&
        c.mediaStatus !== 'DOWNLOADING'
    );

  if (!blurCandidate?.src) return;
  const media =
    blurCandidate.kind === 'video'
      ? pool.getVideo(blurCandidate.src)
      : pool.getImage(blurCandidate.src);
  if (!media) return;
  if (media instanceof HTMLVideoElement && media.readyState < 2) return;

  const mw =
    media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth;
  const mh =
    media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight;
  if (!mw || !mh) return;

  const crop = getNormalizedCrop(blurCandidate);
  const effW = Math.max(1, mw * crop.width);
  const effH = Math.max(1, mh * crop.height);
  const coverScale = Math.max(cw / effW, ch / effH) * 1.18;
  const drawW = effW * coverScale;
  const drawH = effH * coverScale;
  const blurPx = Math.max(8, Math.round((bg.blurAmount ?? 44) * (cw / 720)));

  ctx.save();
  ctx.filter = `blur(${blurPx}px) saturate(1.15) brightness(0.76)`;
  ctx.drawImage(
    media,
    crop.x * mw,
    crop.y * mh,
    crop.width * mw,
    crop.height * mh,
    (cw - drawW) / 2,
    (ch - drawH) / 2,
    drawW,
    drawH
  );
  ctx.restore();
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
  maskEditClipId?: string | null,
  canvasBackground?: CanvasBackground
) {

  const trackList = tracks ?? [];
  const hiddenTrackIds = new Set(
    trackList.filter((t) => t.hidden).map((t) => t.id)
  );

  const trackOrder = new Map<string, number>();
  trackList.forEach((t, i) => trackOrder.set(t.id, i));

  const fallbackRank = (type: Clip['track']) =>
    type === 'video'
      ? 0
      : type === 'overlay'
        ? 1
        : type === 'text'
          ? 2
          : type === 'adjustment'
            ? 3
            : 4;

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

  drawCanvasBackground(
    ctx,
    cw,
    ch,
    activeVisualClips,
    pool,
    backgroundColor,
    canvasBackground
  );

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
    } else if (clip.track === 'adjustment' || clip.kind === 'adjustment') {
      drawAdjustmentLayer(
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
  canvasBackground?: CanvasBackground;
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
      opts.pool.syncVideos(
        opts.clips,
        t,
        true,
        opts.tracks,
        opts.audioEngine
      );
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
        opts.backgroundColor,
        undefined,
        undefined,
        undefined,
        opts.canvasBackground
      );
      opts.onProgress(Math.min(99, Math.round((t / totalDuration) * 100)));

      if (t >= totalDuration) {
        opts.audioEngine.stopAll();
        opts.audioEngine.clearExportDestination();
        opts.pool.syncVideos(
          opts.clips,
          0,
          false,
          opts.tracks,
          opts.audioEngine
        );
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
