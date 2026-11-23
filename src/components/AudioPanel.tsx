import React, {useState} from 'react';
import {
  AudioWaveform,
  FileAudio,
  Gauge,
  Link2,
  Loader2,
  Mic,
  Music,
  Plus,
  Radio,
  RotateCcw,
  Sparkles,
  Volume2,
} from 'lucide-react';
import {
  extractAudioFromVideoClip,
  probeAudioDuration,
  renderTimelineMixdownToWav,
} from '../lib/audioDsp.ts';
import {extractAudioNative, uploadFileForP2P} from '../lib/lanSyncBridge.ts';
import {
  SYNTH_AUDIO_PRESETS,
  VOICE_EFFECT_PRESETS,
} from '../shared/types.ts';
import type {Clip, Track, VoiceEffectPreset} from '../shared/types.ts';
import {UnityNumberField} from './UnityNumberField.tsx';

export type AudioSubSection = 'all' | 'speed' | 'fx';

interface AudioPanelProps {
  selectedClip: Clip | null;
  allClips: Clip[];
  tracks: Track[];
  duration: number;
  initialSection?: AudioSubSection;
  onAddAudioClip: (opts: {
    name: string;
    kind: 'audio' | 'synth';
    src: string;
    fileName?: string;
    remoteUrl?: string;
    fileSize?: number;
    fileHash?: string;
    duration: number;
    startTime?: number;
    forceNewTrack?: boolean;
  }) => void;
  onUpdateClip: (
    clipId: string,
    patch: Partial<Clip>,
    opts?: {skipUndo?: boolean; skipSync?: boolean}
  ) => void;
  onOpenRecorder: () => void;
  onNotify?: (msg: string) => void;
  onClose?: () => void;
}

