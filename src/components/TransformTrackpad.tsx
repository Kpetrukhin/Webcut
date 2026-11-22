import React, {useRef, useState} from 'react';
import {
  Maximize2,
  Move,
  RotateCcw,
  RotateCw,
  X,
} from 'lucide-react';
import type {Clip} from '../shared/types.ts';
import {evaluateClipTransform} from '../lib/keyframeEngine.ts';
import type {CanvasTransformPatch} from './PreviewCanvas.tsx';

export type TrackpadMode = 'position' | 'scale' | 'rotation';

interface TransformTrackpadProps {
  clip: Clip;
  currentTime: number;
  currentUserId?: string;
  snapEnabled: boolean;
  onLockLayer?: (layerId: string, locked: boolean) => boolean;
  onTransformClip: (
    clipId: string,
    patch: CanvasTransformPatch,
    commit: boolean
  ) => void;
  onSnapGuidesChange: (guides: {x: boolean; y: boolean}) => void;
  onClose: () => void;
}

function normalizeAngleDeg(deg: number): number {
  let d = deg;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return Math.round(d);
}

function wrapRadiansDiff(diff: number): number {
  let d = diff;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export const TransformTrackpad: React.FC<TransformTrackpadProps> = ({
  clip,
  currentTime,
  currentUserId,
  snapEnabled,
  onLockLayer,
  onTransformClip,
  onSnapGuidesChange,
  onClose,
}) => {
  const [mode, setMode] = useState<TrackpadMode>('position');
  const [isTouching, setIsTouching] = useState(false);
  const [touchReticle, setTouchReticle] = useState<{x: number; y: number} | null>(
    null
  );

  const padRef = useRef<HTMLDivElement | null>(null);
  const pointersRef = useRef<Map<number, {x: number; y: number}>>(new Map());
  const snapStateRef = useRef<{x: boolean; y: boolean}>({x: false, y: false});

  const gestureRef = useRef<{
    clipId: string;
    isPinch: boolean;
    startX: number;
    startY: number;
    prevX: number;
    prevY: number;
    startDist: number;
    startAngle: number;
    origX: number;
    origY: number;
    origScale: number;
    origRotation: number;
    accumRotation: number;
    lastPatch: CanvasTransformPatch;
  } | null>(null);

  const currentTransform = evaluateClipTransform(clip, currentTime);

  const applySnap = (
    rawX: number,
    rawY: number
  ): {x: number; y: number; snappedX: boolean; snappedY: boolean} => {
    let x = Math.max(-5, Math.min(6, rawX));
    let y = Math.max(-5, Math.min(6, rawY));
    let snappedX = false;
    let snappedY = false;

    if (snapEnabled) {
      const snapThreshold = 0.028;
      if (Math.abs(x - 0.5) <= snapThreshold) {
        x = 0.5;
        snappedX = true;
      }
      if (Math.abs(y - 0.5) <= snapThreshold) {
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
      onSnapGuidesChange({x: snappedX, y: snappedY});
    }

    return {x, y, snappedX, snappedY};
  };

  const beginGesture = () => {
    const pts = Array.from(pointersRef.current.values());
    if (pts.length === 0) return;

    const tr = evaluateClipTransform(clip, currentTime);

    if (pts.length >= 2) {
      const [p1, p2] = pts;
      const cx = (p1.x + p2.x) / 2;
      const cy = (p1.y + p2.y) / 2;
      const dist = Math.max(10, Math.hypot(p2.x - p1.x, p2.y - p1.y));
      const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
      gestureRef.current = {
        clipId: clip.id,
        isPinch: true,
        startX: cx,
        startY: cy,
        prevX: cx,
        prevY: cy,
        startDist: dist,
        startAngle: angle,
        origX: tr.x,
        origY: tr.y,
        origScale: tr.scale,
        origRotation: tr.rotation,
        accumRotation: tr.rotation,
        lastPatch: {
          x: tr.x,
          y: tr.y,
          scale: tr.scale,
          rotation: tr.rotation,
        },
      };
    } else {
      const [p1] = pts;
      gestureRef.current = {
        clipId: clip.id,
        isPinch: false,
        startX: p1.x,
        startY: p1.y,
        prevX: p1.x,
        prevY: p1.y,
        startDist: 1,
        startAngle: 0,
        origX: tr.x,
        origY: tr.y,
        origScale: tr.scale,
        origRotation: tr.rotation,
        accumRotation: tr.rotation,
        lastPatch: {
          x: tr.x,
          y: tr.y,
          scale: tr.scale,
          rotation: tr.rotation,
        },
      };
    }
  };

  const updateReticle = (clientX: number, clientY: number) => {
    const pad = padRef.current;
    if (!pad) return;
    const rect = pad.getBoundingClientRect();
    setTouchReticle({
      x: Math.max(0, Math.min(rect.width, clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, clientY - rect.top)),
    });
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const pad = padRef.current;
    if (!pad) return;
    if (clip.lockedByUserId && clip.lockedByUserId !== currentUserId) {
      onLockLayer?.(clip.id, true);
      return;
    }
    if (onLockLayer && onLockLayer(clip.id, true) === false) {
      return;
    }
    pad.setPointerCapture(e.pointerId);
    pointersRef.current.set(e.pointerId, {x: e.clientX, y: e.clientY});
    setIsTouching(true);
    updateReticle(e.clientX, e.clientY);
    beginGesture();
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, {x: e.clientX, y: e.clientY});

    const pad = padRef.current;
    const gesture = gestureRef.current;
    if (!pad || !gesture) return;

    const rect = pad.getBoundingClientRect();
    const pts = Array.from(pointersRef.current.values());

    if (pts.length >= 2) {
      if (!gesture.isPinch) {
        beginGesture();
        return;
      }
      const [p1, p2] = pts;
      const cx = (p1.x + p2.x) / 2;
      const cy = (p1.y + p2.y) / 2;
      updateReticle(cx, cy);

      const dist = Math.max(10, Math.hypot(p2.x - p1.x, p2.y - p1.y));
      const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);

      const dx = ((cx - gesture.startX) / Math.max(120, rect.width)) * 0.9;
      const dy = ((cy - gesture.startY) / Math.max(120, rect.height)) * 0.9;
      const snapped = applySnap(gesture.origX + dx, gesture.origY + dy);

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
      gesture.lastPatch = patch;
      onTransformClip(gesture.clipId, patch, false);
      return;
    }

    if (pts.length === 1 && !gesture.isPinch) {
      const [p1] = pts;
      updateReticle(p1.x, p1.y);

      if (mode === 'position') {
        const dx = ((p1.x - gesture.startX) / Math.max(120, rect.width)) * 0.85;
        const dy =
          ((p1.y - gesture.startY) / Math.max(120, rect.height)) * 0.85;
        const snapped = applySnap(gesture.origX + dx, gesture.origY + dy);
        const patch: CanvasTransformPatch = {
          x: snapped.x,
          y: snapped.y,
        };
        gesture.lastPatch = patch;
        onTransformClip(gesture.clipId, patch, false);
      } else if (mode === 'scale') {
        const deltaY = gesture.startY - p1.y;
        const factor = Math.exp(deltaY / 160);
        const nextScale = Math.max(
          0.1,
          Math.min(2.5, Math.round(gesture.origScale * factor * 100) / 100)
        );
        const patch: CanvasTransformPatch = {
          x: gesture.origX,
          y: gesture.origY,
          scale: nextScale,
        };
        gesture.lastPatch = patch;
        onTransformClip(gesture.clipId, patch, false);
      } else if (mode === 'rotation') {
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const prevDist = Math.hypot(
          gesture.prevX - centerX,
          gesture.prevY - centerY
        );
        const currDist = Math.hypot(p1.x - centerX, p1.y - centerY);

        let deltaDeg = 0;
        if (prevDist > 26 && currDist > 26) {
          const prevA = Math.atan2(
            gesture.prevY - centerY,
            gesture.prevX - centerX
          );
          const currA = Math.atan2(p1.y - centerY, p1.x - centerX);
          deltaDeg = (wrapRadiansDiff(currA - prevA) * 180) / Math.PI;
        } else {
          deltaDeg = (p1.x - gesture.prevX) * 0.65;
        }

        gesture.accumRotation += deltaDeg;
        gesture.prevX = p1.x;
        gesture.prevY = p1.y;

        const patch: CanvasTransformPatch = {
          x: gesture.origX,
          y: gesture.origY,
          rotation: normalizeAngleDeg(gesture.accumRotation),
        };
        gesture.lastPatch = patch;
        onTransformClip(gesture.clipId, patch, false);
      }
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const pad = padRef.current;
    pointersRef.current.delete(e.pointerId);
    try {
      pad?.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }

    const gesture = gestureRef.current;
    if (!gesture) return;

    if (pointersRef.current.size === 1) {
      onTransformClip(gesture.clipId, gesture.lastPatch, true);
      beginGesture();
      return;
    }

    if (pointersRef.current.size === 0) {
      const finalPatch = gesture.lastPatch;
      const targetId = gesture.clipId;
      gestureRef.current = null;
      snapStateRef.current = {x: false, y: false};
      onSnapGuidesChange({x: false, y: false});
      setIsTouching(false);
      setTouchReticle(null);
      onTransformClip(targetId, finalPatch, true);
      onLockLayer?.(targetId, false);
    }
  };

  const handleResetActiveParam = () => {
    if (mode === 'position') {
      onTransformClip(clip.id, {x: 0.5, y: 0.5}, true);
    } else if (mode === 'scale') {
      const defaultScale = clip.track === 'overlay' ? 0.42 : 1;
      onTransformClip(
        clip.id,
        {
          x: currentTransform.x,
          y: currentTransform.y,
          scale: defaultScale,
        },
        true
      );
    } else {
      onTransformClip(
        clip.id,
        {
          x: currentTransform.x,
          y: currentTransform.y,
          rotation: 0,
        },
        true
      );
    }
  };

  const readoutText =
    mode === 'position'
      ? `X ${Math.round(currentTransform.x * 100)}% · Y ${Math.round(currentTransform.y * 100)}%`
      : mode === 'scale'
        ? `Масштаб ${Math.round(currentTransform.scale * 100)}%`
        : `Поворот ${Math.round(currentTransform.rotation)}°`;

  const hintText =
    mode === 'position'
      ? 'Водите 1 пальцем для сдвига · 2 пальцами для масштаба и поворота'
      : mode === 'scale'
        ? 'Двигайте вверх/вниз для размера · 2 пальцами щипок/поворот'
        : 'Крутите по кругу или влево/вправо для поворота · 2 пальца для масштаба';

  return (
    <div className="flex h-full flex-col border-t border-white/10 bg-[#0d0d11] select-none">
      {/* Top Trackpad Bar */}
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-white/10 bg-[#121217] px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs font-semibold text-white">
            Трекпад · {clip.name}
          </span>
          <span className="rounded-md bg-cyan-500/15 px-2 py-0.5 font-mono text-[11px] font-medium tabular-nums text-cyan-300">
            {readoutText}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={handleResetActiveParam}
            className="flex h-7 items-center gap-1 rounded-md border border-white/10 bg-zinc-900 px-2 text-[11px] font-medium text-zinc-200 hover:border-cyan-400/60 hover:text-white active:scale-95"
            title="Сбросить выбранный параметр"
          >
            <RotateCcw className="h-3 w-3 text-cyan-400" />
            <span>Сброс</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 items-center gap-1 rounded-md bg-white/10 px-2 text-[11px] font-medium text-zinc-200 hover:bg-white/15 active:scale-95"
            title="Вернуться к таймлайну"
          >
            <X className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Таймлайн</span>
          </button>
        </div>
      </div>

      {/* Main Trackpad Body + Right Mode Switcher */}
      <div className="flex min-h-0 flex-1">
        {/* Touch Surface with Visual Dot Grid */}
        <div
          ref={padRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          className={`relative flex-1 overflow-hidden touch-none cursor-crosshair transition-colors ${
            isTouching ? 'bg-[#090d12]' : 'bg-[#0a0a0e]'
          }`}
          style={{
            backgroundImage:
              'radial-gradient(circle, rgba(34, 211, 238, 0.24) 1.2px, transparent 1.2px)',
            backgroundSize: '20px 20px',
            backgroundPosition: 'center center',
          }}
        >
          {/* Subtle Center Crosshair */}
          <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-cyan-400/15" />
          <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px bg-cyan-400/15" />

          {/* Circular Dial Guide when in Rotation Mode */}
          {mode === 'rotation' && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="h-32 w-32 rounded-full border border-dashed border-cyan-400/25 sm:h-36 sm:w-36" />
            </div>
          )}

          {/* Touch Reticle Feedback */}
          {touchReticle && (
            <div
              className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
              style={{left: touchReticle.x, top: touchReticle.y}}
            >
              <div className="h-12 w-12 rounded-full border border-cyan-400/80 bg-cyan-400/15 shadow-[0_0_20px_rgba(34,211,238,0.35)]" />
              <div className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-cyan-300" />
            </div>
          )}

          {/* Bottom Helper Hint */}
          <div className="pointer-events-none absolute inset-x-3 bottom-2 flex justify-center">
            <span className="rounded-md bg-zinc-950/80 px-2.5 py-1 text-center text-[10px] text-zinc-400 backdrop-blur-xs">
              {hintText}
            </span>
          </div>
        </div>

        {/* Right Mode Tabs Rail (Alight Motion style) */}
        <div className="flex w-24 shrink-0 flex-col gap-1.5 border-l border-white/10 bg-[#121217] p-1.5 sm:w-28">
          <button
            type="button"
            onClick={() => setMode('position')}
            className={`flex flex-1 flex-col items-center justify-center gap-1 rounded-lg border text-[11px] font-medium transition active:scale-95 ${
              mode === 'position'
                ? 'border-cyan-400/70 bg-cyan-500/20 text-cyan-200'
                : 'border-white/5 bg-zinc-900/70 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Move className="h-4 w-4" />
            <span>Позиция</span>
          </button>

          <button
            type="button"
            onClick={() => setMode('scale')}
            className={`flex flex-1 flex-col items-center justify-center gap-1 rounded-lg border text-[11px] font-medium transition active:scale-95 ${
              mode === 'scale'
                ? 'border-cyan-400/70 bg-cyan-500/20 text-cyan-200'
                : 'border-white/5 bg-zinc-900/70 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Maximize2 className="h-4 w-4" />
            <span>Масштаб</span>
          </button>

          <button
            type="button"
            onClick={() => setMode('rotation')}
            className={`flex flex-1 flex-col items-center justify-center gap-1 rounded-lg border text-[11px] font-medium transition active:scale-95 ${
              mode === 'rotation'
                ? 'border-cyan-400/70 bg-cyan-500/20 text-cyan-200'
                : 'border-white/5 bg-zinc-900/70 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <RotateCw className="h-4 w-4" />
            <span>Поворот</span>
          </button>
        </div>
      </div>
    </div>
  );
};
