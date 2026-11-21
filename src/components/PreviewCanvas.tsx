import React, {useEffect, useRef, useState} from 'react';
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
} from '../lib/renderEngine.ts';

interface PreviewCanvasProps {
  tracks: Track[];
  clips: Clip[];
  aspectRatio: AspectRatio;
  backgroundColor?: string;
  customFonts?: ProjectFont[];
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
  backgroundColor,
  customFonts,
  currentTime,
  isPlaying,
  selectedClipId,
  collaborators,
  mediaPool,
  onSelectClip,
  onDragClipPosition,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [renderNonce, setRenderNonce] = useState(0);
  const dragStateRef = useRef<{
    clipId: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
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
      tracks,
      backgroundColor
    );
  }, [
    tracks,
    clips,
    aspectRatio,
    backgroundColor,
    currentTime,
    isPlaying,
    selectedClipId,
    collaborators,
    mediaPool,
    width,
    height,
    renderNonce,
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
          tracks,
          backgroundColor
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
      const tr = evaluateClipTransform(c, currentTime);
      if (Math.abs(nx - tr.x) < 0.28 && Math.abs(ny - tr.y) < 0.12) {
        onSelectClip(c.id);
        canvas.setPointerCapture(e.pointerId);
        dragStateRef.current = {
          clipId: c.id,
          startX: e.clientX,
          startY: e.clientY,
          origX: tr.x,
          origY: tr.y,
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
      const tr = evaluateClipTransform(c, currentTime);
      const half = Math.max(0.1, tr.scale / 2);
      if (Math.abs(nx - tr.x) <= half && Math.abs(ny - tr.y) <= half) {
        onSelectClip(c.id);
        canvas.setPointerCapture(e.pointerId);
        dragStateRef.current = {
          clipId: c.id,
          startX: e.clientX,
          startY: e.clientY,
          origX: tr.x,
          origY: tr.y,
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
    const nextX = Math.max(0.05, Math.min(0.95, drag.origX + dx));
    const nextY = Math.max(0.05, Math.min(0.95, drag.origY + dy));
    onDragClipPosition(drag.clipId, nextX, nextY, false);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragStateRef.current;
    const canvas = canvasRef.current;
    if (!drag || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dx = (e.clientX - drag.startX) / rect.width;
    const dy = (e.clientY - drag.startY) / rect.height;
    const nextX = Math.max(0.05, Math.min(0.95, drag.origX + dx));
    const nextY = Math.max(0.05, Math.min(0.95, drag.origY + dy));
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