export const AudioPanel: React.FC<AudioPanelProps> = ({
  selectedClip,
  allClips,
  tracks,
  duration,
  initialSection = 'all',
  onAddAudioClip,
  onUpdateClip,
  onOpenRecorder,
  onNotify,
  onClose,
}) => {
  const [uploading, setUploading] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  const audioEditableClip =
    selectedClip &&
    (selectedClip.track === 'audio' || selectedClip.kind === 'video')
      ? selectedClip
      : null;

  const isSelectedVideo = selectedClip?.kind === 'video';

  const handleAudioUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setStatusError(null);
    try {
      const prepared = await uploadFileForP2P(file, 'audio');
      const dur = await probeAudioDuration(prepared.localSrc);
      onAddAudioClip({
        name: prepared.name.replace(/\.[^.]+$/, ''),
        kind: 'audio',
        src: prepared.localSrc,
        fileName: prepared.fileName,
        remoteUrl: prepared.shareUrl,
        fileSize: prepared.fileSize,
        fileHash: prepared.fileHash,
        duration: Math.max(0.5, Math.min(1800, dur)),
        forceNewTrack: false,
      });
      onNotify?.('Аудио добавлено на дорожку');
      onClose?.();
    } catch (err) {
      setStatusError(
        err instanceof Error ? err.message : 'Не удалось загрузить аудио'
      );
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const handleExtractAudio = async () => {
    setExtracting(true);
    setStatusError(null);
    try {
      if (isSelectedVideo && selectedClip) {
        // 1. Extract audio track from the selected video clip
        let extractedSrc = '';
        let extractedFileName = '';
        let extractedShareUrl = '';
        let extractedFileSize: number | undefined;
        let extractedFileHash: string | undefined;
        let extractedDur = selectedClip.duration;

        try {
          if (selectedClip.src) {
            const nativeRes = await extractAudioNative({
              sourceUrl: selectedClip.src,
              fileName: selectedClip.mediaFileName || `${selectedClip.name}.mp4`,
              trimStartSec: selectedClip.trimStart,
              durationSec: selectedClip.duration * (selectedClip.speed || 1),
            });
            if (nativeRes) {
              extractedSrc = nativeRes.localSrc;
              extractedFileName = nativeRes.fileName;
              extractedShareUrl = nativeRes.shareUrl;
              extractedFileSize = nativeRes.fileSize;
              extractedFileHash = nativeRes.fileHash;
              extractedDur = Math.min(
                selectedClip.duration,
                nativeRes.durationSec || selectedClip.duration
              );
            }
          }
        } catch {
          // Fall through to Web Audio extraction
        }

        if (!extractedSrc) {
          const {file, duration: webDur} =
            await extractAudioFromVideoClip(selectedClip);
          const prepared = await uploadFileForP2P(file, 'audio');
          extractedSrc = prepared.localSrc;
          extractedFileName = prepared.fileName;
          extractedShareUrl = prepared.shareUrl;
          extractedFileSize = prepared.fileSize;
          extractedFileHash = prepared.fileHash;
          extractedDur = webDur;
        }

        // Mute original video clip & place extracted audio directly underneath at the exact same start
        onUpdateClip(selectedClip.id, {volume: 0});
        onAddAudioClip({
          name: `Звук · ${selectedClip.name}`,
          kind: 'audio',
          src: extractedSrc,
          fileName: extractedFileName,
          remoteUrl: extractedShareUrl,
          fileSize: extractedFileSize,
          fileHash: extractedFileHash,
          duration: extractedDur,
          startTime: selectedClip.start,
          forceNewTrack: false,
        });
        onNotify?.('Аудио извлечено из видеоклипа');
        onClose?.();
      } else {
        // 2. Mixdown the entire timeline 0..duration into a single new audio clip
        const {file, duration: mixDur} = await renderTimelineMixdownToWav(
          allClips,
          tracks,
          duration
        );
        const prepared = await uploadFileForP2P(file, 'audio');
        onAddAudioClip({
          name: 'Сведённое аудио',
          kind: 'audio',
          src: prepared.localSrc,
          fileName: prepared.fileName,
          remoteUrl: prepared.shareUrl,
          fileSize: prepared.fileSize,
          fileHash: prepared.fileHash,
          duration: mixDur,
          startTime: 0,
          forceNewTrack: true,
        });
        onNotify?.('Сводная аудиодорожка создана');
        onClose?.();
      }
    } catch (err) {
      setStatusError(
        err instanceof Error ? err.message : 'Не удалось извлечь аудио'
      );
    } finally {
      setExtracting(false);
    }
  };

  const updateSpeed = (nextSpeedRaw: number, commit: boolean) => {
    if (!audioEditableClip) return;
    const nextSpeed = Math.max(
      0.01,
      Math.min(100, Math.round(nextSpeedRaw * 100) / 100)
    );
    const prevSpeed = audioEditableClip.speed || 1;
    const ratio = prevSpeed / nextSpeed;
    const nextDuration = Math.max(
      0.1,
      Math.min(3600, Math.round(audioEditableClip.duration * ratio * 100) / 100)
    );

    const patch: Partial<Clip> = {
      speed: nextSpeed,
      duration: nextDuration,
    };

    if (audioEditableClip.linkSpeedPitch) {
      patch.pitch = Math.max(
        0.01,
        Math.min(100, Math.round(nextSpeed * 100) / 100)
      );
    }

    onUpdateClip(audioEditableClip.id, patch, {
      skipUndo: !commit,
    });
  };

  const updatePitch = (nextPitchRaw: number, commit: boolean) => {
    if (!audioEditableClip) return;
    const nextPitch = Math.max(
      0.01,
      Math.min(100, Math.round(nextPitchRaw * 100) / 100)
    );
    onUpdateClip(
      audioEditableClip.id,
      {pitch: nextPitch},
      {skipUndo: !commit}
    );
  };

  const toggleLinkSpeedPitch = () => {
    if (!audioEditableClip) return;
    const nextLinked = !audioEditableClip.linkSpeedPitch;
    const patch: Partial<Clip> = {linkSpeedPitch: nextLinked};
    if (nextLinked) {
      patch.pitch = Math.max(
        0.01,
        Math.min(100, Math.round((audioEditableClip.speed || 1) * 100) / 100)
      );
    }
    onUpdateClip(audioEditableClip.id, patch);
  };

  const selectVoiceEffect = (fxId: VoiceEffectPreset) => {
    if (!audioEditableClip) return;
    onUpdateClip(audioEditableClip.id, {voiceEffect: fxId});
  };

  const currentSpeed = audioEditableClip?.speed ?? 1;
  const currentPitch = audioEditableClip?.pitch ?? 1;
  const isLinked = Boolean(audioEditableClip?.linkSpeedPitch);
  const currentFx: VoiceEffectPreset =
    audioEditableClip?.voiceEffect ?? 'original';

  return (
    <div className="space-y-4">
      {statusError && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
          {statusError}
        </div>
      )}

      {/* Main Sound Actions (Import, Extract Audio, Voice Recorder) */}
      {initialSection === 'all' && (
        <div className="grid grid-cols-3 gap-2">
          <label
            className={`flex min-h-[76px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-2 py-2.5 text-center transition hover:bg-emerald-500/15 active:scale-95 ${
              uploading ? 'pointer-events-none opacity-60' : ''
            }`}
          >
            {uploading ? (
              <Loader2 className="h-5 w-5 animate-spin text-emerald-400" />
            ) : (
              <FileAudio className="h-5 w-5 text-emerald-400" />
            )}
            <span className="text-[11px] font-semibold leading-tight text-emerald-100">
              {uploading ? 'Загрузка...' : 'Из файла'}
            </span>
            <input
              type="file"
              accept="audio/*"
              disabled={uploading}
              onChange={handleAudioUpload}
              className="hidden"
            />
          </label>

          <button
            type="button"
            disabled={extracting}
            onClick={() => void handleExtractAudio()}
            className="flex min-h-[76px] flex-col items-center justify-center gap-1.5 rounded-xl border border-cyan-500/35 bg-cyan-500/10 px-2 py-2.5 text-center transition hover:bg-cyan-500/15 disabled:opacity-60 active:scale-95"
          >
            {extracting ? (
              <Loader2 className="h-5 w-5 animate-spin text-cyan-400" />
            ) : (
              <AudioWaveform className="h-5 w-5 text-cyan-400" />
            )}
            <span className="text-[11px] font-semibold leading-tight text-cyan-100">
              {extracting
                ? 'Рендер...'
                : isSelectedVideo
                  ? 'Извлечь из видео'
                  : 'Свести всё аудио'}
            </span>
          </button>

          <button
            type="button"
            onClick={() => {
              onClose?.();
              onOpenRecorder();
            }}
            className="flex min-h-[76px] flex-col items-center justify-center gap-1.5 rounded-xl border border-rose-500/35 bg-rose-500/10 px-2 py-2.5 text-center transition hover:bg-rose-500/15 active:scale-95"
          >
            <Mic className="h-5 w-5 text-rose-400" />
            <span className="text-[11px] font-semibold leading-tight text-rose-100">
              Диктофон
            </span>
          </button>
        </div>
      )}

      {/* Selected Clip Audio Controls: Volume, Speed & Pitch (UnityNumberField), Voice FX */}
      {audioEditableClip ? (
        <div className="space-y-3">
          {/* Volume */}
          {initialSection === 'all' && (
            <div className="rounded-xl border border-white/10 bg-zinc-900/70 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <Volume2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                  <span className="truncate text-xs font-medium text-zinc-200">
                    Громкость · {audioEditableClip.name}
                  </span>
                </div>
                <UnityNumberField
                  compact
                  accent="emerald"
                  value={Math.round(audioEditableClip.volume * 100)}
                  min={0}
                  max={100}
                  step={1}
                  decimals={0}
                  sensitivity={4}
                  suffix="%"
                  ariaLabel="Громкость клипа"
                  onChange={(pct) =>
                    onUpdateClip(
                      audioEditableClip.id,
                      {volume: pct / 100},
                      {skipUndo: true}
                    )
                  }
                  onCommit={(pct) =>
                    onUpdateClip(audioEditableClip.id, {volume: pct / 100})
                  }
                />
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={audioEditableClip.volume}
                onChange={(e) =>
                  onUpdateClip(
                    audioEditableClip.id,
                    {volume: Number(e.target.value)},
                    {skipUndo: true}
                  )
                }
                onPointerUp={(e) =>
                  onUpdateClip(audioEditableClip.id, {
                    volume: Number((e.target as HTMLInputElement).value),
                  })
                }
                onTouchEnd={(e) =>
                  onUpdateClip(audioEditableClip.id, {
                    volume: Number((e.target as HTMLInputElement).value),
                  })
                }
                className="h-2 w-full cursor-pointer accent-emerald-400"
              />
            </div>
          )}

          {/* Speed & Pitch with UnityNumberField */}
          {(initialSection === 'all' || initialSection === 'speed') && (
            <div className="space-y-2.5 rounded-xl border border-white/10 bg-zinc-900/70 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <Gauge className="h-3.5 w-3.5 text-emerald-400" />
                  <span className="text-xs font-semibold text-white">
                    Скорость и Тон (Pitch)
                  </span>
                </div>
                {(Math.abs(currentSpeed - 1) > 0.01 ||
                  Math.abs(currentPitch - 1) > 0.01 ||
                  isLinked) && (
                  <button
                    type="button"
                    onClick={() => {
                      const ratio = (audioEditableClip.speed || 1) / 1;
                      onUpdateClip(audioEditableClip.id, {
                        speed: 1,
                        pitch: 1,
                        linkSpeedPitch: false,
                        duration: Math.max(
                          0.4,
                          Math.round(audioEditableClip.duration * ratio * 100) /
                            100
                        ),
                      });
                    }}
                    className="flex items-center gap-1 text-[11px] text-zinc-400 hover:text-emerald-300"
                  >
                    <RotateCcw className="h-3 w-3" />
                    <span>Сброс</span>
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div className="rounded-lg border border-white/5 bg-zinc-950/70 px-2.5 py-2">
                  <UnityNumberField
                    label="Скорость"
                    value={currentSpeed}
                    min={0.01}
                    max={100}
                    step={0.05}
                    decimals={2}
                    sensitivity={8}
                    suffix="x"
                    accent="emerald"
                    ariaLabel="Скорость воспроизведения"
                    onChange={(v) => updateSpeed(v, false)}
                    onCommit={(v) => updateSpeed(v, true)}
                  />
                </div>

                <div className="rounded-lg border border-white/5 bg-zinc-950/70 px-2.5 py-2">
                  <UnityNumberField
                    label="Тон (Pitch)"
                    value={currentPitch}
                    min={0.01}
                    max={100}
                    step={0.05}
                    decimals={2}
                    sensitivity={10}
                    suffix="x"
                    accent="cyan"
                    disabled={isLinked}
                    ariaLabel="Тон голоса Pitch"
                    onChange={(v) => updatePitch(v, false)}
                    onCommit={(v) => updatePitch(v, true)}
                  />
                </div>
              </div>

              <button
                type="button"
                onClick={toggleLinkSpeedPitch}
                className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-xs font-medium transition ${
                  isLinked
                    ? 'border-emerald-400/60 bg-emerald-500/15 text-emerald-200'
                    : 'border-white/10 bg-zinc-950/60 text-zinc-300 hover:border-white/20'
                }`}
              >
                <span className="flex items-center gap-1.5">
                  <Link2 className="h-3.5 w-3.5 text-emerald-400" />
                  <span>Связать скорость и тон</span>
                </span>
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                    isLinked
                      ? 'bg-emerald-400 text-zinc-950'
                      : 'bg-white/10 text-zinc-400'
                  }`}
                >
                  {isLinked ? 'ВКЛ' : 'ВЫКЛ'}
                </span>
              </button>

              <p className="text-[10px] text-zinc-400">
                Потяните число пальцем влево/вправо или нажмите на него для точного ввода.
              </p>
            </div>
          )}

          {/* Voice Effects Horizontal Preset Strip */}
          {(initialSection === 'all' || initialSection === 'fx') && (
            <div className="space-y-2 rounded-xl border border-white/10 bg-zinc-900/70 p-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <Sparkles className="h-3.5 w-3.5 text-cyan-400" />
                  <span className="text-xs font-semibold text-white">
                    Звуковые эффекты (Голосовые фильтры)
                  </span>
                </div>
                {currentFx !== 'original' && (
                  <button
                    type="button"
                    onClick={() => selectVoiceEffect('original')}
                    className="text-[11px] text-cyan-300 hover:underline"
                  >
                    Сбросить
                  </button>
                )}
              </div>

              <div className="no-scrollbar flex gap-2 overflow-x-auto pb-1">
                {VOICE_EFFECT_PRESETS.map((fx) => {
                  const active = currentFx === fx.id;
                  return (
                    <button
                      key={fx.id}
                      type="button"
                      onClick={() => selectVoiceEffect(fx.id)}
                      className={`flex min-w-[96px] shrink-0 flex-col items-start gap-1 rounded-xl border px-3 py-2 text-left transition active:scale-95 ${
                        active
                          ? 'border-cyan-400 bg-cyan-500/20 text-cyan-100'
                          : 'border-white/10 bg-zinc-950/70 text-zinc-300 hover:border-white/25'
                      }`}
                    >
                      <div className="flex w-full items-center justify-between">
                        <Radio
                          className={`h-3.5 w-3.5 ${
                            active ? 'text-cyan-300' : 'text-zinc-500'
                          }`}
                        />
                        {active && (
                          <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
                        )}
                      </div>
                      <span className="text-[11px] font-semibold leading-tight">
                        {fx.label}
                      </span>
                      <span className="text-[9px] leading-tight text-zinc-400">
                        {fx.hint}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-white/10 bg-zinc-900/50 p-3 text-center text-xs text-zinc-400">
          Выделите аудиоклип или видео на таймлайне, чтобы настроить скорость, тон (Pitch) и голосовые фильтры.
        </div>
      )}

      {/* Built-in Soundtracks */}
      {initialSection === 'all' && (
        <div>
          <p className="mb-2 text-xs font-medium text-zinc-400">
            Встроенные саундтреки (Web Audio)
          </p>
          <div className="space-y-2">
            {SYNTH_AUDIO_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => {
                  onAddAudioClip({
                    name: preset.name,
                    kind: 'synth',
                    src: preset.src,
                    duration: preset.duration,
                    forceNewTrack: false,
                  });
                  onClose?.();
                }}
                className="flex min-h-[48px] w-full items-center justify-between rounded-xl border border-white/10 bg-zinc-900 px-3.5 py-2 text-left hover:border-emerald-400/60 active:scale-[0.99]"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-400">
                    <Music className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-white">
                      {preset.name}
                    </p>
                    <p className="text-[11px] text-zinc-500">
                      {preset.bpm} BPM · {preset.duration}с
                    </p>
                  </div>
                </div>
                <Plus className="h-4 w-4 shrink-0 text-emerald-400" />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
