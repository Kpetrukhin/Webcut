import React, {useRef} from 'react';
import {Film, Layers, Music, Type, ZoomIn, ZoomOut} from 'lucide-react';
import type {Clip, Collaborator, TrackType} from '../shared/types.ts';

interface TimelineProps {
  clips: Clip[];
  duration: number;
  currentTime: number;
  pxPerSec: number;
  selectedClipId: string | null;
  collaborators: Collaborator[];
  onSeek: (time: number) => void;
  onSelectClip: (clipId: string | null) => void;
  onZoomChange: (pxPerSec: number) => void;
  onClipTransform: (
    clipId: string,
    patch: Partial<Clip>,
    commit: boolean
  ) => void;
}

const TRACK_CONFIG: Array<{
  id: TrackType;
  label: string;
  icon: React.FC<{className?: string}>;
  heightClass: string;
}> = [
  {id: 'video', label: 'Видео', icon: Film, heightClass: 'h-12 sm:h-14'},
  {id: 'overlay', label: 'Слой', icon: Layers, heightClass: 'h-10 sm:h-11'},
  {id: 'text', label: 'Текст', icon: Type, heightClass: 'h-9 sm:h-10'},
  {id: 'audio', label: 'Аудио', icon: Music, heightClass: 'h-9 sm:h-10'},
];

