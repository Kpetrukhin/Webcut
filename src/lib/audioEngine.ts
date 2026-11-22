import type {Clip, Track, VoiceEffectPreset} from '../shared/types.ts';
import {
  createPitchShifterNode,
  createVoiceEffectNodes,
  getClipEffectivePitch,
} from './audioDsp.ts';
import type {PitchShifterController, VoiceEffectGraph} from './audioDsp.ts';
import {resolveMediaSrc} from './serverConfig.ts';

interface ElementDspChain {
  source: MediaElementAudioSourceNode;
  gain: GainNode;
  pitcher: PitchShifterController;
  effectGraph: VoiceEffectGraph;
  currentEffect: VoiceEffectPreset;
}

/**
 * Web Audio engine supporting uploaded audio files, video clip audio,
 * and procedural backing tracks (`synth:lofi`, `synth:pulse`, `synth:cinema`)
 * with real-time granular pitch shifting and voice effect DSP chains for both
 * live preview and video export.
 */
export class StudioAudioEngine {
  private ctx: AudioContext | null = null;
  private audioElements = new Map<string, HTMLAudioElement>();
  private elementChains = new WeakMap<HTMLMediaElement, ElementDspChain>();
  private synthTimers = new Map<string, ReturnType<typeof setInterval>>();
  private synthSteps = new Map<string, number>();
  private synthFxMap = new Map<string, VoiceEffectGraph>();
  private synthClipSnapshot = new Map<string, Clip>();
  private exportDestination: MediaStreamAudioDestinationNode | null = null;
  private mutePlayback = false;

  public setPlaybackMuted(muted: boolean) {
    this.mutePlayback = muted;
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as {webkitAudioContext: typeof AudioContext})
          .webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  public getExportAudioStream(clips: Clip[]): MediaStream | null {
    const hasAudio = clips.some(
      (c) => (c.track === 'audio' || c.kind === 'video') && c.volume > 0
    );
    if (!hasAudio) return null;
    const ctx = this.ensureContext();
    if (!this.exportDestination) {
      this.exportDestination = ctx.createMediaStreamDestination();
    }
    return this.exportDestination.stream;
  }

  public clearExportDestination() {
    this.exportDestination = null;
  }

  private getOrCreateAudioEl(src: string): HTMLAudioElement {
    const resolved = resolveMediaSrc(src) || src;
    let el = this.audioElements.get(resolved);
    if (!el) {
      el = new Audio(resolved);
      el.crossOrigin = 'anonymous';
      el.preload = 'auto';
      this.audioElements.set(resolved, el);
    }
    return el;
  }

  private connectToOutput(node: AudioNode) {
    const ctx = this.ensureContext();
    node.connect(ctx.destination);
    if (this.exportDestination) {
      node.connect(this.exportDestination);
    }
  }

  private ensureElementChain(
    el: HTMLMediaElement,
    effect: VoiceEffectPreset,
    pitch: number
  ): ElementDspChain | null {
    const ctx = this.ensureContext();
    let chain = this.elementChains.get(el);
    if (!chain) {
      try {
        const source = ctx.createMediaElementSource(el);
        const gain = ctx.createGain();
        const pitcher = createPitchShifterNode(ctx, pitch);
        const effectGraph = createVoiceEffectNodes(ctx, effect);

        source.connect(gain);
        gain.connect(pitcher.input);
        pitcher.output.connect(effectGraph.input);
        this.connectToOutput(effectGraph.output);

        chain = {
          source,
          gain,
          pitcher,
          effectGraph,
          currentEffect: effect,
        };
        this.elementChains.set(el, chain);
      } catch {
        return null;
      }
    }

    // Update export destination connection cleanly
    if (this.exportDestination) {
      try {
        chain.effectGraph.output.connect(this.exportDestination);
      } catch {
        // ignore if already connected
      }
    }

    chain.pitcher.setPitch(pitch);

    if (chain.currentEffect !== effect) {
      try {
        chain.pitcher.output.disconnect(chain.effectGraph.input);
      } catch {
        // ignore
      }
      chain.effectGraph.dispose();
      const nextFx = createVoiceEffectNodes(ctx, effect);
      chain.pitcher.output.connect(nextFx.input);
      this.connectToOutput(nextFx.output);
      chain.effectGraph = nextFx;
      chain.currentEffect = effect;
    }

    return chain;
  }

