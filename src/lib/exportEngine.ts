import {Muxer, ArrayBufferTarget} from 'mp4-muxer';
import type {
  GIFEncoder as GIFEncoderType,
  quantize as quantizeType,
  applyPalette as applyPaletteType,
} from 'gifenc';
import type {
  AspectRatio,
  CanvasBackground,
  Clip,
  MotionTrackerBeacon,
  ProjectFont,
  Track,
} from '../shared/types.ts';
import {renderTimelineAudioBuffer} from './audioDsp.ts';
import type {StudioAudioEngine} from './audioEngine.ts';
import {loadCustomFont, preloadProjectFonts} from './fontLoader.ts';
import {
  getCanvasDimensions,
  MediaPool,
  renderCompositeFrame,
} from './renderEngine.ts';
import {resolveMediaSrc} from './serverConfig.ts';
import {buildAnimatedWebp} from './webpMuxer.ts';
import type {AnimatedWebpFrame} from './webpMuxer.ts';

export type ExportFormat = 'mp4' | 'webm' | 'webp' | 'gif' | 'png';
export type ExportResolution = '480p' | '720p' | '1080p' | '1440p' | '2160p';
export type ExportFps = 15 | 24 | 25 | 30 | 50 | 60;
export type ExportQuality = 'standard' | 'high' | 'ultra';

export interface ExportProjectOptions {
  clips: Clip[];
  tracks: Track[];
  aspectRatio: AspectRatio;
  backgroundColor?: string;
  canvasBackground?: CanvasBackground;
  customFonts?: ProjectFont[];
  trackers?: MotionTrackerBeacon[];
  duration: number;
  currentTime?: number;
  format?: ExportFormat;
  resolution?: ExportResolution;
  fps?: ExportFps;
  quality?: ExportQuality;
  pool: MediaPool;
  audioEngine: StudioAudioEngine;
  onProgress: (pct: number) => void;
  onStage?: (stage: string) => void;
  signal?: AbortSignal;
}

export interface ExportProjectResult {
  blob: Blob;
  ext: ExportFormat;
  width: number;
  height: number;
  fps: number;
}

export const EXPORT_RESOLUTION_OPTIONS: Array<{
  id: ExportResolution;
  label: string;
  shortSide: number;
  hint: string;
}> = [
  {id: '480p', label: '480p', shortSide: 480, hint: 'Лёгкое'},
  {id: '720p', label: '720p HD', shortSide: 720, hint: 'Стандарт'},
  {id: '1080p', label: '1080p Full HD', shortSide: 1080, hint: 'Чёткое'},
  {id: '1440p', label: '2K QHD', shortSide: 1440, hint: 'Высокое'},
  {id: '2160p', label: '4K UHD', shortSide: 2160, hint: 'Максимум'},
];

export const EXPORT_FPS_OPTIONS: ExportFps[] = [15, 24, 25, 30, 50, 60];

export const EXPORT_FORMAT_OPTIONS: Array<{
  id: ExportFormat;
  label: string;
  ext: string;
  hint: string;
  isStill?: boolean;
}> = [
  {id: 'mp4', label: 'MP4', ext: '.mp4', hint: 'Универсальное видео H.264'},
  {id: 'webm', label: 'WebM', ext: '.webm', hint: 'VP9/VP8 для веба'},
  {id: 'webp', label: 'WebP', ext: '.webp', hint: 'Анимация без звука'},
  {id: 'gif', label: 'GIF', ext: '.gif', hint: 'Анимация для чатов'},
  {id: 'png', label: 'PNG', ext: '.png', hint: 'Стоп-кадр на плейхеде', isStill: true},
];

export const MAX_ANIMATED_IMAGE_FRAMES = 900;

export function getExportDimensions(
  aspect: AspectRatio,
  resolution: ExportResolution = '720p'
): {width: number; height: number} {
  const base = getCanvasDimensions(aspect);
  const preset =
    EXPORT_RESOLUTION_OPTIONS.find((r) => r.id === resolution) ??
    EXPORT_RESOLUTION_OPTIONS[1];
  const baseShort = Math.min(base.width, base.height);
  const scale = preset.shortSide / Math.max(1, baseShort);
  const width = Math.max(2, Math.round((base.width * scale) / 2) * 2);
  const height = Math.max(2, Math.round((base.height * scale) / 2) * 2);
  return {width, height};
}

