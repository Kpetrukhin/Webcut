import type {Clip, Track, VoiceEffectPreset} from '../shared/types.ts';
import {resolveMediaSrc} from './serverConfig.ts';

export function getVoiceEffectPitchMultiplier(
  effect?: VoiceEffectPreset
): number {
  switch (effect) {
    case 'chipmunk':
      return 1.45;
    case 'monster':
      return 0.68;
    default:
      return 1;
  }
}

export function getClipEffectivePitch(clip: Pick<Clip, 'pitch' | 'voiceEffect'>): number {
  const basePitch = clip.pitch ?? 1;
  const effectMult = getVoiceEffectPitchMultiplier(clip.voiceEffect);
  return Math.max(0.01, Math.min(100, basePitch * effectMult));
}

export interface PitchShifterController {
  input: AudioNode;
  output: AudioNode;
  setPitch: (pitch: number) => void;
  getPitch: () => number;
  dispose: () => void;
}

const RING_SIZE = 4096;
const GRAIN_SIZE = 2048;

/**
 * Dual-tap Hann-windowed granular pitch shifter implemented on AudioContext.
 * Zero-latency, constant unity gain (sin^2 + cos^2 = 1), works reliably
 * across all Android WebViews and desktop browsers without Worklet race conditions.
 */
export function createPitchShifterNode(
  ctx: AudioContext,
  initialPitch = 1
): PitchShifterController {
  let targetPitch = Math.max(0.01, Math.min(100, initialPitch));

  // eslint-disable-next-line deprecation/deprecation
  const proc = ctx.createScriptProcessor(1024, 2, 2);
  const ringL = new Float32Array(RING_SIZE);
  const ringR = new Float32Array(RING_SIZE);
  let writeIdx = 0;
  let phase = 0;

  const readInterpolated = (buf: Float32Array, delaySamples: number): number => {
    let idx = writeIdx - delaySamples;
    while (idx < 0) idx += RING_SIZE;
    const i0 = Math.floor(idx) % RING_SIZE;
    const i1 = (i0 + 1) % RING_SIZE;
    const frac = idx - Math.floor(idx);
    return buf[i0] * (1 - frac) + buf[i1] * frac;
  };

  proc.onaudioprocess = (ev) => {
    const inBuf = ev.inputBuffer;
    const outBuf = ev.outputBuffer;
    const frames = outBuf.length;
    const inL = inBuf.getChannelData(0);
    const inR = inBuf.numberOfChannels > 1 ? inBuf.getChannelData(1) : inL;
    const outL = outBuf.getChannelData(0);
    const outR = outBuf.getChannelData(1);

    if (Math.abs(targetPitch - 1) < 0.015) {
      for (let i = 0; i < frames; i++) {
        ringL[writeIdx] = inL[i];
        ringR[writeIdx] = inR[i];
        writeIdx = (writeIdx + 1) % RING_SIZE;
        outL[i] = inL[i];
        outR[i] = inR[i];
      }
      return;
    }

    const phaseStep = (1 - targetPitch) / GRAIN_SIZE;

    for (let i = 0; i < frames; i++) {
      ringL[writeIdx] = inL[i];
      ringR[writeIdx] = inR[i];

      const pA = phase;
      const pB = (phase + 0.5) % 1;
      const delayA = 64 + pA * GRAIN_SIZE;
      const delayB = 64 + pB * GRAIN_SIZE;

      const sA = Math.sin(Math.PI * pA);
      const wA = sA * sA;
      const wB = 1 - wA;

      outL[i] =
        readInterpolated(ringL, delayA) * wA +
        readInterpolated(ringL, delayB) * wB;
      outR[i] =
        readInterpolated(ringR, delayA) * wA +
        readInterpolated(ringR, delayB) * wB;

      writeIdx = (writeIdx + 1) % RING_SIZE;
      phase = (((phase + phaseStep) % 1) + 1) % 1;
    }
  };

  return {
    input: proc,
    output: proc,
    setPitch: (p: number) => {
      targetPitch = Math.max(0.01, Math.min(100, p));
    },
    getPitch: () => targetPitch,
    dispose: () => {
      proc.onaudioprocess = null;
      try {
        proc.disconnect();
      } catch {
        // ignore
      }
    },
  };
}

/**
 * Offline Hann-windowed pitch shift on an AudioBuffer (used for mixdown / export).
 */
