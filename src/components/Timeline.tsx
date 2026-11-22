import React, {useEffect, useRef, useState} from 'react';
import {
  Eye,
  EyeOff,
  Film,
  GripVertical,
  Layers,
  Music,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Type,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type {Clip, Collaborator, Track, TrackType} from '../shared/types.ts';
import {getTextAnimationSpec} from '../lib/textRenderer.ts';
import {ScrubNumberField} from './ScrubNumberField.tsx';

const BASE_PX_PER_SEC = 64;
const MIN_ZOOM_PCT = 30;
const MAX_ZOOM_PCT = 300;
const MIN_PX_PER_SEC = (BASE_PX_PER_SEC * MIN_ZOOM_PCT) / 100;
const MAX_PX_PER_SEC = (BASE_PX_PER_SEC * MAX_ZOOM_PCT) / 100;

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
  onReorderTracks: (
    trackIds: string[],
    opts?: {commit?: boolean; undoTracks?: Track[]}
  ) => void;
  onLockLayer?: (layerId: string, locked: boolean) => boolean;
  onRetryDownload?: (clipId: string) => void;
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
    case 'adjustment':
      return Sparkles;
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
    case 'adjustment':
      return 'bg-violet-400';
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
    case 'adjustment':
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
  onReorderTracks,
  onLockLayer,
  onRetryDownload,
  onClipTransform,
}) => {
  const rulerRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const stickyHeaderRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const scrubActiveRef = useRef(false);
  const [editingTrackId, setEditingTrackId] = useState<string | null>(null);
  const [trackNameDraft, setTrackNameDraft] = useState('');
  const [draggingTrackId, setDraggingTrackId] = useState<string | null>(null);

  const pxPerSecRef = useRef(pxPerSec);
  pxPerSecRef.current = pxPerSec;
  const onZoomChangeRef = useRef(onZoomChange);
  onZoomChangeRef.current = onZoomChange;
  const onClipTransformRef = useRef(onClipTransform);
  onClipTransformRef.current = onClipTransform;
  const onLockLayerRef = useRef(onLockLayer);
  onLockLayerRef.current = onLockLayer;

  const pinchRef = useRef<{
    startDist: number;
    startPxPerSec: number;
    startTimeAtMid: number;
  } | null>(null);

  const dragTrackRef = useRef<{
    trackId: string;
    origTracks: Track[];
    currentOrder: string[];
  } | null>(null);

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

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const getStickyWidth = () =>
      stickyHeaderRef.current?.getBoundingClientRect().width ?? 132;

    const cancelActiveSingleFingerDrags = () => {
      scrubActiveRef.current = false;
      if (dragTrackRef.current) {
        dragTrackRef.current = null;
        setDraggingTrackId(null);
      }
      const clipDrag = dragClipRef.current;
      if (clipDrag) {
        dragClipRef.current = null;
        onClipTransformRef.current(
          clipDrag.clipId,
          {
            start: clipDrag.origStart,
            duration: clipDrag.origDuration,
            trimStart: clipDrag.origTrimStart,
            trackId: clipDrag.origTrackId,
          },
          false
        );
        onLockLayerRef.current?.(clipDrag.clipId, false);
      }
    };

    const initPinch = (t1: Touch, t2: Touch) => {
      const startDist = Math.max(
        10,
        Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY)
      );
      const midClientX = (t1.clientX + t2.clientX) / 2;
      const rect = container.getBoundingClientRect();
      const anchorOffsetPx = Math.max(0, midClientX - rect.left - getStickyWidth());
      const curPx = pxPerSecRef.current;
      pinchRef.current = {
        startDist,
        startPxPerSec: curPx,
        startTimeAtMid: (container.scrollLeft + anchorOffsetPx) / curPx,
      };
    };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length >= 2) {
        cancelActiveSingleFingerDrags();
        initPinch(e.touches[0], e.touches[1]);
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length < 2) return;
      if (e.cancelable) e.preventDefault();
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      if (!pinchRef.current) {
        cancelActiveSingleFingerDrags();
        initPinch(t1, t2);
      }
      const pinch = pinchRef.current;
      if (!pinch) return;

      const dist = Math.max(
        10,
        Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY)
      );
      const rawPx = pinch.startPxPerSec * (dist / pinch.startDist);
      const nextPx = Math.max(MIN_PX_PER_SEC, Math.min(MAX_PX_PER_SEC, rawPx));
      onZoomChangeRef.current(nextPx);

      const midClientX = (t1.clientX + t2.clientX) / 2;
      const rect = container.getBoundingClientRect();
      const curAnchorPx = Math.max(0, midClientX - rect.left - getStickyWidth());
      const targetScrollLeft = Math.max(
        0,
        pinch.startTimeAtMid * nextPx - curAnchorPx
      );
      requestAnimationFrame(() => {
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollLeft = targetScrollLeft;
        }
      });
    };

    const onTouchEndOrCancel = (e: TouchEvent) => {
      if (e.touches.length < 2) {
        pinchRef.current = null;
      }
    };

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const curPx = pxPerSecRef.current;
      const factor = Math.exp(-e.deltaY * 0.004);
      const nextPx = Math.max(
        MIN_PX_PER_SEC,
        Math.min(MAX_PX_PER_SEC, curPx * factor)
      );
      onZoomChangeRef.current(nextPx);
    };

    container.addEventListener('touchstart', onTouchStart, {passive: true});
    container.addEventListener('touchmove', onTouchMove, {passive: false});
    container.addEventListener('touchend', onTouchEndOrCancel, {passive: true});
    container.addEventListener('touchcancel', onTouchEndOrCancel, {passive: true});
    container.addEventListener('wheel', onWheel, {passive: false});

    return () => {
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEndOrCancel);
      container.removeEventListener('touchcancel', onTouchEndOrCancel);
      container.removeEventListener('wheel', onWheel);
    };
  }, []);

  const totalWidth = Math.max(640, Math.ceil((duration + 4) * pxPerSec));
  const zoomPercent = Math.max(
    MIN_ZOOM_PCT,
    Math.min(MAX_ZOOM_PCT, Math.round((pxPerSec / BASE_PX_PER_SEC) * 100))
  );

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
    if (pinchRef.current) return;
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
      const minDelta =
        drag.trackType === 'adjustment'
          ? -drag.origStart
          : -Math.min(drag.origStart, drag.origTrimStart / drag.speed);
      const clampedDt = Math.max(minDelta, Math.min(maxDelta, dt));
      const nextStart = Math.round((drag.origStart + clampedDt) * 100) / 100;
      const nextDur = Math.round((drag.origDuration - clampedDt) * 100) / 100;
      const nextTrim =
        drag.trackType === 'adjustment'
          ? 0
          : Math.max(
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
    if (pinchRef.current) return;
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

  const startTrackDrag = (
    e: React.PointerEvent<HTMLElement>,
    track: Track
  ) => {
    e.stopPropagation();
    setEditingTrackId(null);
    e.currentTarget.setPointerCapture(e.pointerId);
    setDraggingTrackId(track.id);
    dragTrackRef.current = {
      trackId: track.id,
      origTracks: tracks,
      currentOrder: tracks.map((t) => t.id),
    };
  };

  const handleTrackDragMove = (e: React.PointerEvent<HTMLElement>) => {
    const drag = dragTrackRef.current;
    if (!drag) return;
    e.stopPropagation();

    const order = drag.currentOrder;
    const currentIdx = order.indexOf(drag.trackId);
    if (currentIdx === -1) return;

    let targetIdx = currentIdx;
    for (let i = 0; i < order.length; i++) {
      const id = order[i];
      const row = rowRefs.current.get(id);
      if (!row) continue;
      const rect = row.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (e.clientY < midY) {
        targetIdx = i;
        break;
      }
      targetIdx = i;
    }

    if (targetIdx !== currentIdx) {
      const nextOrder = [...order];
      const [moved] = nextOrder.splice(currentIdx, 1);
      nextOrder.splice(targetIdx, 0, moved);
      drag.currentOrder = nextOrder;
      onReorderTracks(nextOrder, {commit: false});
    }
  };

  const handleTrackDragUp = (e: React.PointerEvent<HTMLElement>) => {
    const drag = dragTrackRef.current;
    if (!drag) return;
    e.stopPropagation();
    dragTrackRef.current = null;
    setDraggingTrackId(null);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }

    const origOrder = drag.origTracks.map((t) => t.id);
    const changed =
      drag.currentOrder.length === origOrder.length &&
      drag.currentOrder.some((id, idx) => id !== origOrder[idx]);
    if (changed) {
      onReorderTracks(drag.currentOrder, {
        commit: true,
        undoTracks: drag.origTracks,
      });
    }
  };

  const commitTrackRename = (track: Track) => {
    const trimmed = trackNameDraft.trim().slice(0, 24);
    setEditingTrackId(null);
    if (trimmed && trimmed !== track.name) {
      onUpdateTrack(track.id, {name: trimmed});
    }
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
            onClick={() => onAddTrack('adjustment')}
            className="flex h-6 items-center gap-1 rounded-md border border-violet-500/35 bg-violet-500/15 px-2 text-[10px] font-medium text-violet-300 hover:bg-violet-500/25 whitespace-nowrap"
          >
            <Plus className="h-3 w-3" />
            Эффект
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

        <div className="flex shrink-0 items-center gap-1.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
          <ScrubNumberField
            compact
            accent="cyan"
            value={zoomPercent}
            min={MIN_ZOOM_PCT}
            max={MAX_ZOOM_PCT}
            step={1}
            suffix="%"
            ariaLabel="Масштаб таймлайна в процентах"
            onChange={(pct) => {
              const clamped = Math.max(MIN_ZOOM_PCT, Math.min(MAX_ZOOM_PCT, pct));
              onZoomChange((clamped / 100) * BASE_PX_PER_SEC);
            }}
          />
        </div>
      </div>

      {/* Unified Single Scroll Container: Sticky Left Cells + Track Lanes stay 100% aligned */}
      <div
        ref={scrollContainerRef}
        className="studio-scrollbar relative flex-1 min-h-0 overflow-auto bg-[#0e0e11] [touch-action:pan-x_pan-y]"
      >
        <div className="relative min-w-max">
          {/* Top Sticky Ruler Row */}
          <div className="sticky top-0 z-40 flex h-6 border-b border-white/10 bg-[#16161b]">
            <div
              ref={stickyHeaderRef}
              className="sticky left-0 z-50 flex w-[132px] shrink-0 items-center justify-between border-r border-white/10 bg-[#16161b] px-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 sm:w-[158px]"
            >
              <span>Слои</span>
              <span className="text-[9px] font-normal normal-case text-zinc-500">
                верх=фон
              </span>
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
            const isDraggingThisTrack = draggingTrackId === track.id;
            const isEditingThisTrack = editingTrackId === track.id;

            return (
              <div
                key={track.id}
                ref={(el) => {
                  if (el) rowRefs.current.set(track.id, el);
                  else rowRefs.current.delete(track.id);
                }}
                className={`flex ${hClass} border-b border-white/5 transition-colors ${
                  isDraggingThisTrack
                    ? 'relative z-40 bg-[#1a1a24] ring-1 ring-cyan-400/70'
                    : 'bg-[#0e0e11]'
                }`}
              >
                {/* Sticky Left Track Header Cell */}
                <div
                  className={`sticky left-0 z-30 flex w-[132px] shrink-0 items-center justify-between gap-0.5 border-r border-white/10 pl-1 pr-1 text-[11px] font-medium text-zinc-200 sm:w-[158px] sm:pl-1.5 sm:pr-1.5 ${
                    isDraggingThisTrack ? 'bg-[#1c1c28]' : 'bg-[#141418]'
                  }`}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-1">
                    <button
                      type="button"
                      onPointerDown={(e) => startTrackDrag(e, track)}
                      onPointerMove={handleTrackDragMove}
                      onPointerUp={handleTrackDragUp}
                      onPointerCancel={handleTrackDragUp}
                      aria-label={`Перетащить дорожку ${track.name}`}
                      title="Потяните вверх/вниз для смены порядка слоёв"
                      className="flex h-7 w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded text-zinc-500 hover:bg-white/10 hover:text-zinc-200 active:cursor-grabbing active:text-cyan-300"
                    >
                      <GripVertical className="h-3.5 w-3.5" />
                    </button>
                    <span className={`h-4 w-1 shrink-0 rounded-full ${accentClass}`} />
                    <Icon className="h-3 w-3 shrink-0 text-zinc-400" />
                    {isEditingThisTrack ? (
                      <input
                        type="text"
                        autoFocus
                        value={trackNameDraft}
                        onChange={(e) => setTrackNameDraft(e.target.value)}
                        onBlur={() => commitTrackRename(track)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            commitTrackRename(track);
                          } else if (e.key === 'Escape') {
                            setEditingTrackId(null);
                          }
                        }}
                        onClick={(e) => e.stopPropagation()}
                        onPointerDown={(e) => e.stopPropagation()}
                        className="h-6 min-w-0 flex-1 rounded border border-cyan-400 bg-zinc-900 px-1 text-[11px] font-medium text-white focus:outline-none"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingTrackId(track.id);
                          setTrackNameDraft(track.name);
                        }}
                        title="Нажмите, чтобы переименовать дорожку"
                        className="min-w-0 flex-1 truncate rounded px-0.5 py-0.5 text-left hover:bg-white/10 hover:text-cyan-200"
                      >
                        {track.name}
                      </button>
                    )}
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
                    const isDownloadError = clip.mediaStatus === 'ERROR';
                    const leftPx = clip.start * pxPerSec;
                    const widthPx = Math.max(28, clip.duration * pxPerSec);

                    const baseSurface =
                      track.type === 'video'
                        ? 'bg-zinc-800/95'
                        : track.type === 'overlay'
                          ? 'bg-indigo-950/90'
                          : track.type === 'text'
                            ? 'bg-amber-950/85'
                            : track.type === 'adjustment'
                              ? 'border border-violet-300/45 bg-violet-500/25 backdrop-blur-[2px]'
                              : 'bg-emerald-950/85';

                    return (
                      <div
                        key={clip.id}
                        style={{
                          left: `${leftPx}px`,
                          width: `${widthPx}px`,
                          boxShadow: peerLock
                            ? `0 0 0 2px ${peerLock.color}`
                            : isDownloadError
                              ? '0 0 0 2px #f43f5e'
                              : isSelected
                                ? '0 0 0 2px #22d3ee'
                                : track.type === 'adjustment'
                                  ? 'inset 0 0 0 1px rgba(192,132,252,0.35)'
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
                        {track.type === 'adjustment' && (
                          <div
                            className="pointer-events-none absolute inset-0 opacity-35"
                            style={{
                              backgroundImage:
                                'repeating-linear-gradient(135deg, rgba(192,132,252,0.28) 0px, rgba(192,132,252,0.28) 6px, transparent 6px, transparent 14px)',
                            }}
                          />
                        )}
                        {clip.kind === 'image' && clip.src && !isDownloading && !isDownloadError && (
                          <div
                            className="pointer-events-none absolute inset-0 opacity-45"
                            style={{
                              backgroundImage: `url(${clip.src})`,
                              backgroundSize: clip.isSticker ? 'contain' : 'auto 100%',
                              backgroundRepeat: clip.isSticker ? 'space' : 'repeat-x',
                            }}
                          />
                        )}

                        {clip.track === 'text' &&
                          (() => {
                            const animSpec = getTextAnimationSpec(clip);
                            const inW =
                              animSpec.inType !== 'none'
                                ? Math.min(
                                    widthPx,
                                    Math.max(4, animSpec.inDuration * pxPerSec)
                                  )
                                : 0;
                            const outW =
                              animSpec.outType !== 'none'
                                ? Math.min(
                                    widthPx,
                                    Math.max(4, animSpec.outDuration * pxPerSec)
                                  )
                                : 0;
                            return (
                              <>
                                {inW > 0 && (
                                  <div
                                    style={{width: `${inW}px`}}
                                    title={`Ввод: ${animSpec.inDuration.toFixed(1)}с`}
                                    className="pointer-events-none absolute top-0 bottom-0 left-0 z-10 border-r border-cyan-300/75 bg-gradient-to-r from-cyan-400/45 via-cyan-400/20 to-cyan-400/5"
                                  >
                                    {inW >= 24 && (
                                      <span className="absolute top-0.5 left-1 rounded bg-cyan-400/80 px-1 font-mono text-[8px] font-bold leading-tight text-zinc-950">
                                        IN {animSpec.inDuration.toFixed(1)}с
                                      </span>
                                    )}
                                  </div>
                                )}
                                {outW > 0 && (
                                  <div
                                    style={{width: `${outW}px`}}
                                    title={`Вывод: ${animSpec.outDuration.toFixed(1)}с`}
                                    className="pointer-events-none absolute top-0 right-0 bottom-0 z-10 border-l border-violet-300/75 bg-gradient-to-l from-violet-400/45 via-violet-400/20 to-violet-400/5"
                                  >
                                    {outW >= 26 && (
                                      <span className="absolute top-0.5 right-1 rounded bg-violet-400/85 px-1 font-mono text-[8px] font-bold leading-tight text-zinc-950">
                                        OUT {animSpec.outDuration.toFixed(1)}с
                                      </span>
                                    )}
                                  </div>
                                )}
                              </>
                            );
                          })()}

                        {isDownloading && (
                          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1 bg-zinc-900/90">
                            <div
                              style={{width: `${clip.downloadProgress ?? 0}%`}}
                              className="h-full bg-cyan-400 transition-all duration-150"
                            />
                          </div>
                        )}

                        {track.type === 'audio' && (
                          <div
                            className="pointer-events-none absolute inset-x-2 inset-y-2.5 opacity-40"
                            style={{
                              backgroundImage:
                                'repeating-linear-gradient(90deg, rgba(110,231,183,0.95) 0px, rgba(110,231,183,0.95) 2px, transparent 2px, transparent 5px)',
                              maskImage:
                                'linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.45) 22%, #000 50%, rgba(0,0,0,0.45) 78%, transparent 100%)',
                              WebkitMaskImage:
                                'linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.45) 22%, #000 50%, rgba(0,0,0,0.45) 78%, transparent 100%)',
                            }}
                          />
                        )}

                        {clip.adjustmentMask && (
                          <div
                            className="pointer-events-none absolute inset-0 opacity-30"
                            style={{
                              backgroundImage:
                                'repeating-linear-gradient(135deg, rgba(168,85,247,0.38) 0px, rgba(168,85,247,0.38) 5px, transparent 5px, transparent 12px)',
                            }}
                          />
                        )}

                        {clip.kind === 'shape' && !clip.adjustmentMask && (
                          <span
                            className="pointer-events-none ml-1.5 h-3.5 w-3.5 shrink-0 rounded-sm border border-white/40"
                            style={{
                              backgroundColor: clip.shapeStyle?.fillColor || '#22d3ee',
                            }}
                          />
                        )}

                        <div className="relative z-10 flex w-full items-center justify-between gap-1 px-2 text-[11px] font-medium text-white drop-shadow">
                          <span
                            className={`truncate ${isDownloadError ? 'text-rose-300' : ''}`}
                            title={isDownloadError ? clip.mediaError || 'Ошибка загрузки файла' : undefined}
                          >
                            {isDownloading
                              ? `⬇ ${clip.downloadProgress ?? 0}% · ${clip.name}`
                              : isDownloadError
                                ? `⚠ ${clip.name}`
                                : clip.adjustmentMask
                                  ? `◐ ${clip.kind === 'text' ? clip.text || clip.name : clip.name}`
                                  : clip.kind === 'text'
                                    ? clip.text || clip.name
                                    : clip.name}
                          </span>
                          <div className="flex shrink-0 items-center gap-1">
                            {isDownloadError && onRetryDownload && (
                              <button
                                type="button"
                                onPointerDown={(e) => e.stopPropagation()}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onRetryDownload(clip.id);
                                }}
                                title={clip.mediaError || 'Повторить скачивание'}
                                className="inline-flex items-center gap-0.5 rounded bg-rose-500/85 px-1.5 py-0.5 text-[9px] font-semibold text-white transition hover:bg-rose-400 active:scale-95"
                              >
                                <RefreshCw className="h-2.5 w-2.5" />
                                Повтор
                              </button>
                            )}
                            <span className="font-mono text-[10px] text-zinc-200/80 tabular-nums">
                              {clip.duration.toFixed(1)}с
                            </span>
                          </div>
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
          <div className="pointer-events-none absolute top-6 bottom-0 left-[132px] right-0 z-20 sm:left-[158px]">
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