function getTargetVideoBitrate(
  width: number,
  height: number,
  fps: number,
  quality: ExportQuality
): number {
  const pixels = width * height;
  const pixelScale = pixels / (1280 * 720);
  const fpsScale = Math.max(0.65, fps / 30);
  const qualityMult =
    quality === 'ultra' ? 1.85 : quality === 'high' ? 1.25 : 0.85;
  const raw = 4_800_000 * Math.pow(pixelScale, 0.85) * Math.pow(fpsScale, 0.7) * qualityMult;
  return Math.max(1_200_000, Math.min(48_000_000, Math.round(raw)));
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException('Экспорт отменён пользователем', 'AbortError');
  }
}

async function preloadMediaAssets(
  clips: Clip[],
  tracks: Track[],
  pool: MediaPool,
  signal?: AbortSignal
): Promise<void> {
  const hiddenTrackIds = new Set(
    tracks.filter((t) => t.hidden).map((t) => t.id)
  );
  const activeVisualClips = clips.filter(
    (c) => !hiddenTrackIds.has(c.trackId) && c.src
  );

  const tasks: Array<Promise<void>> = [];
  const seenImages = new Set<string>();
  const seenVideos = new Set<string>();

  for (const clip of activeVisualClips) {
    if (!clip.src) continue;
    const resolved = resolveMediaSrc(clip.src) || clip.src;

    if (clip.kind === 'image') {
      if (seenImages.has(resolved)) continue;
      seenImages.add(resolved);
      // Warm pool and wait for completion
      pool.getImage(clip.src);
      tasks.push(
        new Promise<void>((resolve) => {
          const probe = new Image();
          probe.crossOrigin = 'anonymous';
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(finish, 8000);
          probe.onload = finish;
          probe.onerror = finish;
          probe.src = resolved;
          if (probe.complete) finish();
        })
      );
    } else if (clip.kind === 'video') {
      if (seenVideos.has(resolved)) continue;
      seenVideos.add(resolved);
      const vid = pool.getVideo(clip.src);
      if (vid.readyState < 2) {
        tasks.push(
          new Promise<void>((resolve) => {
            let settled = false;
            const cleanup = () => {
              vid.removeEventListener('loadeddata', onReady);
              vid.removeEventListener('canplay', onReady);
              vid.removeEventListener('error', onReady);
              clearTimeout(timer);
            };
            const onReady = () => {
              if (settled) return;
              settled = true;
              cleanup();
              resolve();
            };
            const timer = setTimeout(onReady, 12000);
            vid.addEventListener('loadeddata', onReady);
            vid.addEventListener('canplay', onReady);
            vid.addEventListener('error', onReady);
            if (vid.readyState === 0) {
              try {
                vid.load();
              } catch {
                // ignore
              }
            }
          })
        );
      }
    }
  }

  await Promise.all(tasks);
  throwIfAborted(signal);
}

async function seekVideoToTime(
  vid: HTMLVideoElement,
  targetSec: number
): Promise<void> {
  if (vid.readyState < 1) return;
  if (!vid.paused) vid.pause();
  const maxDur = Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : 3600;
  const clamped = Math.min(Math.max(0, targetSec), Math.max(0, maxDur - 0.02));
  if (Math.abs(vid.currentTime - clamped) <= 0.015 && vid.readyState >= 2) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      vid.removeEventListener('seeked', done);
      vid.removeEventListener('error', done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, 350);
    vid.addEventListener('seeked', done, {once: true});
    vid.addEventListener('error', done, {once: true});
    try {
      vid.currentTime = clamped;
    } catch {
      done();
    }
  });
}

async function syncVideosDeterministicForFrame(
  clips: Clip[],
  time: number,
  tracks: Track[],
  pool: MediaPool
): Promise<void> {
  const hiddenIds = new Set(
    tracks.filter((t) => t.hidden).map((t) => t.id)
  );
  const seeks: Array<Promise<void>> = [];
  const seen = new Set<string>();

  for (const c of clips) {
    if (
      c.kind === 'video' &&
      c.src &&
      !hiddenIds.has(c.trackId) &&
      time >= c.start &&
      time < c.start + c.duration
    ) {
      const resolved = resolveMediaSrc(c.src) || c.src;
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      const vid = pool.getVideo(c.src);
      const targetTime = c.trimStart + (time - c.start) * (c.speed || 1);
      seeks.push(seekVideoToTime(vid, targetTime));
    }
  }

  if (seeks.length > 0) {
    await Promise.all(seeks);
  }
}