export function processAudioBufferPitchOffline(
  ctx: BaseAudioContext,
  source: AudioBuffer,
  pitchRatio: number
): AudioBuffer {
  if (Math.abs(pitchRatio - 1) < 0.015) return source;
  const clamped = Math.max(0.01, Math.min(100, pitchRatio));
  const out = ctx.createBuffer(
    source.numberOfChannels,
    source.length,
    source.sampleRate
  );
  const phaseStep = (1 - clamped) / GRAIN_SIZE;

  for (let ch = 0; ch < source.numberOfChannels; ch++) {
    const srcData = source.getChannelData(ch);
    const dstData = out.getChannelData(ch);
    const ring = new Float32Array(RING_SIZE);
    let writeIdx = 0;
    let phase = 0;

    const readInterp = (delay: number): number => {
      let idx = writeIdx - delay;
      while (idx < 0) idx += RING_SIZE;
      const i0 = Math.floor(idx) % RING_SIZE;
      const i1 = (i0 + 1) % RING_SIZE;
      const frac = idx - Math.floor(idx);
      return ring[i0] * (1 - frac) + ring[i1] * frac;
    };

    for (let i = 0; i < srcData.length; i++) {
      ring[writeIdx] = srcData[i];
      const pA = phase;
      const pB = (phase + 0.5) % 1;
      const delayA = 64 + pA * GRAIN_SIZE;
      const delayB = 64 + pB * GRAIN_SIZE;
      const sA = Math.sin(Math.PI * pA);
      const wA = sA * sA;
      const wB = 1 - wA;

      dstData[i] = readInterp(delayA) * wA + readInterp(delayB) * wB;

      writeIdx = (writeIdx + 1) % RING_SIZE;
      phase = (((phase + phaseStep) % 1) + 1) % 1;
    }
  }
  return out;
}

export interface VoiceEffectGraph {
  input: AudioNode;
  output: AudioNode;
  effect: VoiceEffectPreset;
  dispose: () => void;
}

function createHallImpulseResponse(ctx: BaseAudioContext): AudioBuffer {
  const durationSec = 1.45;
  const sampleRate = ctx.sampleRate;
  const length = Math.floor(sampleRate * durationSec);
  const ir = ctx.createBuffer(2, length, sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const t = i / length;
      const decay = Math.pow(1 - t, 2.7);
      data[i] = (Math.random() * 2 - 1) * decay;
    }
  }
  return ir;
}

function createWarmOverdriveCurve(): Float32Array<ArrayBuffer> {
  const samples = 1024;
  const curve = new Float32Array(new ArrayBuffer(samples * 4));
  const deg = Math.PI / 180;
  const k = 18;
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}

/**
 * Builds a Web Audio DSP node graph for the requested VoiceEffectPreset.
 * Works identically on real-time AudioContext and OfflineAudioContext.
 */
