import type {
  AspectRatio,
  Clip,
  Collaborator,
  FilterPreset,
} from '../shared/types.ts';
import type {StudioAudioEngine} from './audioEngine.ts';

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

  public getImage(src: string): HTMLImageElement | null {
    let img = this.images.get(src);
    if (!img) {
      img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = src;
      this.images.set(src, img);
    }
    return img.complete && img.naturalWidth > 0 ? img : null;
  }

  public getVideo(src: string): HTMLVideoElement {
    let vid = this.videos.get(src);
    if (!vid) {
      vid = document.createElement('video');
      vid.crossOrigin = 'anonymous';
      vid.playsInline = true;
      vid.muted = true; // Video preview playback synced separately
      vid.preload = 'auto';
      vid.src = src;
      this.videos.set(src, vid);
    }
    return vid;
  }

  public syncVideos(clips: Clip[], time: number, isPlaying: boolean) {
    const activeVideos = new Map<string, Clip>();
    for (const c of clips) {
      if (
        c.kind === 'video' &&
        c.src &&
        time >= c.start &&
        time < c.start + c.duration
      ) {
        activeVideos.set(c.src, c);
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
      vid.muted = activeClip.volume <= 0.01;
      vid.volume = Math.max(0, Math.min(1, activeClip.volume));

      if (vid.readyState >= 1) {
        const clampedTarget = Math.min(
          Math.max(0, targetTime),
          Math.max(0, (vid.duration || 60) - 0.05)
        );
        if (Math.abs(vid.currentTime - clampedTarget) > (isPlaying ? 0.3 : 0.08)) {
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
  saturate: number
): string {
  const parts: string[] = [];
  if (brightness !== 1) parts.push(`brightness(${brightness})`);
  if (contrast !== 1) parts.push(`contrast(${contrast})`);
  if (saturate !== 1) parts.push(`saturate(${saturate})`);

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
  progress: number
) {
  const mw =
    media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth;
  const mh =
    media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight;
  if (!mw || !mh) return;

  const baseScale = Math.max(cw / mw, ch / mh);
  let zoom = clip.mediaScale ?? 1;
  let offsetX = 0;
  let offsetY = 0;

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

  // Transition In (first 0.45s)
  const elapsed = progress * clip.duration;
  const transDur = Math.min(0.45, clip.duration * 0.4);
  let transAlpha = clip.opacity;
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

  const drawW = mw * baseScale * zoom;
  const drawH = mh * baseScale * zoom;
  const centerX = cw * (clip.mediaX ?? 0.5) + offsetX;
  const centerY = ch * (clip.mediaY ?? 0.5) + offsetY;

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, transAlpha));
  ctx.filter = buildFilterString(
    clip.filter,
    clip.brightness,
    clip.contrast,
    clip.saturate
  );
  ctx.drawImage(media, centerX - drawW / 2, centerY - drawH / 2, drawW, drawH);
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
  collaborators: Collaborator[]
) {
  ctx.fillStyle = '#09090b';
  ctx.fillRect(0, 0, cw, ch);

  const activeAtTime = (track: Clip['track']) =>
    clips
      .filter(
        (c) =>
          c.track === track && time >= c.start && time < c.start + c.duration
      )
      .sort((a, b) => a.start - b.start);

  // 1. Main Video Track
  for (const clip of activeAtTime('video')) {
    const progress = Math.max(
      0,
      Math.min(1, (time - clip.start) / Math.max(0.01, clip.duration))
    );
    if (clip.kind === 'image' && clip.src) {
      const img = pool.getImage(clip.src);
      if (img) drawCoverMedia(ctx, img, cw, ch, clip, progress);
    } else if (clip.kind === 'video' && clip.src) {
      const vid = pool.getVideo(clip.src);
      if (vid.readyState >= 2) {
        drawCoverMedia(ctx, vid, cw, ch, clip, progress);
      }
    }
  }

  // 2. Overlay / PIP Track
  for (const clip of activeAtTime('overlay')) {
    const progress = Math.max(
      0,
      Math.min(1, (time - clip.start) / Math.max(0.01, clip.duration))
    );
    const scale = clip.mediaScale ?? 0.45;
    const pipW = cw * scale;
    const pipH = ch * scale;
    const cx = cw * (clip.mediaX ?? 0.72);
    const cy = ch * (clip.mediaY ?? 0.25);

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(cx - pipW / 2, cy - pipH / 2, pipW, pipH, 24);
    ctx.clip();

    const media =
      clip.kind === 'video' && clip.src
        ? pool.getVideo(clip.src)
        : clip.src
          ? pool.getImage(clip.src)
          : null;

    if (
      media &&
      (media instanceof HTMLImageElement || media.readyState >= 2)
    ) {
      ctx.globalAlpha = clip.opacity;
      ctx.filter = buildFilterString(
        clip.filter,
        clip.brightness,
        clip.contrast,
        clip.saturate
      );
      const mw =
        media instanceof HTMLVideoElement
          ? media.videoWidth
          : media.naturalWidth;
      const mh =
        media instanceof HTMLVideoElement
          ? media.videoHeight
          : media.naturalHeight;
      if (mw && mh) {
        const s = Math.max(pipW / mw, pipH / mh);
        const dw = mw * s;
        const dh = mh * s;
        ctx.drawImage(media, cx - dw / 2, cy - dh / 2, dw, dh);
      }
    } else {
      ctx.fillStyle = '#18181b';
      ctx.fillRect(cx - pipW / 2, cy - pipH / 2, pipW, pipH);
    }
    ctx.restore();

    if (clip.id === selectedClipId) {
      ctx.save();
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 3;
      ctx.setLineDash([8, 6]);
      ctx.strokeRect(cx - pipW / 2, cy - pipH / 2, pipW, pipH);
      ctx.restore();
    }
    void progress;
  }

  // 3. Text Overlay Track
  for (const clip of activeAtTime('text')) {
    const style = clip.textStyle ?? {
      fontSize: 48,
      color: '#ffffff',
      bgColor: 'rgba(9,9,11,0.72)',
      fontWeight: 'bold',
      x: 0.5,
      y: 0.78,
      align: 'center',
    };
    const textVal = clip.text ?? clip.name;
    const elapsed = time - clip.start;
    const transDur = Math.min(0.35, clip.duration * 0.3);
    let alpha = clip.opacity;
    if (clip.transitionIn === 'fade' && elapsed < transDur) {
      alpha *= Math.max(0, elapsed / transDur);
    }

    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    const scaleFactor = cw / 720;
    const fontSize = Math.round(style.fontSize * scaleFactor);
    ctx.font = `${style.fontWeight === 'bold' ? '700' : '500'} ${fontSize}px "Plus Jakarta Sans", sans-serif`;
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
    const anchorX = cw * style.x;
    const anchorY = ch * style.y;

    let boxX = anchorX - boxW / 2;
    if (style.align === 'left') boxX = anchorX - padX;
    if (style.align === 'right') boxX = anchorX - boxW + padX;
    const boxY = anchorY - boxH / 2;

    if (style.bgColor && style.bgColor !== 'transparent') {
      ctx.fillStyle = style.bgColor;
      ctx.beginPath();
      ctx.roundRect(boxX, boxY, boxW, boxH, 16 * scaleFactor);
      ctx.fill();
    }

    ctx.fillStyle = style.color;
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 10 * scaleFactor;
    lines.forEach((line, i) => {
      const ly =
        anchorY - ((lines.length - 1) * lineHeight) / 2 + i * lineHeight;
      ctx.fillText(line, anchorX, ly);
    });

    // Selection or collaborator border on text
    const remoteUser = collaborators.find((u) => u.selectedClipId === clip.id);
    if (clip.id === selectedClipId || remoteUser) {
      ctx.shadowBlur = 0;
      ctx.strokeStyle =
        clip.id === selectedClipId ? '#22d3ee' : remoteUser!.color;
      ctx.lineWidth = 3 * scaleFactor;
      ctx.setLineDash([8 * scaleFactor, 6 * scaleFactor]);
      ctx.strokeRect(
        boxX - 6 * scaleFactor,
        boxY - 6 * scaleFactor,
        boxW + 12 * scaleFactor,
        boxH + 12 * scaleFactor
      );
    }

    ctx.restore();
  }
}

export async function exportProjectToVideo(opts: {
  clips: Clip[];
  aspectRatio: AspectRatio;
  duration: number;
  pool: MediaPool;
  audioEngine: StudioAudioEngine;
  onProgress: (pct: number) => void;
}): Promise<{blob: Blob; ext: string}> {
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
      opts.pool.syncVideos(opts.clips, t, true);
      opts.audioEngine.sync(opts.clips, t, true);
      renderCompositeFrame(ctx, width, height, opts.clips, t, opts.pool, null, []);
      opts.onProgress(Math.min(99, Math.round((t / totalDuration) * 100)));

      if (t >= totalDuration) {
        opts.audioEngine.stopAll();
        opts.audioEngine.clearExportDestination();
        opts.pool.syncVideos(opts.clips, 0, false);
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