  /**
   * Routes a Pool HTMLVideoElement's audio through the DSP chain (pitch + voice effects + export).
   */
  public syncVideoElementAudio(
    vid: HTMLVideoElement,
    clip: Clip | undefined,
    isPlaying: boolean,
    isTrackMuted: boolean
  ) {
    if (!clip || !isPlaying) {
      const existing = this.elementChains.get(vid);
      if (existing) {
        existing.gain.gain.value = 0;
      }
      return;
    }

    const muted =
      this.mutePlayback || isTrackMuted || (clip.volume ?? 1) <= 0.01;
    const pitch = getClipEffectivePitch(clip);
    const effect = clip.voiceEffect ?? 'original';

    // Ensure video element preserves time-stretched pitch so our granular pitcher controls pitch accurately
    const vAny = vid as HTMLVideoElement & {
      preservesPitch?: boolean;
      mozPreservesPitch?: boolean;
      webkitPreservesPitch?: boolean;
    };
    if ('preservesPitch' in vAny) vAny.preservesPitch = true;
    if ('mozPreservesPitch' in vAny) vAny.mozPreservesPitch = true;
    if ('webkitPreservesPitch' in vAny) vAny.webkitPreservesPitch = true;

    const chain = this.ensureElementChain(vid, effect, pitch);
    if (chain) {
      vid.muted = false;
      vid.volume = 1;
      chain.gain.gain.value = muted
        ? 0
        : Math.max(0, Math.min(1.5, clip.volume ?? 1));
    } else {
      vid.muted = muted;
      vid.volume = muted ? 0 : Math.max(0, Math.min(1, clip.volume ?? 1));
    }
  }

  private getOrUpdateSynthOutput(clip: Clip): AudioNode {
    const ctx = this.ensureContext();
    const effect = clip.voiceEffect ?? 'original';
    const existing = this.synthFxMap.get(clip.id);
    if (existing && existing.effect === effect) {
      if (this.exportDestination) {
        try {
          existing.output.connect(this.exportDestination);
        } catch {
          // ignore
        }
      }
      return existing.input;
    }
    if (existing) {
      existing.dispose();
    }
    const graph = createVoiceEffectNodes(ctx, effect);
    this.connectToOutput(graph.output);
    this.synthFxMap.set(clip.id, graph);
    return graph.input;
  }