export function createVoiceEffectNodes(
  ctx: BaseAudioContext,
  effect: VoiceEffectPreset = 'original'
): VoiceEffectGraph {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const nodesToCleanup: AudioNode[] = [input, output];
  const oscsToStop: OscillatorNode[] = [];

  if (effect === 'original') {
    input.connect(output);
  } else if (effect === 'chipmunk') {
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 210;

    const formant = ctx.createBiquadFilter();
    formant.type = 'peaking';
    formant.frequency.value = 2700;
    formant.Q.value = 1.3;
    formant.gain.value = 7.5;

    const air = ctx.createBiquadFilter();
    air.type = 'highshelf';
    air.frequency.value = 4600;
    air.gain.value = 4;

    input.connect(hp);
    hp.connect(formant);
    formant.connect(air);
    air.connect(output);
    nodesToCleanup.push(hp, formant, air);
  } else if (effect === 'monster') {
    const chest = ctx.createBiquadFilter();
    chest.type = 'lowshelf';
    chest.frequency.value = 160;
    chest.gain.value = 8.5;

    const body = ctx.createBiquadFilter();
    body.type = 'peaking';
    body.frequency.value = 340;
    body.Q.value = 1.1;
    body.gain.value = 3.5;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2500;

    input.connect(chest);
    chest.connect(body);
    body.connect(lp);
    lp.connect(output);
    nodesToCleanup.push(chest, body, lp);
  } else if (effect === 'robot') {
    // Ring modulator + metallic comb filter
    const carrierOsc = ctx.createOscillator();
    carrierOsc.type = 'sine';
    carrierOsc.frequency.value = 54;

    const ringGain = ctx.createGain();
    ringGain.gain.value = 0.55;

    const modDepth = ctx.createGain();
    modDepth.gain.value = 0.55;
    carrierOsc.connect(modDepth);
    modDepth.connect(ringGain.gain);
    carrierOsc.start();
    oscsToStop.push(carrierOsc);

    const combDelay = ctx.createDelay(0.1);
    combDelay.delayTime.value = 0.013;
    const combFb = ctx.createGain();
    combFb.gain.value = 0.42;

    const bp = ctx.createBiquadFilter();
    bp.type = 'peaking';
    bp.frequency.value = 1150;
    bp.Q.value = 2.2;
    bp.gain.value = 5;

    input.connect(ringGain);
    ringGain.connect(bp);
    bp.connect(combDelay);
    combDelay.connect(combFb);
    combFb.connect(combDelay);
    bp.connect(output);
    combDelay.connect(output);

    nodesToCleanup.push(ringGain, modDepth, combDelay, combFb, bp);
  } else if (effect === 'hall') {
    const dry = ctx.createGain();
    dry.gain.value = 0.78;
    const wet = ctx.createGain();
    wet.gain.value = 0.62;

    const preDelay = ctx.createDelay(0.5);
    preDelay.delayTime.value = 0.045;

    const convolver = ctx.createConvolver();
    convolver.buffer = createHallImpulseResponse(ctx);

    const echo = ctx.createDelay(0.6);
    echo.delayTime.value = 0.19;
    const echoGain = ctx.createGain();
    echoGain.gain.value = 0.24;

    input.connect(dry);
    dry.connect(output);

    input.connect(preDelay);
    preDelay.connect(convolver);
    convolver.connect(wet);
    wet.connect(output);

    input.connect(echo);
    echo.connect(echoGain);
    echoGain.connect(output);

    nodesToCleanup.push(dry, wet, preDelay, convolver, echo, echoGain);
  } else if (effect === 'radio') {
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 390;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2600;

    const mid = ctx.createBiquadFilter();
    mid.type = 'peaking';
    mid.frequency.value = 1350;
    mid.Q.value = 1.8;
    mid.gain.value = 6.5;

    const shaper = ctx.createWaveShaper();
    shaper.curve = createWarmOverdriveCurve();
    shaper.oversample = '2x';

    const makeup = ctx.createGain();
    makeup.gain.value = 0.85;

    input.connect(hp);
    hp.connect(lp);
    lp.connect(mid);
    mid.connect(shaper);
    shaper.connect(makeup);
    makeup.connect(output);

    nodesToCleanup.push(hp, lp, mid, shaper, makeup);
  }

  return {
    input,
    output,
    effect,
    dispose: () => {
      for (const osc of oscsToStop) {
        try {
          osc.stop();
          osc.disconnect();
        } catch {
          // ignore
        }
      }
      for (const n of nodesToCleanup) {
        try {
          n.disconnect();
        } catch {
          // ignore
        }
      }
    },
  };
}

/**
 * Encodes an AudioBuffer into a standard 16-bit PCM WAV Blob.
 */
export function encodeAudioBufferToWav(buffer: AudioBuffer): Blob {
  const numChannels = Math.min(2, buffer.numberOfChannels);
  const sampleRate = buffer.sampleRate;
  const length = buffer.length;
  const blockAlign = numChannels * 2;
  const byteRate = sampleRate * blockAlign;
  const dataSize = length * blockAlign;
  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // AudioFormat = PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // BitsPerSample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) {
    channels.push(buffer.getChannelData(ch));
  }

  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i]));
      view.setInt16(
        offset,
        sample < 0 ? sample * 0x8000 : sample * 0x7fff,
        true
      );
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], {type: 'audio/wav'});
}