async function findSupportedAvcConfig(
  width: number,
  height: number,
  fps: number,
  bitrate: number
): Promise<VideoEncoderConfig | null> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    return null;
  }
  const pixels = width * height;
  const codecs =
    pixels > 2_300_000
      ? [
          'avc1.640034',
          'avc1.640033',
          'avc1.4d0033',
          'avc1.64002a',
          'avc1.4d002a',
          'avc1.42001f',
        ]
      : [
          'avc1.64002a',
          'avc1.640028',
          'avc1.4d002a',
          'avc1.4d001f',
          'avc1.42001f',
          'avc1.42E01E',
          'avc1.640033',
        ];

  for (const hw of ['no-preference', 'prefer-software'] as const) {
    for (const codec of codecs) {
      const cfg: VideoEncoderConfig = {
        codec,
        width,
        height,
        bitrate,
        framerate: fps,
        hardwareAcceleration: hw,
      };
      try {
        const sup = await VideoEncoder.isConfigSupported(cfg);
        if (sup.supported) {
          return sup.config ?? cfg;
        }
      } catch {
        // try next codec
      }
    }
  }
  return null;
}

async function findSupportedAudioConfig(
  sampleRate: number,
  numberOfChannels: number
): Promise<{
  encoderConfig: AudioEncoderConfig;
  muxerCodec: 'aac' | 'opus';
} | null> {
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') {
    return null;
  }
  const candidates: Array<{codec: string; muxerCodec: 'aac' | 'opus'; bitrate: number}> = [
    {codec: 'mp4a.40.2', muxerCodec: 'aac', bitrate: 192_000},
    {codec: 'mp4a.40.2', muxerCodec: 'aac', bitrate: 128_000},
    {codec: 'opus', muxerCodec: 'opus', bitrate: 128_000},
  ];
  for (const c of candidates) {
    const cfg: AudioEncoderConfig = {
      codec: c.codec,
      sampleRate,
      numberOfChannels,
      bitrate: c.bitrate,
    };
    try {
      const sup = await AudioEncoder.isConfigSupported(cfg);
      if (sup.supported) {
        return {
          encoderConfig: sup.config ?? cfg,
          muxerCodec: c.muxerCodec,
        };
      }
    } catch {
      // try next
    }
  }
  return null;
}