  private triggerSynthStep(clip: Clip) {
    if (this.mutePlayback) return;
    const preset = clip.src || 'synth:lofi';
    const volume = clip.volume ?? 0.8;
    const pitchMult = getClipEffectivePitch(clip);
    const ctx = this.ensureContext();
    const now = ctx.currentTime;
    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(Math.max(0.01, volume * 0.25), now);
    const fxInput = this.getOrUpdateSynthOutput(clip);
    masterGain.connect(fxInput);

    const prevStep = this.synthSteps.get(clip.id) ?? 0;
    const step = prevStep % 8;

    if (preset === 'synth:lofi') {
      const chords = [220, 261.63, 329.63, 392.0];
      const note = chords[step % chords.length] * pitchMult;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(note, now);
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.exponentialRampToValueAtTime(0.35, now + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.42);
      osc.connect(gain);
      gain.connect(masterGain);
      osc.start(now);
      osc.stop(now + 0.44);

      if (step === 0 || step === 4) {
        const kick = ctx.createOscillator();
        const kGain = ctx.createGain();
        kick.type = 'sine';
        kick.frequency.setValueAtTime(125 * pitchMult, now);
        kick.frequency.exponentialRampToValueAtTime(42 * pitchMult, now + 0.14);
        kGain.gain.setValueAtTime(0.6, now);
        kGain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
        kick.connect(kGain);
        kGain.connect(masterGain);
        kick.start(now);
        kick.stop(now + 0.18);
      }
    } else if (preset === 'synth:pulse') {
      const notes = [146.83, 146.83, 220, 196, 174.61, 174.61, 220, 261.63];
      const freq = notes[step] * pitchMult;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq, now);
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(950, now);
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.exponentialRampToValueAtTime(0.28, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(masterGain);
      osc.start(now);
      osc.stop(now + 0.24);
    } else {
      if (step % 2 === 0) {
        const padNotes = [130.81, 196.0, 246.94, 293.66];
        const freq = padNotes[(step / 2) % padNotes.length] * pitchMult;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now);
        gain.gain.setValueAtTime(0.001, now);
        gain.gain.linearRampToValueAtTime(0.32, now + 0.15);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.85);
        osc.connect(gain);
        gain.connect(masterGain);
        osc.start(now);
        osc.stop(now + 0.9);
      }
    }

    this.synthSteps.set(clip.id, prevStep + 1);
  }

  public sync(
    clips: Clip[],
    time: number,
    isPlaying: boolean,
    tracks?: Track[]
  ) {
    const mutedTrackIds = new Set(
      (tracks ?? []).filter((t) => t.muted).map((t) => t.id)
    );

    const activeAudioClips = clips.filter(
      (c) =>
        c.track === 'audio' &&
        !mutedTrackIds.has(c.trackId) &&
        time >= c.start &&
        time < c.start + c.duration
    );

    const activeSrcs = new Set(
      activeAudioClips
        .map((c) => resolveMediaSrc(c.src) || c.src)
        .filter(Boolean) as string[]
    );

    for (const [src, el] of this.audioElements.entries()) {
      if (!isPlaying || !activeSrcs.has(src)) {
        if (!el.paused) el.pause();
      }
    }

    if (!isPlaying) {
      this.stopAllSynths();
      return;
    }

    const activeSynthIds = new Set(
      activeAudioClips.filter((c) => c.kind === 'synth').map((c) => c.id)
    );
    for (const [id, timer] of this.synthTimers.entries()) {
      if (!activeSynthIds.has(id)) {
        clearInterval(timer);
        this.synthTimers.delete(id);
        this.synthClipSnapshot.delete(id);
      }
    }

    for (const clip of activeAudioClips) {
      if (clip.kind === 'synth' && clip.src) {
        this.synthClipSnapshot.set(clip.id, clip);
        if (!this.synthTimers.has(clip.id)) {
          const baseInterval = clip.src === 'synth:pulse' ? 255 : 350;
          const speed = Math.max(0.01, Math.min(100, clip.speed || 1));
          const intervalMs = Math.max(20, Math.round(baseInterval / speed));
          this.triggerSynthStep(clip);
          const timer = setInterval(() => {
            const latest = this.synthClipSnapshot.get(clip.id) || clip;
            this.triggerSynthStep(latest);
          }, intervalMs);
          this.synthTimers.set(clip.id, timer);
        }
      } else if (clip.kind === 'audio' && clip.src) {
        const el = this.getOrCreateAudioEl(clip.src);
        const speed = Math.max(0.01, Math.min(100, clip.speed || 1));
        const pitch = getClipEffectivePitch(clip);
        const effect = clip.voiceEffect ?? 'original';

        // Preserve pitch in HTMLAudioElement so DSP pitch shifter controls pitch cleanly
        const aAny = el as HTMLAudioElement & {
          preservesPitch?: boolean;
          mozPreservesPitch?: boolean;
          webkitPreservesPitch?: boolean;
        };
        if ('preservesPitch' in aAny) aAny.preservesPitch = true;
        if ('mozPreservesPitch' in aAny) aAny.mozPreservesPitch = true;
        if ('webkitPreservesPitch' in aAny) aAny.webkitPreservesPitch = true;

        const chain = this.ensureElementChain(el, effect, pitch);
        const targetVol = this.mutePlayback
          ? 0
          : Math.max(0, Math.min(1, clip.volume ?? 1));
        if (chain) {
          el.volume = 1;
          el.muted = false;
          chain.gain.gain.value = targetVol;
        } else {
          el.volume = targetVol;
        }

        try {
          el.playbackRate = Math.max(0.0625, Math.min(16, speed));
        } catch {
          // Fallback for browsers rejecting extreme rates
        }
        const targetTime = clip.trimStart + (time - clip.start) * speed;
        if (Math.abs(el.currentTime - targetTime) > 0.35) {
          el.currentTime = Math.max(0, targetTime);
        }
        if (el.paused) {
          void el.play().catch(() => {});
        }
      }
    }
  }

  public stopAllSynths() {
    for (const timer of this.synthTimers.values()) {
      clearInterval(timer);
    }
    this.synthTimers.clear();
    this.synthClipSnapshot.clear();
  }

  public stopAll() {
    this.stopAllSynths();
    for (const el of this.audioElements.values()) {
      if (!el.paused) el.pause();
    }
  }
}
