import React, {useEffect, useRef, useState} from 'react';
import {
  ChevronsUpDown,
  EyeOff,
  Magnet,
  SlidersHorizontal,
} from 'lucide-react';
import type {
  AspectRatio,
  Clip,
  Collaborator,
  ProjectFont,
  Track,
} from '../shared/types.ts';
import {preloadProjectFonts, subscribeFontLoads} from '../lib/fontLoader.ts';
import {evaluateClipTransform} from '../lib/keyframeEngine.ts';
import {
  getCanvasDimensions,
  MediaPool,
  renderCompositeFrame,
  sampleClipColorAtNormalizedPoint,
} from '../lib/renderEngine.ts';

export interface CanvasTransformPatch {
  x: number;
  y: number;
  scale?: number;
  rotation?: number;
}

interface PreviewCanvasProps {
  tracks: Track[];
  clips: Clip[];
  aspectRatio: AspectRatio;
  backgroundColor?: string;
  customFonts?: ProjectFont[];
  currentTime: number;
  isPlaying: boolean;
  selectedClipId: string | null;
  currentUserId?: string;
  collaborators: Collaborator[];
  mediaPool: MediaPool;
  snapEnabled?: boolean;
  onToggleSnap?: () => void;
  showSelectionOutline?: boolean;
  onToggleSelectionOutline?: () => void;
  externalSnapGuides?: {x: boolean; y: boolean};
  chromaKeyPickerActive?: boolean;
  onPickChromaKeyColor?: (
    clipId: string,
    hexColor: string,
    commit: boolean
  ) => void;
  onLockLayer?: (layerId: string, locked: boolean) => boolean;
  onSelectClip: (clipId: string | null) => void;
  onTransformClip: (
    clipId: string,
    patch: CanvasTransformPatch,
    commit: boolean
  ) => void;
}

function normalizeAngleDeg(deg: number): number {
  let d = deg;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return Math.round(d);
}

const PICKER_OFFSET_STORAGE_KEY = 'cutsync_chroma_picker_offset';

function loadSavedPickerOffset(): number {
  try {
    const raw = localStorage.getItem(PICKER_OFFSET_STORAGE_KEY);
    if (raw !== null) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
  } catch {
    // ignore storage errors
  }
  return 52;
}

interface ScrubNumberFieldProps {
  value: number;
  onChange: (next: number) => void;
}

const ScrubNumberField: React.FC<ScrubNumberFieldProps> = ({
  value,
  onChange,
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));
  const [scrubbing, setScrubbing] = useState(false);
  const dragRef = useRef<{
    startY: number;
    startVal: number;
    moved: boolean;
  } | null>(null);

  const commitDraft = () => {
    const parsed = Number(draft.replace(',', '.').trim());
    if (Number.isFinite(parsed)) {
      onChange(parsed);
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        type="text"
        inputMode="decimal"
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitDraft}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commitDraft();
          if (e.key === 'Escape') setEditing(false);
        }}
        className="h-8 w-24 rounded-lg border border-cyan-400 bg-zinc-900 px-2 text-right font-mono text-xs text-white focus:outline-none"
      />
    );
  }

  return (
    <div
      role="spinbutton"
      aria-valuenow={value}
      tabIndex={0}
      onPointerDown={(e) => {
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        dragRef.current = {
          startY: e.clientY,
          startVal: value,
          moved: false,
        };
      }}
      onPointerMove={(e) => {
        if (!dragRef.current) return;
        e.stopPropagation();
        const dy = dragRef.current.startY - e.clientY;
        if (!dragRef.current.moved && Math.abs(dy) > 4) {
          dragRef.current.moved = true;
          setScrubbing(true);
        }
        if (dragRef.current.moved) {
          const next = Math.round(dragRef.current.startVal + dy * 0.75);
          onChange(next);
        }
      }}
      onPointerUp={(e) => {
        e.stopPropagation();
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          // ignore
        }
        const wasMoved = dragRef.current?.moved;
        dragRef.current = null;
        setScrubbing(false);
        if (!wasMoved) {
          setDraft(String(value));
          setEditing(true);
        }
      }}
      onPointerCancel={() => {
        dragRef.current = null;
        setScrubbing(false);
      }}
      title="Потяните вверх/вниз для изменения или нажмите для ввода"
      className={`flex h-8 w-24 cursor-ns-resize touch-none items-center justify-between gap-1 rounded-lg border px-2 font-mono text-xs select-none transition ${
        scrubbing
          ? 'border-cyan-400 bg-cyan-500/20 text-cyan-200'
          : 'border-white/15 bg-zinc-900 text-zinc-100 hover:border-cyan-400/60'
      }`}
    >
      <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
      <span className="truncate tabular-nums">{value}</span>
    </div>
  );
};