async function exportMp4WebCodecs(
  opts: ExportProjectOptions,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  fps: ExportFps,
  bitrate: number
): Promise<ExportProjectResult | null> {
  const videoCfg = await findSupportedAvcConfig(width, height, fps, bitrate);
  if (!videoCfg) return null;

  const totalDuration = Math.max(0.5, opts.duration);
  const totalFrames = Math.max(1, Math.round(totalDuration * fps));

  opts.onStage?.('Подготовка аудиодорожки...');
  opts.onProgress(2);

  let audioBuffer: AudioBuffer | null = null;
  let audioSupport: Awaited<ReturnType<typeof findSupportedAudioConfig>> = null;
  try {
    const sampleRate = totalDuration > 300 ? 44100 : 48000;
    audioBuffer = await renderTimelineAudioBuffer(
      opts.clips,
      opts.tracks,
      totalDuration,
      sampleRate
    );
    throwIfAborted(opts.signal);
    if (audioBuffer) {
      audioSupport = await findSupportedAudioConfig(
        audioBuffer.sampleRate,
        Math.min(2, audioBuffer.numberOfChannels || 2)
      );
      if (!audioSupport) {
        audioBuffer = null;
      }
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    audioBuffer = null;
    audioSupport = null;
  }

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: {
      codec: 'avc',
      width,
      height,
      frameRate: fps,
    },
    ...(audioBuffer && audioSupport
      ? {
          audio: {
            codec: audioSupport.muxerCodec,
            numberOfChannels: Math.min(2, audioBuffer.numberOfChannels || 2),
            sampleRate: audioBuffer.sampleRate,
          },
        }
      : {}),
    fastStart: 'in-memory',
  });

  let encoderError: Error | null = null;

  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta);
    },
    error: (err) => {
      encoderError = err instanceof Error ? err : new Error(String(err));
    },
  });

  let audioEncoder: AudioEncoder | null = null;
  if (audioBuffer && audioSupport) {
    audioEncoder = new AudioEncoder({
      output: (chunk, meta) => {
        muxer.addAudioChunk(chunk, meta);
      },
      error: (err) => {
        encoderError = err instanceof Error ? err : new Error(String(err));
      },
    });
  }

  try {
    videoEncoder.configure(videoCfg);
    if (audioEncoder && audioSupport) {
      audioEncoder.configure(audioSupport.encoderConfig);
    }

    opts.onStage?.('Рендеринг кадров MP4...');
    const frameDurationUs = Math.round(1_000_000 / fps);
    const keyFrameInterval = Math.max(1, Math.round(fps * 2));

    for (let i = 0; i < totalFrames; i++) {
      throwIfAborted(opts.signal);
      if (encoderError) throw encoderError;

      const t = Math.min(totalDuration - 0.001, i / fps);
      await syncVideosDeterministicForFrame(
        opts.clips,
        t,
        opts.tracks,
        opts.pool
      );
      throwIfAborted(opts.signal);

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
        opts.canvasBackground,
        opts.trackers
      );

      const timestampUs = Math.round((i * 1_000_000) / fps);
      const vf = new VideoFrame(canvas, {
        timestamp: timestampUs,
        duration: frameDurationUs,
      });
      try {
        videoEncoder.encode(vf, {
          keyFrame: i % keyFrameInterval === 0,
        });
      } finally {
        vf.close();
      }

      if (videoEncoder.encodeQueueSize > 8) {
        await new Promise<void>((r) => setTimeout(r, 8));
      } else if (i % 4 === 0) {
        await new Promise<void>((r) => setTimeout(r, 0));
      }

      const videoPctWeight = audioEncoder ? 88 : 96;
      opts.onProgress(
        Math.min(92, 5 + Math.round(((i + 1) / totalFrames) * videoPctWeight))
      );
    }

    if (audioEncoder && audioBuffer) {
      opts.onStage?.('Кодирование аудио...');
      const channels = Math.min(2, audioBuffer.numberOfChannels || 2);
      const sr = audioBuffer.sampleRate;
      const totalSamples = audioBuffer.length;
      const chunkFrames = 1024;
      const ch0 = audioBuffer.getChannelData(0);
      const ch1 = channels > 1 ? audioBuffer.getChannelData(1) : ch0;

      for (let offset = 0; offset < totalSamples; offset += chunkFrames) {
        throwIfAborted(opts.signal);
        if (encoderError) throw encoderError;

        const frames = Math.min(chunkFrames, totalSamples - offset);
        const planar = new Float32Array(frames * channels);
        planar.set(ch0.subarray(offset, offset + frames), 0);
        if (channels > 1) {
          planar.set(ch1.subarray(offset, offset + frames), frames);
        }

        const audioData = new AudioData({
          format: 'f32-planar',
          sampleRate: sr,
          numberOfFrames: frames,
          numberOfChannels: channels,
          timestamp: Math.round((offset / sr) * 1_000_000),
          data: planar,
        });
        try {
          audioEncoder.encode(audioData);
        } finally {
          audioData.close();
        }

        if (audioEncoder.encodeQueueSize > 16) {
          await new Promise<void>((r) => setTimeout(r, 4));
        }
      }
      await audioEncoder.flush();
    }

    opts.onStage?.('Сборка MP4 контейнера...');
    await videoEncoder.flush();
    if (encoderError) throw encoderError;
    muxer.finalize();

    const blob = new Blob([target.buffer], {type: 'video/mp4'});
    opts.onProgress(100);
    return {blob, ext: 'mp4', width, height, fps};
  } finally {
    try {
      if (videoEncoder.state !== 'closed') videoEncoder.close();
    } catch {
      // ignore
    }
    try {
      if (audioEncoder && audioEncoder.state !== 'closed') audioEncoder.close();
    } catch {
      // ignore
    }
  }
}

