import React, {useEffect, useRef} from 'react';
import type {AspectRatio, Clip, Collaborator, Track} from '../shared/types.ts';
import {
  getCanvasDimensions,
  MediaPool,
  renderCompositeFrame,
} from '../lib/renderEngine.ts';

interface PreviewCanvasProps {
  tracks: Track[];
  clips: Clip[];
  aspectRatio: AspectRatio;
  currentTime: number;
  isPlaying: boolean;
  selectedClipId: string | null;
  collaborators: Collaborator[];
  mediaPool: MediaPool;
  onSelectClip: (clipId: string | null) => void;
  onDragClipPosition: (
    clipId: string,
    x: number,
    y: number,
    commit: boolean
  ) => void;
}

export const PreviewCanvas: React.FC<PreviewCanvasProps> = ({
  tracks,
  clips,
  aspectRatio,
  currentTime,
  isPlaying,
  selectedClipId,
  collaborators,
  mediaPool,
  onSelectClip,
  onDragClipPosition,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragStateRef = useRef<{
    clipId: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  const {width, height} = getCanvasDimensions(aspectRatio);

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
      selectedClipId,
      collaborators,
      tracks
    );
  }, [
    tracks,
    clips,
    aspectRatio,
    currentTime,
    isPlaying,
    selectedClipId,
    collaborators,
    mediaPool,
    width,
    height,
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
          selectedClipId,
          collaborators,
          tracks
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
    currentTime,
    width,
    height,
    mediaPool,
    selectedClipId,
    collaborators,
  ]);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;

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
      const cx = c.textStyle?.x ?? 0.5;
      const cy = c.textStyle?.y ?? 0.78;
      if (Math.abs(nx - cx) < 0.28 && Math.abs(ny - cy) < 0.1) {
        onSelectClip(c.id);
        canvas.setPointerCapture(e.pointerId);
        dragStateRef.current = {
          clipId: c.id,
          startX: e.clientX,
          startY: e.clientY,
          origX: cx,
          origY: cy,
        };
        return;
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
      const cx = c.mediaX ?? 0.72;
      const cy = c.mediaY ?? 0.25;
      const half = (c.mediaScale ?? 0.42) / 2;
      if (Math.abs(nx - cx) <= half && Math.abs(ny - cy) <= half) {
        onSelectClip(c.id);
        canvas.setPointerCapture(e.pointerId);
        dragStateRef.current = {
          clipId: c.id,
          startX: e.clientX,
          startY: e.clientY,
          origX: cx,
          origY: cy,
        };
        return;
      }
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragStateRef.current;
    const canvas = canvasRef.current;
    if (!drag || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dx = (e.clientX - drag.startX) / rect.width;
    const dy = (e.clientY - drag.startY) / rect.height;
    const nextX = Math.max(0.08, Math.min(0.92, drag.origX + dx));
    const nextY = Math.max(0.08, Math.min(0.92, drag.origY + dy));
    onDragClipPosition(drag.clipId, nextX, nextY, false);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragStateRef.current;
    const canvas = canvasRef.current;
    if (!drag || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dx = (e.clientX - drag.startX) / rect.width;
    const dy = (e.clientY - drag.startY) / rect.height;
    const nextX = Math.max(0.08, Math.min(0.92, drag.origX + dx));
    const nextY = Math.max(0.08, Math.min(0.92, drag.origY + dy));
    dragStateRef.current = null;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    onDragClipPosition(drag.clipId, nextX, nextY, true);
  };

  const aspectClass =
    aspectRatio === '9:16'
      ? 'aspect-[9/16]'
      : aspectRatio === '16:9'
        ? 'aspect-video'
        : aspectRatio === '4:5'
          ? 'aspect-[4/5]'
          : 'aspect-square';

  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden p-2 sm:p-4">
      <div
        className={`relative max-h-full max-w-full ${aspectClass} overflow-hidden rounded-xl border border-white/10 bg-[#09090b] shadow-2xl`}
        style={{
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

        {clips.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center p-4 text-center">
            <p className="text-sm font-medium text-zinc-300">Таймлайн пуст</p>
            <p className="mt-1 text-xs text-zinc-500">
              Нажмите «Медиа» внизу, чтобы добавить видео или фото
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
