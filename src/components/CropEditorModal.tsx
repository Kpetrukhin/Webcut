import React, {useEffect, useRef, useState} from 'react';
import {Check, Crop as CropIcon, RotateCcw, X} from 'lucide-react';
import type {Clip, ClipCrop} from '../shared/types.ts';
import {resolveMediaSrc} from '../lib/serverConfig.ts';

interface CropEditorModalProps {
  clip: Clip;
  currentTime: number;
  onApplyCrop: (crop: ClipCrop | undefined) => void;
  onClose: () => void;
}

type AspectPresetId = NonNullable<ClipCrop['aspectPreset']>;

const ASPECT_PRESETS: Array<{
  id: AspectPresetId;
  label: string;
  ratio: number | null;
}> = [
  {id: 'free', label: 'Свободно', ratio: null},
  {id: '1:1', label: '1:1', ratio: 1},
  {id: '9:16', label: '9:16', ratio: 9 / 16},
  {id: '16:9', label: '16:9', ratio: 16 / 9},
  {id: '4:5', label: '4:5', ratio: 4 / 5},
];

type DragHandle = 'move' | 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'w' | 'e';

const MIN_CROP_SIZE = 0.08;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function getRatioValue(id: AspectPresetId): number | null {
  return ASPECT_PRESETS.find((p) => p.id === id)?.ratio ?? null;
}