export const Timeline: React.FC<TimelineProps> = ({
  clips,
  duration,
  currentTime,
  pxPerSec,
  selectedClipId,
  collaborators,
  onSeek,
  onSelectClip,
  onZoomChange,
  onClipTransform,
}) => {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const trackAreaRef = useRef<HTMLDivElement | null>(null);
  const scrubActiveRef = useRef(false);
  const dragClipRef = useRef<{
    clipId: string;
    mode: 'move' | 'trim-left' | 'trim-right';
    startX: number;
    origStart: number;
    origDuration: number;
    origTrimStart: number;
    sourceDuration: number;
    speed: number;
  } | null>(null);

  const totalWidth = Math.max(
    600,
    Math.ceil((duration + 4) * pxPerSec)
  );

  const clientXToTime = (clientX: number): number => {
    const el = trackAreaRef.current;
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

  const startClipDrag = (
    e: React.PointerEvent<HTMLElement>,
    clip: Clip,
    mode: 'move' | 'trim-left' | 'trim-right'
  ) => {
    e.stopPropagation();
    onSelectClip(clip.id);
    e.currentTarget.setPointerCapture(e.pointerId);
    dragClipRef.current = {
      clipId: clip.id,
      mode,
      startX: e.clientX,
      origStart: clip.start,
      origDuration: clip.duration,
      origTrimStart: clip.trimStart,
      sourceDuration: clip.sourceDuration || 60,
      speed: clip.speed || 1,
    };
  };

  const computePatchFromDrag = (
    drag: NonNullable<typeof dragClipRef.current>,
    clientX: number
  ): Partial<Clip> => {
    const dt = Math.round(((clientX - drag.startX) / pxPerSec) * 20) / 20;
    if (drag.mode === 'move') {
      const nextStart = Math.max(0, Math.round((drag.origStart + dt) * 100) / 100);
      return {start: nextStart};
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
    // trim-right
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
    const patch = computePatchFromDrag(drag, e.clientX);
    onClipTransform(drag.clipId, patch, false);
  };

  const handleClipPointerUp = (e: React.PointerEvent<HTMLElement>) => {
    const drag = dragClipRef.current;
    if (!drag) return;
    e.stopPropagation();
    const patch = computePatchFromDrag(drag, e.clientX);
    dragClipRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    onClipTransform(drag.clipId, patch, true);
  };

  const secStep = pxPerSec >= 90 ? 1 : pxPerSec >= 55 ? 2 : 5;
  const totalSecTicks = Math.ceil(totalWidth / pxPerSec);
  const ticks: number[] = [];
  for (let s = 0; s <= totalSecTicks; s += secStep) {
    ticks.push(s);
  }

  return (
    <div className="flex flex-col border-t border-white/10 bg-[#111114] select-none">
      {/* Compact zoom & track header strip */}
      <div className="flex h-8 items-center justify-between border-b border-white/5 px-3 text-[11px] text-zinc-400">
        <span className="font-medium text-zinc-300">Дорожки монтажа</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onZoomChange(Math.max(36, pxPerSec - 16))}
            aria-label="Уменьшить масштаб таймлайна"
            className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 hover:bg-white/10 hover:text-white active:scale-95"
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </button>
          <span className="w-10 text-center font-mono text-[10px] tabular-nums text-zinc-400">
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

      {/* Main scrollable track grid */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left Track Labels */}
        <div className="z-20 flex w-14 shrink-0 flex-col border-r border-white/10 bg-[#141418] sm:w-20">
          <div className="h-6 border-b border-white/5" />
          {TRACK_CONFIG.map((t) => {
            const Icon = t.icon;
            return (
              <div
                key={t.id}
                className={`flex ${t.heightClass} items-center justify-center gap-1.5 border-b border-white/5 px-1.5 text-[10px] font-medium text-zinc-400 sm:justify-start sm:px-2.5 sm:text-[11px]`}
              >
                <Icon className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                <span className="hidden truncate sm:inline">{t.label}</span>
              </div>
            );
          })}
        </div>

        {/* Scrollable Ruler + Tracks */}
        <div
          ref={scrollContainerRef}
          className="studio-scrollbar relative flex-1 overflow-x-auto overflow-y-hidden"
        >
          <div
            ref={trackAreaRef}
            style={{width: `${totalWidth}px`}}
            className="relative"
          >
            {/* Interactive Time Ruler */}
            <div
              onPointerDown={handleRulerPointerDown}
              onPointerMove={handleRulerPointerMove}
              onPointerUp={handleRulerPointerUp}
              onPointerCancel={handleRulerPointerUp}
              className="relative h-6 cursor-ew-resize touch-none border-b border-white/10 bg-[#16161b]"
            >
              {ticks.map((sec) => (
                <div
                  key={sec}
                  style={{left: `${sec * pxPerSec}px`}}
                  className="pointer-events-none absolute top-0 flex h-full flex-col justify-between"
                >
                  <span className="pl-1 font-mono text-[10px] leading-none text-zinc-500 tabular-nums pt-1">
                    {sec}s
                  </span>
                  <span className="h-1.5 w-px bg-white/20" />
                </div>
              ))}
            </div>

            {/* Track Rows */}
            {TRACK_CONFIG.map((track) => {
              const trackClips = clips
                .filter((c) => c.track === track.id)
                .sort((a, b) => a.start - b.start);

              return (
                <div
                  key={track.id}
                  onClick={() => onSelectClip(null)}
                  className={`relative ${track.heightClass} border-b border-white/5 bg-[#0e0e11]`}
                >
                  {trackClips.map((clip) => {
                    const isSelected = clip.id === selectedClipId;
                    const remoteOwner = collaborators.find(
                      (u) => u.selectedClipId === clip.id
                    );
                    const leftPx = clip.start * pxPerSec;
                    const widthPx = Math.max(26, clip.duration * pxPerSec);

                    const baseSurface =
                      track.id === 'video'
                        ? 'bg-zinc-800/95'
                        : track.id === 'overlay'
                          ? 'bg-indigo-950/90'
                          : track.id === 'text'
                            ? 'bg-amber-950/85'
                            : 'bg-emerald-950/85';

                    return (
                      <div
                        key={clip.id}
                        style={{
                          left: `${leftPx}px`,
                          width: `${widthPx}px`,
                          boxShadow: isSelected
                            ? '0 0 0 2px #22d3ee'
                            : remoteOwner
                              ? `0 0 0 2px ${remoteOwner.color}`
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
                        className={`group absolute top-1 bottom-1 flex touch-none cursor-grab items-center overflow-hidden rounded-lg ${baseSurface} active:cursor-grabbing`}
                      >
                        {/* Thumbnail strip for image clips */}
                        {clip.kind === 'image' && clip.src && (
                          <div
                            className="pointer-events-none absolute inset-0 opacity-45"
                            style={{
                              backgroundImage: `url(${clip.src})`,
                              backgroundSize: 'auto 100%',
                              backgroundRepeat: 'repeat-x',
                            }}
                          />
                        )}

                        {/* Waveform visualization for audio clips */}
                        {track.id === 'audio' && (
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

                        {/* Clip Label */}
                        <div className="relative z-10 flex w-full items-center justify-between gap-1 px-2.5 text-[11px] font-medium text-white drop-shadow">
                          <span className="truncate">
                            {clip.kind === 'text'
                              ? clip.text || clip.name
                              : clip.name}
                          </span>
                          <span className="shrink-0 font-mono text-[10px] text-zinc-200/80 tabular-nums">
                            {clip.duration.toFixed(1)}с
                          </span>
                        </div>

                        {/* Remote Collaborator Indicator */}
                        {remoteOwner && (
                          <span
                            style={{backgroundColor: remoteOwner.color}}
                            className="pointer-events-none absolute top-0.5 right-1 z-20 rounded px-1 py-px text-[9px] font-semibold text-zinc-950"
                          >
                            {remoteOwner.name}
                          </span>
                        )}

                        {/* Left & Right Touch Trim Handles when selected */}
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
              );
            })}

            {/* Remote Collaborators Live Playheads */}
            {collaborators.map((collab) => (
              <div
                key={collab.id}
                style={{
                  left: `${collab.playhead * pxPerSec}px`,
                  backgroundColor: collab.color,
                }}
                className="pointer-events-none absolute top-0 bottom-0 z-20 w-[2px] opacity-85 transition-transform duration-75"
              >
                <div
                  style={{backgroundColor: collab.color}}
                  className="absolute top-0.5 -translate-x-1/2 rounded px-1 py-0.5 text-[9px] font-bold leading-none text-zinc-950 whitespace-nowrap"
                >
                  {collab.name.slice(0, 6)}
                </div>
              </div>
            ))}

            {/* Local Master Playhead Needle */}
            <div
              style={{left: `${currentTime * pxPerSec}px`}}
              className="pointer-events-none absolute top-0 bottom-0 z-30 w-[2px] bg-white shadow-[0_0_8px_rgba(255,255,255,0.8)]"
            >
              <div className="absolute top-0 -translate-x-1/2 h-3.5 w-3 rounded-b-sm bg-white" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