export const PreviewCanvas: React.FC<PreviewCanvasProps> = ({
  tracks,
  clips,
  aspectRatio,
  backgroundColor,
  customFonts,
  currentTime,
  isPlaying,
  selectedClipId,
  currentUserId,
  collaborators,
  mediaPool,
  snapEnabled = true,
  onToggleSnap,
  showSelectionOutline = true,
  onToggleSelectionOutline,
  externalSnapGuides,
  chromaKeyPickerActive = false,
  onPickChromaKeyColor,
  onLockLayer,
  onSelectClip,
  onTransformClip,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [renderNonce, setRenderNonce] = useState(0);
  const [snapGuides, setSnapGuides] = useState<{x: boolean; y: boolean}>({
    x: false,
    y: false,
  });
  const [pickerPos, setPickerPos] = useState<{x: number; y: number}>({
    x: 0.5,
    y: 0.3,
  });
  const [draggingPicker, setDraggingPicker] = useState(false);
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const [pickerOffsetPx, setPickerOffsetPx] = useState<number>(
    loadSavedPickerOffset
  );

  const updatePickerOffset = (next: number) => {
    setPickerOffsetPx(next);
    try {
      localStorage.setItem(PICKER_OFFSET_STORAGE_KEY, String(next));
    } catch {
      // ignore
    }
  };

  const activePointersRef = useRef<Map<number, {x: number; y: number}>>(
    new Map()
  );
  const snapStateRef = useRef<{x: boolean; y: boolean}>({x: false, y: false});

  const gestureRef = useRef<{
    clipId: string;
    mode: 'pan' | 'pinch';
    startX: number;
    startY: number;
    startDist: number;
    startAngle: number;
    origX: number;
    origY: number;
    origScale: number;
    origRotation: number;
    lastCommitted: CanvasTransformPatch;
  } | null>(null);

  const {width, height} = getCanvasDimensions(aspectRatio);

  useEffect(() => {
    mediaPool.setOnAssetReady(() => {
      setRenderNonce((n) => n + 1);
    });
    const unsubFonts = subscribeFontLoads(() => {
      setRenderNonce((n) => n + 1);
    });
    return () => {
      mediaPool.setOnAssetReady(undefined);
      unsubFonts();
    };
  }, [mediaPool]);

  useEffect(() => {
    if (customFonts && customFonts.length > 0) {
      void preloadProjectFonts(customFonts);
    }
  }, [customFonts]);

  const renderedSelectedId = showSelectionOutline ? selectedClipId : null;
  const effectiveSnapGuides = snapEnabled
    ? {
        x: snapGuides.x || Boolean(externalSnapGuides?.x),
        y: snapGuides.y || Boolean(externalSnapGuides?.y),
      }
    : {x: false, y: false};

  useEffect(() => {
    if (!chromaKeyPickerActive || !selectedClipId) {
      setDraggingPicker(false);
      return;
    }
    const target = clips.find((c) => c.id === selectedClipId);
    if (!target) return;
    const tr = evaluateClipTransform(target, currentTime);
    setPickerPos({
      x: Math.max(0.08, Math.min(0.92, tr.x)),
      y: Math.max(0.08, Math.min(0.92, tr.y)),
    });
  }, [chromaKeyPickerActive, selectedClipId]);

  useEffect(() => {
    if (!snapEnabled) {
      snapStateRef.current = {x: false, y: false};
      setSnapGuides({x: false, y: false});
    }
  }, [snapEnabled]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    mediaPool.syncVideos(clips, currentTime, isPlaying, tracks);
    renderCompositeFrame(
      ctx,
      width,
      height,
      clips,
      currentTime,
      mediaPool,
      renderedSelectedId,
      collaborators,
      tracks,
      backgroundColor,
      effectiveSnapGuides,
      currentUserId
    );
  }, [
    tracks,
    clips,
    aspectRatio,
    backgroundColor,
    currentTime,
    isPlaying,
    renderedSelectedId,
    collaborators,
    mediaPool,
    width,
    height,
    renderNonce,
    effectiveSnapGuides.x,
    effectiveSnapGuides.y,
    currentUserId,
  ]);

  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    const loop = () => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (canvas && ctx) {
        renderCompositeFrame(
          ctx,
          width,
          height,
          clips,
          currentTime,
          mediaPool,
          renderedSelectedId,
          collaborators,
          tracks,
          backgroundColor,
          effectiveSnapGuides,
          currentUserId
        );
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [
    isPlaying,
    tracks,
    clips,
    backgroundColor,
    currentTime,
    width,
    height,
    mediaPool,
    renderedSelectedId,
    collaborators,
    effectiveSnapGuides.x,
    effectiveSnapGuides.y,
    currentUserId,
  ]);

  const findHitClip = (nx: number, ny: number): Clip | null => {
    const hiddenIds = new Set(tracks.filter((t) => t.hidden).map((t) => t.id));

    const activeTexts = clips.filter(
      (c) =>
        c.track === 'text' &&
        !hiddenIds.has(c.trackId) &&
        currentTime >= c.start &&
        currentTime < c.start + c.duration
    );
    for (let i = activeTexts.length - 1; i >= 0; i--) {
      const c = activeTexts[i];
      const tr = evaluateClipTransform(c, currentTime);
      if (Math.abs(nx - tr.x) < 0.28 && Math.abs(ny - tr.y) < 0.12) {
        return c;
      }
    }

    const activeOverlays = clips.filter(
      (c) =>
        c.track === 'overlay' &&
        !hiddenIds.has(c.trackId) &&
        currentTime >= c.start &&
        currentTime < c.start + c.duration
    );
    for (let i = activeOverlays.length - 1; i >= 0; i--) {
      const c = activeOverlays[i];
      const tr = evaluateClipTransform(c, currentTime);
      const half = Math.max(0.12, tr.scale / 2);
      if (Math.abs(nx - tr.x) <= half && Math.abs(ny - tr.y) <= half) {
        return c;
      }
    }

    const activeVideos = clips.filter(
      (c) =>
        c.track === 'video' &&
        !hiddenIds.has(c.trackId) &&
        currentTime >= c.start &&
        currentTime < c.start + c.duration
    );
    if (activeVideos.length > 0) {
      return activeVideos[activeVideos.length - 1];
    }

    return null;
  };

  const beginGestureForClip = (clip: Clip) => {
    const pointers = Array.from(activePointersRef.current.values());
    if (pointers.length === 0) return;

    if (clip.lockedByUserId && clip.lockedByUserId !== currentUserId) {
      onLockLayer?.(clip.id, true);
      return;
    }
    if (onLockLayer && onLockLayer(clip.id, true) === false) {
      return;
    }

    const tr = evaluateClipTransform(clip, currentTime);
    if (pointers.length >= 2) {
      const [p1, p2] = pointers;
      const cx = (p1.x + p2.x) / 2;
      const cy = (p1.y + p2.y) / 2;
      const dist = Math.max(10, Math.hypot(p2.x - p1.x, p2.y - p1.y));
      const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
      gestureRef.current = {
        clipId: clip.id,
        mode: 'pinch',
        startX: cx,
        startY: cy,
        startDist: dist,
        startAngle: angle,
        origX: tr.x,
        origY: tr.y,
        origScale: tr.scale,
        origRotation: tr.rotation,
        lastCommitted: {
          x: tr.x,
          y: tr.y,
          scale: tr.scale,
          rotation: tr.rotation,
        },
      };
    } else {
      const [p1] = pointers;
      gestureRef.current = {
        clipId: clip.id,
        mode: 'pan',
        startX: p1.x,
        startY: p1.y,
        startDist: 1,
        startAngle: 0,
        origX: tr.x,
        origY: tr.y,
        origScale: tr.scale,
        origRotation: tr.rotation,
        lastCommitted: {x: tr.x, y: tr.y},
      };
    }
  };

  const applySnapToCoords = (
    rawX: number,
    rawY: number,
    rect: DOMRect
  ): {x: number; y: number; snappedX: boolean; snappedY: boolean} => {
    const snapNormX = 12 / Math.max(1, rect.width);
    const snapNormY = 12 / Math.max(1, rect.height);

    let x = Math.max(0.02, Math.min(0.98, rawX));
    let y = Math.max(0.02, Math.min(0.98, rawY));
    let snappedX = false;
    let snappedY = false;

    if (snapEnabled) {
      if (Math.abs(x - 0.5) <= snapNormX) {
        x = 0.5;
        snappedX = true;
      }
      if (Math.abs(y - 0.5) <= snapNormY) {
        y = 0.5;
        snappedY = true;
      }
    }

    const prev = snapStateRef.current;
    if (snapEnabled && ((!prev.x && snappedX) || (!prev.y && snappedY))) {
      try {
        navigator.vibrate?.(12);
      } catch {
        // ignore unsupported vibration
      }
    }
    if (prev.x !== snappedX || prev.y !== snappedY) {
      snapStateRef.current = {x: snappedX, y: snappedY};
      setSnapGuides({x: snappedX, y: snappedY});
    }

    return {x, y, snappedX, snappedY};
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(e.pointerId);
    activePointersRef.current.set(e.pointerId, {x: e.clientX, y: e.clientY});

    const rect = canvas.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;

    const existingSelected = selectedClipId
      ? clips.find(
          (c) =>
            c.id === selectedClipId &&
            c.track !== 'audio' &&
            currentTime >= c.start &&
            currentTime < c.start + c.duration
        ) ?? null
      : null;

    if (activePointersRef.current.size >= 2 && existingSelected) {
      beginGestureForClip(existingSelected);
      return;
    }

    const hit = findHitClip(nx, ny);
    if (hit) {
      onSelectClip(hit.id);
      beginGestureForClip(hit);
    } else if (existingSelected && activePointersRef.current.size === 1) {
      beginGestureForClip(existingSelected);
    } else {
      onSelectClip(null);
      gestureRef.current = null;
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!activePointersRef.current.has(e.pointerId)) return;
    activePointersRef.current.set(e.pointerId, {x: e.clientX, y: e.clientY});

    const gesture = gestureRef.current;
    const canvas = canvasRef.current;
    if (!gesture || !canvas) return;

    const rect = canvas.getBoundingClientRect();
    const pointers = Array.from(activePointersRef.current.values());

    if (pointers.length >= 2) {
      if (gesture.mode !== 'pinch') {
        const clip = clips.find((c) => c.id === gesture.clipId);
        if (clip) beginGestureForClip(clip);
        return;
      }
      const [p1, p2] = pointers;
      const cx = (p1.x + p2.x) / 2;
      const cy = (p1.y + p2.y) / 2;
      const dist = Math.max(10, Math.hypot(p2.x - p1.x, p2.y - p1.y));
      const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);

      const dx = (cx - gesture.startX) / rect.width;
      const dy = (cy - gesture.startY) / rect.height;
      const snapped = applySnapToCoords(
        gesture.origX + dx,
        gesture.origY + dy,
        rect
      );

      const nextScale = Math.max(
        0.1,
        Math.min(
          2.5,
          Math.round(gesture.origScale * (dist / gesture.startDist) * 100) / 100
        )
      );
      const deltaDeg = ((angle - gesture.startAngle) * 180) / Math.PI;
      const nextRotation = normalizeAngleDeg(gesture.origRotation + deltaDeg);

      const patch: CanvasTransformPatch = {
        x: snapped.x,
        y: snapped.y,
        scale: nextScale,
        rotation: nextRotation,
      };
      gesture.lastCommitted = patch;
      onTransformClip(gesture.clipId, patch, false);
      return;
    }

    if (pointers.length === 1 && gesture.mode === 'pan') {
      const [p1] = pointers;
      const dx = (p1.x - gesture.startX) / rect.width;
      const dy = (p1.y - gesture.startY) / rect.height;
      const snapped = applySnapToCoords(
        gesture.origX + dx,
        gesture.origY + dy,
        rect
      );
      const patch: CanvasTransformPatch = {x: snapped.x, y: snapped.y};
      gesture.lastCommitted = patch;
      onTransformClip(gesture.clipId, patch, false);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    activePointersRef.current.delete(e.pointerId);
    try {
      canvas?.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }

    const gesture = gestureRef.current;
    if (!gesture) return;

    if (activePointersRef.current.size === 1) {
      const clip = clips.find((c) => c.id === gesture.clipId);
      if (clip) {
        onTransformClip(gesture.clipId, gesture.lastCommitted, true);
        beginGestureForClip(clip);
        return;
      }
    }

    if (activePointersRef.current.size === 0) {
      const finalPatch = gesture.lastCommitted;
      const clipId = gesture.clipId;
      gestureRef.current = null;
      snapStateRef.current = {x: false, y: false};
      setSnapGuides({x: false, y: false});
      onTransformClip(clipId, finalPatch, true);
      onLockLayer?.(clipId, false);
    }
  };

  const samplePickerAtClientCoords = (
    clientX: number,
    clientY: number,
    commit: boolean
  ) => {
    const canvas = canvasRef.current;
    if (!canvas || !selectedClipId || !onPickChromaKeyColor) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const effectiveY = clientY - pickerOffsetPx;
    const nx = Math.max(
      0.005,
      Math.min(0.995, (clientX - rect.left) / rect.width)
    );
    const ny = Math.max(
      0.005,
      Math.min(0.995, (effectiveY - rect.top) / rect.height)
    );
    setPickerPos({x: nx, y: ny});

    const target = clips.find((c) => c.id === selectedClipId);
    if (!target) return;
    const hex = sampleClipColorAtNormalizedPoint(
      target,
      nx,
      ny,
      width,
      height,
      currentTime,
      mediaPool
    );
    if (hex) {
      onPickChromaKeyColor(target.id, hex, commit);
    }
  };

  const aspectClass =
    aspectRatio === '9:16'
      ? 'aspect-[9/16]'
      : aspectRatio === '16:9'
        ? 'aspect-video'
        : aspectRatio === '4:5'
          ? 'aspect-[4/5]'
          : 'aspect-square';

  const activeSelectedClip = selectedClipId
    ? clips.find((c) => c.id === selectedClipId) ?? null
    : null;

  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden p-2 sm:p-4">
      {showSettingsMenu && (
        <div
          onClick={() => setShowSettingsMenu(false)}
          className="fixed inset-0 z-20"
        />
      )}

      <div className="absolute right-2.5 top-2.5 z-30 sm:right-4 sm:top-4">
        <button
          type="button"
          onClick={() => setShowSettingsMenu((v) => !v)}
          title="Настройки холста и пипетки"
          aria-label="Настройки холста"
          className={`flex h-9 w-9 items-center justify-center rounded-xl border backdrop-blur-md transition active:scale-95 ${
            showSettingsMenu
              ? 'border-cyan-400 bg-cyan-500/25 text-cyan-200 shadow-lg'
              : 'border-white/15 bg-zinc-950/80 text-zinc-200 hover:border-cyan-400/60'
          }`}
        >
          <SlidersHorizontal className="h-4 w-4" />
        </button>

        {showSettingsMenu && (
          <div className="absolute right-0 mt-2 w-64 space-y-2.5 rounded-xl border border-white/15 bg-[#141418]/95 p-3 shadow-2xl backdrop-blur-md">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
              Настройки холста
            </p>

            {/* 1. Привязка к сетке */}
            <button
              type="button"
              onClick={onToggleSnap}
              className="flex w-full items-center justify-between rounded-lg border border-white/10 bg-zinc-900/80 px-2.5 py-2 text-left transition hover:border-white/20 active:scale-[0.99]"
            >
              <span className="flex items-center gap-2 text-xs font-medium text-zinc-200">
                <Magnet
                  className={`h-4 w-4 ${snapEnabled ? 'text-cyan-400' : 'text-zinc-500'}`}
                />
                Привязка к сетке
              </span>
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                  snapEnabled
                    ? 'bg-cyan-500/20 text-cyan-300'
                    : 'bg-white/10 text-zinc-400'
                }`}
              >
                {snapEnabled ? 'ВКЛ' : 'ВЫКЛ'}
              </span>
            </button>

            {/* 2. Рамка выделения */}
            <button
              type="button"
              onClick={onToggleSelectionOutline}
              className="flex w-full items-center justify-between rounded-lg border border-white/10 bg-zinc-900/80 px-2.5 py-2 text-left transition hover:border-white/20 active:scale-[0.99]"
            >
              <span className="flex items-center gap-2 text-xs font-medium text-zinc-200">
                {showSelectionOutline ? (
                  <svg
                    viewBox="0 0 24 24"
                    className="h-4 w-4 text-cyan-400"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M4 7V5a1 1 0 0 1 1-1h2" />
                    <path d="M17 4h2a1 1 0 0 1 1 1v2" />
                    <path d="M20 17v2a1 1 0 0 1-1 1h-2" />
                    <path d="M7 20H5a1 1 0 0 1-1-1v-2" />
                    <rect
                      x="7"
                      y="7"
                      width="10"
                      height="10"
                      rx="1"
                      strokeDasharray="2.5 2.5"
                    />
                  </svg>
                ) : (
                  <EyeOff className="h-4 w-4 text-zinc-500" />
                )}
                Рамка выделения
              </span>
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                  showSelectionOutline
                    ? 'bg-cyan-500/20 text-cyan-300'
                    : 'bg-white/10 text-zinc-400'
                }`}
              >
                {showSelectionOutline ? 'ВКЛ' : 'СКРЫТА'}
              </span>
            </button>

            {/* 3. Высота пипетки (Unity-style drag up/down) */}
            <div className="flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-zinc-900/80 px-2.5 py-2">
              <div className="min-w-0">
                <p className="text-xs font-medium text-zinc-200">
                  Высота пипетки
                </p>
                <p className="text-[10px] text-zinc-500">
                  Свайп ↕ или ввод
                </p>
              </div>
              <ScrubNumberField
                value={pickerOffsetPx}
                onChange={updatePickerOffset}
              />
            </div>
          </div>
        )}
      </div>

      <div
        className={`relative max-h-full max-w-full ${aspectClass} overflow-hidden rounded-xl border border-white/10 shadow-2xl`}
        style={{
          backgroundColor: backgroundColor || '#09090b',
          height: aspectRatio === '16:9' ? 'auto' : '100%',
          width: aspectRatio === '16:9' ? '100%' : 'auto',
        }}
      >
        <canvas
          ref={canvasRef}
          width={width}
          height={height}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          className="h-full w-full touch-none object-contain cursor-grab active:cursor-grabbing"
        />

        {chromaKeyPickerActive &&
          activeSelectedClip &&
          (activeSelectedClip.kind === 'image' ||
            activeSelectedClip.kind === 'video') && (
            <div
              onPointerDown={(e) => {
                e.stopPropagation();
                e.currentTarget.setPointerCapture(e.pointerId);
                setDraggingPicker(true);
                samplePickerAtClientCoords(e.clientX, e.clientY, false);
              }}
              onPointerMove={(e) => {
                if (!draggingPicker) return;
                e.stopPropagation();
                samplePickerAtClientCoords(e.clientX, e.clientY, false);
              }}
              onPointerUp={(e) => {
                if (!draggingPicker) return;
                e.stopPropagation();
                try {
                  e.currentTarget.releasePointerCapture(e.pointerId);
                } catch {
                  // ignore
                }
                setDraggingPicker(false);
                samplePickerAtClientCoords(e.clientX, e.clientY, true);
              }}
              onPointerCancel={(e) => {
                if (!draggingPicker) return;
                setDraggingPicker(false);
                samplePickerAtClientCoords(e.clientX, e.clientY, true);
              }}
              className="absolute inset-0 z-10 touch-none cursor-crosshair"
            >
              <div
                className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
                style={{
                  left: `${pickerPos.x * 100}%`,
                  top: `${pickerPos.y * 100}%`,
                }}
              >
                {/* Floating color loupe badge above finger while dragging */}
                {draggingPicker && (
                  <div className="mb-2 flex -translate-y-10 justify-center">
                    <div
                      className="h-8 w-8 rounded-full border-2 border-white shadow-lg ring-2 ring-black/60"
                      style={{
                        backgroundColor:
                          activeSelectedClip.chromaKeyColor || '#00ff00',
                      }}
                    />
                  </div>
                )}

                {/* Eyedropper Crosshair Ring */}
                <div
                  className="relative flex h-11 w-11 items-center justify-center rounded-full border-2 border-white shadow-[0_0_0_2px_rgba(0,0,0,0.75)]"
                  style={{
                    boxShadow: `0 0 0 2px rgba(0,0,0,0.75), inset 0 0 0 3px ${activeSelectedClip.chromaKeyColor || '#00ff00'}`,
                  }}
                >
                  <div className="h-3.5 w-[1.5px] bg-white shadow-[0_0_2px_#000]" />
                  <div className="absolute h-[1.5px] w-3.5 bg-white shadow-[0_0_2px_#000]" />
                </div>
              </div>
            </div>
          )}

        {clips.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center p-4 text-center">
            <p className="text-sm font-medium text-zinc-200 drop-shadow">
              Пустой холст
            </p>
            <p className="mt-1 text-xs text-zinc-400 drop-shadow">
              Нажмите «Медиа», «Наложение» или «Текст» внизу
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
