import React, {useEffect, useRef, useState} from 'react';
import {
  EyeOff,
  Magnet,
  SlidersHorizontal,
} from 'lucide-react';
import {ScrubNumberField} from './ScrubNumberField.tsx';
import type {
  AspectRatio,
  CanvasBackground,
  Clip,
  ClipMask,
  ClipWarp,
  Collaborator,
  ProjectFont,
  TextCurvePoint,
  Track,
  WarpPoint,
} from '../shared/types.ts';
import {preloadProjectFonts, subscribeFontLoads} from '../lib/fontLoader.ts';
import {evaluateClipTransform} from '../lib/keyframeEngine.ts';
import type {StudioAudioEngine} from '../lib/audioEngine.ts';
import {
  getCanvasDimensions,
  getClipLayerBox,
  MediaPool,
  renderCompositeFrame,
  sampleClipColorAtNormalizedPoint,
  sampleCompositeColorAtNormalizedPoint,
} from '../lib/renderEngine.ts';
import {
  canvasNormToTextLocal,
  getTextCurveOverlayData,
  hitTestTextClip,
  normalizeTextStyle,
} from '../lib/textRenderer.ts';
import {
  canvasPxToLayerUv,
  evalMeshSplinePoint,
  getWarpedOutlinePolygon,
  isIdentityWarp,
  layerUvToCanvasPx,
  normalizeWarp,
  pointInPolygon,
} from '../lib/warpEngine.ts';

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
  canvasBackground?: CanvasBackground;
  customFonts?: ProjectFont[];
  currentTime: number;
  isPlaying: boolean;
  selectedClipId: string | null;
  currentUserId?: string;
  collaborators: Collaborator[];
  mediaPool: MediaPool;
  audioEngine?: StudioAudioEngine;
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
  colorPickerActive?: boolean;
  colorPickerPreviewHex?: string;
  onPickCanvasColor?: (hexColor: string, commit: boolean) => void;
  maskEditActive?: boolean;
  onTransformMask?: (
    clipId: string,
    patch: Partial<ClipMask>,
    commit: boolean
  ) => void;
  curveEditActive?: boolean;
  selectedCurvePointId?: string | null;
  onSelectCurvePoint?: (pointId: string | null) => void;
  onUpdateCurvePoints?: (
    clipId: string,
    points: TextCurvePoint[],
    commit: boolean
  ) => void;
  warpEditActive?: boolean;
  onUpdateWarp?: (clipId: string, warp: ClipWarp, commit: boolean) => void;
  onLockLayer?: (layerId: string, locked: boolean) => boolean;
  onSelectClip: (clipId: string | null) => void;
  onDoubleClickTextClip?: (clipId: string) => void;
  disableSizeTransition?: boolean;
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

function loadSavedNumber(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
  } catch {
    // ignore storage errors
  }
  return fallback;
}

