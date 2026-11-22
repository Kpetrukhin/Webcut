import React, {useRef} from 'react';
import {
  Eye,
  EyeOff,
  Film,
  Layers,
  Music,
  Plus,
  Trash2,
  Type,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type {Clip, Collaborator, Track, TrackType} from '../shared/types.ts';

interface TimelineProps {
  tracks: Track[];
  clips: Clip[];
  duration: number;
  currentTime: number;
  pxPerSec: number;
  selectedClipId: string | null;
  currentUserId?: string;
  collaborators: Collaborator[];
  onSeek: (time: number) => void;
  onSelectClip: (clipId: string | null) => void;
  onZoomChange: (pxPerSec: number) => void;
  onAddTrack: (type: TrackType) => void;
  onUpdateTrack: (trackId: string, patch: Partial<Track>) => void;
  onDeleteTrack: (trackId: string) => void;
  onLockLayer?: (layerId: string, locked: boolean) => boolean;
  onClipTransform: (
    clipId: string,
    patch: Partial<Clip>,
    commit: boolean
  ) => void;
}

function getTrackIcon(type: TrackType) {
  switch (type) {
    case 'video':
      return Film;
    case 'overlay':
      return Layers;
    case 'text':
      return Type;
    case 'audio':
      return Music;
  }
}

function getTrackAccentClass(type: TrackType): string {
  switch (type) {
    case 'video':
      return 'bg-cyan-400';
    case 'overlay':
      return 'bg-indigo-400';
    case 'text':
      return 'bg-amber-400';
    case 'audio':
      return 'bg-emerald-400';
  }
}

function getTrackHeightClass(type: TrackType): string {
  switch (type) {
    case 'video':
      return 'h-13 sm:h-14';
    case 'overlay':
      return 'h-11 sm:h-12';
    case 'text':
    case 'audio':
      return 'h-10 sm:h-11';
  }
}

export const Timeline: React.FC<TimelineProps> = ({
  tracks,
  clips,
  duration,
  currentTime,
  pxPerSec,
  selectedClipId,
  currentUserId,
  collaborators,
  onSeek,
  onSelectClip,
  onZoomChange,
  onAddTrack,
  onUpdateTrack,
  onDeleteTrack,
  onLockLayer,
  onClipTransform,
}) => {
  const rulerRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const scrubActiveRef = useRef(false);

  const dragClipRef = useRef<{
    clipId: string;
    trackType: TrackType;
    mode: 'move' | 'trim-left' | 'trim-right';
    startX: number;
    origStart: number;
    origDuration: number;
    origTrimStart: number;
    origTrackId: string;
    sourceDuration: number;
    speed: number;
  } | null>(null);

  const totalWidth = Math.max(640, Math.ceil((duration + 4) * pxPerSec));

  const clientXToTime = (clientX: number): number => {
    const el = rulerRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left;
    return Math.max(0, Math.min(duration + 2, x / pxPerSec));
  };

  const handleRulerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    scrubActiveRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    onSeek(clientXToTime(e.clientX));
  };

  const handleRulerPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubActiveRef.current) return;
    onSeek(clientXToTime(e.clientX));
  };

  const handleRulerPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubActiveRef.current) return;
    scrubActiveRef.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  const findCompatibleTrackAtY = (
    clientY: number,
    type: TrackType,
    fallbackTrackId: string
  ): string => {
    for (const track of tracks) {
      if (track.type !== type) continue;
      const el = rowRefs.current.get(track.id);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (clientY >= rect.top && clientY <= rect.bottom) {
        return track.id;
      }
    }
    return fallbackTrackId;
  };

  const snapTime = (rawTime: number, excludeClipId: string): number => {
    const thresholdSec = 8 / pxPerSec;
    const candidates = [0, currentTime];
    for (const c of clips) {
      if (c.id === excludeClipId) continue;
      candidates.push(c.start, c.start + c.duration);
    }
    for (const target of candidates) {
      if (Math.abs(rawTime - target) <= thresholdSec) {
        return Math.round(target * 100) / 100;
      }
    }
    return Math.round(rawTime * 20) / 20;
  };

  const startClipDrag = (
    e: React.PointerEvent<HTMLElement>,
    clip: Clip,
    mode: 'move' | 'trim-left' | 'trim-right'
  ) => {
    e.stopPropagation();
    onSelectClip(clip.id);
    if (clip.lockedByUserId && clip.lockedByUserId !== currentUserId) {
      onLockLayer?.(clip.id, true);
      return;
    }
    if (onLockLayer && onLockLayer(clip.id, true) === false) {
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    dragClipRef.current = {
      clipId: clip.id,
      trackType: clip.track,
      mode,
      startX: e.clientX,
      origStart: clip.start,
      origDuration: clip.duration,
      origTrimStart: clip.trimStart,
      origTrackId: clip.trackId,
      sourceDuration: clip.sourceDuration || 60,
      speed: clip.speed || 1,
    };
  };

  const computePatchFromDrag = (
    drag: NonNullable<typeof dragClipRef.current>,
    clientX: number,
    clientY: number
  ): Partial<Clip> => {
    const dt = (clientX - drag.startX) / pxPerSec;
    if (drag.mode === 'move') {
      const rawStart = Math.max(0, drag.origStart + dt);
      const nextStart = snapTime(rawStart, drag.clipId);
      const targetTrackId = findCompatibleTrackAtY(
        clientY,
        drag.trackType,
        drag.origTrackId
      );
      return {start: nextStart, trackId: targetTrackId};
    }
    if (drag.mode === 'trim-left') {
      const maxDelta = drag.origDuration - 0.3;
      const minDelta = -Math.min(drag.origStart, drag.origTrimStart / drag.speed);
      const clampedDt = Math.max(minDelta, Math.min(maxDelta, dt));
      const nextStart = Math.round((drag.origStart + clampedDt) * 100) / 100;
      const nextDur = Math.round((drag.origDuration - clampedDt) * 100) / 100;
      const nextTrim = Math.max(
        0,
        Math.round((drag.origTrimStart + clampedDt * drag.speed) * 100) / 100
      );
      return {start: nextStart, duration: nextDur, trimStart: nextTrim};
    }
    const maxAllowedDur = Math.max(
      0.3,
      (drag.sourceDuration - drag.origTrimStart) / drag.speed
    );
    const nextDur = Math.max(
      0.3,
      Math.min(maxAllowedDur, Math.round((drag.origDuration + dt) * 100) / 100)
    );
    return {duration: nextDur};
  };

  const handleClipPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const drag = dragClipRef.current;
    if (!drag) return;
    e.stopPropagation();
    const patch = computePatchFromDrag(drag, e.clientX, e.clientY);
    onClipTransform(drag.clipId, patch, false);
  };

  const handleClipPointerUp = (e: React.PointerEvent<HTMLElement>) => {
    const drag = dragClipRef.current;
    if (!drag) return;
    e.stopPropagation();
    const patch = computePatchFromDrag(drag, e.clientX, e.clientY);
    dragClipRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    onClipTransform(drag.clipId, patch, true);
    onLockLayer?.(drag.clipId, false);
  };

  const secStep = pxPerSec >= 90 ? 1 : pxPerSec >= 55 ? 2 : 5;
  const totalSecTicks = Math.ceil(totalWidth / pxPerSec);
  const ticks: number[] = [];
  for (let s = 0; s <= totalSecTicks; s += secStep) {
    ticks.push(s);
  }

  return (
    <div className="flex h-full flex-col border-t border-white/10 bg-[#111114] select-none">
      {/* Compact Track Creation + Zoom Header Strip */}
      <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-white/5 px-2.5 text-[11px] text-zinc-400">
        <div className="no-scrollbar flex items-center gap-1 overflow-x-auto">
          <button
            type="button"
            onClick={() => onAddTrack('overlay')}
            className="flex h-6 items-center gap-1 rounded-md border border-indigo-500/30 bg-indigo-500/10 px-2 text-[10px] font-medium text-indigo-300 hover:bg-indigo-500/20 whitespace-nowrap"
          >
            <Plus className="h-3 w-3" />
            Слой
          </button>
          <button
            type="button"
            onClick={() => onAddTrack('text')}
            className="flex h-6 items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 text-[10px] font-medium text-amber-300 hover:bg-amber-500/20 whitespace-nowrap"
          >
            <Plus className="h-3 w-3" />
            Текст
          </button>
          <button
            type="button"
            onClick={() => onAddTrack('audio')}
            className="flex h-6 items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 text-[10px] font-medium text-emerald-300 hover:bg-emerald-500/20 whitespace-nowrap"
          >
            <Plus className="h-3 w-3" />
            Аудио
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => onZoomChange(Math.max(36, pxPerSec - 16))}
            aria-label="Уменьшить масштаб таймлайна"
            className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 hover:bg-white/10 hover:text-white active:scale-95"
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </button>
          <span className="w-9 text-center font-mono text-[10px] tabular-nums text-zinc-400">
            {Math.round((pxPerSec / 64) * 100)}%
          </span>
          <button
            type="button"
            onClick={() => onZoomChange(Math.min(160, pxPerSec + 16))}
            aria-label="Увеличить масштаб таймлайна"
            className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 hover:bg-white/10 hover:text-white active:scale-95"
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Unified Single Scroll Container: Sticky Left Cells + Track Lanes stay 100% aligned */}
      <div className="studio-scrollbar relative flex-1 min-h-0 overflow-auto bg-[#0e0e11]">
        <div className="relative min-w-max">
          {/* Top Sticky Ruler Row */}
          <div className="sticky top-0 z-40 flex h-6 border-b border-white/10 bg-[#16161b]">
            <div className="sticky left-0 z-50 flex w-[112px] shrink-0 items-center border-r border-white/10 bg-[#16161b] px-2.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 sm:w-[136px]">
              Дорожки
            </div>
            <div
              ref={rulerRef}
              onPointerDown={handleRulerPointerDown}
              onPointerMove={handleRulerPointerMove}
              onPointerUp={handleRulerPointerUp}
              onPointerCancel={handleRulerPointerUp}
              style={{width: `${totalWidth}px`}}
              className="relative h-full shrink-0 cursor-ew-resize touch-none bg-[#16161b]"
            >
              {ticks.map((sec) => (
                <div
                  key={sec}
                  style={{left: `${sec * pxPerSec}px`}}
                  className="pointer-events-none absolute top-0 flex h-full flex-col justify-between"
                >
                  <span className="pl-1 pt-0.5 font-mono text-[10px] leading-none text-zinc-500 tabular-nums">
                    {sec}s
                  </span>
                  <span className="h-1.5 w-px bg-white/20" />
                </div>
              ))}
              {/* Playhead cap on ruler */}
              <div
                style={{left: `${currentTime * pxPerSec}px`}}
                className="pointer-events-none absolute top-0 bottom-0 z-10 w-[2px] bg-white"
              >
                <div className="absolute top-0 -translate-x-1/2 h-3.5 w-3 rounded-b-sm bg-white" />
              </div>
            </div>
          </div>

          {/* Unified Track Rows */}
          {tracks.map((track) => {
            const Icon = getTrackIcon(track.type);
            const hClass = getTrackHeightClass(track.type);
            const accentClass = getTrackAccentClass(track.type);
            const trackClips = clips
              .filter((c) => c.trackId === track.id)
              .sort((a, b) => a.start - b.start);
            const sameTypeCount = tracks.filter(
              (t) => t.type === track.type
            ).length;

            return (
              <div
                key={track.id}
                ref={(el) => {
                  if (el) rowRefs.current.set(track.id, el);
                  else rowRefs.current.delete(track.id);
                }}
                className={`flex ${hClass} border-b border-white/5 bg-[#0e0e11]`}
              >
                {/* Sticky Left Track Header Cell */}
                <div className="sticky left-0 z-30 flex w-[112px] shrink-0 items-center justify-between gap-1 border-r border-white/10 bg-[#141418] pl-2 pr-1 text-[11px] font-medium text-zinc-200 sm:w-[136px] sm:pl-2.5 sm:pr-1.5">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className={`h-4 w-1 shrink-0 rounded-full ${accentClass}`} />
                    <Icon className="h-3 w-3 shrink-0 text-zinc-400" />
                    <span className="truncate">{track.name}</span>
                  </div>

                  <div className="flex shrink-0 items-center">
                    {track.type === 'audio' ? (
                      <button
                        type="button"
                        onClick={() =>
                          onUpdateTrack(track.id, {muted: !track.muted})
                        }
                        aria-label="Отключить звук дорожки"
                        className={`flex h-6 w-6 items-center justify-center rounded hover:bg-white/10 ${
                          track.muted ? 'text-rose-400' : 'text-zinc-500'
                        }`}
                      >
                        {track.muted ? (
                          <VolumeX className="h-3.5 w-3.5" />
                        ) : (
                          <Volume2 className="h-3.5 w-3.5" />
                        )}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() =>
                          onUpdateTrack(track.id, {hidden: !track.hidden})
                        }
                        aria-label="Скрыть слой дорожки"
                        className={`flex h-6 w-6 items-center justify-center rounded hover:bg-white/10 ${
                          track.hidden ? 'text-amber-400' : 'text-zinc-500'
                        }`}
                      >
                        {track.hidden ? (
                          <EyeOff className="h-3.5 w-3.5" />
                        ) : (
                          <Eye className="h-3.5 w-3.5" />
                        )}
                      </button>
                    )}

                    {trackClips.length === 0 && sameTypeCount > 1 && (
                      <button
                        type="button"
                        onClick={() => onDeleteTrack(track.id)}
                        aria-label="Удалить пустую дорожку"
                        className="flex h-6 w-6 items-center justify-center rounded text-zinc-500 hover:bg-rose-500/15 hover:text-rose-400"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Track Clip Lane */}
                <div
                  style={{width: `${totalWidth}px`}}
                  onClick={() => onSelectClip(null)}
                  className={`relative h-full shrink-0 bg-[#0e0e11] ${
                    track.hidden || track.muted ? 'opacity-45' : ''
                  }`}
                >
                  {trackClips.map((clip) => {
                    const isSelected = clip.id === selectedClipId;
                    const peerLock =
                      clip.lockedByUserId &&
                      clip.lockedByUserId !== currentUserId
                        ? {
                            color: clip.lockedByUserColor || '#f97316',
                            name: clip.lockedByUserName || 'Участник',
                          }
                        : collaborators.find(
                            (u) => u.selectedClipId === clip.id
                          );
                    const isDownloading = clip.mediaStatus === 'DOWNLOADING';
                    const leftPx = clip.start * pxPerSec;
                    const widthPx = Math.max(28, clip.duration * pxPerSec);

                    const baseSurface =
                      track.type === 'video'
                        ? 'bg-zinc-800/95'
                        : track.type === 'overlay'
                          ? 'bg-indigo-950/90'
                          : track.type === 'text'
                            ? 'bg-amber-950/85'
                            : 'bg-emerald-950/85';

                    return (
                      <div
                        key={clip.id}
                        style={{
                          left: `${leftPx}px`,
                          width: `${widthPx}px`,
                          boxShadow: peerLock
                            ? `0 0 0 2px ${peerLock.color}`
                            : isSelected
                              ? '0 0 0 2px #22d3ee'
                              : 'inset 0 0 0 1px rgba(255,255,255,0.12)',
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectClip(clip.id);
                        }}
                        onPointerDown={(e) => startClipDrag(e, clip, 'move')}
                        onPointerMove={handleClipPointerMove}
                        onPointerUp={handleClipPointerUp}
                        onPointerCancel={handleClipPointerUp}
                        className={`group absolute top-1 bottom-1 z-10 flex touch-none cursor-grab items-center overflow-hidden rounded-lg ${baseSurface} active:cursor-grabbing`}
                      >
                        {clip.kind === 'image' && clip.src && !isDownloading && (
                          <div
                            className="pointer-events-none absolute inset-0 opacity-45"
                            style={{
                              backgroundImage: `url(${clip.src})`,
                              backgroundSize: 'auto 100%',
                              backgroundRepeat: 'repeat-x',
                            }}
                          />
                        )}

                        {isDownloading && (
                          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1 bg-zinc-900/90">
                            <div
                              style={{width: `${clip.downloadProgress ?? 0}%`}}
                              className="h-full bg-cyan-400 transition-all duration-150"
                            />
                          </div>
                        )}

                        {track.type === 'audio' && (
                          <div className="pointer-events-none absolute inset-0 flex items-center gap-[2px] px-2 opacity-35">
                            {Array.from({
                              length: Math.max(6, Math.floor(widthPx / 6)),
                            }).map((_, idx) => (
                              <span
                                key={idx}
                                className="w-[2px] rounded-full bg-emerald-300"
                                style={{
                                  height: `${28 + ((idx * 37) % 58)}%`,
                                }}
                              />
                            ))}
                          </div>
                        )}

                        <div className="relative z-10 flex w-full items-center justify-between gap-1 px-2.5 text-[11px] font-medium text-white drop-shadow">
                          <span className="truncate">
                            {isDownloading
                              ? `⬇ ${clip.downloadProgress ?? 0}% · ${clip.name}`
                              : clip.kind === 'text'
                                ? clip.text || clip.name
                                : clip.name}
                          </span>
                          <span className="shrink-0 font-mono text-[10px] text-zinc-200/80 tabular-nums">
                            {clip.duration.toFixed(1)}с
                          </span>
                        </div>

                        {/* Keyframe Diamond Markers on Clip */}
                        {clip.keyframes &&
                          clip.keyframes.map((kf) => (
                            <span
                              key={kf.id}
                              style={{
                                left: `${Math.max(
                                  6,
                                  Math.min(widthPx - 6, kf.timeOffset * pxPerSec)
                                )}px`,
                              }}
                              title={`Ключ ${kf.timeOffset.toFixed(1)}с`}
                              className="pointer-events-none absolute bottom-1 z-20 h-2 w-2 -translate-x-1/2 rotate-45 border border-zinc-950 bg-amber-300 shadow"
                            />
                          ))}

                        {peerLock && (
                          <span
                            style={{backgroundColor: peerLock.color}}
                            className="pointer-events-none absolute top-0.5 right-1 z-20 rounded px-1 py-px text-[9px] font-semibold text-zinc-950"
                          >
                            {clip.lockedByUserId &&
                            clip.lockedByUserId !== currentUserId
                              ? `🔒 ${peerLock.name}`
                              : peerLock.name}
                          </span>
                        )}

                        {isSelected && (
                          <>
                            <div
                              onPointerDown={(e) =>
                                startClipDrag(e, clip, 'trim-left')
                              }
                              onPointerMove={handleClipPointerMove}
                              onPointerUp={handleClipPointerUp}
                              onPointerCancel={handleClipPointerUp}
                              className="absolute top-0 bottom-0 left-0 z-30 flex w-4 cursor-ew-resize touch-none items-center justify-center bg-cyan-400 text-zinc-950 sm:w-3.5"
                            >
                              <span className="h-4 w-0.5 rounded-full bg-zinc-950/70" />
                            </div>
                            <div
                              onPointerDown={(e) =>
                                startClipDrag(e, clip, 'trim-right')
                              }
                              onPointerMove={handleClipPointerMove}
                              onPointerUp={handleClipPointerUp}
                              onPointerCancel={handleClipPointerUp}
                              className="absolute top-0 right-0 bottom-0 z-30 flex w-4 cursor-ew-resize touch-none items-center justify-center bg-cyan-400 text-zinc-950 sm:w-3.5"
                            >
                              <span className="h-4 w-0.5 rounded-full bg-zinc-950/70" />
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {/* Continuous Playhead Lines Over Track Lanes Only (always slide cleanly under sticky left column z-30) */}
          <div className="pointer-events-none absolute top-6 bottom-0 left-[112px] right-0 z-20 sm:left-[136px]">
            {collaborators.map((collab) => (
              <div
                key={collab.id}
                style={{
                  left: `${collab.playhead * pxPerSec}px`,
                  backgroundColor: collab.color,
                }}
                className="absolute top-0 bottom-0 w-[2px] opacity-85 transition-transform duration-75"
              >
                <div
                  style={{backgroundColor: collab.color}}
                  className="absolute top-0.5 -translate-x-1/2 rounded px-1 py-0.5 text-[9px] font-bold leading-none text-zinc-950 whitespace-nowrap"
                >
                  {collab.name.slice(0, 6)}
                </div>
              </div>
            ))}

            <div
              style={{left: `${currentTime * pxPerSec}px`}}
              className="absolute top-0 bottom-0 w-[2px] bg-white shadow-[0_0_8px_rgba(255,255,255,0.8)]"
            />
          </div>
        </div>
      </div>
    </div>
  );
};