async function exportViaMediaRecorder(
  opts: ExportProjectOptions,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  fps: ExportFps,
  bitrate: number,
  preferredFormat: 'mp4' | 'webm'
): Promise<ExportProjectResult> {
  await opts.audioEngine.resume();
  await syncVideosDeterministicForFrame(opts.clips, 0, opts.tracks, opts.pool);

  renderCompositeFrame(
    ctx,
    width,
    height,
    opts.clips,
    0,
    opts.pool,
    null,
    [],
    opts.tracks,
    opts.backgroundColor,
    undefined,
    undefined,
    undefined,
    opts.canvasBackground,
    opts.trackers
  );

  const mp4Candidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a',
    'video/mp4;codecs=vp9,opus',
    'video/mp4',
  ];
  const webmCandidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  const orderedCandidates =
    preferredFormat === 'mp4'
      ? [...mp4Candidates, ...webmCandidates]
      : [...webmCandidates, ...mp4Candidates];

  const mimeType =
    typeof MediaRecorder !== 'undefined'
      ? orderedCandidates.find((m) => MediaRecorder.isTypeSupported(m)) || ''
      : '';

  if (typeof MediaRecorder === 'undefined') {
    throw new Error('Браузер не поддерживает запись видео (MediaRecorder)');
  }

  const stream = canvas.captureStream(fps);
  const audioStream = opts.audioEngine.getExportAudioStream(
    opts.clips,
    opts.tracks
  );
  if (audioStream) {
    for (const track of audioStream.getAudioTracks()) {
      stream.addTrack(track);
    }
  }

  const recorder = new MediaRecorder(
    stream,
    mimeType
      ? {mimeType, videoBitsPerSecond: bitrate}
      : {videoBitsPerSecond: bitrate}
  );
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  const donePromise = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => {
      resolve(new Blob(chunks, {type: mimeType || 'video/webm'}));
    };
    recorder.onerror = () => {
      reject(new Error('Ошибка кодирования потока MediaRecorder'));
    };
  });

  opts.onStage?.('Запись видеопотока...');
  const totalDuration = Math.max(0.5, opts.duration);
  const startWall = performance.now();
  const frameIntervalMs = Math.max(10, Math.round(1000 / fps));
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let rafId = 0;

  try {
    recorder.start(250);

    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const cleanup = () => {
        if (timerId !== null) clearTimeout(timerId);
        cancelAnimationFrame(rafId);
        opts.signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        if (finished) return;
        finished = true;
        cleanup();
        reject(new DOMException('Экспорт отменён пользователем', 'AbortError'));
      };
      opts.signal?.addEventListener('abort', onAbort);

      const step = () => {
        if (finished) return;
        if (opts.signal?.aborted) {
          onAbort();
          return;
        }
        const elapsedSec = (performance.now() - startWall) / 1000;
        const t = Math.min(totalDuration, elapsedSec);

        // Keep playing videos smooth without constant re-seek stutter (>0.6s tolerance)
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
          opts.canvasBackground,
          opts.trackers
        );
        opts.onProgress(Math.min(98, Math.round((t / totalDuration) * 98)));

        if (t >= totalDuration) {
          finished = true;
          cleanup();
          resolve();
          return;
        }

        // Schedule next frame both via rAF and fallback timer so throttled tabs continue smoothly
        timerId = setTimeout(() => {
          cancelAnimationFrame(rafId);
          step();
        }, frameIntervalMs + 12);
        rafId = requestAnimationFrame(() => {
          if (timerId !== null) {
            clearTimeout(timerId);
            timerId = null;
          }
          step();
        });
      };

      step();
    });

    if (recorder.state !== 'inactive') {
      recorder.stop();
    }
    const blob = await donePromise;
    opts.onProgress(100);
    const actualExt: ExportFormat = mimeType.includes('mp4') ? 'mp4' : 'webm';
    return {blob, ext: actualExt, width, height, fps};
  } finally {
    if (timerId !== null) clearTimeout(timerId);
    cancelAnimationFrame(rafId);
    if (recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        // ignore
      }
    }
    for (const track of stream.getTracks()) {
      track.stop();
    }
    opts.audioEngine.stopAll();
    opts.audioEngine.clearExportDestination();
    opts.pool.syncVideos(
      opts.clips,
      0,
      false,
      opts.tracks,
      opts.audioEngine
    );
  }
}