function scheduleSynthClipOffline(
  ctx: OfflineAudioContext,
  clip: Clip,
  dest: AudioNode
) {
  const preset = clip.src || 'synth:lofi';
  const intervalSec = preset === 'synth:pulse' ? 0.255 : 0.35;
  const stepsCount = Math.ceil(clip.duration / intervalSec);

  for (let stepIdx = 0; stepIdx < stepsCount; stepIdx++) {
    const stepTime = clip.start + stepIdx * intervalSec;
    if (stepTime >= clip.start + clip.duration) break;
    const step = stepIdx % 8;

    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(
      Math.max(0.01, (clip.volume ?? 0.8) * 0.25),
      stepTime
    );
    masterGain.connect(dest);

    if (preset === 'synth:lofi') {
      const chords = [220, 261.63, 329.63, 392.0];
      const note = chords[step % chords.length];
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(note, stepTime);
      g.gain.setValueAtTime(0.001, stepTime);
      g.gain.exponentialRampToValueAtTime(0.35, stepTime + 0.04);
      g.gain.exponentialRampToValueAtTime(0.001, stepTime + 0.42);
      osc.connect(g);
      g.connect(masterGain);
      osc.start(stepTime);
      osc.stop(stepTime + 0.44);

      if (step === 0 || step === 4) {
        const kick = ctx.createOscillator();
        const kG = ctx.createGain();
        kick.type = 'sine';
        kick.frequency.setValueAtTime(125, stepTime);
        kick.frequency.exponentialRampToValueAtTime(42, stepTime + 0.14);
        kG.gain.setValueAtTime(0.6, stepTime);
        kG.gain.exponentialRampToValueAtTime(0.001, stepTime + 0.16);
        kick.connect(kG);
        kG.connect(masterGain);
        kick.start(stepTime);
        kick.stop(stepTime + 0.18);
      }
    } else if (preset === 'synth:pulse') {
      const notes = [146.83, 146.83, 220, 196, 174.61, 174.61, 220, 261.63];
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(notes[step], stepTime);
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(950, stepTime);
      g.gain.setValueAtTime(0.001, stepTime);
      g.gain.exponentialRampToValueAtTime(0.28, stepTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, stepTime + 0.22);
      osc.connect(filter);
      filter.connect(g);
      g.connect(masterGain);
      osc.start(stepTime);
      osc.stop(stepTime + 0.24);
    } else if (step % 2 === 0) {
      const padNotes = [130.81, 196.0, 246.94, 293.66];
      const freq = padNotes[(step / 2) % padNotes.length];
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, stepTime);
      g.gain.setValueAtTime(0.001, stepTime);
      g.gain.linearRampToValueAtTime(0.32, stepTime + 0.15);
      g.gain.exponentialRampToValueAtTime(0.001, stepTime + 0.85);
      osc.connect(g);
      g.connect(masterGain);
      osc.start(stepTime);
      osc.stop(stepTime + 0.9);
    }
  }
}

async function decodeClipSourceAudio(
  src: string,
  decodeCtx: AudioContext
): Promise<AudioBuffer> {
  const resolved = resolveMediaSrc(src) || src;
  const res = await fetch(resolved);
  if (!res.ok) {
    throw new Error(`Не удалось загрузить медиа (HTTP ${res.status})`);
  }
  const arr = await res.arrayBuffer();
  return decodeCtx.decodeAudioData(arr);
}

/**
 * Extracts the audio stream from a video clip into a standalone WAV File,
 * respecting trimStart and duration.
 */
export async function extractAudioFromVideoClip(clip: Clip): Promise<{
  file: File;
  duration: number;
}> {
  if (!clip.src) {
    throw new Error('У видеоклипа отсутствует источник');
  }
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as {webkitAudioContext: typeof AudioContext})
      .webkitAudioContext;
  const decodeCtx = new AudioCtx();
  try {
    let decoded: AudioBuffer;
    try {
      decoded = await decodeClipSourceAudio(clip.src, decodeCtx);
    } catch {
      throw new Error('В этом видео нет звуковой дорожки');
    }

    const sr = decoded.sampleRate || 44100;
    const trimStart = Math.max(0, clip.trimStart || 0);
    const speed = clip.speed || 1;
    const maxSrcDur = Math.max(0.1, decoded.duration - trimStart);
    const outDuration = Math.max(
      0.2,
      Math.min(clip.duration, maxSrcDur / speed)
    );
    const frameCount = Math.max(1, Math.ceil(outDuration * sr));

    const offline = new OfflineAudioContext(
      Math.min(2, decoded.numberOfChannels || 1),
      frameCount,
      sr
    );

    const effPitch = getClipEffectivePitch(clip);
    const processedBuf = processAudioBufferPitchOffline(
      offline,
      decoded,
      effPitch
    );

    const srcNode = offline.createBufferSource();
    srcNode.buffer = processedBuf;
    srcNode.playbackRate.value = speed;

    const fx = createVoiceEffectNodes(offline, clip.voiceEffect ?? 'original');
    srcNode.connect(fx.input);
    fx.output.connect(offline.destination);
    srcNode.start(0, trimStart, outDuration * speed);

    const rendered = await offline.startRendering();
    fx.dispose();
    const wavBlob = encodeAudioBufferToWav(rendered);
    const cleanName = (clip.name || 'video').replace(/\.[^.]+$/, '');
    const file = new File([wavBlob], `${cleanName}_audio.wav`, {
      type: 'audio/wav',
    });
    return {file, duration: Math.round(outDuration * 100) / 100};
  } finally {
    void decodeCtx.close().catch(() => {});
  }
}