export const CropEditorModal: React.FC<CropEditorModalProps> = ({
  clip,
  currentTime,
  onApplyCrop,
  onClose,
}) => {
  const [mediaSize, setMediaSize] = useState<{w: number; h: number}>({
    w: 16,
    h: 9,
  });
  const [crop, setCrop] = useState<ClipCrop>(() =>
    clip.crop
      ? {...clip.crop, aspectPreset: clip.crop.aspectPreset ?? 'free'}
      : {x: 0, y: 0, width: 1, height: 1, aspectPreset: 'free'}
  );

  const stageRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const dragStateRef = useRef<{
    handle: DragHandle;
    startClientX: number;
    startClientY: number;
    origCrop: ClipCrop;
    stageWidth: number;
    stageHeight: number;
  } | null>(null);

  const resolvedSrc = clip.src ? resolveMediaSrc(clip.src) || clip.src : '';

  useEffect(() => {
    const vid = videoRef.current;
    if (!vid || clip.kind !== 'video') return;
    const targetTime = Math.max(
      0,
      clip.trimStart + Math.max(0, currentTime - clip.start) * (clip.speed || 1)
    );
    const seekIt = () => {
      if (vid.readyState >= 1) {
        vid.currentTime = Math.min(
          targetTime,
          Math.max(0, (vid.duration || 60) - 0.05)
        );
      }
    };
    seekIt();
    vid.addEventListener('loadedmetadata', seekIt);
    return () => vid.removeEventListener('loadedmetadata', seekIt);
  }, [clip.kind, clip.start, clip.trimStart, clip.speed, currentTime]);

  const applyAspectPreset = (presetId: AspectPresetId) => {
    const targetRatio = getRatioValue(presetId);
    if (!targetRatio) {
      setCrop((prev) => ({...prev, aspectPreset: 'free'}));
      return;
    }
    const mw = Math.max(1, mediaSize.w);
    const mh = Math.max(1, mediaSize.h);
    // In normalized coords: (w * mw) / (h * mh) = targetRatio => w / h = targetRatio * (mh / mw)
    const normRatio = targetRatio * (mh / mw);

    let newW = 1;
    let newH = newW / normRatio;
    if (newH > 1) {
      newH = 1;
      newW = newH * normRatio;
    }
    newW = clamp(newW, MIN_CROP_SIZE, 1);
    newH = clamp(newH, MIN_CROP_SIZE, 1);

    const cx = crop.x + crop.width / 2;
    const cy = crop.y + crop.height / 2;
    const newX = clamp(cx - newW / 2, 0, 1 - newW);
    const newY = clamp(cy - newH / 2, 0, 1 - newH);

    setCrop({
      x: Number(newX.toFixed(4)),
      y: Number(newY.toFixed(4)),
      width: Number(newW.toFixed(4)),
      height: Number(newH.toFixed(4)),
      aspectPreset: presetId,
    });
  };

  const beginDrag = (
    e: React.PointerEvent,
    handle: DragHandle
  ) => {
    e.stopPropagation();
    e.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragStateRef.current = {
      handle,
      startClientX: e.clientX,
      startClientY: e.clientY,
      origCrop: {...crop},
      stageWidth: rect.width,
      stageHeight: rect.height,
    };
  };

  const onDragMove = (e: React.PointerEvent) => {
    const drag = dragStateRef.current;
    if (!drag) return;
    e.stopPropagation();

    const dx = (e.clientX - drag.startClientX) / drag.stageWidth;
    const dy = (e.clientY - drag.startClientY) / drag.stageHeight;
    const o = drag.origCrop;
    const presetRatio = getRatioValue(o.aspectPreset ?? 'free');
    const normRatio = presetRatio
      ? presetRatio * (Math.max(1, mediaSize.h) / Math.max(1, mediaSize.w))
      : null;

    if (drag.handle === 'move') {
      const nx = clamp(o.x + dx, 0, 1 - o.width);
      const ny = clamp(o.y + dy, 0, 1 - o.height);
      setCrop({
        ...o,
        x: Number(nx.toFixed(4)),
        y: Number(ny.toFixed(4)),
      });
      return;
    }

    let left = o.x;
    let top = o.y;
    let right = o.x + o.width;
    let bottom = o.y + o.height;

    const h = drag.handle;
    if (h.includes('w')) {
      left = clamp(o.x + dx, 0, right - MIN_CROP_SIZE);
    }
    if (h.includes('e')) {
      right = clamp(o.x + o.width + dx, left + MIN_CROP_SIZE, 1);
    }
    if (h.includes('n')) {
      top = clamp(o.y + dy, 0, bottom - MIN_CROP_SIZE);
    }
    if (h.includes('s')) {
      bottom = clamp(o.y + o.height + dy, top + MIN_CROP_SIZE, 1);
    }

    if (normRatio) {
      let w = right - left;
      let targetH = w / normRatio;

      if (h === 'n' || h === 's') {
        targetH = bottom - top;
        w = targetH * normRatio;
        const cx = (left + right) / 2;
        left = cx - w / 2;
        right = cx + w / 2;
        if (left < 0) {
          left = 0;
          right = w;
        }
        if (right > 1) {
          right = 1;
          left = 1 - w;
        }
        if (left < 0 || right > 1) {
          w = Math.min(1, w);
          targetH = w / normRatio;
          left = 0;
          right = w;
          if (h === 'n') top = bottom - targetH;
          else bottom = top + targetH;
        }
      } else {
        if (h.includes('n')) {
          top = bottom - targetH;
          if (top < 0) {
            top = 0;
            targetH = bottom;
            w = targetH * normRatio;
            if (h.includes('w')) left = right - w;
            else right = left + w;
          }
        } else {
          bottom = top + targetH;
          if (bottom > 1) {
            bottom = 1;
            targetH = 1 - top;
            w = targetH * normRatio;
            if (h.includes('w')) left = right - w;
            else right = left + w;
          }
        }
      }

      if (right - left < MIN_CROP_SIZE || bottom - top < MIN_CROP_SIZE) {
        return;
      }
    }

    setCrop({
      ...o,
      x: Number(clamp(left, 0, 1 - MIN_CROP_SIZE).toFixed(4)),
      y: Number(clamp(top, 0, 1 - MIN_CROP_SIZE).toFixed(4)),
      width: Number(clamp(right - left, MIN_CROP_SIZE, 1).toFixed(4)),
      height: Number(clamp(bottom - top, MIN_CROP_SIZE, 1).toFixed(4)),
    });
  };

  const endDrag = (e: React.PointerEvent) => {
    if (!dragStateRef.current) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    dragStateRef.current = null;
  };

  const handleReset = () => {
    setCrop({x: 0, y: 0, width: 1, height: 1, aspectPreset: 'free'});
  };

  const handleCommit = () => {
    const isFull =
      crop.x <= 0.002 &&
      crop.y <= 0.002 &&
      crop.width >= 0.996 &&
      crop.height >= 0.996;
    onApplyCrop(isFull ? undefined : crop);
    onClose();
  };

  const mediaAspect = Math.max(0.1, mediaSize.w / Math.max(1, mediaSize.h));

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/88 backdrop-blur-sm">
      {/* Header */}
      <div className="flex h-13 shrink-0 items-center justify-between border-b border-white/10 bg-[#111114] px-4">
        <div className="flex items-center gap-2 min-w-0">
          <CropIcon className="h-4 w-4 shrink-0 text-cyan-400" />
          <h3 className="truncate text-sm font-semibold text-white">
            Кадрирование · {clip.name}
          </h3>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleReset}
            className="flex h-8 items-center gap-1 rounded-lg border border-white/10 bg-zinc-900 px-2.5 text-xs font-medium text-zinc-300 hover:border-white/25 hover:text-white"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Сбросить
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Отменить кадрирование"
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-800 text-zinc-300 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Interactive Crop Workspace */}
      <div className="flex flex-1 min-h-0 items-center justify-center p-4 sm:p-8">
        <div
          ref={stageRef}
          style={{aspectRatio: `${mediaAspect}`}}
          className="relative max-h-full max-w-full overflow-hidden rounded-lg border border-white/15 bg-zinc-950 shadow-2xl"
        >
          {clip.kind === 'video' ? (
            <video
              ref={videoRef}
              src={resolvedSrc}
              muted
              playsInline
              preload="auto"
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                if (v.videoWidth && v.videoHeight) {
                  setMediaSize({w: v.videoWidth, h: v.videoHeight});
                }
              }}
              className="pointer-events-none block h-full w-full select-none object-fill"
            />
          ) : (
            <img
              src={resolvedSrc}
              alt={clip.name}
              onLoad={(e) => {
                const img = e.currentTarget;
                if (img.naturalWidth && img.naturalHeight) {
                  setMediaSize({w: img.naturalWidth, h: img.naturalHeight});
                }
              }}
              className="pointer-events-none block h-full w-full select-none object-fill"
            />
          )}

          {/* Dimmed Outside Masks (4 regions around crop rect) */}
          <div
            className="pointer-events-none absolute inset-x-0 top-0 bg-black/65"
            style={{height: `${crop.y * 100}%`}}
          />
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 bg-black/65"
            style={{height: `${Math.max(0, 1 - crop.y - crop.height) * 100}%`}}
          />
          <div
            className="pointer-events-none absolute left-0 bg-black/65"
            style={{
              top: `${crop.y * 100}%`,
              height: `${crop.height * 100}%`,
              width: `${crop.x * 100}%`,
            }}
          />
          <div
            className="pointer-events-none absolute right-0 bg-black/65"
            style={{
              top: `${crop.y * 100}%`,
              height: `${crop.height * 100}%`,
              width: `${Math.max(0, 1 - crop.x - crop.width) * 100}%`,
            }}
          />

          {/* Interactive Crop Frame */}
          <div
            onPointerDown={(e) => beginDrag(e, 'move')}
            onPointerMove={onDragMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            style={{
              left: `${crop.x * 100}%`,
              top: `${crop.y * 100}%`,
              width: `${crop.width * 100}%`,
              height: `${crop.height * 100}%`,
            }}
            className="absolute touch-none cursor-move border-2 border-cyan-400 shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
          >
            {/* Rule of thirds grid */}
            <div className="pointer-events-none absolute inset-0">
              <div className="absolute inset-y-0 left-1/3 w-px bg-white/30" />
              <div className="absolute inset-y-0 left-2/3 w-px bg-white/30" />
              <div className="absolute inset-x-0 top-1/3 h-px bg-white/30" />
              <div className="absolute inset-x-0 top-2/3 h-px bg-white/30" />
            </div>

            {/* Edge Handles */}
            <div
              onPointerDown={(e) => beginDrag(e, 'n')}
              onPointerMove={onDragMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              className="absolute -top-2 left-4 right-4 h-4 cursor-ns-resize touch-none flex items-center justify-center"
            >
              <div className="h-1 w-8 rounded-full bg-white shadow" />
            </div>
            <div
              onPointerDown={(e) => beginDrag(e, 's')}
              onPointerMove={onDragMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              className="absolute -bottom-2 left-4 right-4 h-4 cursor-ns-resize touch-none flex items-center justify-center"
            >
              <div className="h-1 w-8 rounded-full bg-white shadow" />
            </div>
            <div
              onPointerDown={(e) => beginDrag(e, 'w')}
              onPointerMove={onDragMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              className="absolute -left-2 top-4 bottom-4 w-4 cursor-ew-resize touch-none flex items-center justify-center"
            >
              <div className="h-8 w-1 rounded-full bg-white shadow" />
            </div>
            <div
              onPointerDown={(e) => beginDrag(e, 'e')}
              onPointerMove={onDragMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              className="absolute -right-2 top-4 bottom-4 w-4 cursor-ew-resize touch-none flex items-center justify-center"
            >
              <div className="h-8 w-1 rounded-full bg-white shadow" />
            </div>

            {/* 4 Corner Handles */}
            {(
              [
                {h: 'nw', cls: '-top-2.5 -left-2.5 cursor-nwse-resize'},
                {h: 'ne', cls: '-top-2.5 -right-2.5 cursor-nesw-resize'},
                {h: 'sw', cls: '-bottom-2.5 -left-2.5 cursor-nesw-resize'},
                {h: 'se', cls: '-bottom-2.5 -right-2.5 cursor-nwse-resize'},
              ] as const
            ).map((c) => (
              <div
                key={c.h}
                onPointerDown={(e) => beginDrag(e, c.h)}
                onPointerMove={onDragMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                className={`absolute ${c.cls} flex h-6 w-6 touch-none items-center justify-center`}
              >
                <div className="h-3.5 w-3.5 rounded-sm border-2 border-zinc-950 bg-cyan-400 shadow" />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Bottom Presets & Action Bar */}
      <div className="shrink-0 space-y-3 border-t border-white/10 bg-[#111114] px-4 py-3 pb-safe">
        <div className="mx-auto flex max-w-lg items-center justify-center gap-1.5 overflow-x-auto">
          {ASPECT_PRESETS.map((preset) => {
            const active = (crop.aspectPreset ?? 'free') === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => applyAspectPreset(preset.id)}
                className={`h-9 shrink-0 rounded-xl border px-3 text-xs font-semibold transition ${
                  active
                    ? 'border-cyan-400 bg-cyan-500/20 text-cyan-200'
                    : 'border-white/10 bg-zinc-900 text-zinc-300 hover:border-white/25'
                }`}
              >
                {preset.label}
              </button>
            );
          })}
        </div>

        <div className="mx-auto flex max-w-lg items-center justify-between gap-2">
          <span className="font-mono text-[11px] text-zinc-400 tabular-nums">
            {Math.round(crop.width * 100)}% × {Math.round(crop.height * 100)}%
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-10 rounded-xl border border-white/10 bg-zinc-900 px-4 text-xs font-medium text-zinc-300 hover:bg-zinc-800"
            >
              Отмена
            </button>
            <button
              type="button"
              onClick={handleCommit}
              className="flex h-10 items-center gap-1.5 rounded-xl bg-cyan-500 px-5 text-xs font-semibold text-zinc-950 hover:bg-cyan-400 active:scale-95"
            >
              <Check className="h-4 w-4" />
              Применить
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