async function canvasToBlobAsync(
  canvas: HTMLCanvasElement,
  mime: string,
  quality?: number
): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => {
        if (b) resolve(b);
        else reject(new Error(`Не удалось сформировать изображение ${mime}`));
      },
      mime,
      quality
    );
  });
}

async function exportAnimatedWebp(
  opts: ExportProjectOptions,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  fps: ExportFps,
  quality: ExportQuality
): Promise<ExportProjectResult> {
  const totalDuration = Math.max(0.2, opts.duration);
  const totalFrames = Math.max(1, Math.round(totalDuration * fps));
  if (totalFrames > MAX_ANIMATED_IMAGE_FRAMES) {
    throw new Error(
      `Для WebP слишком много кадров (${totalFrames} при ${fps} fps). Выберите меньше FPS, короче длительность (до ${Math.floor(MAX_ANIMATED_IMAGE_FRAMES / fps)}с) или MP4/WebM.`
    );
  }

  const webpQuality =
    quality === 'ultra' ? 0.94 : quality === 'high' ? 0.85 : 0.72;
  const frameDelayMs = Math.max(16, Math.round(1000 / fps));
  const frames: AnimatedWebpFrame[] = [];

  opts.onStage?.('Рендеринг кадров WebP...');
  for (let i = 0; i < totalFrames; i++) {
    throwIfAborted(opts.signal);
    const t = Math.min(totalDuration - 0.001, i / fps);
    await syncVideosDeterministicForFrame(opts.clips, t, opts.tracks, opts.pool);
    throwIfAborted(opts.signal);

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
      opts.canvasBackground,
      opts.trackers
    );

    const frameBlob = await canvasToBlobAsync(canvas, 'image/webp', webpQuality);
    if (frameBlob.type && frameBlob.type !== 'image/webp') {
      throw new Error('Браузер не поддерживает кодирование WebP');
    }
    const bytes = new Uint8Array(await frameBlob.arrayBuffer());
    frames.push({webpBytes: bytes, durationMs: frameDelayMs});
    opts.onProgress(Math.min(95, Math.round(((i + 1) / totalFrames) * 95)));
  }

  opts.onStage?.('Сборка анимации WebP...');
  const webpBytes = buildAnimatedWebp(frames, width, height, 0);
  const copy = new Uint8Array(webpBytes.byteLength);
  copy.set(webpBytes);
  const blob = new Blob([copy.buffer], {type: 'image/webp'});
  opts.onProgress(100);
  return {blob, ext: 'webp', width, height, fps};
}

async function loadGifenc(): Promise<{
  GIFEncoder: typeof GIFEncoderType;
  quantize: typeof quantizeType;
  applyPalette: typeof applyPaletteType;
}> {
  const mod = (await import('gifenc')) as unknown as Record<string, unknown>;
  const cjsDefault =
    mod.default && typeof mod.default === 'object'
      ? (mod.default as Record<string, unknown>)
      : null;
  const GIFEncoder = (mod.GIFEncoder ?? cjsDefault?.GIFEncoder) as typeof GIFEncoderType;
  const quantize = (mod.quantize ?? cjsDefault?.quantize) as typeof quantizeType;
  const applyPalette = (mod.applyPalette ?? cjsDefault?.applyPalette) as typeof applyPaletteType;
  if (!GIFEncoder || !quantize || !applyPalette) {
    throw new Error('Не удалось загрузить кодировщик GIF.');
  }
  return {GIFEncoder, quantize, applyPalette};
}