/**
 * Mixes all active unmuted audio, synth, and video clips from 0..totalDuration
 * into a single WAV file using OfflineAudioContext.
 */
export async function renderTimelineMixdownToWav(
  clips: Clip[],
  tracks: Track[],
  totalDuration: number
): Promise<{file: File; duration: number}> {
  const sampleRate = 44100;
  const safeDuration = Math.max(1, totalDuration);
  const frameCount = Math.ceil(safeDuration * sampleRate);

  const AudioCtx =
    window.AudioContext ||
    (window as unknown as {webkitAudioContext: typeof AudioContext})
      .webkitAudioContext;
  const decodeCtx = new AudioCtx();
  const offline = new OfflineAudioContext(2, frameCount, sampleRate);
  const cleanupFns: Array<() => void> = [];

  try {
    const mutedTrackIds = new Set(
      tracks.filter((t) => t.muted).map((t) => t.id)
    );
    const audibleClips = clips.filter(
      (c) =>
        !mutedTrackIds.has(c.trackId) &&
        (c.volume ?? 1) > 0.01 &&
        (c.track === 'audio' || c.kind === 'video')
    );

    if (audibleClips.length === 0) {
      throw new Error('На таймлайне нет активных звуковых дорожек');
    }

    const decodedCache = new Map<string, AudioBuffer>();
    for (const clip of audibleClips) {
      if (clip.kind === 'synth') {
        const fx = createVoiceEffectNodes(
          offline,
          clip.voiceEffect ?? 'original'
        );
        cleanupFns.push(fx.dispose);
        fx.output.connect(offline.destination);
        scheduleSynthClipOffline(offline, clip, fx.input);
        continue;
      }

      if (!clip.src) continue;
      try {
        let buf = decodedCache.get(clip.src);
        if (!buf) {
          buf = await decodeClipSourceAudio(clip.src, decodeCtx);
          decodedCache.set(clip.src, buf);
        }
        const effPitch = getClipEffectivePitch(clip);
        const pitchedBuf = processAudioBufferPitchOffline(
          offline,
          buf,
          effPitch
        );

        const srcNode = offline.createBufferSource();
        srcNode.buffer = pitchedBuf;
        srcNode.playbackRate.value = clip.speed || 1;

        const gain = offline.createGain();
        gain.gain.value = Math.max(0, Math.min(1, clip.volume ?? 1));

        const fx = createVoiceEffectNodes(
          offline,
          clip.voiceEffect ?? 'original'
        );
        cleanupFns.push(fx.dispose);

        srcNode.connect(gain);
        gain.connect(fx.input);
        fx.output.connect(offline.destination);

        const startAt = Math.max(0, clip.start);
        const offset = Math.max(0, clip.trimStart || 0);
        const srcDuration = Math.max(0.05, clip.duration * (clip.speed || 1));
        srcNode.start(startAt, offset, srcDuration);
      } catch {
        // Skip silent video without an audio stream
      }
    }

    const rendered = await offline.startRendering();
    const wavBlob = encodeAudioBufferToWav(rendered);
    const file = new File([wavBlob], `mixdown_${Date.now()}.wav`, {
      type: 'audio/wav',
    });
    return {file, duration: Math.round(safeDuration * 100) / 100};
  } finally {
    for (const fn of cleanupFns) fn();
    void decodeCtx.close().catch(() => {});
  }
}

export async function probeAudioDuration(url: string): Promise<number> {
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as {webkitAudioContext: typeof AudioContext})
      .webkitAudioContext;
  try {
    const ctx = new AudioCtx();
    try {
      const buf = await decodeClipSourceAudio(url, ctx);
      if (Number.isFinite(buf.duration) && buf.duration > 0) {
        return Math.round(buf.duration * 100) / 100;
      }
    } finally {
      void ctx.close().catch(() => {});
    }
  } catch {
    // Fallback to <audio> element metadata
  }

  return new Promise<number>((resolve) => {
    const el = document.createElement('audio');
    el.preload = 'metadata';
    el.onloadedmetadata = () => {
      const d = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 5;
      resolve(Math.round(d * 100) / 100);
    };
    el.onerror = () => resolve(5);
    el.src = resolveMediaSrc(url) || url;
  });
}
