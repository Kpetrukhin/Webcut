import type {
  AspectRatio,
  Clip,
  Collaborator,
  FilterPreset,
  ProjectFont,
  Track,
} from '../shared/types.ts';
import type {StudioAudioEngine} from './audioEngine.ts';
import {loadCustomFont, preloadProjectFonts} from './fontLoader.ts';
import {evaluateClipTransform} from './keyframeEngine.ts';
import {resolveMediaSrc} from './serverConfig.ts';

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

function drawCoverMedia(
  ctx: CanvasRenderingContext2D,
  media: HTMLImageElement | HTMLVideoElement,
  cw: number,
  ch: number,
  clip: Clip,
  time: number,
  progress: number
) {
  const mw =
    media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth;
  const mh =
    media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight;
  if (!mw || !mh) return;

  const kf = evaluateClipTransform(clip, time);
  const baseScale = Math.max(cw / mw, ch / mh);
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
      transAlpha *= eased;
    } else if (clip.transitionIn === 'slide') {
      offsetX += (1 - eased) * cw * 0.35;
      transAlpha *= eased;
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
      transAlpha *= eased;
    } else if (clip.transitionOut === 'slide') {
      offsetX -= (1 - eased) * cw * 0.35;
      transAlpha *= eased;
    }
  }

  const drawW = mw * baseScale * zoom;
  const drawH = mh * baseScale * zoom;
  const centerX = cw * kf.x + offsetX;
  const centerY = ch * kf.y + offsetY;

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, transAlpha));
  ctx.globalCompositeOperation = clip.blendMode ?? 'source-over';
  ctx.filter = buildFilterString(
    clip.filter,
    clip.brightness,
    clip.contrast,
    clip.saturate,
    clip.blur
  );
  ctx.translate(centerX, centerY);
  if (kf.rotation) ctx.rotate((kf.rotation * Math.PI) / 180);
  if (clip.flipHorizontal) ctx.scale(-1, 1);
  ctx.drawImage(media, -drawW / 2, -drawH / 2, drawW, drawH);
  ctx.restore();

  if (clip.vignette && clip.vignette > 0) {
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
}

