import type {Clip} from '../shared/types.ts';

/**
 * Web Audio engine supporting uploaded audio files AND procedural backing tracks
 * (`synth:lofi`, `synth:pulse`, `synth:cinema`) for live preview and video export.
 */
export class StudioAudioEngine {
  private ctx: AudioContext | null = null;
  private audioElements = new Map<string, HTMLAudioElement>();
  private mediaNodes = new Map<string, MediaElementAudioSourceNode>();
  private synthTimer: ReturnType<typeof setInterval> | null = null;
  private synthStep = 0;
  private exportDestination: MediaStreamAudioDestinationNode | null = null;

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
    let el = this.audioElements.get(src);
    if (!el) {
      el = new Audio(src);
      el.crossOrigin = 'anonymous';
      el.preload = 'auto';
      this.audioElements.set(src, el);
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

  private triggerSynthStep(preset: string, volume: number) {
    const ctx = this.ensureContext();
    const now = ctx.currentTime;
    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(Math.max(0.01, volume * 0.25), now);
    this.connectToOutput(masterGain);

    const step = this.synthStep % 8;

    if (preset === 'synth:lofi') {
      const chords = [220, 261.63, 329.63, 392.0];
      const note = chords[step % chords.length];
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

      // Soft kick on beats 0 and 4
      if (step === 0 || step === 4) {
        const kick = ctx.createOscillator();
        const kGain = ctx.createGain();
        kick.type = 'sine';
        kick.frequency.setValueAtTime(125, now);
        kick.frequency.exponentialRampToValueAtTime(42, now + 0.14);
        kGain.gain.setValueAtTime(0.6, now);
        kGain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
        kick.connect(kGain);
        kGain.connect(masterGain);
        kick.start(now);
        kick.stop(now + 0.18);
      }
    } else if (preset === 'synth:pulse') {
      const notes = [146.83, 146.83, 220, 196, 174.61, 174.61, 220, 261.63];
      const freq = notes[step];
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
      // synth:cinema
      if (step % 2 === 0) {
        const padNotes = [130.81, 196.0, 246.94, 293.66];
        const freq = padNotes[(step / 2) % padNotes.length];
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

    this.synthStep += 1;
  }

  public sync(clips: Clip[], time: number, isPlaying: boolean) {
    const activeAudioClips = clips.filter(
      (c) => c.track === 'audio' && time >= c.start && time < c.start + c.duration
    );

    const activeSrcs = new Set(
      activeAudioClips.map((c) => c.src).filter(Boolean) as string[]
    );

    // Pause inactive HTMLAudioElements
    for (const [src, el] of this.audioElements.entries()) {
      if (!isPlaying || !activeSrcs.has(src)) {
        if (!el.paused) el.pause();
      }
    }

    if (!isPlaying) {
      this.stopSynth();
      return;
    }

    const activeSynth = activeAudioClips.find((c) => c.kind === 'synth');
    if (activeSynth && activeSynth.src) {
      if (!this.synthTimer) {
        const intervalMs = activeSynth.src === 'synth:pulse' ? 255 : 350;
        this.triggerSynthStep(activeSynth.src, activeSynth.volume);
        this.synthTimer = setInterval(() => {
          this.triggerSynthStep(activeSynth.src!, activeSynth.volume);
        }, intervalMs);
      }
    } else {
      this.stopSynth();
    }

    for (const clip of activeAudioClips) {
      if (clip.kind === 'audio' && clip.src) {
        const el = this.getOrCreateAudioEl(clip.src);
        const ctx = this.ensureContext();
        if (!this.mediaNodes.has(clip.src)) {
          try {
            const sourceNode = ctx.createMediaElementSource(el);
            this.connectToOutput(sourceNode);
            this.mediaNodes.set(clip.src, sourceNode);
          } catch {
            // Already connected
          }
        }
        el.volume = Math.max(0, Math.min(1, clip.volume));
        el.playbackRate = clip.speed || 1;
        const targetTime =
          clip.trimStart + (time - clip.start) * (clip.speed || 1);
        if (Math.abs(el.currentTime - targetTime) > 0.35) {
          el.currentTime = Math.max(0, targetTime);
        }
        if (el.paused) {
          void el.play().catch(() => {});
        }
      }
    }
  }

  public stopSynth() {
    if (this.synthTimer) {
      clearInterval(this.synthTimer);
      this.synthTimer = null;
    }
  }

  public stopAll() {
    this.stopSynth();
    for (const el of this.audioElements.values()) {
      if (!el.paused) el.pause();
    }
  }
}