export const PreviewCanvas: React.FC<PreviewCanvasProps> = ({
  tracks,
  clips,
  aspectRatio,
  backgroundColor,
  canvasBackground,
  customFonts,
  currentTime,
  isPlaying,
  selectedClipId,
  currentUserId,
  collaborators,
  mediaPool,
  audioEngine,
  disableSizeTransition = false,
  snapEnabled = true,
  onToggleSnap,
  showSelectionOutline = true,
  onToggleSelectionOutline,
  externalSnapGuides,
  chromaKeyPickerActive = false,
  onPickChromaKeyColor,
  colorPickerActive = false,
  colorPickerPreviewHex,
  onPickCanvasColor,
  maskEditActive = false,
  onTransformMask,
  curveEditActive = false,
  selectedCurvePointId = null,
  onSelectCurvePoint,
  onUpdateCurvePoints,
  warpEditActive = false,
  onUpdateWarp,
  onLockLayer,
  onSelectClip,
  onDoubleClickTextClip,
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
  const [pickerOffsetPx, setPickerOffsetPx] = useState<number>(() =>
    loadSavedNumber(PICKER_OFFSET_STORAGE_KEY, 52)
  );
  const [hoverLinePos, setHoverLinePos] = useState<{
    cx: number;
    cy: number;
  } | null>(null);

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
    target: 'clip' | 'mask';
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
  const curveDragRef = useRef<{
    clipId: string;
    pointId: string;
    points: TextCurvePoint[];
  } | null>(null);
  const warpDragRef = useRef<
    | {
        clipId: string;
        kind: 'corner';
        index: number;
        box: {
          centerX: number;
          centerY: number;
          layerW: number;
          layerH: number;
          rotationDeg: number;
        };
        warp: ClipWarp;
      }
    | {
        clipId: string;
        kind: 'edge';
        edgeIdx: number;
        startUv: {u: number; v: number};
        origCorners: [WarpPoint, WarpPoint, WarpPoint, WarpPoint];
        box: {
          centerX: number;
          centerY: number;
          layerW: number;
          layerH: number;
          rotationDeg: number;
        };
        warp: ClipWarp;
      }
    | {
        clipId: string;
        kind: 'mesh';
        index: number;
        box: {
          centerX: number;
          centerY: number;
          layerW: number;
          layerH: number;
          rotationDeg: number;
        };
        warp: ClipWarp;
      }
    | null
  >(null);
  const lastTextTapRef = useRef<{clipId: string; ts: number} | null>(null);
  const lastCurvePointTapRef = useRef<{pointId: string; ts: number} | null>(
    null
  );

  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stageSize, setStageSize] = useState<{w: number; h: number}>({w: 0, h: 0});
  const {width, height} = getCanvasDimensions(aspectRatio);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setStageSize({w: rect.width, h: rect.height});
      }
    };
    updateSize();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
    if (!chromaKeyPickerActive && !colorPickerActive) {
      setDraggingPicker(false);
      return;
    }
    if (chromaKeyPickerActive && selectedClipId) {
      const target = clips.find((c) => c.id === selectedClipId);
      if (!target) return;
      const tr = evaluateClipTransform(target, currentTime);
      setPickerPos({
        x: Math.max(0.08, Math.min(0.92, tr.x)),
        y: Math.max(0.08, Math.min(0.92, tr.y)),
      });
    } else if (colorPickerActive) {
      setPickerPos({x: 0.5, y: 0.45});
    }
  }, [chromaKeyPickerActive, colorPickerActive, selectedClipId]);

  useEffect(() => {
    if (!snapEnabled) {
      snapStateRef.current = {x: false, y: false};
      setSnapGuides({x: false, y: false});
    }
  }, [snapEnabled]);

  const maskEditClipId = maskEditActive ? selectedClipId : null;

  const renderStateRef = useRef({
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
    currentUserId,
    maskEditClipId,
    canvasBackground,
  });
  renderStateRef.current = {
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
    currentUserId,
    maskEditClipId,
    canvasBackground,
  };

  useEffect(() => {
    mediaPool.syncVideos(clips, currentTime, isPlaying, tracks, audioEngine);
  }, [tracks, clips, currentTime, isPlaying, mediaPool, audioEngine]);

  const pausedRedrawRafRef = useRef<number | null>(null);
  useEffect(() => {
    if (isPlaying) {
      if (pausedRedrawRafRef.current !== null) {
        cancelAnimationFrame(pausedRedrawRafRef.current);
        pausedRedrawRafRef.current = null;
      }
      return;
    }
    if (pausedRedrawRafRef.current !== null) {
      cancelAnimationFrame(pausedRedrawRafRef.current);
    }
    pausedRedrawRafRef.current = requestAnimationFrame(() => {
      pausedRedrawRafRef.current = null;
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;
      const s = renderStateRef.current;
      renderCompositeFrame(
        ctx,
        s.width,
        s.height,
        s.clips,
        s.currentTime,
        s.mediaPool,
        s.renderedSelectedId,
        s.collaborators,
        s.tracks,
        s.backgroundColor,
        s.effectiveSnapGuides,
        s.currentUserId,
        s.maskEditClipId,
        s.canvasBackground
      );
    });
    return () => {
      if (pausedRedrawRafRef.current !== null) {
        cancelAnimationFrame(pausedRedrawRafRef.current);
        pausedRedrawRafRef.current = null;
      }
    };
  }, [
    isPlaying,
    tracks,
    clips,
    aspectRatio,
    backgroundColor,
    canvasBackground,
    currentTime,
    renderedSelectedId,
    collaborators,
    mediaPool,
    width,
    height,
    renderNonce,
    effectiveSnapGuides.x,
    effectiveSnapGuides.y,
    currentUserId,
    maskEditClipId,
  ]);

  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    const loop = () => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (canvas && ctx) {
        const s = renderStateRef.current;
        renderCompositeFrame(
          ctx,
          s.width,
          s.height,
          s.clips,
          s.currentTime,
          s.mediaPool,
          s.renderedSelectedId,
          s.collaborators,
          s.tracks,
          s.backgroundColor,
          s.effectiveSnapGuides,
          s.currentUserId,
          s.maskEditClipId,
          s.canvasBackground
        );
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying]);

  const findHitClip = (nx: number, ny: number): Clip | null => {
    const hiddenIds = new Set(tracks.filter((t) => t.hidden).map((t) => t.id));
    const trackOrder = new Map<string, number>();
    tracks.forEach((t, i) => trackOrder.set(t.id, i));

    const activeVisual = clips
      .filter(
        (c) =>
          c.track !== 'audio' &&
          c.track !== 'adjustment' &&
          c.kind !== 'adjustment' &&
          !hiddenIds.has(c.trackId) &&
          currentTime >= c.start &&
          currentTime < c.start + c.duration
      )
      .sort((a, b) => {
        const ta = trackOrder.get(a.trackId) ?? 0;
        const tb = trackOrder.get(b.trackId) ?? 0;
        if (ta !== tb) return ta - tb;
        return a.start - b.start;
      });

    for (let i = activeVisual.length - 1; i >= 0; i--) {
      const c = activeVisual[i];
      if (c.track === 'text') {
        if (hitTestTextClip(c, nx, ny, width, height, currentTime)) {
          return c;
        }
      } else if (c.track === 'overlay') {
        const box = getClipLayerBox(c, width, height, currentTime, mediaPool);
        if (box) {
          const px = nx * width;
          const py = ny * height;
          const tr = evaluateClipTransform(c, currentTime);
          const warp = normalizeWarp(tr.warp ?? c.warp);
          if (!isIdentityWarp(warp)) {
            const poly = getWarpedOutlinePolygon(
              box.centerX,
              box.centerY,
              box.layerW,
              box.layerH,
              box.rotationDeg,
              warp
            );
            if (pointInPolygon(px, py, poly)) {
              return c;
            }
          } else {
            const {u, v} = canvasPxToLayerUv(
              px,
              py,
              box.centerX,
              box.centerY,
              Math.max(48, box.layerW),
              Math.max(48, box.layerH),
              box.rotationDeg
            );
            if (u >= -0.05 && u <= 1.05 && v >= -0.05 && v <= 1.05) {
              return c;
            }
          }
        } else {
          const tr = evaluateClipTransform(c, currentTime);
          const halfW = Math.max(0.12, (tr.scale * tr.scaleX) / 2);
          const halfH = Math.max(0.12, (tr.scale * tr.scaleY) / 2);
          if (Math.abs(nx - tr.x) <= halfW && Math.abs(ny - tr.y) <= halfH) {
            return c;
          }
        }
      } else if (c.track === 'video') {
        return c;
      }
    }

    return null;
  };

  const beginGestureForClip = (clip: Clip, target: 'clip' | 'mask' = 'clip') => {
    const pointers = Array.from(activePointersRef.current.values());
    if (pointers.length === 0) return;

    if (clip.lockedByUserId && clip.lockedByUserId !== currentUserId) {
      onLockLayer?.(clip.id, true);
      return;
    }
    if (onLockLayer && onLockLayer(clip.id, true) === false) {
      return;
    }

    const mask = clip.mask;
    const tr = evaluateClipTransform(clip, currentTime);
    const origX = target === 'mask' && mask ? mask.x : tr.x;
    const origY = target === 'mask' && mask ? mask.y : tr.y;
    const origScale = target === 'mask' && mask ? mask.scale : tr.scale;
    const origRotation = target === 'mask' && mask ? mask.rotation : tr.rotation;

    if (pointers.length >= 2) {
      const [p1, p2] = pointers;
      const cx = (p1.x + p2.x) / 2;
      const cy = (p1.y + p2.y) / 2;
      const dist = Math.max(10, Math.hypot(p2.x - p1.x, p2.y - p1.y));
      const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
      gestureRef.current = {
        clipId: clip.id,
        target,
        mode: 'pinch',
        startX: cx,
        startY: cy,
        startDist: dist,
        startAngle: angle,
        origX,
        origY,
        origScale,
        origRotation,
        lastCommitted: {
          x: origX,
          y: origY,
          scale: origScale,
          rotation: origRotation,
        },
      };
    } else {
      const [p1] = pointers;
      gestureRef.current = {
        clipId: clip.id,
        target,
        mode: 'pan',
        startX: p1.x,
        startY: p1.y,
        startDist: 1,
        startAngle: 0,
        origX,
        origY,
        origScale,
        origRotation,
        lastCommitted: {x: origX, y: origY},
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

    let x = Math.max(-5, Math.min(6, rawX));
    let y = Math.max(-5, Math.min(6, rawY));
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

  const findClosestPolylinePoint = (
    cx: number,
    cy: number,
    polyline: Array<{cx: number; cy: number; segIdx: number}>
  ) => {
    let bestDist = Infinity;
    let bestCx = cx;
    let bestCy = cy;
    let bestSegIdx = 0;

    for (let i = 0; i < polyline.length - 1; i++) {
      const a = polyline[i];
      const b = polyline[i + 1];
      const abx = b.cx - a.cx;
      const aby = b.cy - a.cy;
      const lenSq = abx * abx + aby * aby;
      let t = 0;
      if (lenSq > 1e-6) {
        t = Math.max(
          0,
          Math.min(1, ((cx - a.cx) * abx + (cy - a.cy) * aby) / lenSq)
        );
      }
      const px = a.cx + abx * t;
      const py = a.cy + aby * t;
      const d = Math.hypot(cx - px, cy - py);
      if (d < bestDist) {
        bestDist = d;
        bestCx = px;
        bestCy = py;
        bestSegIdx = a.segIdx;
      }
    }
    return {distPx: bestDist, cx: bestCx, cy: bestCy, segIdx: bestSegIdx};
  };

  const activeCurveClip = selectedClipId
    ? clips.find(
        (c) =>
          c.id === selectedClipId &&
          c.track === 'text' &&
          currentTime >= c.start &&
          currentTime < c.start + c.duration &&
          c.textStyle?.curveMode === 'custom'
      ) ?? null
    : null;

  const curveOverlay =
    curveEditActive &&
    activeCurveClip &&
    !isPlaying &&
    showSelectionOutline &&
    !chromaKeyPickerActive &&
    !colorPickerActive
      ? getTextCurveOverlayData(activeCurveClip, width, height, currentTime)
      : null;

  const activeWarpClip = selectedClipId
    ? clips.find(
        (c) =>
          c.id === selectedClipId &&
          c.track !== 'audio' &&
          c.track !== 'adjustment' &&
          c.kind !== 'adjustment' &&
          currentTime >= c.start &&
          currentTime < c.start + c.duration
      ) ?? null
    : null;

  const warpOverlay = (() => {
    if (
      !warpEditActive ||
      !activeWarpClip ||
      isPlaying ||
      !showSelectionOutline ||
      chromaKeyPickerActive ||
      colorPickerActive ||
      maskEditActive
    ) {
      return null;
    }
    const tr = evaluateClipTransform(activeWarpClip, currentTime);
    const warp = normalizeWarp(tr.warp ?? activeWarpClip.warp);
    if (warp.mode === 'none') return null;
    const box = getClipLayerBox(
      activeWarpClip,
      width,
      height,
      currentTime,
      mediaPool
    );
    if (!box) return null;

    const toPx = (u: number, v: number) =>
      layerUvToCanvasPx(
        u,
        v,
        box.centerX,
        box.centerY,
        box.layerW,
        box.layerH,
        box.rotationDeg
      );

    if (warp.mode === 'perspective') {
      const cornerPx = warp.corners.map((p) => toPx(p.x, p.y));
      const edges: Array<[number, number]> = [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 0],
      ];
      const edgeMidPx = edges.map(([iA, iB]) => {
        const a = cornerPx[iA];
        const b = cornerPx[iB];
        return {
          x: (a.x + b.x) / 2,
          y: (a.y + b.y) / 2,
          angleDeg: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI,
        };
      });
      return {
        clip: activeWarpClip,
        box,
        warp,
        mode: 'perspective' as const,
        cornerPx,
        edgeMidPx,
      };
    }

    const n = warp.meshSize;
    const nodePx = warp.meshPoints.map((p) => toPx(p.x, p.y));
    const gridLines: string[] = [];
    const steps = 16;

    for (let r = 0; r < n; r++) {
      const v = r / (n - 1);
      let d = '';
      for (let s = 0; s <= steps; s++) {
        const u = s / steps;
        const uv = evalMeshSplinePoint(warp.meshPoints, n, u, v);
        const p = toPx(uv.x, uv.y);
        d += `${s === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)} `;
      }
      gridLines.push(d.trim());
    }
    for (let c = 0; c < n; c++) {
      const u = c / (n - 1);
      let d = '';
      for (let s = 0; s <= steps; s++) {
        const v = s / steps;
        const uv = evalMeshSplinePoint(warp.meshPoints, n, u, v);
        const p = toPx(uv.x, uv.y);
        d += `${s === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)} `;
      }
      gridLines.push(d.trim());
    }

    return {
      clip: activeWarpClip,
      box,
      warp,
      mode: 'mesh' as const,
      nodePx,
      gridLines,
    };
  })();

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
            c.track !== 'adjustment' &&
            c.kind !== 'adjustment' &&
            currentTime >= c.start &&
            currentTime < c.start + c.duration
        ) ?? null
      : null;

    if (activePointersRef.current.size >= 2) {
      curveDragRef.current = null;
      warpDragRef.current = null;
      if (existingSelected) {
        beginGestureForClip(existingSelected, maskEditActive && existingSelected.mask ? 'mask' : 'clip');
      }
      return;
    }

    if (warpOverlay && onUpdateWarp) {
      const pxPerCss = width / Math.max(1, rect.width);
      const canvasX = nx * width;
      const canvasY = ny * height;
      const nodeHitR = 24 * pxPerCss;

      if (warpOverlay.mode === 'perspective') {
        let bestCorner = -1;
        let bestCornerDist = Infinity;
        warpOverlay.cornerPx.forEach((pt, idx) => {
          const d = Math.hypot(canvasX - pt.x, canvasY - pt.y);
          if (d <= nodeHitR && d < bestCornerDist) {
            bestCornerDist = d;
            bestCorner = idx;
          }
        });
        if (bestCorner >= 0) {
          if (
            warpOverlay.clip.lockedByUserId &&
            warpOverlay.clip.lockedByUserId !== currentUserId
          ) {
            onLockLayer?.(warpOverlay.clip.id, true);
            return;
          }
          onLockLayer?.(warpOverlay.clip.id, true);
          warpDragRef.current = {
            clipId: warpOverlay.clip.id,
            kind: 'corner',
            index: bestCorner,
            box: warpOverlay.box,
            warp: warpOverlay.warp,
          };
          return;
        }

        let bestEdge = -1;
        let bestEdgeDist = Infinity;
        warpOverlay.edgeMidPx.forEach((pt, idx) => {
          const d = Math.hypot(canvasX - pt.x, canvasY - pt.y);
          if (d <= 21 * pxPerCss && d < bestEdgeDist) {
            bestEdgeDist = d;
            bestEdge = idx;
          }
        });
        if (bestEdge >= 0) {
          if (
            warpOverlay.clip.lockedByUserId &&
            warpOverlay.clip.lockedByUserId !== currentUserId
          ) {
            onLockLayer?.(warpOverlay.clip.id, true);
            return;
          }
          onLockLayer?.(warpOverlay.clip.id, true);
          const startUv = canvasPxToLayerUv(
            canvasX,
            canvasY,
            warpOverlay.box.centerX,
            warpOverlay.box.centerY,
            warpOverlay.box.layerW,
            warpOverlay.box.layerH,
            warpOverlay.box.rotationDeg
          );
          warpDragRef.current = {
            clipId: warpOverlay.clip.id,
            kind: 'edge',
            edgeIdx: bestEdge,
            startUv,
            origCorners: [
              {...warpOverlay.warp.corners[0]},
              {...warpOverlay.warp.corners[1]},
              {...warpOverlay.warp.corners[2]},
              {...warpOverlay.warp.corners[3]},
            ],
            box: warpOverlay.box,
            warp: warpOverlay.warp,
          };
          return;
        }
      } else {
        let bestNode = -1;
        let bestNodeDist = Infinity;
        warpOverlay.nodePx.forEach((pt, idx) => {
          const d = Math.hypot(canvasX - pt.x, canvasY - pt.y);
          if (d <= nodeHitR && d < bestNodeDist) {
            bestNodeDist = d;
            bestNode = idx;
          }
        });
        if (bestNode >= 0) {
          if (
            warpOverlay.clip.lockedByUserId &&
            warpOverlay.clip.lockedByUserId !== currentUserId
          ) {
            onLockLayer?.(warpOverlay.clip.id, true);
            return;
          }
          onLockLayer?.(warpOverlay.clip.id, true);
          warpDragRef.current = {
            clipId: warpOverlay.clip.id,
            kind: 'mesh',
            index: bestNode,
            box: warpOverlay.box,
            warp: warpOverlay.warp,
          };
          return;
        }
      }
    }

    if (curveOverlay && activeCurveClip && onUpdateCurvePoints) {
      const pxPerCss = width / Math.max(1, rect.width);
      const canvasX = nx * width;
      const canvasY = ny * height;
      const ptHitRadius = 22 * pxPerCss;
      const lineHitRadius = 16 * pxPerCss;

      let bestPt: (typeof curveOverlay.points)[number] | null = null;
      let bestPtDist = Infinity;
      for (const pt of curveOverlay.points) {
        const d = Math.hypot(canvasX - pt.cx, canvasY - pt.cy);
        if (d <= ptHitRadius && d < bestPtDist) {
          bestPtDist = d;
          bestPt = pt;
        }
      }

      const rawPoints = normalizeTextStyle(activeCurveClip.textStyle).curvePoints;

      if (bestPt) {
        const now = Date.now();
        if (
          lastCurvePointTapRef.current &&
          lastCurvePointTapRef.current.pointId === bestPt.id &&
          now - lastCurvePointTapRef.current.ts < 320 &&
          rawPoints.length > 2
        ) {
          lastCurvePointTapRef.current = null;
          const idx = rawPoints.findIndex((p) => p.id === bestPt!.id);
          const nextPts = rawPoints.filter((p) => p.id !== bestPt!.id);
          const fallbackIdx = Math.max(0, Math.min(nextPts.length - 1, idx));
          onSelectCurvePoint?.(nextPts[fallbackIdx]?.id ?? null);
          onUpdateCurvePoints(activeCurveClip.id, nextPts, true);
          return;
        }
        lastCurvePointTapRef.current = {pointId: bestPt.id, ts: now};
        onSelectCurvePoint?.(bestPt.id);
        if (
          activeCurveClip.lockedByUserId &&
          activeCurveClip.lockedByUserId !== currentUserId
        ) {
          onLockLayer?.(activeCurveClip.id, true);
          return;
        }
        onLockLayer?.(activeCurveClip.id, true);
        curveDragRef.current = {
          clipId: activeCurveClip.id,
          pointId: bestPt.id,
          points: rawPoints,
        };
        setHoverLinePos(null);
        return;
      }

      const closest = findClosestPolylinePoint(
        canvasX,
        canvasY,
        curveOverlay.polyline
      );
      if (closest.distPx <= lineHitRadius) {
        const {localX, localY} = canvasNormToTextLocal(
          activeCurveClip,
          closest.cx / width,
          closest.cy / height,
          width,
          height,
          currentTime
        );
        const newPt: TextCurvePoint = {
          id: `pt-${Math.random().toString(36).slice(2, 7)}`,
          x: Math.round(localX * 10) / 10,
          y: Math.round(localY * 10) / 10,
        };
        const insertAt = Math.max(
          1,
          Math.min(rawPoints.length, closest.segIdx + 1)
        );
        const nextPts = [
          ...rawPoints.slice(0, insertAt),
          newPt,
          ...rawPoints.slice(insertAt),
        ];
        onLockLayer?.(activeCurveClip.id, true);
        onSelectCurvePoint?.(newPt.id);
        onUpdateCurvePoints(activeCurveClip.id, nextPts, false);
        curveDragRef.current = {
          clipId: activeCurveClip.id,
          pointId: newPt.id,
          points: nextPts,
        };
        setHoverLinePos(null);
        return;
      }
    }

    if (maskEditActive && existingSelected?.mask && onTransformMask) {
      beginGestureForClip(existingSelected, 'mask');
      return;
    }

    const hit = findHitClip(nx, ny);
    if (hit) {
      if (hit.track === 'text' && activePointersRef.current.size === 1) {
        const now = Date.now();
        if (
          lastTextTapRef.current &&
          lastTextTapRef.current.clipId === hit.id &&
          now - lastTextTapRef.current.ts < 340
        ) {
          lastTextTapRef.current = null;
          onSelectClip(hit.id);
          onDoubleClickTextClip?.(hit.id);
          gestureRef.current = null;
          return;
        }
        lastTextTapRef.current = {clipId: hit.id, ts: now};
      }
      onSelectClip(hit.id);
      beginGestureForClip(hit, 'clip');
    } else if (existingSelected && activePointersRef.current.size === 1) {
      beginGestureForClip(existingSelected, 'clip');
    } else {
      onSelectClip(null);
      gestureRef.current = null;
    }
  };

  const commitTargetPatch = (
    target: 'clip' | 'mask',
    clipId: string,
    patch: CanvasTransformPatch,
    commit: boolean
  ) => {
    if (target === 'mask') {
      onTransformMask?.(
        clipId,
        {
          x: patch.x,
          y: patch.y,
          ...(patch.scale !== undefined ? {scale: patch.scale} : {}),
          ...(patch.rotation !== undefined ? {rotation: patch.rotation} : {}),
        },
        commit
      );
    } else {
      onTransformClip(clipId, patch, commit);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();

    if (warpDragRef.current && activePointersRef.current.has(e.pointerId)) {
      activePointersRef.current.set(e.pointerId, {x: e.clientX, y: e.clientY});
      const pointers = Array.from(activePointersRef.current.values());
      if (pointers.length >= 2) {
        warpDragRef.current = null;
      } else if (onUpdateWarp) {
        const drag = warpDragRef.current;
        const nx = (e.clientX - rect.left) / rect.width;
        const ny = (e.clientY - rect.top) / rect.height;
        const rawUv = canvasPxToLayerUv(
          nx * width,
          ny * height,
          drag.box.centerX,
          drag.box.centerY,
          drag.box.layerW,
          drag.box.layerH,
          drag.box.rotationDeg
        );
        const clampUv = (v: number) =>
          Math.max(-4.0, Math.min(5.0, Math.round(v * 1000) / 1000));
        const uv = {u: clampUv(rawUv.u), v: clampUv(rawUv.v)};

        let nextWarp: ClipWarp = drag.warp;
        if (drag.kind === 'corner') {
          const corners = drag.warp.corners.map((pt, idx) =>
            idx === drag.index ? {x: uv.u, y: uv.v} : {...pt}
          ) as [WarpPoint, WarpPoint, WarpPoint, WarpPoint];
          nextWarp = {...drag.warp, corners};
        } else if (drag.kind === 'edge') {
          const du = uv.u - drag.startUv.u;
          const dv = uv.v - drag.startUv.v;
          const edgePairs: Array<[number, number]> = [
            [0, 1],
            [1, 2],
            [2, 3],
            [3, 0],
          ];
          const [iA, iB] = edgePairs[drag.edgeIdx];
          const corners = drag.origCorners.map((pt, idx) =>
            idx === iA || idx === iB
              ? {x: clampUv(pt.x + du), y: clampUv(pt.y + dv)}
              : {...pt}
          ) as [WarpPoint, WarpPoint, WarpPoint, WarpPoint];
          nextWarp = {...drag.warp, corners};
        } else if (drag.kind === 'mesh') {
          const meshPoints = drag.warp.meshPoints.map((pt, idx) =>
            idx === drag.index ? {x: uv.u, y: uv.v} : {...pt}
          );
          nextWarp = {...drag.warp, meshPoints};
        }
        drag.warp = nextWarp;
        onUpdateWarp(drag.clipId, nextWarp, false);
        return;
      }
    }

    if (curveDragRef.current && activePointersRef.current.has(e.pointerId)) {
      activePointersRef.current.set(e.pointerId, {x: e.clientX, y: e.clientY});
      const pointers = Array.from(activePointersRef.current.values());
      if (pointers.length >= 2) {
        curveDragRef.current = null;
      } else if (activeCurveClip && onUpdateCurvePoints) {
        const nx = (e.clientX - rect.left) / rect.width;
        const ny = (e.clientY - rect.top) / rect.height;
        const {localX, localY} = canvasNormToTextLocal(
          activeCurveClip,
          nx,
          ny,
          width,
          height,
          currentTime
        );
        const drag = curveDragRef.current;
        const nextPts = drag.points.map((pt) =>
          pt.id === drag.pointId
            ? {
                ...pt,
                x: Math.round(localX * 10) / 10,
                y: Math.round(localY * 10) / 10,
              }
            : pt
        );
        drag.points = nextPts;
        onUpdateCurvePoints(drag.clipId, nextPts, false);
        return;
      }
    }

    if (!activePointersRef.current.has(e.pointerId)) {
      if (curveOverlay && e.pointerType === 'mouse' && rect.width > 0) {
        const pxPerCss = width / Math.max(1, rect.width);
        const canvasX = ((e.clientX - rect.left) / rect.width) * width;
        const canvasY = ((e.clientY - rect.top) / rect.height) * height;
        const nearExistingPt = curveOverlay.points.some(
          (p) => Math.hypot(canvasX - p.cx, canvasY - p.cy) <= 18 * pxPerCss
        );
        if (nearExistingPt) {
          setHoverLinePos(null);
        } else {
          const closest = findClosestPolylinePoint(
            canvasX,
            canvasY,
            curveOverlay.polyline
          );
          if (closest.distPx <= 14 * pxPerCss) {
            setHoverLinePos({cx: closest.cx, cy: closest.cy});
          } else {
            setHoverLinePos(null);
          }
        }
      } else if (hoverLinePos) {
        setHoverLinePos(null);
      }
      return;
    }

    activePointersRef.current.set(e.pointerId, {x: e.clientX, y: e.clientY});

    const gesture = gestureRef.current;
    if (!gesture) return;

    const pointers = Array.from(activePointersRef.current.values());

    if (pointers.length >= 2) {
      if (gesture.mode !== 'pinch') {
        const clip = clips.find((c) => c.id === gesture.clipId);
        if (clip) beginGestureForClip(clip, gesture.target);
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
        0.08,
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
      commitTargetPatch(gesture.target, gesture.clipId, patch, false);
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
      commitTargetPatch(gesture.target, gesture.clipId, patch, false);
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

    if (warpDragRef.current) {
      const drag = warpDragRef.current;
      warpDragRef.current = null;
      onUpdateWarp?.(drag.clipId, drag.warp, true);
      onLockLayer?.(drag.clipId, false);
      return;
    }

    if (curveDragRef.current) {
      const drag = curveDragRef.current;
      curveDragRef.current = null;
      onUpdateCurvePoints?.(drag.clipId, drag.points, true);
      onLockLayer?.(drag.clipId, false);
      return;
    }

    const gesture = gestureRef.current;
    if (!gesture) return;

    if (activePointersRef.current.size === 1) {
      const clip = clips.find((c) => c.id === gesture.clipId);
      if (clip) {
        commitTargetPatch(gesture.target, gesture.clipId, gesture.lastCommitted, true);
        beginGestureForClip(clip, gesture.target);
        return;
      }
    }

    if (activePointersRef.current.size === 0) {
      const finalPatch = gesture.lastCommitted;
      const clipId = gesture.clipId;
      const target = gesture.target;
      gestureRef.current = null;
      snapStateRef.current = {x: false, y: false};
      setSnapGuides({x: false, y: false});
      commitTargetPatch(target, clipId, finalPatch, true);
      onLockLayer?.(clipId, false);
    }
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    if (!maskEditActive || !onTransformMask || !selectedClipId) return;
    const clip = clips.find((c) => c.id === selectedClipId);
    if (!clip?.mask) return;
    e.preventDefault();
    if (e.shiftKey) {
      const nextRot = normalizeAngleDeg(
        clip.mask.rotation + (e.deltaY > 0 ? 5 : -5)
      );
      onTransformMask(clip.id, {rotation: nextRot}, true);
    } else {
      const factor = e.deltaY < 0 ? 1.06 : 0.94;
      const nextScale = Math.max(
        0.08,
        Math.min(2.5, Math.round(clip.mask.scale * factor * 100) / 100)
      );
      onTransformMask(clip.id, {scale: nextScale}, true);
    }
  };

  const samplePickerAtClientCoords = (
    clientX: number,
    clientY: number,
    commit: boolean
  ) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
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

    if (colorPickerActive && onPickCanvasColor) {
      const hex = sampleCompositeColorAtNormalizedPoint(
        nx,
        ny,
        width,
        height,
        clips,
        currentTime,
        mediaPool,
        tracks,
        backgroundColor,
        canvasBackground
      );
      if (hex) {
        onPickCanvasColor(hex, commit);
      }
      return;
    }

    if (!selectedClipId || !onPickChromaKeyColor) return;
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

  const targetAspect = width / height;
  const fittedSize =
    stageSize.w > 0 && stageSize.h > 0
      ? stageSize.w / stageSize.h > targetAspect
        ? {
            w: Math.max(40, Math.floor(stageSize.h * targetAspect)),
            h: Math.max(40, Math.floor(stageSize.h)),
          }
        : {
            w: Math.max(40, Math.floor(stageSize.w)),
            h: Math.max(40, Math.floor(stageSize.w / targetAspect)),
          }
      : null;

  const containerBgStyle: React.CSSProperties =
    canvasBackground?.type === 'gradient'
      ? {
          backgroundImage: `linear-gradient(${canvasBackground.angle ?? 135}deg, ${canvasBackground.colors[0]}, ${canvasBackground.colors[1]})`,
        }
      : {
          backgroundColor:
            (canvasBackground?.type === 'solid'
              ? canvasBackground.color
              : undefined) ||
            backgroundColor ||
            '#09090b',
        };

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

            {/* 3. Высота пипетки (Unity-style scrub) */}
            <div className="flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-zinc-900/80 px-2.5 py-2">
              <div className="min-w-0">
                <p className="text-xs font-medium text-zinc-200">
                  Высота пипетки
                </p>
                <p className="text-[10px] text-zinc-500">
                  Свайп ↕/↔ или ввод
                </p>
              </div>
              <ScrubNumberField
                value={pickerOffsetPx}
                onChange={updatePickerOffset}
                min={-250}
                max={250}
                step={1}
                suffix="px"
                ariaLabel="Высота пипетки"
              />
            </div>
          </div>
        )}
      </div>

      <div
        ref={stageRef}
        className="flex h-full w-full min-h-0 min-w-0 items-center justify-center"
      >
        <div
          className={`relative rounded-xl border border-white/10 shadow-2xl ${
            disableSizeTransition
              ? ''
              : 'transition-[width,height] duration-300 ease-out'
          }`}
          style={{
            ...containerBgStyle,
            width: fittedSize ? `${fittedSize.w}px` : undefined,
            height: fittedSize ? `${fittedSize.h}px` : undefined,
            ...(fittedSize
              ? {}
              : {
                  aspectRatio: `${width} / ${height}`,
                  maxWidth: '100%',
                  maxHeight: '100%',
                }),
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
          onPointerLeave={() => setHoverLinePos(null)}
          onWheel={handleWheel}
          className="h-full w-full touch-none overflow-hidden rounded-xl object-contain cursor-grab active:cursor-grabbing"
        />

        {curveOverlay && (
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="pointer-events-none absolute inset-0 z-10 h-full w-full overflow-visible"
          >
            {/* Dark contrast halo for visibility over bright or dark videos */}
            <path
              d={curveOverlay.pathD}
              fill="none"
              stroke="rgba(9, 9, 11, 0.78)"
              strokeWidth={Math.max(4.5, width * 0.0075)}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {/* Interactive cyan spline line over text */}
            <path
              d={curveOverlay.pathD}
              fill="none"
              stroke="#22d3ee"
              strokeWidth={Math.max(2.2, width * 0.0038)}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={`${Math.max(6, width * 0.01)} ${Math.max(4, width * 0.0065)}`}
            />

            {/* Hover '+' hint on spline line */}
            {hoverLinePos && (
              <g>
                <circle
                  cx={hoverLinePos.cx}
                  cy={hoverLinePos.cy}
                  r={Math.max(7, width * 0.011)}
                  fill="rgba(34, 211, 238, 0.35)"
                  stroke="#ffffff"
                  strokeWidth={Math.max(1.5, width * 0.0025)}
                />
              </g>
            )}

            {/* Draggable control points */}
            {curveOverlay.points.map((pt, idx) => {
              const isSelected = pt.id === selectedCurvePointId;
              const baseR = Math.max(8, width * 0.0145);
              const r = isSelected ? baseR * 1.25 : baseR;
              return (
                <g key={pt.id}>
                  <circle
                    cx={pt.cx}
                    cy={pt.cy}
                    r={r + Math.max(3, width * 0.005)}
                    fill="rgba(9, 9, 11, 0.45)"
                  />
                  <circle
                    cx={pt.cx}
                    cy={pt.cy}
                    r={r}
                    fill={isSelected ? '#facc15' : '#22d3ee'}
                    stroke="#ffffff"
                    strokeWidth={Math.max(2, width * 0.0035)}
                  />
                  <text
                    x={pt.cx}
                    y={pt.cy - r - Math.max(6, width * 0.009)}
                    textAnchor="middle"
                    fill="#ffffff"
                    stroke="rgba(9,9,11,0.85)"
                    strokeWidth={Math.max(2.5, width * 0.004)}
                    paintOrder="stroke"
                    fontSize={Math.max(11, Math.round(width * 0.02))}
                    fontWeight="700"
                  >
                    {idx + 1}
                  </text>
                </g>
              );
            })}
          </svg>
        )}

        {warpOverlay && (
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="pointer-events-none absolute inset-0 z-10 h-full w-full overflow-visible"
          >
            {warpOverlay.mode === 'perspective' ? (
              <g>
                {/* Perspective Quad Wireframe */}
                <polygon
                  points={warpOverlay.cornerPx
                    .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
                    .join(' ')}
                  fill="none"
                  stroke="rgba(9, 9, 11, 0.72)"
                  strokeWidth={Math.max(4, width * 0.0065)}
                  strokeLinejoin="round"
                />
                <polygon
                  points={warpOverlay.cornerPx
                    .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
                    .join(' ')}
                  fill="none"
                  stroke="#3b82f6"
                  strokeWidth={Math.max(2, width * 0.0032)}
                  strokeLinejoin="round"
                />

                {/* Edge Midpoint Handles */}
                {warpOverlay.edgeMidPx.map((m, idx) => {
                  const pw = Math.max(18, width * 0.026);
                  const ph = Math.max(7, width * 0.01);
                  return (
                    <g
                      key={`edge-${idx}`}
                      transform={`translate(${m.x.toFixed(1)} ${m.y.toFixed(1)}) rotate(${m.angleDeg.toFixed(1)})`}
                    >
                      <rect
                        x={-pw / 2}
                        y={-ph / 2}
                        width={pw}
                        height={ph}
                        rx={ph / 2}
                        fill="#3b82f6"
                        stroke="#ffffff"
                        strokeWidth={Math.max(1.8, width * 0.003)}
                      />
                    </g>
                  );
                })}

                {/* 4 Draggable Corner Handles */}
                {warpOverlay.cornerPx.map((pt, idx) => {
                  const r = Math.max(9, width * 0.0145);
                  return (
                    <g key={`corner-${idx}`}>
                      <circle
                        cx={pt.x}
                        cy={pt.y}
                        r={r + Math.max(3, width * 0.0045)}
                        fill="rgba(9, 9, 11, 0.48)"
                      />
                      <circle
                        cx={pt.x}
                        cy={pt.y}
                        r={r}
                        fill="#3b82f6"
                        stroke="#ffffff"
                        strokeWidth={Math.max(2.2, width * 0.0036)}
                      />
                    </g>
                  );
                })}
              </g>
            ) : (
              <g>
                {/* Mesh Spline Grid Lines */}
                {warpOverlay.gridLines.map((d, idx) => (
                  <g key={`grid-${idx}`}>
                    <path
                      d={d}
                      fill="none"
                      stroke="rgba(9, 9, 11, 0.68)"
                      strokeWidth={Math.max(3.6, width * 0.0055)}
                      strokeLinecap="round"
                    />
                    <path
                      d={d}
                      fill="none"
                      stroke="#60a5fa"
                      strokeWidth={Math.max(1.8, width * 0.0028)}
                      strokeLinecap="round"
                    />
                  </g>
                ))}

                {/* Mesh Draggable Nodes (9 or 16) */}
                {warpOverlay.nodePx.map((pt, idx) => {
                  const r = Math.max(8, width * 0.013);
                  return (
                    <g key={`mesh-${idx}`}>
                      <circle
                        cx={pt.x}
                        cy={pt.y}
                        r={r + Math.max(2.5, width * 0.004)}
                        fill="rgba(9, 9, 11, 0.45)"
                      />
                      <circle
                        cx={pt.x}
                        cy={pt.y}
                        r={r}
                        fill="#3b82f6"
                        stroke="#ffffff"
                        strokeWidth={Math.max(2, width * 0.0032)}
                      />
                    </g>
                  );
                })}
              </g>
            )}
          </svg>
        )}

        {((chromaKeyPickerActive &&
          activeSelectedClip &&
          (activeSelectedClip.kind === 'image' ||
            activeSelectedClip.kind === 'video')) ||
          colorPickerActive) && (
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
              {/* Floating color loupe badge above crosshair while dragging */}
              {draggingPicker && (
                <div className="pointer-events-none absolute left-1/2 bottom-full mb-2 flex -translate-x-1/2 -translate-y-full justify-center">
                  <div
                    className="h-8 w-8 rounded-full border-2 border-white shadow-lg ring-2 ring-black/60"
                    style={{
                      backgroundColor: colorPickerActive
                        ? colorPickerPreviewHex || '#ffffff'
                        : activeSelectedClip?.chromaKeyColor || '#00ff00',
                    }}
                  />
                </div>
              )}

              {/* Eyedropper Crosshair Ring */}
              <div
                className="relative flex h-11 w-11 items-center justify-center rounded-full border-2 border-white shadow-[0_0_0_2px_rgba(0,0,0,0.75)]"
                style={{
                  boxShadow: `0 0 0 2px rgba(0,0,0,0.75), inset 0 0 0 3px ${
                    colorPickerActive
                      ? colorPickerPreviewHex || '#ffffff'
                      : activeSelectedClip?.chromaKeyColor || '#00ff00'
                  }`,
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
    </div>
  );
};
