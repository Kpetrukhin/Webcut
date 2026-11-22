import React, {useEffect, useRef, useState} from 'react';
import {Mic, Square, Volume2, VolumeX, X} from 'lucide-react';
import {
  requestNativeAudioPermission,
  uploadFileForP2P,
} from '../lib/lanSyncBridge.ts';
import {probeAudioDuration} from '../lib/audioDsp.ts';

interface VoiceRecorderOverlayProps {
  currentTime: number;
  onStartPlayback: () => void;
  onStopPlayback: () => void;
  onMutePlaybackChange: (muted: boolean) => void;
  onRecordingSaved: (opts: {
    name: string;
    src: string;
    fileName?: string;
    remoteUrl?: string;
    duration: number;
    startTime: number;
  }) => void;
  onClose: () => void;
}

const METER_BARS = 18;

export const VoiceRecorderOverlay: React.FC<VoiceRecorderOverlayProps> = ({
  currentTime,
  onStartPlayback,
  onStopPlayback,
  onMutePlaybackChange,
  onRecordingSaved,
  onClose,
}) => {
  const [phase, setPhase] = useState<
    'requesting' | 'ready' | 'recording' | 'saving' | 'error'
  >('requesting');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [muteVideoDuringRec, setMuteVideoDuringRec] = useState(true);
  const [micLevel, setMicLevel] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(0);

  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const rafRef = useRef<number>(0);
  const recordStartTimeRef = useRef<number>(currentTime);
  const recordWallStartRef = useRef<number>(0);
  const currentTimeRef = useRef<number>(currentTime);
  currentTimeRef.current = currentTime;

  useEffect(() => {
    onMutePlaybackChange(phase === 'recording' && muteVideoDuringRec);
    return () => {
      onMutePlaybackChange(false);
    };
  }, [phase, muteVideoDuringRec, onMutePlaybackChange]);

  useEffect(() => {
    let cancelled = false;

    const initMic = async () => {
      setPhase('requesting');
      setErrorMsg(null);
      try {
        const nativeOk = await requestNativeAudioPermission();
        if (!nativeOk) {
          throw new Error('Нет разрешения на запись с микрофона');
        }
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('Микрофон недоступен в этом браузере');
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;

        const AudioCtx =
          window.AudioContext ||
          (window as unknown as {webkitAudioContext: typeof AudioContext})
            .webkitAudioContext;
        const ctx = new AudioCtx();
        audioCtxRef.current = ctx;
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.65;
        src.connect(analyser);
        analyserRef.current = analyser;

        const dataArr = new Uint8Array(analyser.frequencyBinCount);
        const updateMeter = () => {
          if (cancelled) return;
          analyser.getByteTimeDomainData(dataArr);
          let sumSq = 0;
          for (let i = 0; i < dataArr.length; i++) {
            const norm = (dataArr[i] - 128) / 128;
            sumSq += norm * norm;
          }
          const rms = Math.sqrt(sumSq / dataArr.length);
          const boosted = Math.min(1, rms * 3.4);
          setMicLevel(boosted);
          if (recordWallStartRef.current > 0) {
            setElapsedSec((performance.now() - recordWallStartRef.current) / 1000);
          }
          rafRef.current = requestAnimationFrame(updateMeter);
        };
        rafRef.current = requestAnimationFrame(updateMeter);
        setPhase('ready');
      } catch (err) {
        if (!cancelled) {
          setErrorMsg(
            err instanceof Error
              ? err.message
              : 'Разрешите доступ к микрофону в настройках устройства'
          );
          setPhase('error');
        }
      }
    };

    void initMic();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        try {
          recorderRef.current.stop();
        } catch {
          // ignore
        }
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      void audioCtxRef.current?.close().catch(() => {});
      audioCtxRef.current = null;
      onMutePlaybackChange(false);
    };
  }, [onMutePlaybackChange]);

  const handleStart = () => {
    const stream = streamRef.current;
    if (!stream || phase !== 'ready') return;
    if (audioCtxRef.current?.state === 'suspended') {
      void audioCtxRef.current.resume();
    }

    const mimeCandidates = [
      'audio/webm;codecs=opus',
      'audio/mp4',
      'audio/webm',
      'audio/ogg',
    ];
    const mimeType =
      mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';

    chunksRef.current = [];
    const rec = new MediaRecorder(
      stream,
      mimeType ? {mimeType} : undefined
    );
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        chunksRef.current.push(e.data);
      }
    };
    recorderRef.current = rec;
    recordStartTimeRef.current = currentTimeRef.current;
    recordWallStartRef.current = performance.now();
    setElapsedSec(0);
    setPhase('recording');
    rec.start(150);
    onStartPlayback();
  };

  const handleStopAndSave = () => {
    const rec = recorderRef.current;
    if (!rec || rec.state === 'inactive') return;

    const wallDur = Math.max(
      0.3,
      (performance.now() - recordWallStartRef.current) / 1000
    );
    recordWallStartRef.current = 0;
    onStopPlayback();
    setPhase('saving');

    rec.onstop = async () => {
      try {
        const mime = rec.mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, {type: mime});
        const ext = mime.includes('mp4')
          ? 'm4a'
          : mime.includes('ogg')
            ? 'ogg'
            : 'webm';
        const stamp = new Date()
          .toTimeString()
          .slice(0, 8)
          .replace(/:/g, '-');
        const file = new File([blob], `Голос_${stamp}.${ext}`, {type: mime});
        const prepared = await uploadFileForP2P(file, 'audio');
        const probedDur = await probeAudioDuration(prepared.localSrc).catch(
          () => wallDur
        );
        const finalDur =
          Number.isFinite(probedDur) && probedDur > 0.25 ? probedDur : wallDur;

        onRecordingSaved({
          name: `Озвучка ${stamp}`,
          src: prepared.localSrc,
          fileName: prepared.fileName,
          remoteUrl: prepared.shareUrl,
          duration: Math.round(finalDur * 100) / 100,
          startTime: Math.round(recordStartTimeRef.current * 100) / 100,
        });
        onClose();
      } catch (err) {
        setErrorMsg(
          err instanceof Error ? err.message : 'Не удалось сохранить запись'
        );
        setPhase('error');
      }
    };

    rec.stop();
  };

  const handleCancel = () => {
    recordWallStartRef.current = 0;
    if (phase === 'recording') {
      onStopPlayback();
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        recorderRef.current.onstop = null;
        recorderRef.current.stop();
      }
    }
    onClose();
  };

  const formatRecTime = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const d = Math.floor((sec % 1) * 10);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${d}`;
  };

  return (
    <div className="absolute inset-0 z-30 flex flex-col border-t border-white/10 bg-[#0d0d11]">
      {/* Compact Header */}
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-white/10 bg-[#121217] px-3">
        <div className="flex items-center gap-2">
          <span
            className={`h-2.5 w-2.5 rounded-full ${
              phase === 'recording'
                ? 'bg-rose-500 animate-pulse'
                : 'bg-emerald-400'
            }`}
          />
          <span className="text-xs font-semibold text-white">
            Диктофон · Озвучка
          </span>
          <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-rose-300">
            {formatRecTime(elapsedSec)}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setMuteVideoDuringRec((v) => !v)}
            className={`flex h-7 items-center gap-1 rounded-md border px-2 text-[10px] font-medium transition ${
              muteVideoDuringRec
                ? 'border-amber-400/50 bg-amber-500/15 text-amber-200'
                : 'border-white/10 bg-zinc-900 text-zinc-300'
            }`}
            title="Отключить звук таймлайна во время записи, чтобы избежать эха"
          >
            {muteVideoDuringRec ? (
              <VolumeX className="h-3.5 w-3.5" />
            ) : (
              <Volume2 className="h-3.5 w-3.5" />
            )}
            <span className="hidden sm:inline">
              {muteVideoDuringRec ? 'Без звука ролика' : 'Мониторинг'}
            </span>
          </button>

          <button
            type="button"
            onClick={handleCancel}
            className="flex h-7 w-7 items-center justify-center rounded-md bg-white/10 text-zinc-200 hover:bg-white/15"
            aria-label="Закрыть диктофон"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Body with Live VU Meter + Record CTA */}
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-2">
        {phase === 'error' ? (
          <div className="max-w-md space-y-2 text-center">
            <p className="text-xs font-medium text-rose-300">{errorMsg}</p>
            <button
              type="button"
              onClick={handleCancel}
              className="rounded-lg bg-white/10 px-4 py-1.5 text-xs font-medium text-white"
            >
              Закрыть
            </button>
          </div>
        ) : (
          <>
            {/* Live Microphone Level Bars */}
            <div className="flex h-12 w-full max-w-md items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-zinc-950/90 px-4">
              {Array.from({length: METER_BARS}).map((_, idx) => {
                const threshold = (idx + 1) / METER_BARS;
                const lit = micLevel >= threshold * 0.72;
                const isPeak = idx >= METER_BARS - 3;
                const isMid = idx >= METER_BARS - 7;
                return (
                  <div
                    key={idx}
                    className={`h-6 flex-1 rounded-sm transition-all duration-75 ${
                      lit
                        ? isPeak
                          ? 'bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.6)]'
                          : isMid
                            ? 'bg-amber-400'
                            : 'bg-emerald-400'
                        : 'bg-zinc-800/80'
                    }`}
                  />
                );
              })}
            </div>

            {/* Action Button */}
            <div className="flex items-center gap-3">
              {phase === 'requesting' && (
                <p className="text-xs text-zinc-400">
                  Запрос доступа к микрофону...
                </p>
              )}
              {phase === 'ready' && (
                <button
                  type="button"
                  onClick={handleStart}
                  className="flex h-12 items-center gap-2 rounded-full bg-rose-500 px-6 text-xs font-semibold text-white shadow-lg shadow-rose-500/30 hover:bg-rose-400 active:scale-95"
                >
                  <Mic className="h-4 w-4" />
                  <span>Начать запись с {currentTime.toFixed(1)}с</span>
                </button>
              )}
              {phase === 'recording' && (
                <button
                  type="button"
                  onClick={handleStopAndSave}
                  className="flex h-12 items-center gap-2 rounded-full border-2 border-rose-400 bg-rose-600/90 px-6 text-xs font-semibold text-white shadow-lg shadow-rose-500/30 hover:bg-rose-500 active:scale-95"
                >
                  <Square className="h-4 w-4 fill-white" />
                  <span>Стоп и добавить на дорожку</span>
                </button>
              )}
              {phase === 'saving' && (
                <p className="text-xs font-medium text-emerald-300">
                  Сохранение записи...
                </p>
              )}
            </div>

            <p className="text-[10px] text-zinc-400">
              Во время записи видео воспроизводится синхронно, чтобы озвучивать ролик в реальном времени.
            </p>
          </>
        )}
      </div>
    </div>
  );
};