async function exportAnimatedGif(
  opts: ExportProjectOptions,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  fps: ExportFps
): Promise<ExportProjectResult> {
  const totalDuration = Math.max(0.2, opts.duration);
  const totalFrames = Math.max(1, Math.round(totalDuration * fps));
  if (totalFrames > MAX_ANIMATED_IMAGE_FRAMES) {
    throw new Error(
      `Для GIF слишком много кадров (${totalFrames} при ${fps} fps). Выберите меньше FPS, короче длительность (до ${Math.floor(MAX_ANIMATED_IMAGE_FRAMES / fps)}с) или MP4/WebM.`
    );
  }

  const {GIFEncoder, quantize, applyPalette} = await loadGifenc();
  const gif = GIFEncoder();
  const delayMs = Math.max(20, Math.round(1000 / fps));

  opts.onStage?.('Кодирование GIF...');
  for (let i = 0; i < totalFrames; i++) {
    throwIfAborted(opts.signal);
    const t = Math.min(totalDuration - 0.001, i / fps);
    await syncVideosDeterministicForFrame(opts.clips, t, opts.tracks, opts.pool);
    throwIfAborted(opts.signal);

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
      opts.canvasBackground,
      opts.trackers
    );

    const imageData = ctx.getImageData(0, 0, width, height);
    const palette = quantize(imageData.data, 256, {format: 'rgb565'});
    const index = applyPalette(imageData.data, palette, 'rgb565');
    gif.writeFrame(index, width, height, {
      palette,
      delay: delayMs,
      repeat: i === 0 ? 0 : undefined,
    });

    if (i % 2 === 0) {
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    opts.onProgress(Math.min(98, Math.round(((i + 1) / totalFrames) * 98)));
  }

  gif.finish();
  const raw = gif.bytes();
  const copy = new Uint8Array(raw.byteLength);
  copy.set(raw);
  const blob = new Blob([copy.buffer], {type: 'image/gif'});
  opts.onProgress(100);
  return {blob, ext: 'gif', width, height, fps};
}

async function exportStillPng(
  opts: ExportProjectOptions,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  fps: ExportFps
): Promise<ExportProjectResult> {
  const t = Math.max(0, Math.min(opts.duration, opts.currentTime ?? 0));
  opts.onStage?.('Рендеринг кадра PNG...');
  await syncVideosDeterministicForFrame(opts.clips, t, opts.tracks, opts.pool);
  throwIfAborted(opts.signal);

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
    opts.canvasBackground,
    opts.trackers
  );
  const blob = await canvasToBlobAsync(canvas, 'image/png');
  opts.onProgress(100);
  return {blob, ext: 'png', width, height, fps};
}

export async function exportProjectToVideo(
  opts: ExportProjectOptions
): Promise<ExportProjectResult> {
  const format: ExportFormat = opts.format ?? 'mp4';
  const resolution: ExportResolution = opts.resolution ?? '720p';
  const fps: ExportFps = opts.fps ?? 30;
  const quality: ExportQuality = opts.quality ?? 'high';

  throwIfAborted(opts.signal);
  opts.onStage?.('Загрузка шрифтов и медиафайлов...');
  opts.onProgress(1);

  await preloadProjectFonts(opts.customFonts);
  for (const c of opts.clips) {
    if (c.textStyle?.fontFamily && c.textStyle?.fontSrc) {
      await loadCustomFont(c.textStyle.fontFamily, c.textStyle.fontSrc);
    }
  }
  throwIfAborted(opts.signal);

  await preloadMediaAssets(opts.clips, opts.tracks, opts.pool, opts.signal);

  const {width, height} = getExportDimensions(opts.aspectRatio, resolution);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', {
    willReadFrequently: format === 'gif',
  });
  if (!ctx) throw new Error('Не удалось создать Canvas 2D контекст');

  const bitrate = getTargetVideoBitrate(width, height, fps, quality);

  try {
    if (format === 'png') {
      return await exportStillPng(opts, canvas, ctx, width, height, fps);
    }
    if (format === 'webp') {
      return await exportAnimatedWebp(
        opts,
        canvas,
        ctx,
        width,
        height,
        fps,
        quality
      );
    }
    if (format === 'gif') {
      return await exportAnimatedGif(opts, canvas, ctx, width, height, fps);
    }
    if (format === 'mp4') {
      const webCodecsRes = await exportMp4WebCodecs(
        opts,
        canvas,
        ctx,
        width,
        height,
        fps,
        bitrate
      );
      if (webCodecsRes) {
        return webCodecsRes;
      }
      return await exportViaMediaRecorder(
        opts,
        canvas,
        ctx,
        width,
        height,
        fps,
        bitrate,
        'mp4'
      );
    }

    return await exportViaMediaRecorder(
      opts,
      canvas,
      ctx,
      width,
      height,
      fps,
      bitrate,
      'webm'
    );
  } finally {
    opts.audioEngine.stopAll();
    opts.audioEngine.clearExportDestination();
    opts.pool.syncVideos(
      opts.clips,
      opts.currentTime ?? 0,
      false,
      opts.tracks,
      opts.audioEngine
    );
  }
}