function drawOverlayClip(
  ctx: CanvasRenderingContext2D,
  cw: number,
  ch: number,
  clip: Clip,
  time: number,
  pool: MediaPool,
  selectedClipId: string | null,
  collaborators: Collaborator[]
) {
  const media =
    clip.kind === 'video' && clip.src
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

  const kf = evaluateClipTransform(clip, time);
  const scale = kf.scale;
  const aspect = mw && mh ? mw / mh : 9 / 16;
  const pipW = cw * scale;
  const pipH = pipW / aspect;
  const cx = cw * kf.x;
  const cy = ch * kf.y;

  const elapsed = time - clip.start;
  const remaining = clip.start + clip.duration - time;
  const transDur = Math.min(0.4, clip.duration * 0.35);
  let alpha = kf.opacity;
  let animScale = 1;
  if (elapsed < transDur && clip.transitionIn !== 'none') {
    const t = Math.max(0, elapsed / transDur);
    alpha *= t;
    if (clip.transitionIn === 'zoom') animScale = 0.75 + 0.25 * t;
  }
  if (
    remaining < transDur &&
    clip.transitionOut &&
    clip.transitionOut !== 'none'
  ) {
    const t = Math.max(0, remaining / transDur);
    alpha *= t;
  }

  const radius = (clip.borderRadius ?? 20) * (cw / 720);
  const rotRad = (kf.rotation * Math.PI) / 180;

  ctx.save();
  ctx.translate(cx, cy);
  if (rotRad !== 0) ctx.rotate(rotRad);
  if (animScale !== 1) ctx.scale(animScale, animScale);
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.globalCompositeOperation = clip.blendMode ?? 'source-over';

  ctx.beginPath();
  ctx.roundRect(-pipW / 2, -pipH / 2, pipW, pipH, radius);
  ctx.clip();

  if (
    media &&
    (media instanceof HTMLImageElement || media.readyState >= 2) &&
    mw &&
    mh
  ) {
    ctx.save();
    if (clip.flipHorizontal) ctx.scale(-1, 1);
    ctx.filter = buildFilterString(
      clip.filter,
      clip.brightness,
      clip.contrast,
      clip.saturate,
      clip.blur
    );
    ctx.drawImage(media, -pipW / 2, -pipH / 2, pipW, pipH);
    ctx.restore();
  } else {
    ctx.fillStyle = '#18181b';
    ctx.fillRect(-pipW / 2, -pipH / 2, pipW, pipH);
  }
  ctx.restore();

  if (clip.borderWidth && clip.borderWidth > 0) {
    ctx.save();
    ctx.translate(cx, cy);
    if (rotRad !== 0) ctx.rotate(rotRad);
    if (animScale !== 1) ctx.scale(animScale, animScale);
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.strokeStyle = clip.borderColor || '#ffffff';
    ctx.lineWidth = clip.borderWidth * (cw / 720);
    ctx.beginPath();
    ctx.roundRect(-pipW / 2, -pipH / 2, pipW, pipH, radius);
    ctx.stroke();
    ctx.restore();
  }

  const remoteOwner = collaborators.find((u) => u.selectedClipId === clip.id);
  if (clip.id === selectedClipId || remoteOwner) {
    ctx.save();
    ctx.translate(cx, cy);
    if (rotRad !== 0) ctx.rotate(rotRad);
    ctx.strokeStyle =
      clip.id === selectedClipId ? '#22d3ee' : remoteOwner!.color;
    ctx.lineWidth = 3 * (cw / 720);
    ctx.setLineDash([8 * (cw / 720), 6 * (cw / 720)]);
    ctx.beginPath();
    ctx.roundRect(-pipW / 2, -pipH / 2, pipW, pipH, radius);
    ctx.stroke();
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
  collaborators: Collaborator[]
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

  ctx.translate(anchorX, anchorY);
  if (kf.rotation !== 0) {
    ctx.rotate((kf.rotation * Math.PI) / 180);
  }

  if (style.bgColor && style.bgColor !== 'transparent') {
    ctx.fillStyle = style.bgColor;
    ctx.beginPath();
    ctx.roundRect(localBoxX, localBoxY, boxW, boxH, 16 * scaleFactor);
    ctx.fill();
  }

  ctx.fillStyle = style.color;
  if (style.shadow !== false) {
    ctx.shadowColor = 'rgba(0,0,0,0.65)';
    ctx.shadowBlur = 10 * scaleFactor;
  }

  lines.forEach((line, i) => {
    const ly = -((lines.length - 1) * lineHeight) / 2 + i * lineHeight;
    if (style.outline) {
      ctx.lineWidth = Math.max(2, fontSize * 0.08);
      ctx.strokeStyle = '#09090b';
      ctx.strokeText(line, 0, ly);
    }
    ctx.fillText(line, 0, ly);
  });

  const remoteUser = collaborators.find((u) => u.selectedClipId === clip.id);
  if (clip.id === selectedClipId || remoteUser) {
    ctx.shadowBlur = 0;
    ctx.strokeStyle =
      clip.id === selectedClipId ? '#22d3ee' : remoteUser!.color;
    ctx.lineWidth = 3 * scaleFactor;
    ctx.setLineDash([8 * scaleFactor, 6 * scaleFactor]);
    ctx.strokeRect(
      localBoxX - 6 * scaleFactor,
      localBoxY - 6 * scaleFactor,
      boxW + 12 * scaleFactor,
      boxH + 12 * scaleFactor
    );
  }

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
  backgroundColor?: string
) {
  ctx.fillStyle = backgroundColor || '#09090b';
  ctx.fillRect(0, 0, cw, ch);

  const trackList = tracks ?? [];
  const hiddenTrackIds = new Set(
    trackList.filter((t) => t.hidden).map((t) => t.id)
  );

  const orderedClipsForType = (type: Clip['track']) => {
    const matchingTracks = trackList.filter((t) => t.type === type);
    const trackOrder = new Map<string, number>();
    matchingTracks.forEach((t, i) => trackOrder.set(t.id, i));

    return clips
      .filter(
        (c) =>
          c.track === type &&
          !hiddenTrackIds.has(c.trackId) &&
          time >= c.start &&
          time < c.start + c.duration
      )
      .sort((a, b) => {
        const ta = trackOrder.get(a.trackId) ?? 0;
        const tb = trackOrder.get(b.trackId) ?? 0;
        if (ta !== tb) return ta - tb;
        return a.start - b.start;
      });
  };

  // 1. Base Video Tracks
  for (const clip of orderedClipsForType('video')) {
    const progress = Math.max(
      0,
      Math.min(1, (time - clip.start) / Math.max(0.01, clip.duration))
    );
    if (clip.kind === 'image' && clip.src) {
      const img = pool.getImage(clip.src);
      if (img) drawCoverMedia(ctx, img, cw, ch, clip, time, progress);
    } else if (clip.kind === 'video' && clip.src) {
      const vid = pool.getVideo(clip.src);
      if (vid.readyState >= 2) {
        drawCoverMedia(ctx, vid, cw, ch, clip, time, progress);
      }
    }
  }

  // 2. Overlay / PIP Tracks
  for (const clip of orderedClipsForType('overlay')) {
    drawOverlayClip(
      ctx,
      cw,
      ch,
      clip,
      time,
      pool,
      selectedClipId,
      collaborators
    );
  }

  // 3. Text Tracks
  for (const clip of orderedClipsForType('text')) {
    drawTextClip(ctx, cw, ch, clip, time, selectedClipId, collaborators);
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
