import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  ChevronLeft,
  ChevronsUpDown,
  CopyPlus,
  Crop,
  Diamond,
  Download,
  Droplet,
  FlipHorizontal2,
  Gauge,
  Grid3X3,
  Home,
  ImagePlus,
  Layers,
  MessageSquare,
  Minimize2,
  Move,
  Music,
  PaintBucket,
  Palette,
  Pause,
  Pipette,
  Play,
  Plus,
  Radio,
  Redo2,
  RefreshCw,
  RotateCcw,
  Scissors,
  Settings,
  Shapes,
  Sliders,
  Sparkles,
  Spline,
  Trash2,
  Type,
  Undo2,
  Wifi,
} from 'lucide-react';
import {
  createDefaultTracks,
  createStarterClips,
  getProjectDuration,
} from './shared/types.ts';
import type {
  AspectRatio,
  Clip,
  ClipMask,
  ClipWarp,
  ColorFilterPreset,
  ShapeType,
  TextCurvePoint,
} from './shared/types.ts';
import {StudioAudioEngine} from './lib/audioEngine.ts';
import {getCustomColorPresets} from './lib/colorPresets.ts';
import {
  evaluateClipTransform,
  upsertKeyframeAtTime,
} from './lib/keyframeEngine.ts';
import {
  fetchServerStorageConfig,
  getNativeStorageConfig,
  uploadFileForP2P,
} from './lib/lanSyncBridge.ts';
import type {CompressedMediaResult} from './lib/lanSyncBridge.ts';
import {getClientStorageSummary} from './lib/mediaStorage.ts';
import {
  getLocalProjects,
  removeLocalProject,
  upsertLocalProject,
} from './lib/localProjects.ts';
import type {LocalProjectRecord} from './lib/localProjects.ts';
import {
  EXPORT_FORMAT_OPTIONS,
  EXPORT_FPS_OPTIONS,
  EXPORT_RESOLUTION_OPTIONS,
  exportProjectToVideo,
  getExportDimensions,
  MAX_ANIMATED_IMAGE_FRAMES,
} from './lib/exportEngine.ts';
import type {
  ExportFormat,
  ExportFps,
  ExportQuality,
  ExportResolution,
} from './lib/exportEngine.ts';
import {MediaPool} from './lib/renderEngine.ts';
import {getApiUrl, isNativeCapacitorApp} from './lib/serverConfig.ts';
import {
  colorToHex,
  createDefaultCurvePoints,
  measureBaseTextHalfWidth,
  normalizeTextStyle,
} from './lib/textRenderer.ts';
import {getDefaultShapeStyle, getShapeCatalogItem} from './lib/shapeEngine.ts';
import {
  createDefaultWarp,
  isIdentityWarp,
  normalizeWarp,
} from './lib/warpEngine.ts';
import {
  hasExplicitRoomInUrl,
  useCollaborativeRoom,
} from './hooks/useCollaborativeRoom.ts';
import {AudioPanel} from './components/AudioPanel.tsx';
import {AppSettingsModal} from './components/AppSettingsModal.tsx';
import {AIModelManagerModal} from './components/AIModelManagerModal.tsx';
import './lib/webcutAi.ts';
import {ChromaKeyPanel} from './components/ChromaKeyPanel.tsx';
import {ColorAdjustPanel} from './components/ColorAdjustPanel.tsx';
import {CropEditorModal} from './components/CropEditorModal.tsx';
import {FilterStripPanel} from './components/FilterStripPanel.tsx';
import {HomeScreen} from './components/HomeScreen.tsx';
import {MaskPanel} from './components/MaskPanel.tsx';
import {PreviewCanvas} from './components/PreviewCanvas.tsx';
import type {CanvasTransformPatch} from './components/PreviewCanvas.tsx';
import {ProjectSettingsPanel} from './components/ProjectSettingsPanel.tsx';
import {ScrubNumberField} from './components/ScrubNumberField.tsx';
import {ShapesPanel} from './components/ShapesPanel.tsx';
import {StickersSheet} from './components/StickersSheet.tsx';
import {Timeline} from './components/Timeline.tsx';
import {TransformPanel} from './components/TransformPanel.tsx';
import type {ClipTransformPatch} from './components/TransformPanel.tsx';
import {TransformTrackpad} from './components/TransformTrackpad.tsx';
import {VoiceRecorderOverlay} from './components/VoiceRecorderOverlay.tsx';
import {RoomsLobbyModal} from './components/RoomsLobbyModal.tsx';
import {
  BottomSheet,
  CompressMediaModal,
  EffectsPanel,
  KeyframeControls,
  OverlayPanel,
  TeamPanel,
  TOOL_TABS,
  TextPanel,
} from './components/ToolSheets.tsx';
import type {ActiveToolTab, TextColorField} from './components/ToolSheets.tsx';
import {
  OfflineIndicator,
  PWAInstallButton,
} from './components/PWAInstallButton.tsx';

function formatTimecode(sec: number): string {
  const clamped = Math.max(0, sec);
  const mins = Math.floor(clamped / 60);
  const secs = Math.floor(clamped % 60);
  const tenths = Math.floor((clamped % 1) * 10);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${tenths}`;
}

export default function App() {
  const {
    user,
    roomId,
    serverUrl,
    p2pMode,
    networkInterfaces,
    hostPort,
    udpRooms,
    lockWarning,
    pingMs,
    ktorStatus,
    downloadQueue,
    status,
    project,
    collaborators,
    allCollaborators,
    availableRooms,
    canUndo,
    canRedo,
    addTrack,
    updateTrack,
    deleteTrack,
    reorderTracks,
    addClip,
    updateClip,
    deleteClip,
    splitClip,
    duplicateClip,
    moveClipTrackType,
    updateProjectMeta,
    addCustomFont,
    replaceClips,
    undo,
    redo,
    sendPresence,
    sendChatMessage,
    sendLayerMediaUpdated,
    sendLayerLock,
    forceSyncProject,
    retryMediaDownload,
    switchRoom,
    updateUserProfile,
    updateServerConnection,
    startHostRoom,
    stopHostRoom,
    connectToHostIp,
    refreshRooms,
    refreshNetworkInfo,
  } = useCollaborativeRoom();

  const [screen, setScreen] = useState<'home' | 'editor'>(() =>
    hasExplicitRoomInUrl() ? 'editor' : 'home'
  );
  const [localProjects, setLocalProjects] = useState<LocalProjectRecord[]>(
    getLocalProjects
  );
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [pxPerSec, setPxPerSec] = useState(64);
  const [desktopTab, setDesktopTab] = useState<ActiveToolTab>('overlay');
  const [desktopOverlayView, setDesktopOverlayView] = useState<'media' | 'shapes'>('media');
  const [mobileSheet, setMobileSheet] = useState<
    ActiveToolTab | 'shapes' | null
  >(null);
  const [showOverlayChooser, setShowOverlayChooser] = useState(false);
  const [showOpacitySlider, setShowOpacitySlider] = useState(false);
  const [showChromaKeyPanel, setShowChromaKeyPanel] = useState(false);
  const [showTrackpad, setShowTrackpad] = useState(false);
  const [showVoiceRecorder, setShowVoiceRecorder] = useState(false);
  const [showCompressModal, setShowCompressModal] = useState(false);
  const [editSubMode, setEditSubMode] = useState<
    | 'menu'
    | 'transform'
    | 'shape'
    | 'opacity'
    | 'mask'
    | 'chromakey'
    | 'adjust'
    | 'filters'
    | 'keyframes'
  >('menu');
  const [mobileEditTool, setMobileEditTool] = useState<
    | 'transform'
    | 'shape'
    | 'mask'
    | 'adjust'
    | 'filters'
    | 'keyframes'
    | 'audio_speed'
    | 'audio_fx'
    | 'text'
    | null
  >(null);
  const overlayFileInputRef = useRef<HTMLInputElement | null>(null);
  const [textFocusTrigger, setTextFocusTrigger] = useState(0);
  const [textColorPicker, setTextColorPicker] = useState<{
    clipId: string;
    field: TextColorField;
  } | null>(null);
  const [bgColorPickerActive, setBgColorPickerActive] = useState(false);
  const [curveEditActive, setCurveEditActive] = useState(true);
  const [selectedCurvePointId, setSelectedCurvePointId] = useState<string | null>(
    null
  );
  const [showCropModal, setShowCropModal] = useState(false);
  const [customColorPresets, setCustomColorPresets] = useState<
    ColorFilterPreset[]
  >(getCustomColorPresets);
  const [noticeMsg, setNoticeMsg] = useState<string | null>(null);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [showSelectionOutline, setShowSelectionOutline] = useState(true);
  const [replacingMedia, setReplacingMedia] = useState(false);
  const [trackpadSnapGuides, setTrackpadSnapGuides] = useState<{
    x: boolean;
    y: boolean;
  }>({x: false, y: false});
  const studioRootRef = useRef<HTMLDivElement | null>(null);
  const previewBoxRef = useRef<HTMLDivElement | null>(null);
  const bottomPanelRef = useRef<HTMLDivElement | null>(null);
  const [viewportHeight, setViewportHeight] = useState<number>(() =>
    typeof window !== 'undefined' ? window.innerHeight : 800
  );
  const [customTimelineHeight, setCustomTimelineHeight] = useState<
    number | null
  >(() => {
    try {
      const raw = localStorage.getItem('cutsync_timeline_height');
      if (raw !== null) {
        const parsed = Number(raw);
        if (Number.isFinite(parsed) && parsed >= 120) {
          return Math.round(parsed);
        }
      }
    } catch {
      // ignore storage errors
    }
    return null;
  });
  const [isResizingTimeline, setIsResizingTimeline] = useState(false);
  const timelineResizeDragRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
    maxHeight: number;
    moved: boolean;
  } | null>(null);
  const [showLobbyModal, setShowLobbyModal] = useState(false);
  const [showStickersSheet, setShowStickersSheet] = useState(false);
  const [showAppSettings, setShowAppSettings] = useState(false);
  const [giphyKeyVersion, setGiphyKeyVersion] = useState(0);
  const [storageSummaryState, setStorageSummaryState] = useState<{
    label: string;
    isCustom: boolean;
  }>({
    label: 'По стандарту (корневая папка приложения)',
    isCustom: false,
  });

  const refreshStorageSummary = useCallback(async () => {
    try {
      if (isNativeCapacitorApp()) {
        const nativeCfg = await getNativeStorageConfig();
        if (nativeCfg) {
          setStorageSummaryState({
            label: nativeCfg.isDefault
              ? 'По стандарту (корень приложения)'
              : `${nativeCfg.displayName} (${nativeCfg.currentDir})`,
            isCustom: !nativeCfg.isDefault,
          });
          return;
        }
      }
      const [client, srv] = await Promise.all([
        getClientStorageSummary().catch(() => null),
        fetchServerStorageConfig().catch(() => null),
      ]);
      const clientCustom = Boolean(client && !client.isDefault);
      const srvCustom = Boolean(srv && !srv.isDefault);
      if (clientCustom && client) {
        setStorageSummaryState({
          label: `Устройство: ${client.folderName}${srvCustom && srv ? ` · Хост: ${srv.currentDir}` : ''}`,
          isCustom: true,
        });
      } else if (srvCustom && srv) {
        setStorageSummaryState({
          label: srv.currentDir,
          isCustom: true,
        });
      } else {
        setStorageSummaryState({
          label: srv?.currentDir
            ? `По стандарту (${srv.currentDir})`
            : 'По стандарту (корневая папка приложения)',
          isCustom: false,
        });
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void refreshStorageSummary();
  }, [refreshStorageSummary, serverUrl]);

  useEffect(() => {
    const onResize = () => {
      setViewportHeight(
        studioRootRef.current?.clientHeight || window.innerHeight
      );
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const maxSafeTimelineHeight = Math.max(180, viewportHeight - 210);
  const clampedCustomTimelineHeight =
    customTimelineHeight !== null
      ? Math.max(120, Math.min(maxSafeTimelineHeight, customTimelineHeight))
      : null;

  const handleTimelineResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const bottomEl = bottomPanelRef.current;
      if (!bottomEl) return;
      const startHeight = bottomEl.getBoundingClientRect().height;
      const previewHeight =
        previewBoxRef.current?.getBoundingClientRect().height ?? 240;
      const minTimelineHeight = 120;
      const minPreviewHeight = 96;
      const maxHeight = Math.max(
        minTimelineHeight + 40,
        Math.round(startHeight + previewHeight - minPreviewHeight)
      );
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      timelineResizeDragRef.current = {
        pointerId: e.pointerId,
        startY: e.clientY,
        startHeight,
        maxHeight,
        moved: false,
      };
      setIsResizingTimeline(true);
    },
    []
  );

  const handleTimelineResizePointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const drag = timelineResizeDragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      const dy = drag.startY - e.clientY;
      if (Math.abs(dy) > 2) drag.moved = true;
      const nextHeight = Math.round(
        Math.max(120, Math.min(drag.maxHeight, drag.startHeight + dy))
      );
      setCustomTimelineHeight(nextHeight);
    },
    []
  );

  const handleTimelineResizePointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const drag = timelineResizeDragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      timelineResizeDragRef.current = null;
      setIsResizingTimeline(false);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      if (drag.moved) {
        const finalH = Math.round(
          Math.max(
            120,
            Math.min(drag.maxHeight, drag.startHeight + (drag.startY - e.clientY))
          )
        );
        try {
          localStorage.setItem('cutsync_timeline_height', String(finalH));
        } catch {
          // ignore
        }
      }
    },
    []
  );

  const handleTimelineResizeReset = useCallback(() => {
    setCustomTimelineHeight(null);
    try {
      localStorage.removeItem('cutsync_timeline_height');
    } catch {
      // ignore
    }
  }, []);

  const handleTimelineResizeKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      const currentH =
        bottomPanelRef.current?.getBoundingClientRect().height ?? 240;
      const delta = e.key === 'ArrowUp' ? 24 : -24;
      const nextH = Math.round(
        Math.max(120, Math.min(maxSafeTimelineHeight, currentH + delta))
      );
      setCustomTimelineHeight(nextH);
      try {
        localStorage.setItem('cutsync_timeline_height', String(nextH));
      } catch {
        // ignore
      }
    },
    [maxSafeTimelineHeight]
  );
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(project.title);
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>('mp4');
  const [exportResolution, setExportResolution] =
    useState<ExportResolution>('1080p');
  const [exportFps, setExportFps] = useState<ExportFps>(30);
  const [exportQuality, setExportQuality] = useState<ExportQuality>('high');
  const [exportProgress, setExportProgress] = useState<number | null>(null);
  const [exportStage, setExportStage] = useState<string>('');
  const exportAbortRef = useRef<AbortController | null>(null);
  const [exportedUrl, setExportedUrl] = useState<{
    url: string;
    filename: string;
    ext: ExportFormat;
    width: number;
    height: number;
    fps: number;
  } | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const mediaPoolRef = useRef<MediaPool | null>(null);
  if (!mediaPoolRef.current) mediaPoolRef.current = new MediaPool();

  const audioEngineRef = useRef<StudioAudioEngine | null>(null);
  if (!audioEngineRef.current) audioEngineRef.current = new StudioAudioEngine();

  const duration = useMemo(
    () => getProjectDuration(project.clips),
    [project.clips]
  );

  const selectedClip = useMemo(
    () => project.clips.find((c) => c.id === selectedClipId) ?? null,
    [project.clips, selectedClipId]
  );

  const selectedClipRef = useRef(selectedClip);
  selectedClipRef.current = selectedClip;
  const projectRef = useRef(project);
  projectRef.current = project;
  const durationRef = useRef(duration);
  durationRef.current = duration;

  useEffect(() => {
    setTitleDraft(project.title);
  }, [project.title]);

  useEffect(() => {
    if (selectedClipId && !project.clips.some((c) => c.id === selectedClipId)) {
      setSelectedClipId(null);
    }
  }, [project.clips, selectedClipId]);

  const selectedClipIdValue = selectedClip?.id ?? null;
  const selectedClipTrackValue = selectedClip?.track ?? null;
  const selectedClipKindValue = selectedClip?.kind ?? null;
  const selectedClipCurvePoints = selectedClip?.textStyle?.curvePoints;

  useEffect(() => {
    const clip = selectedClipRef.current;
    if (!clip || !selectedClipIdValue) {
      setShowOpacitySlider(false);
      setShowChromaKeyPanel(false);
      setShowTrackpad(false);
      setShowCompressModal(false);
      setShowCropModal(false);
      setTrackpadSnapGuides({x: false, y: false});
      setMobileEditTool(null);
      setTextColorPicker(null);
      setSelectedCurvePointId(null);
      setEditSubMode('menu');
      return;
    }

    setTextColorPicker((cur) =>
      cur && cur.clipId === clip.id && clip.track === 'text' ? cur : null
    );

    if (clip.track === 'audio') {
      setShowOpacitySlider(false);
      setShowTrackpad(false);
      setTrackpadSnapGuides({x: false, y: false});
      setMobileEditTool((cur) =>
        cur === 'audio_speed' || cur === 'audio_fx' ? cur : null
      );
      setEditSubMode('menu');
      return;
    }

    if (clip.track === 'adjustment' || clip.kind === 'adjustment') {
      setShowChromaKeyPanel(false);
      setShowCompressModal(false);
      setShowCropModal(false);
      setShowTrackpad(false);
      setTrackpadSnapGuides({x: false, y: false});
      setMobileEditTool((cur) =>
        cur === 'adjust' || cur === 'filters' || cur === 'keyframes'
          ? cur
          : null
      );
      setEditSubMode((cur) =>
        cur === 'opacity' ||
        cur === 'adjust' ||
        cur === 'filters' ||
        cur === 'keyframes'
          ? cur
          : 'menu'
      );
      return;
    }

    if (clip.kind !== 'image' && clip.kind !== 'video') {
      setShowChromaKeyPanel(false);
      setShowCompressModal(false);
      setShowCropModal(false);
      setMobileEditTool((cur) =>
        cur === 'transform' ||
        cur === 'mask' ||
        cur === 'adjust' ||
        cur === 'filters' ||
        cur === 'keyframes' ||
        (cur === 'shape' && clip.kind === 'shape') ||
        cur === 'audio_speed' ||
        cur === 'audio_fx' ||
        (cur === 'text' && clip.track === 'text')
          ? cur
          : null
      );
      setEditSubMode((cur) =>
        cur === 'transform' ||
        cur === 'mask' ||
        cur === 'adjust' ||
        cur === 'filters' ||
        cur === 'opacity' ||
        cur === 'keyframes' ||
        (cur === 'shape' && clip.kind === 'shape')
          ? cur
          : 'menu'
      );
    }
  }, [selectedClipIdValue, selectedClipTrackValue, selectedClipKindValue]);

  useEffect(() => {
    if (selectedClipTrackValue !== 'text') {
      setSelectedCurvePointId(null);
      return;
    }
    const pts = selectedClipCurvePoints ?? [];
    setSelectedCurvePointId((cur) => {
      if (cur && pts.some((p) => p.id === cur)) return cur;
      return pts[0]?.id ?? null;
    });
  }, [selectedClipIdValue, selectedClipTrackValue, selectedClipCurvePoints]);

  useEffect(() => {
    if (screen !== 'editor') {
      setLocalProjects(getLocalProjects());
      return;
    }
    const flushSave = () => {
      const p = projectRef.current;
      return upsertLocalProject({
        roomId: p.roomId || roomId,
        title: p.title,
        aspectRatio: p.aspectRatio,
        backgroundColor: p.backgroundColor || '#09090b',
        canvasBackground: p.canvasBackground,
        updatedAt: Date.now(),
        clipsCount: p.clips.length,
        tracksCount: p.tracks.length,
        snapshot: {
          tracks: p.tracks,
          clips: p.clips,
          customFonts: p.customFonts,
        },
      });
    };
    const timer = setTimeout(() => {
      flushSave();
    }, 1200);
    window.addEventListener('beforeunload', flushSave);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('beforeunload', flushSave);
      flushSave();
    };
  }, [screen, project, roomId]);

  useEffect(() => {
    sendPresence(currentTime, selectedClipId, isPlaying);
  }, [currentTime, selectedClipId, isPlaying, sendPresence]);

  useEffect(() => {
    if (!isPlaying) {
      audioEngineRef.current?.stopAll();
      return;
    }

    let lastTs = performance.now();
    let raf = 0;

    const tick = (now: number) => {
      const dt = (now - lastTs) / 1000;
      lastTs = now;
      setCurrentTime((prev) => {
        const next = prev + dt;
        if (next >= durationRef.current) {
          setIsPlaying(false);
          return 0;
        }
        const curProject = projectRef.current;
        audioEngineRef.current?.sync(
          curProject.clips,
          next,
          true,
          curProject.tracks
        );
        return next;
      });
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      audioEngineRef.current?.stopAll();
    };
  }, [isPlaying]);

  const handleSeek = useCallback(
    (time: number) => {
      const clamped = Math.max(0, Math.min(durationRef.current, time));
      setCurrentTime(clamped);
      const curProject = projectRef.current;
      audioEngineRef.current?.sync(
        curProject.clips,
        clamped,
        isPlaying,
        curProject.tracks
      );
    },
    [isPlaying]
  );

  const handleSplitSelectedOrCurrent = useCallback(() => {
    const target =
      selectedClip ??
      project.clips.find(
        (c) =>
          c.track === 'video' &&
          currentTime > c.start + 0.15 &&
          currentTime < c.start + c.duration - 0.15
      );
    if (!target) return;
    const newId = splitClip(target.id, currentTime);
    if (newId) setSelectedClipId(newId);
  }, [selectedClip, project.clips, currentTime, splitClip]);

  const handleDuplicateSelected = useCallback(() => {
    if (!selectedClip) return;
    const newId = duplicateClip(selectedClip.id);
    if (newId) setSelectedClipId(newId);
  }, [selectedClip, duplicateClip]);

  const showTransientNotice = useCallback((msg: string) => {
    setNoticeMsg(msg);
    setTimeout(() => {
      setNoticeMsg((cur) => (cur === msg ? null : cur));
    }, 2000);
  }, []);

  const handleOpenEditTab = useCallback(() => {
    if (selectedClipId) return;
    const hiddenIds = new Set(
      project.tracks.filter((t) => t.hidden).map((t) => t.id)
    );
    const trackRank = new Map(project.tracks.map((t, i) => [t.id, i]));
    const atPlayhead = project.clips
      .filter(
        (c) =>
          currentTime >= c.start - 0.01 &&
          currentTime <= c.start + c.duration + 0.01
      )
      .sort((a, b) => {
        const aHidden = hiddenIds.has(a.trackId) ? 1 : 0;
        const bHidden = hiddenIds.has(b.trackId) ? 1 : 0;
        if (aHidden !== bHidden) return aHidden - bHidden;
        return (trackRank.get(a.trackId) ?? 999) - (trackRank.get(b.trackId) ?? 999);
      });

    const target =
      atPlayhead.find((c) => c.track === 'video' && !hiddenIds.has(c.trackId)) ??
      atPlayhead[0] ??
      null;

    if (target) {
      setSelectedClipId(target.id);
    } else if (project.clips.length === 0) {
      setMobileSheet('overlay');
    } else {
      showTransientNotice('Под белой линией времени нет клипа');
    }
  }, [
    selectedClipId,
    project.tracks,
    project.clips,
    currentTime,
    showTransientNotice,
  ]);

  const handleCycleSpeed = useCallback(() => {
    if (!selectedClip) return;
    const speeds = [0.5, 1, 1.25, 1.5, 2];
    const idx = speeds.indexOf(selectedClip.speed);
    const nextSpeed = speeds[(idx + 1) % speeds.length];
    const ratio = selectedClip.speed / nextSpeed;
    updateClip(selectedClip.id, {
      speed: nextSpeed,
      duration: Math.max(
        0.4,
        Math.round(selectedClip.duration * ratio * 100) / 100
      ),
    });
  }, [selectedClip, updateClip]);

  useEffect(() => {
    if (screen !== 'editor') return;
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if (e.code === 'Space') {
        e.preventDefault();
        setIsPlaying((p) => !p);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedClipId) {
          e.preventDefault();
          deleteClip(selectedClipId);
          setSelectedClipId(null);
        }
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (e.key.toLowerCase() === 's' && !e.metaKey && !e.ctrlKey) {
        handleSplitSelectedOrCurrent();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    screen,
    selectedClipId,
    deleteClip,
    undo,
    redo,
    handleSplitSelectedOrCurrent,
  ]);

  const handleAddMediaClip = useCallback(
    (opts: {
      name: string;
      kind: 'video' | 'image';
      src: string;
      fileName?: string;
      remoteUrl?: string;
      fileSize?: number;
      fileHash?: string;
      duration: number;
      track: 'video' | 'overlay';
      forceNewTrack?: boolean;
      minTrackIndex?: number;
      isSticker?: boolean;
    }) => {
      const sameTrack = project.clips.filter((c) => c.track === opts.track);
      const trackEnd = sameTrack.reduce(
        (acc, c) => Math.max(acc, c.start + c.duration),
        0
      );
      const start =
        opts.track === 'video' && !opts.forceNewTrack
          ? Math.round(trackEnd * 100) / 100
          : Math.round(currentTime * 100) / 100;

      const isSticker = Boolean(opts.isSticker);
      const hasRemoteMedia = Boolean(opts.remoteUrl);
      const {clip, newTrack, insertAt} = addClip(
        {
          id: `clip-${Math.random().toString(36).slice(2, 9)}`,
          track: opts.track,
          kind: opts.kind,
          name: opts.name,
          src: opts.src,
          isSticker: isSticker || undefined,
          mediaFileName: opts.fileName,
          mediaRemoteUrl: opts.remoteUrl,
          mediaFileSize: opts.fileSize,
          mediaFileHash: opts.fileHash,
          mediaStatus: 'READY',
          downloadProgress: 100,
          start,
          duration: opts.duration,
          trimStart: 0,
          sourceDuration: opts.kind === 'image' ? 60 : opts.duration,
          speed: 1,
          volume: opts.kind === 'video' ? 1 : 0,
          opacity: 1,
          filter: 'none',
          brightness: 1,
          contrast: 1,
          saturate: 1,
          transitionIn: 'none',
          motionEffect: 'none',
          mediaScale: isSticker ? 0.36 : opts.track === 'overlay' ? 0.55 : 1,
          mediaX: 0.5,
          mediaY: 0.5,
          rotation: 0,
          borderRadius: 0,
          blendMode: 'source-over',
        },
        {
          forceNewTrack: opts.forceNewTrack,
          minTrackIndex: opts.minTrackIndex,
          skipWs: hasRemoteMedia,
        }
      );

      if (hasRemoteMedia && opts.remoteUrl) {
        sendLayerMediaUpdated({
          layerId: clip.id,
          fileName: opts.fileName || opts.name,
          mediaUrl: opts.remoteUrl,
          localSrc: opts.src,
          fileSize: opts.fileSize,
          fileHash: opts.fileHash,
          clip,
          newTrack,
          insertAt,
        });
      }

      setSelectedClipId(clip.id);
      setCurrentTime(start);
    },
    [project.clips, currentTime, addClip, sendLayerMediaUpdated]
  );

  const handleOverlayPickerChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;

      const selectedTrackIdx =
        selectedClip && selectedClip.track !== 'audio'
          ? project.tracks.findIndex((t) => t.id === selectedClip.trackId)
          : -1;

      try {
        for (const file of Array.from(files)) {
          const isVideo =
            file.type.startsWith('video/') ||
            /\.(mp4|mov|webm|mkv|avi|m4v|3gp)$/i.test(file.name);
          const fallbackKind = isVideo ? 'video' : 'image';
          const prepared = await uploadFileForP2P(
            file,
            fallbackKind,
            (pct) => {
              if (pct < 100) showTransientNotice(`Загрузка файла: ${pct}%`);
            }
          );
          const mediaKind = prepared.kind === 'video' ? 'video' : 'image';
          let dur = 4.5;
          if (mediaKind === 'video') {
            dur = await new Promise<number>((resolve) => {
              const v = document.createElement('video');
              v.preload = 'metadata';
              v.onloadedmetadata = () => {
                resolve(
                  Number.isFinite(v.duration) && v.duration > 0
                    ? Math.min(1800, Math.round(v.duration * 10) / 10)
                    : 5
                );
              };
              v.onerror = () => resolve(5);
              v.src = prepared.localSrc;
            });
          }
          handleAddMediaClip({
            name: prepared.name,
            kind: mediaKind,
            src: prepared.localSrc,
            fileName: prepared.fileName,
            remoteUrl: prepared.shareUrl,
            fileSize: prepared.fileSize,
            fileHash: prepared.fileHash,
            duration: dur,
            track: 'overlay',
            forceNewTrack: false,
            minTrackIndex: selectedTrackIdx,
          });
        }
        setMobileSheet(null);
        setShowTrackpad(false);
        setShowOpacitySlider(false);
        setShowChromaKeyPanel(false);
        setMobileEditTool(null);
        setDesktopTab('edit');
        setEditSubMode('menu');
        showTransientNotice('Наложение добавлено — доступны все инструменты');
      } catch (err) {
        showTransientNotice(
          err instanceof Error ? err.message : 'Не удалось добавить наложение'
        );
      } finally {
        e.target.value = '';
      }
    },
    [selectedClip, project.tracks, handleAddMediaClip, showTransientNotice]
  );

  const handleAddShapeClip = useCallback(
    (shapeType: ShapeType) => {
      const start = Math.round(currentTime * 100) / 100;
      const meta = getShapeCatalogItem(shapeType);
      const selectedTrackIdx =
        selectedClip && selectedClip.track !== 'audio'
          ? project.tracks.findIndex((t) => t.id === selectedClip.trackId)
          : -1;

      const {clip} = addClip(
        {
          id: `clip-${Math.random().toString(36).slice(2, 9)}`,
          track: 'overlay',
          kind: 'shape',
          name: meta.label,
          start,
          duration: 4.5,
          trimStart: 0,
          sourceDuration: 3600,
          speed: 1,
          volume: 0,
          opacity: 1,
          filter: 'none',
          brightness: 1,
          contrast: 1,
          saturate: 1,
          transitionIn: 'none',
          motionEffect: 'none',
          mediaScale: shapeType === 'line' ? 0.62 : 0.42,
          mediaX: 0.5,
          mediaY: 0.5,
          rotation: 0,
          blendMode: 'source-over',
          shapeStyle: getDefaultShapeStyle(shapeType),
        },
        {forceNewTrack: false, minTrackIndex: selectedTrackIdx}
      );

      setSelectedClipId(clip.id);
      setMobileSheet(null);
      setShowOverlayChooser(false);
      setShowTrackpad(false);
      setShowOpacitySlider(false);
      setShowChromaKeyPanel(false);
      setDesktopTab('edit');
      setEditSubMode('shape');
      setMobileEditTool('shape');
      showTransientNotice(`Фигура «${meta.label}» добавлена`);
    },
    [
      currentTime,
      selectedClip,
      project.tracks,
      addClip,
      showTransientNotice,
    ]
  );

  const handleToggleAdjustmentMask = useCallback(
    (clip: Clip) => {
      const next = !clip.adjustmentMask;
      updateClip(clip.id, {adjustmentMask: next});
      if (next) {
        showTransientNotice(
          'Корр. маска включена — настройте размытие, цвет или инверсию в «Настроить»'
        );
      } else {
        showTransientNotice('Корректирующая маска отключена');
      }
    },
    [updateClip, showTransientNotice]
  );

  const handleUpdateClipWarp = useCallback(
    (clipId: string, warp: ClipWarp, commit: boolean) => {
      const target = projectRef.current.clips.find((c) => c.id === clipId);
      if (!target) return;
      if (target.keyframes && target.keyframes.length > 0) {
        const {keyframes} = upsertKeyframeAtTime(target, currentTime, {warp});
        updateClip(clipId, {keyframes}, {skipUndo: !commit});
        return;
      }
      updateClip(clipId, {warp}, {skipUndo: !commit});
    },
    [currentTime, updateClip]
  );

  const handleAddAdjustmentLayer = useCallback(() => {
    const start = Math.round(currentTime * 100) / 100;
    const {clip} = addClip(
      {
        id: `clip-${Math.random().toString(36).slice(2, 9)}`,
        track: 'adjustment',
        kind: 'adjustment',
        name: 'Корр. слой',
        start,
        duration: 3.0,
        trimStart: 0,
        sourceDuration: 3600,
        speed: 1,
        volume: 0,
        opacity: 1,
        filter: 'none',
        brightness: 1,
        contrast: 1,
        saturate: 1,
        transitionIn: 'none',
        motionEffect: 'none',
      },
      {forceNewTrack: false}
    );
    setSelectedClipId(clip.id);
    setMobileSheet(null);
    setShowTrackpad(false);
    setShowOpacitySlider(false);
    setShowChromaKeyPanel(false);
    setDesktopTab('edit');
    setEditSubMode('adjust');
    setMobileEditTool('adjust');
    showTransientNotice('Корректирующий слой (3с) добавлен');
  }, [currentTime, addClip, showTransientNotice]);

  const handleOpenStickers = useCallback(() => {
    setMobileSheet(null);
    setMobileEditTool(null);
    setShowStickersSheet(true);
  }, []);

  const handleReplaceClipMedia = useCallback(
    async (clipId: string, file: File) => {
      const target = project.clips.find((c) => c.id === clipId);
      if (!target) return;
      if (target.lockedByUserId && target.lockedByUserId !== user.id) return;

      setReplacingMedia(true);
      try {
        const isVideo =
          file.type.startsWith('video/') ||
          /\.(mp4|mov|webm|mkv|avi|m4v|3gp)$/i.test(file.name);
        const fallbackKind = isVideo ? 'video' : 'image';
        const prepared = await uploadFileForP2P(file, fallbackKind, (pct) => {
          if (pct < 100) showTransientNotice(`Загрузка файла: ${pct}%`);
        });
        const mediaKind = prepared.kind === 'video' ? 'video' : 'image';

        let probedDuration = target.duration;
        if (mediaKind === 'video') {
          probedDuration = await new Promise<number>((resolve) => {
            const v = document.createElement('video');
            v.preload = 'metadata';
            v.onloadedmetadata = () => {
              resolve(
                Number.isFinite(v.duration) && v.duration > 0
                  ? Math.min(1800, Math.round(v.duration * 10) / 10)
                  : target.duration
              );
            };
            v.onerror = () => resolve(target.duration);
            v.src = prepared.localSrc;
          });
        }

        const updatedClip: Clip = {
          ...target,
          kind: mediaKind,
          name: prepared.name,
          src: prepared.localSrc,
          mediaFileName: prepared.fileName,
          mediaRemoteUrl: prepared.shareUrl,
          mediaFileSize: prepared.fileSize,
          mediaFileHash: prepared.fileHash,
          mediaError: undefined,
          mediaStatus: 'READY',
          downloadProgress: 100,
          trimStart: 0,
          sourceDuration: mediaKind === 'image' ? 60 : probedDuration,
          motionEffect: 'none',
          transitionIn: target.transitionIn === 'zoom' ? 'none' : target.transitionIn,
        };

        sendLayerMediaUpdated({
          layerId: target.id,
          fileName: prepared.fileName,
          mediaUrl: prepared.shareUrl,
          localSrc: prepared.localSrc,
          fileSize: prepared.fileSize,
          fileHash: prepared.fileHash,
          clip: updatedClip,
        });
      } finally {
        setReplacingMedia(false);
      }
    },
    [project.clips, user.id, sendLayerMediaUpdated]
  );

  const handleApplyCompressedMedia = useCallback(
    (clip: Clip, res: CompressedMediaResult) => {
      const updatedClip: Clip = {
        ...clip,
        src: res.localSrc,
        mediaFileName: res.fileName,
        mediaRemoteUrl: res.shareUrl,
        mediaFileSize: res.compressedSizeBytes,
        mediaStatus: 'READY',
        downloadProgress: 100,
      };
      sendLayerMediaUpdated({
        layerId: clip.id,
        fileName: res.fileName,
        mediaUrl: res.shareUrl,
        localSrc: res.localSrc,
        fileSize: res.compressedSizeBytes,
        clip: updatedClip,
      });
    },
    [sendLayerMediaUpdated]
  );

  const handleAddText = useCallback(
    (text: string, forceNewTrack = true) => {
      const cleanText = text.trim() ? text : 'НОВЫЙ ТЕКСТ';
      const {clip} = addClip(
        {
          id: `clip-${Math.random().toString(36).slice(2, 9)}`,
          track: 'text',
          kind: 'text',
          name: cleanText.replace(/\s+/g, ' ').slice(0, 18),
          start: Math.round(currentTime * 100) / 100,
          duration: 3.5,
          trimStart: 0,
          sourceDuration: 60,
          speed: 1,
          volume: 1,
          opacity: 1,
          filter: 'none',
          brightness: 1,
          contrast: 1,
          saturate: 1,
          transitionIn: 'none',
          motionEffect: 'none',
          text: cleanText,
          textStyle: {
            fontSize: 48,
            color: '#ffffff',
            bgColor: '#09090b',
            bgMode: 'block',
            bgOpacity: 0.72,
            fontWeight: 'bold',
            fontStyle: 'normal',
            underline: false,
            fontFamily: 'Plus Jakarta Sans',
            shadow: true,
            shadowColor: '#000000',
            shadowOffsetX: 0,
            shadowOffsetY: 4,
            shadowBlur: 10,
            outline: false,
            strokeColor: '#09090b',
            strokeWidth: 0,
            letterSpacing: 0,
            lineHeight: 1.25,
            spaceWidth: 1,
            curveMode: 'none',
            curveAmplitude: 0,
            curveFrequency: 2,
            x: 0.5,
            y: 0.75,
            align: 'center',
          },
        },
        {forceNewTrack}
      );
      setSelectedClipId(clip.id);
      setMobileSheet(null);
      setDesktopTab('text');
      setShowTrackpad(false);
      setShowOpacitySlider(false);
      setShowChromaKeyPanel(false);
      setMobileEditTool('text');
      setTextFocusTrigger((n) => n + 1);
    },
    [currentTime, addClip]
  );

  const handleDoubleClickTextClip = useCallback((clipId: string) => {
    setSelectedClipId(clipId);
    setDesktopTab('text');
    setMobileSheet(null);
    setShowTrackpad(false);
    setShowOpacitySlider(false);
    setShowChromaKeyPanel(false);
    setMobileEditTool('text');
    setTextFocusTrigger((n) => n + 1);
  }, []);

  const handlePickTextCanvasColor = useCallback(
    (hexColor: string, commit: boolean) => {
      if (!textColorPicker) return;
      const target = project.clips.find((c) => c.id === textColorPicker.clipId);
      if (!target || target.track !== 'text') return;
      const base = normalizeTextStyle(target.textStyle);
      const nextStyle: NonNullable<Clip['textStyle']> = {
        ...base,
        [textColorPicker.field]: hexColor,
      };
      if (textColorPicker.field === 'bgColor' && nextStyle.bgMode === 'none') {
        nextStyle.bgMode = 'block';
        if ((nextStyle.bgOpacity ?? 0) <= 0.05) nextStyle.bgOpacity = 0.75;
      } else if (
        textColorPicker.field === 'strokeColor' &&
        (nextStyle.strokeWidth ?? 0) <= 0
      ) {
        nextStyle.strokeWidth = 4;
        nextStyle.outline = true;
      } else if (textColorPicker.field === 'shadowColor') {
        nextStyle.shadow = true;
      }
      updateClip(target.id, {textStyle: nextStyle}, {skipUndo: !commit});
    },
    [textColorPicker, project.clips, updateClip]
  );

  const handlePickCanvasBackgroundColor = useCallback(
    (hexColor: string, commit: boolean) => {
      updateProjectMeta(
        {
          backgroundColor: hexColor,
          canvasBackground: {type: 'solid', color: hexColor},
        },
        {skipSync: !commit}
      );
    },
    [updateProjectMeta]
  );

  const handleUpdateCurvePoints = useCallback(
    (clipId: string, points: TextCurvePoint[], commit: boolean) => {
      const target = projectRef.current.clips.find((c) => c.id === clipId);
      if (!target || target.track !== 'text') return;
      const base = normalizeTextStyle(target.textStyle);
      const nextStyle: NonNullable<Clip['textStyle']> = {
        ...base,
        curveMode: 'custom',
        curvePoints: points,
      };
      updateClip(target.id, {textStyle: nextStyle}, {skipUndo: !commit});
    },
    [updateClip]
  );

  const handleAddAudioClip = useCallback(
    (opts: {
      name: string;
      kind: 'audio' | 'synth';
      src: string;
      fileName?: string;
      remoteUrl?: string;
      fileSize?: number;
      fileHash?: string;
      duration: number;
      startTime?: number;
      forceNewTrack?: boolean;
    }) => {
      const start = Math.max(
        0,
        Math.round((opts.startTime ?? currentTime) * 100) / 100
      );
      const hasRemote = Boolean(opts.remoteUrl);
      const {clip, newTrack, insertAt} = addClip(
        {
          id: `clip-${Math.random().toString(36).slice(2, 9)}`,
          track: 'audio',
          kind: opts.kind,
          name: opts.name,
          src: opts.src,
          mediaFileName: opts.fileName,
          mediaRemoteUrl: opts.remoteUrl,
          mediaFileSize: opts.fileSize,
          mediaFileHash: opts.fileHash,
          mediaStatus: 'READY',
          downloadProgress: 100,
          start,
          duration: opts.duration,
          trimStart: 0,
          sourceDuration: opts.kind === 'synth' ? 60 : opts.duration,
          speed: 1,
          pitch: 1,
          linkSpeedPitch: false,
          voiceEffect: 'original',
          volume: 0.85,
          opacity: 1,
          filter: 'none',
          brightness: 1,
          contrast: 1,
          saturate: 1,
          transitionIn: 'none',
          motionEffect: 'none',
        },
        {forceNewTrack: opts.forceNewTrack, skipWs: hasRemote}
      );

      if (hasRemote && opts.remoteUrl) {
        sendLayerMediaUpdated({
          layerId: clip.id,
          fileName: opts.fileName || opts.name,
          mediaUrl: opts.remoteUrl,
          localSrc: opts.src,
          fileSize: opts.fileSize,
          fileHash: opts.fileHash,
          clip,
          newTrack,
          insertAt,
        });
      }

      setSelectedClipId(clip.id);
    },
    [currentTime, addClip, sendLayerMediaUpdated]
  );

  const handleTransformClipOnCanvas = useCallback(
    (clipId: string, patch: CanvasTransformPatch, commit: boolean) => {
      const target = projectRef.current.clips.find((c) => c.id === clipId);
      if (!target) return;

      if (target.keyframes && target.keyframes.length > 0) {
        const {keyframes} = upsertKeyframeAtTime(target, currentTime, {
          x: patch.x,
          y: patch.y,
          ...(patch.scale !== undefined ? {scale: patch.scale} : {}),
          ...(patch.rotation !== undefined ? {rotation: patch.rotation} : {}),
        });
        updateClip(clipId, {keyframes}, {skipUndo: !commit});
        return;
      }

      if (target.track === 'text') {
        const baseStyle = target.textStyle ?? {
          fontSize: 48,
          color: '#ffffff',
          bgColor: 'rgba(9, 9, 11, 0.72)',
          fontWeight: 'bold' as const,
          x: 0.5,
          y: 0.75,
          align: 'center' as const,
        };
        updateClip(
          clipId,
          {
            textStyle: {...baseStyle, x: patch.x, y: patch.y},
            ...(patch.scale !== undefined ? {mediaScale: patch.scale} : {}),
            ...(patch.rotation !== undefined ? {rotation: patch.rotation} : {}),
          },
          {skipUndo: !commit}
        );
      } else {
        updateClip(
          clipId,
          {
            mediaX: patch.x,
            mediaY: patch.y,
            ...(patch.scale !== undefined ? {mediaScale: patch.scale} : {}),
            ...(patch.rotation !== undefined ? {rotation: patch.rotation} : {}),
          },
          {skipUndo: !commit}
        );
      }
    },
    [currentTime, updateClip]
  );

  const handleUpdateClipTransformFields = useCallback(
    (
      clipId: string,
      patch: ClipTransformPatch,
      opts?: {skipUndo?: boolean; skipSync?: boolean}
    ) => {
      const target = projectRef.current.clips.find((c) => c.id === clipId);
      if (!target) return;

      if (target.keyframes && target.keyframes.length > 0) {
        const {keyframes} = upsertKeyframeAtTime(target, currentTime, patch);
        updateClip(clipId, {keyframes}, opts);
        return;
      }

      const clipPatch: Partial<Clip> = {};
      if (patch.scaleX !== undefined) clipPatch.scaleX = patch.scaleX;
      if (patch.scaleY !== undefined) clipPatch.scaleY = patch.scaleY;
      if (patch.flipHorizontal !== undefined) {
        clipPatch.flipHorizontal = patch.flipHorizontal;
      }
      if (patch.flipVertical !== undefined) {
        clipPatch.flipVertical = patch.flipVertical;
      }
      if (patch.scale !== undefined) clipPatch.mediaScale = patch.scale;
      if (patch.rotation !== undefined) clipPatch.rotation = patch.rotation;
      if (patch.warp !== undefined) clipPatch.warp = patch.warp;
      if (patch.x !== undefined || patch.y !== undefined) {
        if (target.track === 'text') {
          const baseStyle = normalizeTextStyle(target.textStyle);
          clipPatch.textStyle = {
            ...baseStyle,
            ...(patch.x !== undefined ? {x: patch.x} : {}),
            ...(patch.y !== undefined ? {y: patch.y} : {}),
          };
        } else {
          if (patch.x !== undefined) clipPatch.mediaX = patch.x;
          if (patch.y !== undefined) clipPatch.mediaY = patch.y;
        }
      }
      updateClip(clipId, clipPatch, opts);
    },
    [currentTime, updateClip]
  );

  const handleAddKeyframeAtPlayhead = useCallback(() => {
    if (!selectedClip || selectedClip.track === 'audio') return;
    const {keyframes} = upsertKeyframeAtTime(selectedClip, currentTime);
    updateClip(selectedClip.id, {keyframes});
  }, [selectedClip, currentTime, updateClip]);

  const handleChangeSelectedOpacity = useCallback(
    (nextOpacity: number, commit = true) => {
      if (!selectedClip || selectedClip.track === 'audio') return;
      const clamped = Math.max(0, Math.min(1, Math.round(nextOpacity * 100) / 100));
      if (selectedClip.keyframes && selectedClip.keyframes.length > 0) {
        const {keyframes} = upsertKeyframeAtTime(selectedClip, currentTime, {
          opacity: clamped,
        });
        updateClip(
          selectedClip.id,
          {keyframes},
          {skipUndo: !commit}
        );
        return;
      }
      updateClip(selectedClip.id, {opacity: clamped}, {skipUndo: !commit});
    },
    [selectedClip, currentTime, updateClip]
  );

  const handlePickChromaKeyColor = useCallback(
    (clipId: string, hexColor: string, commit: boolean) => {
      const target = projectRef.current.clips.find((c) => c.id === clipId);
      if (!target) return;
      updateClip(
        clipId,
        {
          chromaKeyEnabled: true,
          chromaKeyColor: hexColor,
          chromaKeyIntensity:
            target.chromaKeyIntensity && target.chromaKeyIntensity > 0
              ? target.chromaKeyIntensity
              : 0.35,
          chromaKeySmoothness: target.chromaKeySmoothness ?? 0.15,
        },
        {skipUndo: !commit}
      );
    },
    [updateClip]
  );

  const handleUpdateChromaKey = useCallback(
    (
      clipId: string,
      patch: Partial<
        Pick<
          Clip,
          | 'chromaKeyEnabled'
          | 'chromaKeyColor'
          | 'chromaKeyIntensity'
          | 'chromaKeySmoothness'
        >
      >,
      commit: boolean
    ) => {
      updateClip(clipId, patch, {skipUndo: !commit});
    },
    [updateClip]
  );

  const handleTransformMaskOnCanvas = useCallback(
    (clipId: string, patch: Partial<ClipMask>, commit: boolean) => {
      const target = projectRef.current.clips.find((c) => c.id === clipId);
      if (!target?.mask) return;
      updateClip(clipId, {mask: {...target.mask, ...patch}}, {skipUndo: !commit});
    },
    [updateClip]
  );

  const handleClipTransform = useCallback(
    (clipId: string, patch: Partial<Clip>, commit: boolean) => {
      updateClip(clipId, patch, {skipUndo: !commit});
    },
    [updateClip]
  );

  const handleCreateRoom = async (opts: {
    title: string;
    aspectRatio: AspectRatio;
    backgroundColor: string;
    blank: boolean;
    isPublicLan: boolean;
    hostName?: string;
  }) => {
    const endpoint = getApiUrl('/api/rooms');
    const localClips = opts.blank ? [] : createStarterClips();
    const localTracks = createDefaultTracks();

    if (opts.isPublicLan && (isNativeCapacitorApp() || !endpoint)) {
      const localId = `cut-${Math.random().toString(36).slice(2, 8)}`;
      await startHostRoom({
        roomId: localId,
        title: opts.title,
        aspectRatio: opts.aspectRatio,
        backgroundColor: opts.backgroundColor,
        tracks: localTracks,
        clips: localClips,
      });
      switchRoom(localId);
      setCurrentTime(0);
      setSelectedClipId(null);
      setScreen('editor');
      return;
    }

    if (!endpoint) {
      const localId = `cut-${Math.random().toString(36).slice(2, 8)}`;
      replaceClips(localClips, {
        title: opts.title,
        aspectRatio: opts.aspectRatio,
        backgroundColor: opts.backgroundColor,
        tracks: localTracks,
      });
      switchRoom(localId);
      setCurrentTime(0);
      setSelectedClipId(null);
      setScreen('editor');
      return;
    }
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          ...opts,
          hostName: opts.hostName ?? (opts.isPublicLan ? user.name : undefined),
        }),
      });
      const data = (await res.json()) as {roomId?: string};
      if (data.roomId) {
        switchRoom(data.roomId);
        setCurrentTime(0);
        setSelectedClipId(null);
        setScreen('editor');
        void refreshRooms();
      }
    } catch {
      const localId = `cut-${Math.random().toString(36).slice(2, 8)}`;
      if (opts.isPublicLan) {
        await startHostRoom({
          roomId: localId,
          title: opts.title,
          aspectRatio: opts.aspectRatio,
          backgroundColor: opts.backgroundColor,
          tracks: localTracks,
          clips: localClips,
        });
      } else {
        replaceClips(localClips, {
          title: opts.title,
          aspectRatio: opts.aspectRatio,
          backgroundColor: opts.backgroundColor,
          canvasBackground: {type: 'solid', color: opts.backgroundColor},
          tracks: localTracks,
        });
      }
      switchRoom(localId);
      setCurrentTime(0);
      setSelectedClipId(null);
      setScreen('editor');
    }
  };

  const handleOpenLocalProject = (record: LocalProjectRecord) => {
    if (record.snapshot) {
      replaceClips(record.snapshot.clips, {
        title: record.title,
        aspectRatio: record.aspectRatio,
        backgroundColor: record.backgroundColor,
        canvasBackground: record.canvasBackground,
        customFonts: record.snapshot.customFonts,
        tracks: record.snapshot.tracks,
      });
    }
    switchRoom(record.roomId);
    setCurrentTime(0);
    setSelectedClipId(null);
    setScreen('editor');
  };

  const handleExportVideo = async () => {
    if (project.clips.length === 0) return;
    setShowExportModal(false);
    setIsPlaying(false);
    setExportError(null);
    setExportStage('Подготовка экспорта...');
    if (exportedUrl?.url) {
      URL.revokeObjectURL(exportedUrl.url);
    }
    setExportedUrl(null);
    setExportProgress(1);

    const controller = new AbortController();
    exportAbortRef.current = controller;

    try {
      const result = await exportProjectToVideo({
        clips: project.clips,
        tracks: project.tracks,
        aspectRatio: project.aspectRatio,
        backgroundColor: project.backgroundColor,
        canvasBackground: project.canvasBackground,
        customFonts: project.customFonts,
        duration,
        currentTime,
        format: exportFormat,
        resolution: exportResolution,
        fps: exportFps,
        quality: exportQuality,
        pool: mediaPoolRef.current!,
        audioEngine: audioEngineRef.current!,
        onProgress: (pct) => setExportProgress(pct),
        onStage: (stage) => setExportStage(stage),
        signal: controller.signal,
      });

      const url = URL.createObjectURL(result.blob);
      const safeTitle =
        project.title.replace(/[^a-zA-Zа-яА-Я0-9_-]/g, '_') || 'CutSync';
      const filename = `${safeTitle}_${result.width}x${result.height}.${result.ext}`;
      setExportedUrl({
        url,
        filename,
        ext: result.ext,
        width: result.width,
        height: result.height,
        fps: result.fps,
      });

      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setExportProgress(null);
        setExportError(null);
        showTransientNotice('Экспорт отменён');
        return;
      }
      setExportError(
        err instanceof Error
          ? err.message
          : 'Браузер не поддерживает выбранный формат экспорта'
      );
    } finally {
      if (exportAbortRef.current === controller) {
        exportAbortRef.current = null;
      }
    }
  };

  const canSplitNow = Boolean(
    selectedClip
      ? currentTime > selectedClip.start + 0.15 &&
          currentTime < selectedClip.start + selectedClip.duration - 0.15
      : project.clips.some(
          (c) =>
            c.track === 'video' &&
            currentTime > c.start + 0.15 &&
            currentTime < c.start + c.duration - 0.15
        )
  );

  const hasKeyframeAtPlayhead = Boolean(
    selectedClip &&
      selectedClip.keyframes?.some(
        (k) => Math.abs(k.timeOffset - (currentTime - selectedClip.start)) <= 0.12
      )
  );

  const selectedEvaluatedTransform = selectedClip
    ? evaluateClipTransform(selectedClip, currentTime)
    : null;
  const selectedOpacityValue = selectedEvaluatedTransform
    ? selectedEvaluatedTransform.opacity
    : 1;
  const hasActiveTransformChanges = Boolean(
    selectedClip &&
      selectedEvaluatedTransform &&
      (selectedEvaluatedTransform.flipHorizontal ||
        selectedEvaluatedTransform.flipVertical ||
        Math.abs(selectedEvaluatedTransform.scaleX - 1) > 0.01 ||
        Math.abs(selectedEvaluatedTransform.scaleY - 1) > 0.01 ||
        !isIdentityWarp(selectedEvaluatedTransform.warp ?? selectedClip.warp))
  );

  const isMaskEditActive = Boolean(
    selectedClip &&
      selectedClip.track !== 'audio' &&
      selectedClip.track !== 'adjustment' &&
      selectedClip.kind !== 'adjustment' &&
      ((desktopTab === 'edit' && editSubMode === 'mask') ||
        mobileEditTool === 'mask')
  );

  const isWarpEditActive = Boolean(
    selectedClip &&
      selectedClip.track !== 'audio' &&
      selectedClip.track !== 'adjustment' &&
      selectedClip.kind !== 'adjustment' &&
      ((desktopTab === 'edit' && editSubMode === 'transform') ||
        mobileEditTool === 'transform')
  );

  const activeWarpState = useMemo(() => {
    if (!selectedClip) return null;
    const tr = evaluateClipTransform(selectedClip, currentTime);
    return normalizeWarp(tr.warp ?? selectedClip.warp);
  }, [selectedClip, currentTime]);

  const isChromaKeyPickerActive = Boolean(
    selectedClip &&
      (selectedClip.kind === 'image' || selectedClip.kind === 'video') &&
      !textColorPicker &&
      !bgColorPickerActive &&
      (showChromaKeyPanel ||
        (desktopTab === 'edit' && editSubMode === 'chromakey'))
  );

  const isTextColorPickerActive = Boolean(
    textColorPicker &&
      selectedClip &&
      selectedClip.id === textColorPicker.clipId &&
      selectedClip.track === 'text'
  );

  const isCurveEditOverlayActive = Boolean(
    curveEditActive &&
      selectedClip &&
      selectedClip.track === 'text' &&
      selectedClip.textStyle?.curveMode === 'custom' &&
      !isPlaying &&
      showSelectionOutline &&
      !isChromaKeyPickerActive &&
      !isTextColorPickerActive &&
      !bgColorPickerActive &&
      currentTime >= selectedClip.start &&
      currentTime < selectedClip.start + selectedClip.duration
  );

  const activeCurvePoints = useMemo<TextCurvePoint[]>(() => {
    if (
      !selectedClip ||
      selectedClip.track !== 'text' ||
      selectedClip.textStyle?.curveMode !== 'custom'
    ) {
      return [];
    }
    const pts = selectedClip.textStyle.curvePoints;
    if (pts && pts.length >= 2) return pts;
    return createDefaultCurvePoints(
      measureBaseTextHalfWidth(
        selectedClip.text ?? selectedClip.name ?? '',
        selectedClip.textStyle
      )
    );
  }, [selectedClip]);

  const textColorPickerHex = useMemo(() => {
    if (!isTextColorPickerActive || !selectedClip || !textColorPicker) {
      return '#ffffff';
    }
    const norm = normalizeTextStyle(selectedClip.textStyle);
    return colorToHex(norm[textColorPicker.field], '#ffffff');
  }, [isTextColorPickerActive, selectedClip, textColorPicker]);

  const textColorPickerFieldLabel =
    textColorPicker?.field === 'strokeColor'
      ? 'Цвет обводки'
      : textColorPicker?.field === 'shadowColor'
        ? 'Цвет тени'
        : textColorPicker?.field === 'bgColor'
          ? 'Цвет фона'
          : 'Цвет текста';

  if (screen === 'home') {
    return (
      <>
        <HomeScreen
          user={user}
          serverUrl={serverUrl}
          p2pMode={p2pMode}
          networkInterfaces={networkInterfaces}
          hostPort={hostPort}
          udpRooms={udpRooms}
          status={status}
          availableRooms={availableRooms}
          localProjects={localProjects}
          onCreateProject={async (opts) => {
            await handleCreateRoom({
              title: opts.title,
              aspectRatio: opts.aspectRatio,
              backgroundColor: opts.backgroundColor,
              blank: opts.blank,
              isPublicLan: opts.isTeamHost,
              hostName: opts.isTeamHost ? user.name : undefined,
            });
          }}
          onJoinTeamRoom={(nextRoomId) => {
            switchRoom(nextRoomId);
            setCurrentTime(0);
            setSelectedClipId(null);
            setScreen('editor');
          }}
          onOpenLocalProject={handleOpenLocalProject}
          onDeleteLocalProject={(id) => {
            setLocalProjects(removeLocalProject(id));
          }}
          onUpdateProfile={updateUserProfile}
          onConnectServer={updateServerConnection}
          onStartHost={startHostRoom}
          onStopHost={stopHostRoom}
          onConnectToHostIp={(ipOrUrl, nextRoomId) => {
            connectToHostIp(ipOrUrl, nextRoomId);
            if (nextRoomId) {
              setCurrentTime(0);
              setSelectedClipId(null);
              setScreen('editor');
            }
          }}
          onRefreshNetwork={() => {
            void refreshNetworkInfo();
          }}
          onRefreshRooms={() => {
            void refreshRooms();
          }}
          onOpenSettings={() => setShowAppSettings(true)}
          storageSummaryLabel={storageSummaryState.label}
          storageIsCustom={storageSummaryState.isCustom}
        />
        {showAppSettings && (
          <AppSettingsModal
            onClose={() => setShowAppSettings(false)}
            onKeyChanged={() => setGiphyKeyVersion((v) => v + 1)}
            onStorageChanged={() => void refreshStorageSummary()}
          />
        )}
        <OfflineIndicator />
      </>
    );
  }

  return (
    <div
      ref={studioRootRef}
      className="flex h-[100dvh] w-full flex-col overflow-hidden bg-[#09090b] text-zinc-100"
    >
      {/* Top Studio Header */}
      <header className="flex h-12 shrink-0 items-center justify-between gap-1.5 border-b border-white/10 bg-[#111114] px-2.5 sm:h-13 sm:gap-2 sm:px-4">
        {/* Left: Home Menu + Project Title */}
        <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
          <button
            type="button"
            onClick={() => {
              setIsPlaying(false);
              setScreen('home');
            }}
            aria-label="Главное меню"
            title="В главное меню"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-zinc-900 text-zinc-300 hover:border-cyan-400 hover:text-white active:scale-95"
          >
            <Home className="h-4 w-4" />
          </button>

          {editingTitle ? (
            <input
              type="text"
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => {
                setEditingTitle(false);
                if (titleDraft.trim()) {
                  updateProjectMeta({title: titleDraft.trim()});
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setEditingTitle(false);
                  if (titleDraft.trim()) {
                    updateProjectMeta({title: titleDraft.trim()});
                  }
                }
              }}
              className="h-8 w-24 rounded-md border border-cyan-400 bg-zinc-900 px-2 text-xs font-semibold text-white focus:outline-none sm:w-44 sm:text-sm"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditingTitle(true)}
              className="max-w-[84px] truncate text-left text-xs font-semibold text-white hover:text-cyan-300 sm:max-w-[190px] sm:text-sm"
              title="Нажмите, чтобы переименовать проект"
            >
              {project.title}
            </button>
          )}
        </div>

        {/* Center: Rooms Browser + Quick Team Chat Button */}
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => setShowLobbyModal(true)}
            className="flex h-8 items-center gap-1.5 rounded-lg border border-white/15 bg-zinc-900 px-2 hover:border-emerald-400/60 active:scale-95 sm:h-9 sm:px-2.5"
            title="Комнаты в локальной сети"
          >
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${
                p2pMode === 'host'
                  ? 'bg-emerald-400 animate-pulse'
                  : status === 'connected'
                    ? 'bg-emerald-400'
                    : status === 'offline'
                      ? 'bg-zinc-500'
                      : 'bg-amber-400 animate-pulse'
              }`}
            />
            <Wifi className="h-3.5 w-3.5 text-emerald-400" />
            <span className="text-[11px] font-medium text-zinc-200 whitespace-nowrap sm:text-xs">
              ({availableRooms.length + udpRooms.length})
            </span>
          </button>

          <button
            type="button"
            onClick={() => {
              setDesktopTab('team');
              setMobileSheet('team');
            }}
            className="flex h-8 items-center gap-1 rounded-lg border border-white/15 bg-zinc-900 px-2 text-[11px] font-medium text-zinc-200 hover:border-cyan-400/60 active:scale-95 sm:h-9 sm:px-2.5"
            title="Чат команды"
          >
            <MessageSquare className="h-3.5 w-3.5 text-cyan-400" />
            <span className="hidden sm:inline">Чат</span>
            {project.chat.length > 0 && (
              <span className="rounded bg-cyan-500/20 px-1 text-[10px] font-bold text-cyan-300">
                {project.chat.length}
              </span>
            )}
          </button>
        </div>

        {/* Right: PWA Install, Settings Shortcut, Export */}
        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          <PWAInstallButton />

          <button
            type="button"
            onClick={() => {
              setSelectedClipId(null);
              setDesktopTab('settings');
              setMobileSheet('settings');
            }}
            title="Настройки проекта, фона и API"
            aria-label="Настройки проекта"
            className={`flex h-8 w-8 items-center justify-center rounded-lg border transition active:scale-95 sm:h-9 sm:w-9 ${
              desktopTab === 'settings' || mobileSheet === 'settings'
                ? 'border-cyan-400 bg-cyan-500/15 text-cyan-300'
                : 'border-white/10 bg-zinc-900 text-zinc-300 hover:border-cyan-400 hover:text-white'
            }`}
          >
            <Settings className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={() => setShowExportModal(true)}
            disabled={project.clips.length === 0 || exportProgress !== null}
            className="flex h-8 items-center gap-1 rounded-lg bg-cyan-500 px-2.5 text-xs font-semibold text-zinc-950 hover:bg-cyan-400 disabled:opacity-45 active:scale-95 whitespace-nowrap sm:h-9 sm:px-3"
          >
            <Download className="h-3.5 w-3.5" />
            <span>Экспорт</span>
          </button>
        </div>
      </header>

      {/* Main Studio Body */}
      <div className="flex flex-1 min-h-0 flex-col lg:grid lg:grid-cols-[300px_1fr_272px] xl:grid-cols-[356px_1fr_308px]">
        {/* Desktop Left Sidebar */}
        <aside className="hidden border-r border-white/10 bg-[#111114] lg:flex lg:min-h-0 lg:flex-col">
          <div className="grid grid-cols-4 gap-1 border-b border-white/10 p-1.5">
            {TOOL_TABS.map((tab) => {
              const Icon = tab.icon;
              const active = desktopTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    if (tab.id === 'effects') {
                      handleAddAdjustmentLayer();
                      return;
                    }
                    if (tab.id === 'edit') {
                      handleOpenEditTab();
                    }
                    setDesktopTab(tab.id);
                  }}
                  className={`flex flex-col items-center justify-center gap-1 rounded-lg py-2 text-[10px] font-medium transition ${
                    active
                      ? 'bg-cyan-500/15 text-cyan-300'
                      : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  <span className="truncate max-w-full px-0.5">{tab.label}</span>
                </button>
              );
            })}
          </div>
          <div className="studio-scrollbar flex-1 overflow-y-auto p-4">
            {desktopTab === 'edit' && (
              <div className="space-y-3">
                {selectedClip ? (
                  <>
                    <div className="rounded-xl border border-white/10 bg-zinc-900/70 p-3">
                      <p className="truncate text-xs font-semibold text-white">
                        {selectedClip.name}
                      </p>
                      <p className="mt-0.5 text-[11px] text-zinc-400">
                        {selectedClip.track === 'video'
                          ? 'Основная видеодорожка'
                          : selectedClip.track === 'overlay'
                            ? 'Дорожка наложения'
                            : selectedClip.track === 'text'
                              ? 'Текстовый титр'
                              : selectedClip.track === 'adjustment'
                                ? 'Корректирующий слой (Эффект)'
                                : 'Аудиодорожка'}
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={handleSplitSelectedOrCurrent}
                        disabled={!canSplitNow}
                        className="flex h-11 min-w-0 items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-zinc-900 px-2.5 text-xs font-medium text-zinc-200 hover:border-cyan-400 disabled:opacity-35"
                      >
                        <Scissors className="h-4 w-4 shrink-0 text-cyan-400" />
                        <span className="truncate">Разделить</span>
                      </button>
                      <button
                        type="button"
                        onClick={handleDuplicateSelected}
                        className="flex h-11 min-w-0 items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-zinc-900 px-2.5 text-xs font-medium text-zinc-200 hover:border-cyan-400"
                      >
                        <CopyPlus className="h-4 w-4 shrink-0 text-cyan-400" />
                        <span className="truncate">Копия</span>
                      </button>
                      {(selectedClip.kind === 'image' ||
                        selectedClip.kind === 'video') && (
                        <label
                          className={`flex h-11 min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-zinc-900 px-2.5 text-xs font-medium text-zinc-200 hover:border-cyan-400 ${
                            replacingMedia ? 'opacity-50 pointer-events-none' : ''
                          }`}
                        >
                          <RefreshCw
                            className={`h-4 w-4 shrink-0 text-cyan-400 ${
                              replacingMedia ? 'animate-spin' : ''
                            }`}
                          />
                          <span className="truncate">Заменить</span>
                          <input
                            type="file"
                            accept="video/*,image/*"
                            disabled={replacingMedia}
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file && selectedClip) {
                                void handleReplaceClipMedia(
                                  selectedClip.id,
                                  file
                                );
                              }
                              e.target.value = '';
                            }}
                            className="hidden"
                          />
                        </label>
                      )}
                      {selectedClip.mediaStatus === 'ERROR' && (
                        <button
                          type="button"
                          onClick={() => retryMediaDownload(selectedClip.id)}
                          className="col-span-2 flex h-11 min-w-0 items-center justify-center gap-1.5 rounded-xl border border-rose-500/50 bg-rose-500/20 px-2.5 text-xs font-semibold text-rose-200 hover:bg-rose-500/30"
                        >
                          <RefreshCw className="h-4 w-4 shrink-0 text-rose-300" />
                          <span className="truncate">Перекачать файл P2P</span>
                        </button>
                      )}
                      {(selectedClip.track === 'video' ||
                        selectedClip.track === 'overlay') && (
                        <button
                          type="button"
                          onClick={() =>
                            moveClipTrackType(
                              selectedClip.id,
                              selectedClip.track === 'video'
                                ? 'overlay'
                                : 'video'
                            )
                          }
                          className="flex h-11 min-w-0 items-center justify-center gap-1.5 rounded-xl border border-indigo-500/35 bg-indigo-500/10 px-2.5 text-xs font-medium text-indigo-200 hover:border-indigo-400"
                        >
                          <Layers className="h-4 w-4 shrink-0 text-indigo-400" />
                          <span className="truncate">
                            {selectedClip.track === 'video'
                              ? 'Наложение'
                              : 'Основное'}
                          </span>
                        </button>
                      )}
                      {(selectedClip.kind === 'image' ||
                        selectedClip.kind === 'video') && (
                        <button
                          type="button"
                          onClick={() => setShowCompressModal(true)}
                          className="flex h-11 min-w-0 items-center justify-center gap-1.5 rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-2.5 text-xs font-medium text-emerald-200 hover:border-emerald-400"
                        >
                          <Minimize2 className="h-4 w-4 shrink-0 text-emerald-400" />
                          <span className="truncate">Сжать</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          deleteClip(selectedClip.id);
                          setSelectedClipId(null);
                        }}
                        className="flex h-11 min-w-0 items-center justify-center gap-1.5 rounded-xl border border-rose-500/30 bg-rose-500/10 px-2.5 text-xs font-medium text-rose-300 hover:border-rose-400"
                      >
                        <Trash2 className="h-4 w-4 shrink-0" />
                        <span className="truncate">Удалить</span>
                      </button>
                    </div>

                    {selectedClip.track !== 'audio' && (
                      <>
                        {editSubMode === 'menu' ? (
                          selectedClip.track === 'adjustment' ||
                          selectedClip.kind === 'adjustment' ? (
                            <div className="space-y-3 border-t border-white/10 pt-3">
                              <div className="rounded-xl border border-violet-400/35 bg-violet-500/10 p-2.5 text-[11px] text-violet-200">
                                Корректирующий слой действует на все слои выше него в таймлайне, не затрагивая слои ниже.
                              </div>
                              <div className="grid grid-cols-2 gap-2">
                                <button
                                  type="button"
                                  onClick={() => setEditSubMode('adjust')}
                                  className="flex h-16 flex-col items-center justify-center gap-1 rounded-xl border border-white/10 bg-zinc-900 px-2 text-[11px] font-medium text-zinc-200 hover:border-cyan-400"
                                >
                                  <Sliders className="h-4 w-4 text-cyan-400" />
                                  <span>Настроить</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditSubMode('filters')}
                                  className="flex h-16 flex-col items-center justify-center gap-1 rounded-xl border border-white/10 bg-zinc-900 px-2 text-[11px] font-medium text-zinc-200 hover:border-cyan-400"
                                >
                                  <Palette className="h-4 w-4 text-cyan-400" />
                                  <span>Фильтры</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditSubMode('opacity')}
                                  className={`flex h-16 flex-col items-center justify-center gap-1 rounded-xl border px-2 text-[11px] font-medium transition ${
                                    selectedOpacityValue < 0.99
                                      ? 'border-violet-400/60 bg-violet-500/15 text-violet-200'
                                      : 'border-white/10 bg-zinc-900 text-zinc-200 hover:border-violet-400'
                                  }`}
                                >
                                  <Droplet className="h-4 w-4 text-violet-400" />
                                  <span>
                                    Интенсивность {Math.round(selectedOpacityValue * 100)}%
                                  </span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditSubMode('keyframes')}
                                  className={`flex h-16 flex-col items-center justify-center gap-1 rounded-xl border px-2 text-[11px] font-medium transition ${
                                    (selectedClip.keyframes?.length ?? 0) > 0
                                      ? 'border-violet-400/60 bg-violet-500/15 text-violet-200'
                                      : 'border-white/10 bg-zinc-900 text-zinc-200 hover:border-violet-400'
                                  }`}
                                >
                                  <Diamond className="h-4 w-4 text-violet-400" />
                                  <span>
                                    Ключи ({selectedClip.keyframes?.length ?? 0})
                                  </span>
                                </button>
                              </div>
                            </div>
                          ) : (
                          <div className="space-y-3 border-t border-white/10 pt-3">
                            {/* Section 1: Geometry, Trackpad, Opacity */}
                            <div className="space-y-2">
                              <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                                Трансформация и трекпад
                              </p>
                              <div className="grid grid-cols-3 gap-2">
                                <button
                                  type="button"
                                  onClick={() => setEditSubMode('transform')}
                                  className={`flex h-16 flex-col items-center justify-center gap-1 rounded-xl border px-1.5 text-[11px] font-medium transition ${
                                    hasActiveTransformChanges
                                      ? 'border-cyan-400/60 bg-cyan-500/15 text-cyan-200'
                                      : 'border-white/10 bg-zinc-900 text-zinc-200 hover:border-cyan-400'
                                  }`}
                                >
                                  <FlipHorizontal2 className="h-4 w-4 text-cyan-400" />
                                  <span className="truncate max-w-full">
                                    Трансформ.
                                  </span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setShowTrackpad((v) => !v)}
                                  className={`flex h-16 flex-col items-center justify-center gap-1 rounded-xl border px-1.5 text-[11px] font-medium transition ${
                                    showTrackpad
                                      ? 'border-cyan-400 bg-cyan-500/20 text-cyan-200'
                                      : 'border-white/10 bg-zinc-900 text-zinc-200 hover:border-cyan-400'
                                  }`}
                                >
                                  <Move className="h-4 w-4 text-cyan-400" />
                                  <span>Трекпад</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditSubMode('opacity')}
                                  className={`flex h-16 flex-col items-center justify-center gap-1 rounded-xl border px-1.5 text-[11px] font-medium transition ${
                                    selectedOpacityValue < 0.99
                                      ? 'border-cyan-400/60 bg-cyan-500/15 text-cyan-200'
                                      : 'border-white/10 bg-zinc-900 text-zinc-200 hover:border-cyan-400'
                                  }`}
                                >
                                  <Droplet className="h-4 w-4 text-cyan-400" />
                                  <span>
                                    {Math.round(selectedOpacityValue * 100)}%
                                  </span>
                                </button>
                              </div>
                            </div>

                            {/* Section: Shape Styling & Adjustment Mask */}
                            <div className="space-y-2 border-t border-white/10 pt-3">
                              <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                                Фигура и корректирующая маска
                              </p>
                              <div className="space-y-2">
                                {selectedClip.kind === 'shape' && (
                                  <button
                                    type="button"
                                    onClick={() => setEditSubMode('shape')}
                                    className="flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-cyan-400/40 bg-cyan-500/10 px-3 text-xs font-semibold text-cyan-200 hover:bg-cyan-500/20"
                                  >
                                    <PaintBucket className="h-4 w-4 text-cyan-400" />
                                    <span>Стиль фигуры (цвет, обводка, углы)</span>
                                  </button>
                                )}

                                <button
                                  type="button"
                                  onClick={() =>
                                    handleToggleAdjustmentMask(selectedClip)
                                  }
                                  className={`flex w-full items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-left transition ${
                                    selectedClip.adjustmentMask
                                      ? 'border-violet-400 bg-violet-500/20 text-violet-100'
                                      : 'border-white/10 bg-zinc-900 text-zinc-200 hover:border-violet-400/60'
                                  }`}
                                >
                                  <div className="min-w-0">
                                    <p className="flex items-center gap-1.5 text-xs font-semibold">
                                      <Sparkles className="h-3.5 w-3.5 text-violet-300" />
                                      <span>Корректирующая маска</span>
                                    </p>
                                    <p className="mt-0.5 text-[10px] text-zinc-400">
                                      {selectedClip.adjustmentMask
                                        ? 'Объект скрыт и фильтрует слои под собой'
                                        : 'Применять цвет/размытие только под границей слоя'}
                                    </p>
                                  </div>
                                  <span
                                    className={`shrink-0 rounded-md px-2 py-0.5 text-[10px] font-bold ${
                                      selectedClip.adjustmentMask
                                        ? 'bg-violet-500 text-white'
                                        : 'bg-white/10 text-zinc-400'
                                    }`}
                                  >
                                    {selectedClip.adjustmentMask ? 'ВКЛ' : 'ВЫКЛ'}
                                  </span>
                                </button>
                              </div>
                            </div>

                            {/* Section 2: Mask & Chroma Key */}
                            <div className="space-y-2 border-t border-white/10 pt-3">
                              <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                                Маска {(selectedClip.kind === 'image' || selectedClip.kind === 'video') ? 'и вырезка фона' : 'вырезания'}
                              </p>
                              <div
                                className={`grid gap-2 ${
                                  selectedClip.kind === 'image' ||
                                  selectedClip.kind === 'video'
                                    ? 'grid-cols-2'
                                    : 'grid-cols-1'
                                }`}
                              >
                                <button
                                  type="button"
                                  onClick={() => {
                                    setShowChromaKeyPanel(false);
                                    setEditSubMode('mask');
                                  }}
                                  className={`flex h-14 items-center justify-center gap-2 rounded-xl border px-2.5 text-xs font-medium transition ${
                                    selectedClip.mask
                                      ? 'border-cyan-400/60 bg-cyan-500/15 text-cyan-200'
                                      : 'border-white/10 bg-zinc-900 text-zinc-200 hover:border-cyan-400'
                                  }`}
                                >
                                  <Shapes className="h-4 w-4 text-cyan-400" />
                                  <span>Маска</span>
                                </button>
                                {(selectedClip.kind === 'image' ||
                                  selectedClip.kind === 'video') && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setShowChromaKeyPanel(true);
                                      setEditSubMode('chromakey');
                                    }}
                                    className={`flex h-14 items-center justify-center gap-2 rounded-xl border px-2.5 text-xs font-medium transition ${
                                      selectedClip.chromaKeyEnabled
                                        ? 'border-emerald-400/60 bg-emerald-500/15 text-emerald-200'
                                        : 'border-white/10 bg-zinc-900 text-zinc-200 hover:border-emerald-400'
                                    }`}
                                  >
                                    <Pipette className="h-4 w-4 text-emerald-400" />
                                    <span>Удалить фон</span>
                                  </button>
                                )}
                              </div>
                            </div>

                            {/* Section 3: Color, Crop & Keyframes */}
                            <div className="space-y-2 border-t border-white/10 pt-3">
                              <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                                Цвет, эффекты и анимация
                              </p>
                              <div className="grid grid-cols-2 gap-2">
                                <button
                                  type="button"
                                  onClick={() => setEditSubMode('adjust')}
                                  className="flex h-14 flex-col items-center justify-center gap-1 rounded-xl border border-white/10 bg-zinc-900 px-2 text-[11px] font-medium text-zinc-200 hover:border-cyan-400"
                                >
                                  <Sliders className="h-4 w-4 text-cyan-400" />
                                  <span>Настроить</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditSubMode('filters')}
                                  className="flex h-14 flex-col items-center justify-center gap-1 rounded-xl border border-white/10 bg-zinc-900 px-2 text-[11px] font-medium text-zinc-200 hover:border-cyan-400"
                                >
                                  <Palette className="h-4 w-4 text-cyan-400" />
                                  <span>Фильтры</span>
                                </button>
                                {(selectedClip.kind === 'image' ||
                                  selectedClip.kind === 'video') && (
                                  <button
                                    type="button"
                                    onClick={() => setShowCropModal(true)}
                                    className={`flex h-14 flex-col items-center justify-center gap-1 rounded-xl border px-2 text-[11px] font-medium transition ${
                                      selectedClip.crop
                                        ? 'border-cyan-400/60 bg-cyan-500/15 text-cyan-200'
                                        : 'border-white/10 bg-zinc-900 text-zinc-200 hover:border-cyan-400'
                                    }`}
                                  >
                                    <Crop className="h-4 w-4 text-cyan-400" />
                                    <span>Кадрировать</span>
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => setEditSubMode('keyframes')}
                                  className={`flex h-14 flex-col items-center justify-center gap-1 rounded-xl border px-2 text-[11px] font-medium transition ${
                                    (selectedClip.keyframes?.length ?? 0) > 0
                                      ? 'border-amber-400/60 bg-amber-500/15 text-amber-200'
                                      : 'border-white/10 bg-zinc-900 text-zinc-200 hover:border-amber-400'
                                  } ${
                                    selectedClip.kind === 'image' ||
                                    selectedClip.kind === 'video'
                                      ? ''
                                      : 'col-span-2'
                                  }`}
                                >
                                  <Diamond className="h-4 w-4 text-amber-400" />
                                  <span>
                                    Ключи ({selectedClip.keyframes?.length ?? 0})
                                  </span>
                                </button>
                              </div>
                            </div>
                          </div>
                          )
                        ) : (
                          <div className="space-y-3 border-t border-white/10 pt-3">
                            <div className="flex items-center justify-between">
                              <button
                                type="button"
                                onClick={() => {
                                  if (editSubMode === 'chromakey') {
                                    setShowChromaKeyPanel(false);
                                  }
                                  setEditSubMode('menu');
                                }}
                                className="flex items-center gap-1 rounded-lg border border-white/10 bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-zinc-200 hover:border-cyan-400"
                              >
                                <ChevronLeft className="h-3.5 w-3.5" />
                                Назад
                              </button>
                              <span className="text-xs font-semibold text-white">
                                {editSubMode === 'transform'
                                  ? 'Трансформация'
                                  : editSubMode === 'shape'
                                    ? 'Фигура и стиль'
                                    : editSubMode === 'opacity'
                                      ? selectedClip.track === 'adjustment' ||
                                        selectedClip.kind === 'adjustment'
                                        ? 'Интенсивность эффекта'
                                        : 'Прозрачность'
                                      : editSubMode === 'mask'
                                        ? 'Маска'
                                        : editSubMode === 'chromakey'
                                          ? 'Удалить фон (Хромакей)'
                                          : editSubMode === 'adjust'
                                            ? 'Цветокоррекция'
                                            : editSubMode === 'keyframes'
                                              ? 'Ключевые кадры'
                                              : 'Фильтры'}
                              </span>
                            </div>

                            {editSubMode === 'transform' && (
                              <TransformPanel
                                clip={selectedClip}
                                currentTime={currentTime}
                                onSeek={handleSeek}
                                onUpdateClip={updateClip}
                                onUpdateTransform={handleUpdateClipTransformFields}
                                onUpdateWarp={handleUpdateClipWarp}
                                onOpenTrackpad={() =>
                                  setShowTrackpad((v) => !v)
                                }
                                trackpadActive={showTrackpad}
                              />
                            )}

                            {editSubMode === 'shape' &&
                              selectedClip.kind === 'shape' && (
                                <ShapesPanel
                                  selectedClip={selectedClip}
                                  onAddShape={handleAddShapeClip}
                                  onUpdateClip={updateClip}
                                  onOpenAdjust={() => setEditSubMode('adjust')}
                                />
                              )}

                            {editSubMode === 'opacity' && (
                              <div className="space-y-3 rounded-xl border border-white/10 bg-zinc-900/60 p-3">
                                <div className="flex items-center justify-between text-xs text-zinc-300">
                                  <span>
                                    {selectedClip.track === 'adjustment' ||
                                    selectedClip.kind === 'adjustment'
                                      ? 'Интенсивность эффекта'
                                      : 'Прозрачность слоя'}
                                  </span>
                                  <ScrubNumberField
                                    compact
                                    accent="cyan"
                                    value={Math.round(
                                      selectedOpacityValue * 100
                                    )}
                                    min={0}
                                    max={100}
                                    step={1}
                                    suffix="%"
                                    ariaLabel="Прозрачность"
                                    onChange={(pct) =>
                                      handleChangeSelectedOpacity(
                                        pct / 100,
                                        false
                                      )
                                    }
                                    onCommit={(pct) =>
                                      handleChangeSelectedOpacity(
                                        pct / 100,
                                        true
                                      )
                                    }
                                  />
                                </div>
                                <input
                                  type="range"
                                  min={0}
                                  max={1}
                                  step={0.01}
                                  value={selectedOpacityValue}
                                  onChange={(e) =>
                                    handleChangeSelectedOpacity(
                                      Number(e.target.value),
                                      false
                                    )
                                  }
                                  onPointerUp={(e) =>
                                    handleChangeSelectedOpacity(
                                      Number(
                                        (e.target as HTMLInputElement).value
                                      ),
                                      true
                                    )
                                  }
                                  className="h-2 w-full cursor-pointer accent-cyan-400"
                                />
                                <div className="grid grid-cols-4 gap-1.5">
                                  {[25, 50, 75, 100].map((pct) => (
                                    <button
                                      key={pct}
                                      type="button"
                                      onClick={() =>
                                        handleChangeSelectedOpacity(
                                          pct / 100,
                                          true
                                        )
                                      }
                                      className="h-8 rounded-lg border border-white/10 bg-zinc-900 text-[11px] font-medium text-zinc-300 hover:border-cyan-400"
                                    >
                                      {pct}%
                                    </button>
                                  ))}
                                </div>
                              </div>
                            )}

                            {editSubMode === 'mask' && (
                              <MaskPanel
                                clip={selectedClip}
                                currentTime={currentTime}
                                onUpdateClip={updateClip}
                              />
                            )}

                            {editSubMode === 'chromakey' && (
                              <ChromaKeyPanel
                                clip={selectedClip}
                                onUpdateChromaKey={handleUpdateChromaKey}
                              />
                            )}

                            {editSubMode === 'adjust' && (
                              <ColorAdjustPanel
                                clip={selectedClip}
                                onUpdateClip={updateClip}
                                onPresetsChanged={setCustomColorPresets}
                              />
                            )}

                            {editSubMode === 'filters' && (
                              <FilterStripPanel
                                clip={selectedClip}
                                customPresets={customColorPresets}
                                previewFallbackSrc={
                                  project.clips.find(
                                    (c) =>
                                      c.kind === 'image' &&
                                      c.src &&
                                      currentTime >= c.start &&
                                      currentTime < c.start + c.duration
                                  )?.src ??
                                  project.clips.find(
                                    (c) => c.kind === 'image' && c.src
                                  )?.src
                                }
                                onUpdateClip={(id, patch) =>
                                  updateClip(id, patch)
                                }
                                onOpenAdjust={() => setEditSubMode('adjust')}
                                onPresetsChanged={setCustomColorPresets}
                              />
                            )}

                            {editSubMode === 'keyframes' && (
                              <KeyframeControls
                                clip={selectedClip}
                                currentTime={currentTime}
                                onSeek={handleSeek}
                                onUpdateClip={(id, patch) => updateClip(id, patch)}
                              />
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </>
                ) : (
                  <div className="space-y-3 rounded-xl border border-white/10 bg-zinc-900/60 p-4 text-center text-xs text-zinc-400">
                    <p>
                      Выберите клип на таймлайне или поставьте линию времени на нужный фрагмент и нажмите «Изменить».
                    </p>
                    <button
                      type="button"
                      onClick={handleOpenEditTab}
                      className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-cyan-500 px-3 text-xs font-semibold text-zinc-950 hover:bg-cyan-400"
                    >
                      <Scissors className="h-3.5 w-3.5" />
                      Выделить под плейхедом
                    </button>
                  </div>
                )}
              </div>
            )}
            {desktopTab === 'overlay' && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-1 rounded-xl border border-white/10 bg-zinc-900 p-1">
                  <button
                    type="button"
                    onClick={() => setDesktopOverlayView('media')}
                    className={`flex h-8 items-center justify-center gap-1.5 rounded-lg text-xs font-medium transition ${
                      desktopOverlayView === 'media'
                        ? 'bg-indigo-500 text-white'
                        : 'text-zinc-300 hover:text-white'
                    }`}
                  >
                    <ImagePlus className="h-3.5 w-3.5" />
                    Фото / Видео
                  </button>
                  <button
                    type="button"
                    onClick={() => setDesktopOverlayView('shapes')}
                    className={`flex h-8 items-center justify-center gap-1.5 rounded-lg text-xs font-medium transition ${
                      desktopOverlayView === 'shapes'
                        ? 'bg-cyan-500 text-zinc-950'
                        : 'text-zinc-300 hover:text-white'
                    }`}
                  >
                    <Shapes className="h-3.5 w-3.5" />
                    Фигуры
                  </button>
                </div>
                {desktopOverlayView === 'shapes' ? (
                  <ShapesPanel
                    selectedClip={selectedClip}
                    onAddShape={handleAddShapeClip}
                    onUpdateClip={updateClip}
                    onOpenAdjust={() => {
                      setDesktopTab('edit');
                      setEditSubMode('adjust');
                    }}
                  />
                ) : (
                  <OverlayPanel
                    selectedClip={selectedClip}
                    currentTime={currentTime}
                    onSeek={handleSeek}
                    onAddMediaClip={handleAddMediaClip}
                    onUpdateClip={(id, patch) => updateClip(id, patch)}
                  />
                )}
              </div>
            )}
            {desktopTab === 'text' && (
              <TextPanel
                selectedClip={selectedClip}
                clips={project.clips}
                customFonts={project.customFonts ?? []}
                currentTime={currentTime}
                autoFocusTrigger={textFocusTrigger}
                activeColorPickerField={
                  isTextColorPickerActive && textColorPicker
                    ? textColorPicker.field
                    : null
                }
                onRequestColorPicker={(field) => {
                  if (!selectedClip || selectedClip.track !== 'text' || !field) {
                    setTextColorPicker(null);
                    return;
                  }
                  setShowChromaKeyPanel(false);
                  setBgColorPickerActive(false);
                  setTextColorPicker({clipId: selectedClip.id, field});
                }}
                curveEditActive={curveEditActive}
                onSetCurveEditActive={setCurveEditActive}
                selectedCurvePointId={selectedCurvePointId}
                onSelectCurvePoint={setSelectedCurvePointId}
                onSelectClip={(id) => {
                  setSelectedClipId(id);
                  setTextFocusTrigger((n) => n + 1);
                }}
                onAddText={handleAddText}
                onUpdateClip={updateClip}
                onAddCustomFont={addCustomFont}
                onOpenTrackpad={() => setShowTrackpad((v) => !v)}
                onAddKeyframe={handleAddKeyframeAtPlayhead}
                hasKeyframeAtPlayhead={hasKeyframeAtPlayhead}
                onOpenStickers={handleOpenStickers}
              />
            )}
            {desktopTab === 'effects' && (
              <EffectsPanel
                selectedClip={selectedClip}
                onUpdateClip={(id, patch) => updateClip(id, patch)}
                onAddAdjustmentLayer={handleAddAdjustmentLayer}
              />
            )}
            {desktopTab === 'audio' && (
              <AudioPanel
                selectedClip={selectedClip}
                allClips={project.clips}
                tracks={project.tracks}
                duration={duration}
                onAddAudioClip={handleAddAudioClip}
                onUpdateClip={updateClip}
                onOpenRecorder={() => {
                  setShowTrackpad(false);
                  setMobileEditTool(null);
                  setShowVoiceRecorder(true);
                }}
                onNotify={showTransientNotice}
              />
            )}
            {desktopTab === 'settings' && (
              <ProjectSettingsPanel
                aspectRatio={project.aspectRatio}
                backgroundColor={project.backgroundColor}
                canvasBackground={project.canvasBackground}
                user={user}
                bgColorPickerActive={bgColorPickerActive}
                onToggleBgColorPicker={(active) => {
                  if (active) {
                    setTextColorPicker(null);
                    setShowChromaKeyPanel(false);
                  }
                  setBgColorPickerActive(active);
                }}
                onUpdateProjectMeta={updateProjectMeta}
                onUpdateProfile={updateUserProfile}
                onGiphyKeyChanged={() => setGiphyKeyVersion((v) => v + 1)}
                onNotify={showTransientNotice}
              />
            )}
            {desktopTab === 'team' && (
              <TeamPanel
                roomId={roomId}
                serverUrl={serverUrl}
                p2pMode={p2pMode}
                networkInterfaces={networkInterfaces}
                hostPort={hostPort}
                udpRooms={udpRooms}
                pingMs={pingMs}
                ktorStatus={ktorStatus}
                downloadQueue={downloadQueue}
                user={user}
                allCollaborators={allCollaborators}
                availableRooms={availableRooms}
                chat={project.chat}
                status={status}
                onUpdateProfile={updateUserProfile}
                onOpenLobby={() => setShowLobbyModal(true)}
                onSwitchRoom={switchRoom}
                onSendChat={sendChatMessage}
                onUpdateServerUrl={updateServerConnection}
                onStartHost={startHostRoom}
                onStopHost={stopHostRoom}
                onConnectToHostIp={connectToHostIp}
                onRefreshNetwork={() => {
                  void refreshNetworkInfo();
                }}
                onForceSyncProject={forceSyncProject}
                onRetryDownload={retryMediaDownload}
              />
            )}
          </div>
        </aside>

        {/* Center Preview Canvas + Transport Bar */}
        <main className="relative flex flex-1 min-h-0 flex-col bg-[#09090b]">
          {(lockWarning || noticeMsg) && (
            <div className="pointer-events-none absolute top-3 left-1/2 z-30 max-w-[calc(100%-96px)] -translate-x-1/2 truncate rounded-full border border-amber-400/50 bg-zinc-950/90 px-3.5 py-1.5 text-xs font-semibold text-amber-300 shadow-lg backdrop-blur-xs">
              {lockWarning || noticeMsg}
            </div>
          )}
          {bgColorPickerActive && (
            <div className="absolute top-3 left-1/2 z-30 flex max-w-[calc(100%-96px)] -translate-x-1/2 items-center gap-2 rounded-full border border-cyan-400/60 bg-zinc-950/90 px-3 py-1.5 shadow-xl backdrop-blur-xs">
              <span
                className="h-4 w-4 shrink-0 rounded-full border border-white/40"
                style={{backgroundColor: project.backgroundColor || '#09090b'}}
              />
              <span className="truncate text-[11px] font-medium text-cyan-200">
                Пипетка (Фон холста): ведите по холсту
              </span>
              <button
                type="button"
                onClick={() => setBgColorPickerActive(false)}
                className="shrink-0 rounded-full bg-cyan-500 px-2.5 py-0.5 text-[10px] font-bold text-zinc-950 hover:bg-cyan-400"
              >
                Готово
              </button>
            </div>
          )}
          {isTextColorPickerActive && (
            <div className="absolute top-3 left-1/2 z-30 flex max-w-[calc(100%-96px)] -translate-x-1/2 items-center gap-2 rounded-full border border-cyan-400/60 bg-zinc-950/90 px-3 py-1.5 shadow-xl backdrop-blur-xs">
              <span
                className="h-4 w-4 shrink-0 rounded-full border border-white/40"
                style={{backgroundColor: textColorPickerHex}}
              />
              <span className="truncate text-[11px] font-medium text-cyan-200">
                Пипетка ({textColorPickerFieldLabel}): ведите по холсту
              </span>
              <button
                type="button"
                onClick={() => setTextColorPicker(null)}
                className="shrink-0 rounded-full bg-cyan-500 px-2.5 py-0.5 text-[10px] font-bold text-zinc-950 hover:bg-cyan-400"
              >
                Готово
              </button>
            </div>
          )}
          {isCurveEditOverlayActive && selectedClip && (
            <div className="absolute top-3 left-1/2 z-30 flex max-w-[calc(100%-96px)] -translate-x-1/2 items-center gap-1.5 rounded-full border border-cyan-400/50 bg-zinc-950/90 px-2.5 py-1 shadow-xl backdrop-blur-xs">
              <Spline className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
              <span className="hidden whitespace-nowrap text-[11px] font-medium text-zinc-200 sm:inline">
                Кривая ({activeCurvePoints.length} т.)
              </span>
              <button
                type="button"
                onClick={() => {
                  const pts = activeCurvePoints;
                  const idx = selectedCurvePointId
                    ? pts.findIndex((p) => p.id === selectedCurvePointId)
                    : -1;
                  const insertAfter =
                    idx >= 0
                      ? Math.min(idx, pts.length - 2)
                      : Math.max(0, Math.floor((pts.length - 1) / 2));
                  const a = pts[insertAfter];
                  const b = pts[insertAfter + 1] ?? a;
                  const newPt: TextCurvePoint = {
                    id: `pt-${Math.random().toString(36).slice(2, 7)}`,
                    x: Math.round(((a.x + b.x) / 2) * 10) / 10,
                    y: Math.round(((a.y + b.y) / 2) * 10) / 10,
                  };
                  const nextPts = [
                    ...pts.slice(0, insertAfter + 1),
                    newPt,
                    ...pts.slice(insertAfter + 1),
                  ];
                  handleUpdateCurvePoints(selectedClip.id, nextPts, true);
                  setSelectedCurvePointId(newPt.id);
                }}
                className="flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-semibold text-zinc-100 hover:bg-white/20"
                title="Добавить точку на кривую"
              >
                <Plus className="h-3 w-3 text-cyan-300" />
                <span>Точка</span>
              </button>
              <button
                type="button"
                disabled={!selectedCurvePointId || activeCurvePoints.length <= 2}
                onClick={() => {
                  if (!selectedCurvePointId || activeCurvePoints.length <= 2) {
                    return;
                  }
                  const idx = activeCurvePoints.findIndex(
                    (p) => p.id === selectedCurvePointId
                  );
                  const nextPts = activeCurvePoints.filter(
                    (p) => p.id !== selectedCurvePointId
                  );
                  handleUpdateCurvePoints(selectedClip.id, nextPts, true);
                  setSelectedCurvePointId(
                    nextPts[Math.min(Math.max(0, idx), nextPts.length - 1)]?.id ??
                      null
                  );
                }}
                className="flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-semibold text-rose-200 hover:bg-rose-500/20 disabled:opacity-40"
                title="Удалить выбранную точку"
              >
                <Trash2 className="h-3 w-3" />
                <span className="hidden sm:inline">Удалить</span>
              </button>
              <button
                type="button"
                onClick={() => setCurveEditActive(false)}
                className="rounded-full bg-cyan-500 px-2.5 py-0.5 text-[10px] font-bold text-zinc-950 hover:bg-cyan-400"
              >
                Готово
              </button>
            </div>
          )}
          {isWarpEditActive &&
            selectedClip &&
            activeWarpState &&
            activeWarpState.mode !== 'none' &&
            !isPlaying &&
            !isCurveEditOverlayActive &&
            !isChromaKeyPickerActive &&
            !isTextColorPickerActive &&
            !bgColorPickerActive && (
              <div className="absolute top-3 left-1/2 z-30 flex max-w-[calc(100%-96px)] -translate-x-1/2 items-center gap-1.5 rounded-full border border-blue-400/60 bg-zinc-950/90 px-2.5 py-1 shadow-xl backdrop-blur-xs">
                <Grid3X3 className="h-3.5 w-3.5 shrink-0 text-blue-400" />
                <span className="whitespace-nowrap text-[11px] font-medium text-blue-100">
                  {activeWarpState.mode === 'perspective'
                    ? 'Перспектива (4 угла)'
                    : `Сетка ${activeWarpState.meshSize}×${activeWarpState.meshSize}`}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    handleUpdateClipWarp(
                      selectedClip.id,
                      createDefaultWarp(
                        activeWarpState.mode,
                        activeWarpState.meshSize
                      ),
                      true
                    )
                  }
                  className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-semibold text-zinc-200 hover:bg-white/20"
                >
                  Сброс
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditSubMode('menu');
                    setMobileEditTool(null);
                  }}
                  className="rounded-full bg-blue-500 px-2.5 py-0.5 text-[10px] font-bold text-white hover:bg-blue-400"
                >
                  Готово
                </button>
              </div>
            )}
          <div ref={previewBoxRef} className="flex-1 min-h-0">
            <PreviewCanvas
              tracks={project.tracks}
              clips={project.clips}
              aspectRatio={project.aspectRatio}
              backgroundColor={project.backgroundColor}
              canvasBackground={project.canvasBackground}
              customFonts={project.customFonts}
              currentTime={currentTime}
              isPlaying={isPlaying}
              disableSizeTransition={isResizingTimeline}
              selectedClipId={selectedClipId}
              currentUserId={user.id}
              collaborators={collaborators}
              mediaPool={mediaPoolRef.current}
              audioEngine={audioEngineRef.current!}
              snapEnabled={snapEnabled}
              onToggleSnap={() => setSnapEnabled((v) => !v)}
              showSelectionOutline={showSelectionOutline}
              onToggleSelectionOutline={() =>
                setShowSelectionOutline((v) => !v)
              }
              externalSnapGuides={trackpadSnapGuides}
              chromaKeyPickerActive={isChromaKeyPickerActive}
              onPickChromaKeyColor={handlePickChromaKeyColor}
              colorPickerActive={isTextColorPickerActive || bgColorPickerActive}
              colorPickerPreviewHex={
                bgColorPickerActive
                  ? project.backgroundColor || '#09090b'
                  : textColorPickerHex
              }
              onPickCanvasColor={
                bgColorPickerActive
                  ? handlePickCanvasBackgroundColor
                  : handlePickTextCanvasColor
              }
              maskEditActive={isMaskEditActive}
              onTransformMask={handleTransformMaskOnCanvas}
              curveEditActive={isCurveEditOverlayActive}
              selectedCurvePointId={selectedCurvePointId}
              onSelectCurvePoint={setSelectedCurvePointId}
              onUpdateCurvePoints={handleUpdateCurvePoints}
              warpEditActive={isWarpEditActive}
              onUpdateWarp={handleUpdateClipWarp}
              onLockLayer={sendLayerLock}
              onSelectClip={setSelectedClipId}
              onDoubleClickTextClip={handleDoubleClickTextClip}
              onTransformClip={handleTransformClipOnCanvas}
            />
          </div>

          {/* Transport Bar */}
          <div className="relative flex min-w-0 shrink-0 flex-col border-t border-white/10 bg-[#101013]">
            {/* Top resize strip across Transport Bar */}
            <div
              onPointerDown={handleTimelineResizePointerDown}
              onPointerMove={handleTimelineResizePointerMove}
              onPointerUp={handleTimelineResizePointerUp}
              onPointerCancel={handleTimelineResizePointerUp}
              onDoubleClick={handleTimelineResizeReset}
              className={`absolute inset-x-0 -top-1.5 z-10 h-3 cursor-ns-resize touch-none transition-colors ${
                isResizingTimeline ? 'bg-cyan-400/20' : 'hover:bg-white/5'
              }`}
            />
            <div className="flex h-[54px] min-w-0 items-center justify-between gap-2 px-2.5 pt-2.5 pb-1 sm:px-4">
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={undo}
                  disabled={!canUndo}
                  aria-label="Отменить"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-zinc-300 hover:bg-white/10 disabled:opacity-30"
                >
                  <Undo2 className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={redo}
                  disabled={!canRedo}
                  aria-label="Повторить"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-zinc-300 hover:bg-white/10 disabled:opacity-30"
                >
                  <Redo2 className="h-4 w-4" />
                </button>
              </div>

              <div className="flex min-w-0 shrink-0 items-center gap-1.5 sm:gap-2.5">
                <span className="font-mono text-xs tabular-nums text-white whitespace-nowrap">
                  {formatTimecode(currentTime)}
                </span>
                <div className="relative flex shrink-0 items-center justify-center">
                  <button
                    type="button"
                    role="separator"
                    aria-orientation="horizontal"
                    aria-label="Двигать нижнее окно вверх и вниз"
                    title="Потяните вверх/вниз для изменения размера таймлайна и превью (двойной клик — сброс)"
                    onPointerDown={handleTimelineResizePointerDown}
                    onPointerMove={handleTimelineResizePointerMove}
                    onPointerUp={handleTimelineResizePointerUp}
                    onPointerCancel={handleTimelineResizePointerUp}
                    onDoubleClick={handleTimelineResizeReset}
                    onKeyDown={handleTimelineResizeKeyDown}
                    className={`before:absolute before:-top-2 before:inset-x-[-6px] before:bottom-0 before:content-[''] absolute -top-[19px] left-1/2 z-20 flex h-[17px] w-11 -translate-x-1/2 cursor-ns-resize touch-none items-center justify-center rounded-full border transition ${
                      isResizingTimeline
                        ? 'border-cyan-400 bg-cyan-500/25 text-cyan-200 shadow-[0_0_12px_rgba(34,211,238,0.4)]'
                        : 'border-white/15 bg-[#1a1a20] text-zinc-400 shadow-sm hover:border-cyan-400/60 hover:bg-[#23232b] hover:text-zinc-100'
                    }`}
                  >
                    <ChevronsUpDown className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsPlaying((p) => !p)}
                    aria-label={isPlaying ? 'Пауза' : 'Воспроизвести'}
                    className="flex h-9 w-11 shrink-0 items-center justify-center rounded-full bg-white text-zinc-950 shadow hover:bg-zinc-200 active:scale-95"
                  >
                    {isPlaying ? (
                      <Pause className="h-4 w-4 fill-current" />
                    ) : (
                      <Play className="ml-0.5 h-4 w-4 fill-current" />
                    )}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={handleAddKeyframeAtPlayhead}
                  disabled={!selectedClip || selectedClip.track === 'audio'}
                  title="Поставить ключевой кадр в текущем времени"
                  aria-label="Ключевой кадр"
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition active:scale-95 disabled:opacity-30 ${
                    hasKeyframeAtPlayhead
                      ? 'border-amber-400/70 bg-amber-500/20 text-amber-300'
                      : 'border-white/10 bg-zinc-900 text-zinc-200 hover:border-amber-400/60 hover:text-amber-200'
                  }`}
                >
                  <svg
                    viewBox="0 0 24 24"
                    className="h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 3l7.5 9L12 21 4.5 12 12 3z" />
                    <path d="M12 9v6" />
                    <path d="M9 12h6" />
                  </svg>
                </button>
                <span className="font-mono text-xs tabular-nums text-zinc-500 whitespace-nowrap">
                  {formatTimecode(duration)}
                </span>
              </div>

              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={handleSplitSelectedOrCurrent}
                  disabled={!canSplitNow}
                  title="Разделить клип по линии времени (S)"
                  className="flex h-9 shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-medium text-zinc-200 hover:bg-white/10 disabled:opacity-30"
                >
                  <Scissors className="h-4 w-4 shrink-0 text-cyan-400" />
                  <span className="hidden xl:inline whitespace-nowrap">Разделить</span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    replaceClips(createStarterClips(), {
                      tracks: createDefaultTracks(),
                    })
                  }
                  title="Сбросить к демо-проекту"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-zinc-400 hover:bg-white/10 hover:text-white"
                >
                  <RotateCcw className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        </main>

        {/* Desktop Right Sidebar: Selected Clip Inspector */}
        <aside className="studio-scrollbar hidden border-l border-white/10 bg-[#111114] p-4 lg:flex lg:min-h-0 lg:flex-col lg:overflow-y-auto">
          {selectedClip ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between border-b border-white/10 pb-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-white">
                    {selectedClip.name}
                  </p>
                  <p className="text-xs text-zinc-500">
                    {selectedClip.start.toFixed(1)}с –{' '}
                    {(selectedClip.start + selectedClip.duration).toFixed(1)}с ·{' '}
                    {selectedClip.duration.toFixed(1)}с
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    deleteClip(selectedClip.id);
                    setSelectedClipId(null);
                  }}
                  aria-label="Удалить клип"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-rose-500/15 text-rose-400 hover:bg-rose-500/25"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>

              <div
                className={`grid gap-2 ${
                  selectedClip.track === 'adjustment' ||
                  selectedClip.kind === 'adjustment'
                    ? 'grid-cols-2'
                    : 'grid-cols-3'
                }`}
              >
                <button
                  type="button"
                  onClick={handleSplitSelectedOrCurrent}
                  disabled={!canSplitNow}
                  className="flex h-10 flex-col items-center justify-center rounded-lg border border-white/10 bg-zinc-900 text-[11px] text-zinc-200 hover:border-cyan-400 disabled:opacity-35"
                >
                  <Scissors className="mb-0.5 h-3.5 w-3.5 text-cyan-400" />
                  Разделить
                </button>
                <button
                  type="button"
                  onClick={handleDuplicateSelected}
                  className="flex h-10 flex-col items-center justify-center rounded-lg border border-white/10 bg-zinc-900 text-[11px] text-zinc-200 hover:border-cyan-400"
                >
                  <CopyPlus className="mb-0.5 h-3.5 w-3.5 text-cyan-400" />
                  Копия
                </button>
                {selectedClip.track !== 'adjustment' &&
                  selectedClip.kind !== 'adjustment' && (
                    <button
                      type="button"
                      onClick={handleCycleSpeed}
                      className="flex h-10 flex-col items-center justify-center rounded-lg border border-white/10 bg-zinc-900 text-[11px] text-zinc-200 hover:border-cyan-400"
                    >
                      <Gauge className="mb-0.5 h-3.5 w-3.5 text-cyan-400" />
                      {selectedClip.speed}x
                    </button>
                  )}
              </div>

              {(selectedClip.track === 'video' ||
                selectedClip.track === 'overlay') && (
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      moveClipTrackType(
                        selectedClip.id,
                        selectedClip.track === 'video' ? 'overlay' : 'video'
                      )
                    }
                    className="flex h-9 min-w-0 items-center justify-center gap-1.5 rounded-lg border border-indigo-500/35 bg-indigo-500/10 px-2 text-xs font-medium text-indigo-200 hover:border-indigo-400"
                  >
                    <Layers className="h-3.5 w-3.5 shrink-0 text-indigo-400" />
                    <span className="truncate">
                      {selectedClip.track === 'video'
                        ? 'Наложение'
                        : 'Основное'}
                    </span>
                  </button>
                  {(selectedClip.kind === 'image' ||
                    selectedClip.kind === 'video') && (
                    <button
                      type="button"
                      onClick={() => setShowCompressModal(true)}
                      className="flex h-9 min-w-0 items-center justify-center gap-1.5 rounded-lg border border-emerald-500/35 bg-emerald-500/10 px-2 text-xs font-medium text-emerald-200 hover:border-emerald-400"
                    >
                      <Minimize2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                      <span className="truncate">Сжать</span>
                    </button>
                  )}
                </div>
              )}

              {selectedClip.track !== 'audio' &&
                selectedClip.track !== 'adjustment' &&
                selectedClip.kind !== 'adjustment' && (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setShowTrackpad((v) => !v)}
                      className={`flex h-9 min-w-0 items-center justify-center gap-1.5 rounded-lg border px-2 text-xs font-medium transition ${
                        showTrackpad
                          ? 'border-cyan-400 bg-cyan-500/20 text-cyan-200'
                          : 'border-white/10 bg-zinc-900 text-zinc-200 hover:border-cyan-400/60'
                      }`}
                    >
                      <Move className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
                      <span className="truncate">Трекпад</span>
                    </button>
                    {(selectedClip.kind === 'image' ||
                      selectedClip.kind === 'video') && (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            if (editSubMode === 'mask') setEditSubMode('menu');
                            setShowChromaKeyPanel((v) => !v);
                          }}
                          className={`flex h-9 min-w-0 items-center justify-center gap-1.5 rounded-lg border px-2 text-xs font-medium transition ${
                            showChromaKeyPanel
                              ? 'border-emerald-400 bg-emerald-500/20 text-emerald-200'
                              : selectedClip.chromaKeyEnabled
                                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                                : 'border-white/10 bg-zinc-900 text-zinc-200 hover:border-emerald-400/60'
                          }`}
                        >
                          <Pipette className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                          <span className="truncate">Хромакей</span>
                        </button>
                        <label
                          className={`col-span-2 flex h-9 min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-zinc-900 px-2.5 text-xs font-medium text-zinc-200 hover:border-cyan-400/60 ${
                            replacingMedia ? 'opacity-50 pointer-events-none' : ''
                          }`}
                        >
                          <RefreshCw
                            className={`h-3.5 w-3.5 shrink-0 text-cyan-400 ${
                              replacingMedia ? 'animate-spin' : ''
                            }`}
                          />
                          <span className="truncate">Заменить медиа</span>
                          <input
                            type="file"
                            accept="video/*,image/*"
                            disabled={replacingMedia}
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file && selectedClip) {
                                void handleReplaceClipMedia(
                                  selectedClip.id,
                                  file
                                );
                              }
                              e.target.value = '';
                            }}
                            className="hidden"
                          />
                        </label>
                        {selectedClip.mediaStatus === 'ERROR' && (
                          <button
                            type="button"
                            onClick={() => retryMediaDownload(selectedClip.id)}
                            className="col-span-2 flex h-10 min-w-0 items-center justify-center gap-1.5 rounded-xl border border-rose-500/50 bg-rose-500/20 px-2.5 text-[11px] font-semibold text-rose-200 hover:bg-rose-500/30"
                          >
                            <RefreshCw className="h-3.5 w-3.5 shrink-0 text-rose-300" />
                            <span className="truncate">Перекачать файл P2P</span>
                          </button>
                        )}
                      </>
                    )}
                  </div>

                  {showChromaKeyPanel &&
                    (selectedClip.kind === 'image' ||
                      selectedClip.kind === 'video') && (
                      <ChromaKeyPanel
                        clip={selectedClip}
                        onUpdateChromaKey={handleUpdateChromaKey}
                      />
                    )}
                </div>
              )}

              {selectedClip.track !== 'audio' && (
                <KeyframeControls
                  clip={selectedClip}
                  currentTime={currentTime}
                  onSeek={handleSeek}
                  onUpdateClip={(id, patch) => updateClip(id, patch)}
                />
              )}

              {(selectedClip.track === 'audio' ||
                selectedClip.kind === 'video') && (
                <div className="space-y-1 text-xs text-zinc-400">
                  <div className="flex items-center justify-between">
                    <span>Громкость</span>
                    <ScrubNumberField
                      compact
                      accent="emerald"
                      value={Math.round(selectedClip.volume * 100)}
                      min={0}
                      max={100}
                      step={1}
                      suffix="%"
                      ariaLabel="Громкость"
                      onChange={(pct) =>
                        updateClip(
                          selectedClip.id,
                          {volume: pct / 100},
                          {skipUndo: true, skipSync: true}
                        )
                      }
                      onCommit={(pct) =>
                        updateClip(selectedClip.id, {volume: pct / 100})
                      }
                    />
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={selectedClip.volume}
                    onChange={(e) =>
                      updateClip(selectedClip.id, {
                        volume: Number(e.target.value),
                      })
                    }
                    className="w-full accent-emerald-400"
                  />
                </div>
              )}

              {selectedClip.track !== 'audio' && (
                <EffectsPanel
                  selectedClip={selectedClip}
                  onUpdateClip={(id, patch) => updateClip(id, patch)}
                  onAddAdjustmentLayer={handleAddAdjustmentLayer}
                />
              )}
            </div>
          ) : (
            <div className="flex h-full flex-col justify-between">
              <div className="space-y-2 text-xs text-zinc-400">
                <p className="text-sm font-semibold text-white">
                  Свойства клипа
                </p>
                <p>
                  Нажмите на любой клип на таймлайне, чтобы обрезать края, перенести на другую дорожку, добавить ключи движения или настроить шрифт.
                </p>
              </div>
              <div className="space-y-2 rounded-xl border border-white/10 bg-zinc-900/70 p-3 text-xs">
                <p className="font-medium text-zinc-200">
                  Горячие клавиши (ПК)
                </p>
                <div className="space-y-1 text-zinc-400">
                  <p>Space — Старт / Пауза</p>
                  <p>S — Разделить клип</p>
                  <p>Ctrl/Cmd + Z — Отменить</p>
                  <p>Delete — Удалить клип</p>
                </div>
              </div>
            </div>
          )}
        </aside>
      </div>

      {/* Multi-Track Dynamic Timeline OR Alight Motion Trackpad / Mobile Tool Overlays */}
      <div
        ref={bottomPanelRef}
        style={
          clampedCustomTimelineHeight !== null
            ? {height: `${clampedCustomTimelineHeight}px`}
            : undefined
        }
        className={`relative shrink-0 ${
          clampedCustomTimelineHeight !== null
            ? ''
            : (selectedClip?.track === 'text' &&
                  mobileEditTool === 'text' &&
                  !isTextColorPickerActive) ||
                mobileEditTool === 'shape' ||
                mobileEditTool === 'adjust' ||
                mobileEditTool === 'filters' ||
                mobileEditTool === 'keyframes'
              ? 'h-[305px] sm:h-[330px] lg:h-[260px]'
              : 'h-[220px] sm:h-[245px] lg:h-[260px]'
        }`}
      >
        {showTrackpad && selectedClip && selectedClip.track !== 'audio' ? (
          <TransformTrackpad
            clip={selectedClip}
            currentTime={currentTime}
            currentUserId={user.id}
            snapEnabled={snapEnabled}
            onLockLayer={sendLayerLock}
            onTransformClip={handleTransformClipOnCanvas}
            onUpdateClip={(id, patch) => updateClip(id, patch)}
            onSnapGuidesChange={setTrackpadSnapGuides}
            onClose={() => {
              setShowTrackpad(false);
              setTrackpadSnapGuides({x: false, y: false});
            }}
          />
        ) : (
          <div className="relative z-0 h-full isolate">
            <Timeline
              tracks={project.tracks}
              clips={project.clips}
              duration={duration}
              currentTime={currentTime}
              pxPerSec={pxPerSec}
              selectedClipId={selectedClipId}
              currentUserId={user.id}
              collaborators={collaborators}
              onSeek={handleSeek}
              onSelectClip={setSelectedClipId}
              onZoomChange={setPxPerSec}
              onAddTrack={addTrack}
              onUpdateTrack={updateTrack}
              onDeleteTrack={deleteTrack}
              onReorderTracks={reorderTracks}
              onLockLayer={sendLayerLock}
              onRetryDownload={retryMediaDownload}
              onClipTransform={handleClipTransform}
            />
          </div>
        )}

        {selectedClip &&
          selectedClip.track !== 'audio' &&
          mobileEditTool === 'transform' && (
            <div className="absolute inset-0 z-30 flex flex-col border-t border-white/10 bg-[#0d0d11] lg:hidden">
              <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-white/10 bg-[#121217] px-3">
                <span className="truncate text-xs font-semibold text-white">
                  Трансформация · {selectedClip.name}
                </span>
                <button
                  type="button"
                  onClick={() => setMobileEditTool(null)}
                  className="rounded-md bg-white/10 px-2.5 py-1 text-[11px] font-medium text-zinc-200 hover:bg-white/15 active:scale-95"
                >
                  Готово
                </button>
              </div>
              <div className="studio-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
                <TransformPanel
                  clip={selectedClip}
                  currentTime={currentTime}
                  onSeek={handleSeek}
                  onUpdateClip={updateClip}
                  onUpdateTransform={handleUpdateClipTransformFields}
                  onUpdateWarp={handleUpdateClipWarp}
                  onOpenTrackpad={() => {
                    setMobileEditTool(null);
                    setShowTrackpad(true);
                  }}
                  trackpadActive={showTrackpad}
                />
              </div>
            </div>
          )}

        {selectedClip &&
          selectedClip.kind === 'shape' &&
          mobileEditTool === 'shape' && (
            <div className="absolute inset-0 z-30 flex flex-col border-t border-white/10 bg-[#0d0d11] lg:hidden">
              <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-white/10 bg-[#121217] px-3">
                <span className="truncate text-xs font-semibold text-white">
                  Фигура · {selectedClip.name}
                </span>
                <button
                  type="button"
                  onClick={() => setMobileEditTool(null)}
                  className="rounded-md bg-cyan-500 px-2.5 py-1 text-[11px] font-bold text-zinc-950 hover:bg-cyan-400 active:scale-95"
                >
                  Готово
                </button>
              </div>
              <div className="studio-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
                <ShapesPanel
                  selectedClip={selectedClip}
                  onAddShape={handleAddShapeClip}
                  onUpdateClip={updateClip}
                  onOpenAdjust={() => setMobileEditTool('adjust')}
                />
              </div>
            </div>
          )}

        {selectedClip &&
          selectedClip.track !== 'audio' &&
          selectedClip.track !== 'adjustment' &&
          selectedClip.kind !== 'adjustment' &&
          mobileEditTool === 'mask' && (
            <div className="absolute inset-0 z-30 flex flex-col border-t border-white/10 bg-[#0d0d11] lg:hidden">
              <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-white/10 bg-[#121217] px-3">
                <span className="truncate text-xs font-semibold text-white">
                  Маска · {selectedClip.name}
                </span>
                <button
                  type="button"
                  onClick={() => setMobileEditTool(null)}
                  className="rounded-md bg-white/10 px-2.5 py-1 text-[11px] font-medium text-zinc-200 hover:bg-white/15 active:scale-95"
                >
                  Готово
                </button>
              </div>
              <div className="studio-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
                <MaskPanel
                  clip={selectedClip}
                  currentTime={currentTime}
                  onUpdateClip={updateClip}
                />
              </div>
            </div>
          )}

        {selectedClip &&
          (selectedClip.track === 'audio' || selectedClip.kind === 'video') &&
          (mobileEditTool === 'audio_speed' ||
            mobileEditTool === 'audio_fx') && (
            <div className="absolute inset-0 z-30 flex flex-col border-t border-white/10 bg-[#0d0d11] lg:hidden">
              <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-white/10 bg-[#121217] px-3">
                <span className="truncate text-xs font-semibold text-white">
                  {mobileEditTool === 'audio_speed'
                    ? `Скорость и Тон · ${selectedClip.name}`
                    : `Голосовые эффекты · ${selectedClip.name}`}
                </span>
                <button
                  type="button"
                  onClick={() => setMobileEditTool(null)}
                  className="rounded-md bg-white/10 px-2.5 py-1 text-[11px] font-medium text-zinc-200 hover:bg-white/15 active:scale-95"
                >
                  Готово
                </button>
              </div>
              <div className="studio-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
                <AudioPanel
                  selectedClip={selectedClip}
                  allClips={project.clips}
                  tracks={project.tracks}
                  duration={duration}
                  initialSection={
                    mobileEditTool === 'audio_speed' ? 'speed' : 'fx'
                  }
                  onAddAudioClip={handleAddAudioClip}
                  onUpdateClip={updateClip}
                  onOpenRecorder={() => {
                    setMobileEditTool(null);
                    setShowVoiceRecorder(true);
                  }}
                  onNotify={showTransientNotice}
                />
              </div>
            </div>
          )}

        {selectedClip &&
          selectedClip.track === 'text' &&
          mobileEditTool === 'text' &&
          !isTextColorPickerActive && (
            <div className="absolute inset-0 z-30 flex flex-col border-t border-white/10 bg-[#0d0d11] lg:hidden">
              <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-white/10 bg-[#121217] px-3">
                <div className="flex min-w-0 items-center gap-1.5">
                  <Type className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
                  <span className="truncate text-xs font-semibold text-white">
                    Текст и стилизация
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setTextColorPicker(null);
                    setMobileEditTool(null);
                  }}
                  className="rounded-md bg-cyan-500 px-2.5 py-1 text-[11px] font-bold text-zinc-950 hover:bg-cyan-400 active:scale-95"
                >
                  Готово
                </button>
              </div>
              <div className="studio-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
                <TextPanel
                  compactLayout
                  selectedClip={selectedClip}
                  clips={project.clips}
                  customFonts={project.customFonts ?? []}
                  currentTime={currentTime}
                  autoFocusTrigger={textFocusTrigger}
                  activeColorPickerField={
                    isTextColorPickerActive && textColorPicker
                      ? textColorPicker.field
                      : null
                  }
                  onRequestColorPicker={(field) => {
                    if (!field) {
                      setTextColorPicker(null);
                      return;
                    }
                    setShowChromaKeyPanel(false);
                    setTextColorPicker({clipId: selectedClip.id, field});
                  }}
                  curveEditActive={curveEditActive}
                  onSetCurveEditActive={setCurveEditActive}
                  selectedCurvePointId={selectedCurvePointId}
                  onSelectCurvePoint={setSelectedCurvePointId}
                  onSelectClip={(id) => {
                    setSelectedClipId(id);
                    setTextFocusTrigger((n) => n + 1);
                  }}
                  onAddText={handleAddText}
                  onUpdateClip={updateClip}
                  onAddCustomFont={addCustomFont}
                  onOpenTrackpad={() => {
                    setMobileEditTool(null);
                    setShowTrackpad(true);
                  }}
                  onAddKeyframe={handleAddKeyframeAtPlayhead}
                  hasKeyframeAtPlayhead={hasKeyframeAtPlayhead}
                  onOpenStickers={handleOpenStickers}
                />
              </div>
            </div>
          )}

        {selectedClip &&
          selectedClip.track !== 'audio' &&
          mobileEditTool === 'filters' && (
            <div className="absolute inset-0 z-30 flex flex-col border-t border-white/10 bg-[#0d0d11] lg:hidden">
              <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-white/10 bg-[#121217] px-3">
                <span className="truncate text-xs font-semibold text-white">
                  Фильтры · {selectedClip.name}
                </span>
                <button
                  type="button"
                  onClick={() => setMobileEditTool(null)}
                  className="rounded-md bg-white/10 px-2.5 py-1 text-[11px] font-medium text-zinc-200 hover:bg-white/15 active:scale-95"
                >
                  Готово
                </button>
              </div>
              <div className="studio-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
                <FilterStripPanel
                  clip={selectedClip}
                  customPresets={customColorPresets}
                  previewFallbackSrc={
                    project.clips.find(
                      (c) =>
                        c.kind === 'image' &&
                        c.src &&
                        currentTime >= c.start &&
                        currentTime < c.start + c.duration
                    )?.src ??
                    project.clips.find((c) => c.kind === 'image' && c.src)?.src
                  }
                  onUpdateClip={(id, patch) => updateClip(id, patch)}
                  onOpenAdjust={() => setMobileEditTool('adjust')}
                  onPresetsChanged={setCustomColorPresets}
                />
              </div>
            </div>
          )}

        {selectedClip &&
          selectedClip.track !== 'audio' &&
          mobileEditTool === 'adjust' && (
            <div className="absolute inset-0 z-30 flex flex-col border-t border-white/10 bg-[#0d0d11] lg:hidden">
              <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-white/10 bg-[#121217] px-3">
                <span className="truncate text-xs font-semibold text-white">
                  Настроить · {selectedClip.name}
                </span>
                <button
                  type="button"
                  onClick={() => setMobileEditTool(null)}
                  className="rounded-md bg-white/10 px-2.5 py-1 text-[11px] font-medium text-zinc-200 hover:bg-white/15 active:scale-95"
                >
                  Готово
                </button>
              </div>
              <div className="studio-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
                <ColorAdjustPanel
                  clip={selectedClip}
                  onUpdateClip={updateClip}
                  onPresetsChanged={setCustomColorPresets}
                />
              </div>
            </div>
          )}

        {selectedClip &&
          selectedClip.track !== 'audio' &&
          mobileEditTool === 'keyframes' && (
            <div className="absolute inset-0 z-30 flex flex-col border-t border-white/10 bg-[#0d0d11] lg:hidden">
              <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-white/10 bg-[#121217] px-3">
                <span className="truncate text-xs font-semibold text-white">
                  Ключи · {selectedClip.name}
                </span>
                <button
                  type="button"
                  onClick={() => setMobileEditTool(null)}
                  className="rounded-md bg-white/10 px-2.5 py-1 text-[11px] font-medium text-zinc-200 hover:bg-white/15 active:scale-95"
                >
                  Готово
                </button>
              </div>
              <div className="studio-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
                <KeyframeControls
                  clip={selectedClip}
                  currentTime={currentTime}
                  onSeek={handleSeek}
                  onUpdateClip={(id, patch) => updateClip(id, patch)}
                />
              </div>
            </div>
          )}

        {showVoiceRecorder && (
          <VoiceRecorderOverlay
            currentTime={currentTime}
            onStartPlayback={() => setIsPlaying(true)}
            onStopPlayback={() => setIsPlaying(false)}
            onMutePlaybackChange={(muted) => {
              audioEngineRef.current?.setPlaybackMuted(muted);
            }}
            onRecordingSaved={(rec) => {
              handleAddAudioClip({
                name: rec.name,
                kind: 'audio',
                src: rec.src,
                fileName: rec.fileName,
                remoteUrl: rec.remoteUrl,
                fileSize: rec.fileSize,
                fileHash: rec.fileHash,
                duration: rec.duration,
                startTime: rec.startTime,
                forceNewTrack: false,
              });
              showTransientNotice('Запись голоса добавлена на аудиодорожку');
            }}
            onClose={() => {
              audioEngineRef.current?.setPlaybackMuted(false);
              setIsPlaying(false);
              setShowVoiceRecorder(false);
            }}
          />
        )}
      </div>

      {/* Mobile Bottom Thumb Toolbar */}
      <nav className="shrink-0 border-t border-white/10 bg-[#111114] pb-safe lg:hidden">
        {selectedClip && selectedClip.track !== 'audio' && showOpacitySlider && (
          <div className="flex items-center gap-3 border-b border-white/10 bg-[#15151a] px-3 py-2">
            <span className="shrink-0 text-[11px] font-medium text-cyan-300">
              {selectedClip.track === 'adjustment' ||
              selectedClip.kind === 'adjustment'
                ? 'Интенсивность'
                : 'Прозрачность'}
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={selectedOpacityValue}
              onChange={(e) =>
                handleChangeSelectedOpacity(Number(e.target.value), false)
              }
              onPointerUp={(e) =>
                handleChangeSelectedOpacity(
                  Number((e.target as HTMLInputElement).value),
                  true
                )
              }
              onTouchEnd={(e) =>
                handleChangeSelectedOpacity(
                  Number((e.target as HTMLInputElement).value),
                  true
                )
              }
              className="h-2 flex-1 cursor-pointer accent-cyan-400"
            />
            <ScrubNumberField
              compact
              accent="cyan"
              value={Math.round(selectedOpacityValue * 100)}
              min={0}
              max={100}
              step={1}
              suffix="%"
              ariaLabel="Прозрачность"
              onChange={(pct) => handleChangeSelectedOpacity(pct / 100, false)}
              onCommit={(pct) => handleChangeSelectedOpacity(pct / 100, true)}
            />
            <button
              type="button"
              onClick={() => setShowOpacitySlider(false)}
              className="rounded-md bg-white/10 px-2 py-1 text-[10px] font-medium text-zinc-200"
            >
              Готово
            </button>
          </div>
        )}
        {selectedClip &&
          (selectedClip.kind === 'image' || selectedClip.kind === 'video') &&
          showChromaKeyPanel && (
            <div className="border-b border-white/10 bg-[#14171a] px-3 py-2">
              <ChromaKeyPanel
                clip={selectedClip}
                onUpdateChromaKey={handleUpdateChromaKey}
                onDone={() => setShowChromaKeyPanel(false)}
              />
            </div>
          )}
        {selectedClip ? (
          <div className="no-scrollbar flex h-14 items-center gap-1 overflow-x-auto px-2">
            <button
              type="button"
              onClick={() => {
                setMobileEditTool(null);
                setSelectedClipId(null);
              }}
              className="flex h-11 min-w-[52px] shrink-0 flex-col items-center justify-center rounded-lg bg-zinc-900 px-2 text-[10px] font-medium text-zinc-300"
            >
              <ChevronLeft className="h-4 w-4" />
              <span>Назад</span>
            </button>
            <button
              type="button"
              onClick={handleSplitSelectedOrCurrent}
              disabled={!canSplitNow}
              className="flex h-11 min-w-[66px] shrink-0 flex-col items-center justify-center rounded-lg px-2 text-[10px] font-medium text-zinc-200 hover:bg-white/5 disabled:opacity-35"
            >
              <Scissors className="h-4 w-4 text-cyan-400" />
              <span>Разделить</span>
            </button>
            <button
              type="button"
              onClick={handleDuplicateSelected}
              className="flex h-11 min-w-[58px] shrink-0 flex-col items-center justify-center rounded-lg px-2 text-[10px] font-medium text-zinc-200 hover:bg-white/5"
            >
              <CopyPlus className="h-4 w-4 text-cyan-400" />
              <span>Копия</span>
            </button>
            {(selectedClip.kind === 'image' ||
              selectedClip.kind === 'video') && (
              <label
                className={`flex h-11 min-w-[64px] shrink-0 cursor-pointer flex-col items-center justify-center rounded-lg px-2 text-[10px] font-medium text-zinc-200 hover:bg-white/5 ${
                  replacingMedia ? 'opacity-50 pointer-events-none' : ''
                }`}
              >
                <RefreshCw
                  className={`h-4 w-4 text-cyan-400 ${
                    replacingMedia ? 'animate-spin' : ''
                  }`}
                />
                <span>Заменить</span>
                <input
                  type="file"
                  accept="video/*,image/*"
                  disabled={replacingMedia}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file && selectedClip) {
                      void handleReplaceClipMedia(selectedClip.id, file);
                    }
                    e.target.value = '';
                  }}
                  className="hidden"
                />
              </label>
            )}
            {(selectedClip.track === 'video' ||
              selectedClip.track === 'overlay') && (
              <button
                type="button"
                onClick={() =>
                  moveClipTrackType(
                    selectedClip.id,
                    selectedClip.track === 'video' ? 'overlay' : 'video'
                  )
                }
                className="flex h-11 min-w-[74px] shrink-0 flex-col items-center justify-center rounded-lg px-2 text-[10px] font-medium text-indigo-300 hover:bg-white/5"
              >
                <Layers className="h-4 w-4 text-indigo-400" />
                <span>
                  {selectedClip.track === 'video' ? 'Наложение' : 'Основное'}
                </span>
              </button>
            )}
            {(selectedClip.kind === 'image' ||
              selectedClip.kind === 'video') && (
              <button
                type="button"
                onClick={() => setShowCompressModal(true)}
                className="flex h-11 min-w-[62px] shrink-0 flex-col items-center justify-center rounded-lg px-2 text-[10px] font-medium text-emerald-300 hover:bg-white/5"
              >
                <Minimize2 className="h-4 w-4 text-emerald-400" />
                <span>Сжать</span>
              </button>
            )}
            {selectedClip.track !== 'audio' &&
              selectedClip.track !== 'adjustment' &&
              selectedClip.kind !== 'adjustment' && (
              <button
                type="button"
                onClick={() => {
                  setShowOpacitySlider(false);
                  setShowChromaKeyPanel(false);
                  setShowTrackpad(false);
                  setTrackpadSnapGuides({x: false, y: false});
                  setMobileEditTool((cur) =>
                    cur === 'transform' ? null : 'transform'
                  );
                }}
                className={`flex h-11 min-w-[78px] shrink-0 flex-col items-center justify-center rounded-lg px-2 text-[10px] font-medium transition ${
                  mobileEditTool === 'transform'
                    ? 'bg-cyan-500/20 text-cyan-300'
                    : hasActiveTransformChanges
                      ? 'text-cyan-300 hover:bg-white/5'
                      : 'text-zinc-200 hover:bg-white/5'
                }`}
              >
                <FlipHorizontal2 className="h-4 w-4 text-cyan-400" />
                <span>Трансформ.</span>
              </button>
            )}
            {selectedClip.track !== 'audio' &&
              selectedClip.track !== 'adjustment' &&
              selectedClip.kind !== 'adjustment' && (
              <button
                type="button"
                onClick={() => {
                  setMobileEditTool(null);
                  setShowTrackpad((v) => !v);
                }}
                className={`flex h-11 min-w-[66px] shrink-0 flex-col items-center justify-center rounded-lg px-2 text-[10px] font-medium transition ${
                  showTrackpad
                    ? 'bg-cyan-500/20 text-cyan-300'
                    : 'text-zinc-200 hover:bg-white/5'
                }`}
              >
                <Move className="h-4 w-4 text-cyan-400" />
                <span>Трекпад</span>
              </button>
            )}
            {selectedClip.track !== 'audio' && (
              <button
                type="button"
                onClick={() => {
                  setShowChromaKeyPanel(false);
                  setMobileEditTool(null);
                  setShowOpacitySlider((v) => !v);
                }}
                className={`flex h-11 min-w-[78px] shrink-0 flex-col items-center justify-center rounded-lg px-2 text-[10px] font-medium transition ${
                  showOpacitySlider
                    ? 'bg-cyan-500/20 text-cyan-300'
                    : 'text-zinc-200 hover:bg-white/5'
                }`}
              >
                <Droplet className="h-4 w-4 text-cyan-400" />
                <span>
                  {selectedClip.track === 'adjustment' ||
                  selectedClip.kind === 'adjustment'
                    ? 'Интенсивность'
                    : 'Прозрачность'}
                </span>
              </button>
            )}
            {selectedClip.kind === 'shape' && (
              <button
                type="button"
                onClick={() => {
                  setShowOpacitySlider(false);
                  setShowChromaKeyPanel(false);
                  setShowTrackpad(false);
                  setMobileEditTool((cur) =>
                    cur === 'shape' ? null : 'shape'
                  );
                }}
                className={`flex h-11 min-w-[74px] shrink-0 flex-col items-center justify-center rounded-lg px-2 text-[10px] font-medium transition ${
                  mobileEditTool === 'shape'
                    ? 'bg-cyan-500/20 text-cyan-300'
                    : 'text-zinc-200 hover:bg-white/5'
                }`}
              >
                <PaintBucket className="h-4 w-4 text-cyan-400" />
                <span>Фигура</span>
              </button>
            )}
            {selectedClip.track !== 'audio' &&
              selectedClip.track !== 'adjustment' &&
              selectedClip.kind !== 'adjustment' && (
                <button
                  type="button"
                  onClick={() => handleToggleAdjustmentMask(selectedClip)}
                  className={`flex h-11 min-w-[78px] shrink-0 flex-col items-center justify-center rounded-lg px-2 text-[10px] font-medium transition ${
                    selectedClip.adjustmentMask
                      ? 'bg-violet-500/25 text-violet-200'
                      : 'text-zinc-200 hover:bg-white/5'
                  }`}
                >
                  <Sparkles className="h-4 w-4 text-violet-300" />
                  <span>Корр. маска</span>
                </button>
              )}
            {selectedClip.track !== 'audio' &&
              selectedClip.track !== 'adjustment' &&
              selectedClip.kind !== 'adjustment' && (
                <button
                  type="button"
                  onClick={() => {
                    setShowOpacitySlider(false);
                    setShowChromaKeyPanel(false);
                    setShowTrackpad(false);
                    setTrackpadSnapGuides({x: false, y: false});
                    setMobileEditTool((cur) =>
                      cur === 'mask' ? null : 'mask'
                    );
                  }}
                  className={`flex h-11 min-w-[58px] shrink-0 flex-col items-center justify-center rounded-lg px-2 text-[10px] font-medium transition ${
                    mobileEditTool === 'mask'
                      ? 'bg-cyan-500/20 text-cyan-300'
                      : selectedClip.mask
                        ? 'text-cyan-300 hover:bg-white/5'
                        : 'text-zinc-200 hover:bg-white/5'
                  }`}
                >
                  <Shapes className="h-4 w-4 text-cyan-400" />
                  <span>Маска</span>
                </button>
              )}
            {(selectedClip.kind === 'image' ||
              selectedClip.kind === 'video') && (
              <button
                type="button"
                onClick={() => {
                  setShowOpacitySlider(false);
                  setMobileEditTool(null);
                  setShowChromaKeyPanel((v) => !v);
                }}
                className={`flex h-11 min-w-[74px] shrink-0 flex-col items-center justify-center rounded-lg px-2 text-[10px] font-medium transition ${
                  showChromaKeyPanel
                    ? 'bg-emerald-500/20 text-emerald-300'
                    : selectedClip.chromaKeyEnabled
                      ? 'text-emerald-300 hover:bg-white/5'
                      : 'text-zinc-200 hover:bg-white/5'
                }`}
              >
                <Pipette className="h-4 w-4 text-emerald-400" />
                <span>Удалить фон</span>
              </button>
            )}
            {selectedClip.track !== 'audio' && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setShowOpacitySlider(false);
                    setShowChromaKeyPanel(false);
                    setMobileEditTool((cur) =>
                      cur === 'adjust' ? null : 'adjust'
                    );
                  }}
                  className={`flex h-11 min-w-[68px] shrink-0 flex-col items-center justify-center rounded-lg px-2 text-[10px] font-medium transition ${
                    mobileEditTool === 'adjust'
                      ? 'bg-cyan-500/20 text-cyan-300'
                      : 'text-zinc-200 hover:bg-white/5'
                  }`}
                >
                  <Sliders className="h-4 w-4 text-cyan-400" />
                  <span>Настроить</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowOpacitySlider(false);
                    setShowChromaKeyPanel(false);
                    setMobileEditTool((cur) =>
                      cur === 'filters' ? null : 'filters'
                    );
                  }}
                  className={`flex h-11 min-w-[64px] shrink-0 flex-col items-center justify-center rounded-lg px-2 text-[10px] font-medium transition ${
                    mobileEditTool === 'filters'
                      ? 'bg-cyan-500/20 text-cyan-300'
                      : 'text-zinc-200 hover:bg-white/5'
                  }`}
                >
                  <Palette className="h-4 w-4 text-cyan-400" />
                  <span>Фильтры</span>
                </button>
              </>
            )}
            {(selectedClip.kind === 'image' ||
              selectedClip.kind === 'video') && (
              <button
                type="button"
                onClick={() => {
                  setShowOpacitySlider(false);
                  setShowChromaKeyPanel(false);
                  setMobileEditTool(null);
                  setShowCropModal(true);
                }}
                className={`flex h-11 min-w-[74px] shrink-0 flex-col items-center justify-center rounded-lg px-2 text-[10px] font-medium transition ${
                  selectedClip.crop
                    ? 'text-cyan-300 hover:bg-white/5'
                    : 'text-zinc-200 hover:bg-white/5'
                }`}
              >
                <Crop className="h-4 w-4 text-cyan-400" />
                <span>Кадрировать</span>
              </button>
            )}
            {selectedClip.track !== 'audio' && (
              <button
                type="button"
                onClick={() => {
                  setShowOpacitySlider(false);
                  setShowChromaKeyPanel(false);
                  setShowTrackpad(false);
                  setMobileEditTool((cur) =>
                    cur === 'keyframes' ? null : 'keyframes'
                  );
                }}
                className={`flex h-11 min-w-[60px] shrink-0 flex-col items-center justify-center rounded-lg px-2 text-[10px] font-medium transition ${
                  mobileEditTool === 'keyframes'
                    ? 'bg-amber-500/20 text-amber-300'
                    : (selectedClip.keyframes?.length ?? 0) > 0
                      ? 'text-amber-300 hover:bg-white/5'
                      : 'text-zinc-200 hover:bg-white/5'
                }`}
              >
                <Diamond className="h-4 w-4 text-amber-400" />
                <span>Ключи</span>
              </button>
            )}
            {selectedClip.track === 'overlay' && (
              <button
                type="button"
                onClick={() => setMobileSheet('overlay')}
                className="flex h-11 min-w-[72px] shrink-0 flex-col items-center justify-center rounded-lg px-2 text-[10px] font-medium text-amber-300 hover:bg-white/5"
              >
                <Layers className="h-4 w-4 text-amber-400" />
                <span>PIP/Стиль</span>
              </button>
            )}
            {(selectedClip.track === 'audio' ||
              selectedClip.kind === 'video') && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setShowOpacitySlider(false);
                    setShowChromaKeyPanel(false);
                    setShowTrackpad(false);
                    setShowVoiceRecorder(false);
                    setMobileEditTool((cur) =>
                      cur === 'audio_speed' ? null : 'audio_speed'
                    );
                  }}
                  className={`flex h-11 min-w-[78px] shrink-0 flex-col items-center justify-center rounded-lg px-2 text-[10px] font-medium transition ${
                    mobileEditTool === 'audio_speed'
                      ? 'bg-emerald-500/20 text-emerald-300'
                      : 'text-zinc-200 hover:bg-white/5'
                  }`}
                >
                  <Gauge className="h-4 w-4 text-emerald-400" />
                  <span>
                    {selectedClip.speed}x · {(selectedClip.pitch ?? 1).toFixed(2)}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowOpacitySlider(false);
                    setShowChromaKeyPanel(false);
                    setShowTrackpad(false);
                    setShowVoiceRecorder(false);
                    setMobileEditTool((cur) =>
                      cur === 'audio_fx' ? null : 'audio_fx'
                    );
                  }}
                  className={`flex h-11 min-w-[72px] shrink-0 flex-col items-center justify-center rounded-lg px-2 text-[10px] font-medium transition ${
                    mobileEditTool === 'audio_fx'
                      ? 'bg-cyan-500/20 text-cyan-300'
                      : selectedClip.voiceEffect &&
                          selectedClip.voiceEffect !== 'original'
                        ? 'text-cyan-300 hover:bg-white/5'
                        : 'text-zinc-200 hover:bg-white/5'
                  }`}
                >
                  <Radio className="h-4 w-4 text-cyan-400" />
                  <span>Голос FX</span>
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => {
                if (selectedClip.track === 'text') {
                  setShowOpacitySlider(false);
                  setShowChromaKeyPanel(false);
                  setShowTrackpad(false);
                  setMobileEditTool((cur) => {
                    const next = cur === 'text' ? null : 'text';
                    if (next === 'text') {
                      setTextFocusTrigger((n) => n + 1);
                    }
                    return next;
                  });
                } else {
                  setMobileSheet(
                    selectedClip.track === 'audio' ? 'audio' : 'effects'
                  );
                }
              }}
              className={`flex h-11 min-w-[66px] shrink-0 flex-col items-center justify-center rounded-lg px-2 text-[10px] font-medium transition ${
                selectedClip.track === 'text' && mobileEditTool === 'text'
                  ? 'bg-cyan-500/20 text-cyan-300'
                  : 'text-zinc-200 hover:bg-white/5'
              }`}
            >
              {selectedClip.track === 'audio' ? (
                <Music className="h-4 w-4 text-emerald-400" />
              ) : selectedClip.track === 'text' ? (
                <Type className="h-4 w-4 text-cyan-400" />
              ) : (
                <Sparkles className="h-4 w-4 text-cyan-400" />
              )}
              <span>
                {selectedClip.track === 'text'
                  ? 'Текст/Стиль'
                  : selectedClip.track === 'audio'
                    ? 'Звук'
                    : 'Эффекты'}
              </span>
            </button>
            {selectedClip.kind === 'video' && (
              <button
                type="button"
                onClick={() => {
                  setMobileEditTool(null);
                  setMobileSheet('audio');
                }}
                className="flex h-11 min-w-[58px] shrink-0 flex-col items-center justify-center rounded-lg px-2 text-[10px] font-medium text-emerald-300 hover:bg-white/5"
              >
                <Music className="h-4 w-4 text-emerald-400" />
                <span>Звук</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                deleteClip(selectedClip.id);
                setSelectedClipId(null);
              }}
              className="flex h-11 min-w-[60px] shrink-0 flex-col items-center justify-center rounded-lg px-2 text-[10px] font-medium text-rose-400 hover:bg-rose-500/10"
            >
              <Trash2 className="h-4 w-4" />
              <span>Удалить</span>
            </button>
          </div>
        ) : (
          <div className="no-scrollbar flex h-14 items-center overflow-x-auto px-1">
            {TOOL_TABS.map((tab) => {
              const Icon = tab.icon;
              const isOpen = mobileSheet === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    if (tab.id === 'edit') {
                      handleOpenEditTab();
                    } else if (tab.id === 'overlay') {
                      setShowOverlayChooser(true);
                    } else if (tab.id === 'effects') {
                      handleAddAdjustmentLayer();
                    } else {
                      setMobileSheet(tab.id);
                    }
                  }}
                  className={`flex h-12 min-w-[54px] flex-1 shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-[10px] font-medium transition ${
                    isOpen
                      ? 'text-cyan-400'
                      : 'text-zinc-300 active:bg-white/5'
                  }`}
                >
                  <Icon className="h-4 w-4 sm:h-5 sm:w-5" />
                  <span className="max-w-full truncate px-0.5">{tab.label}</span>
                </button>
              );
            })}
          </div>
        )}
      </nav>

      {/* Compact Overlay Chooser ("Фото / Видео" vs "Фигуры") */}
      {showOverlayChooser && (
        <div
          onClick={() => setShowOverlayChooser(false)}
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/55 p-3 pb-20 backdrop-blur-xs sm:items-center sm:p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm space-y-3 rounded-2xl border border-white/15 bg-[#141418] p-4 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Layers className="h-4 w-4 text-indigo-400" />
                <h3 className="text-sm font-semibold text-white">
                  Добавить наложение
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowOverlayChooser(false)}
                className="rounded-lg bg-zinc-800 px-2.5 py-1 text-[11px] font-medium text-zinc-300 hover:text-white"
              >
                Отмена
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() => {
                  setShowOverlayChooser(false);
                  overlayFileInputRef.current?.click();
                }}
                className="flex h-24 flex-col items-center justify-center gap-2 rounded-xl border border-indigo-400/35 bg-indigo-500/10 p-3 text-center transition hover:border-indigo-400 hover:bg-indigo-500/20 active:scale-95"
              >
                <ImagePlus className="h-6 w-6 text-indigo-300" />
                <span className="text-xs font-semibold text-white">
                  Фото / Видео
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowOverlayChooser(false);
                  setDesktopTab('overlay');
                  setDesktopOverlayView('shapes');
                  setMobileSheet('shapes');
                }}
                className="flex h-24 flex-col items-center justify-center gap-2 rounded-xl border border-cyan-400/35 bg-cyan-500/10 p-3 text-center transition hover:border-cyan-400 hover:bg-cyan-500/20 active:scale-95"
              >
                <Shapes className="h-6 w-6 text-cyan-300" />
                <span className="text-xs font-semibold text-white">Фигуры</span>
              </button>
            </div>
            <button
              type="button"
              onClick={() => {
                setShowOverlayChooser(false);
                setMobileSheet('overlay');
              }}
              className="flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-zinc-900 text-xs font-medium text-zinc-200 hover:border-indigo-400/50 active:scale-[0.99]"
            >
              <Layers className="h-3.5 w-3.5 text-indigo-400" />
              Выбор дорожки, сцены и настройки слоя
            </button>
          </div>
        </div>
      )}

      {/* Mobile Bottom Sheets */}
      {mobileSheet === 'shapes' && (
        <BottomSheet
          title="Фигуры и свойства"
          onClose={() => setMobileSheet(null)}
        >
          <ShapesPanel
            selectedClip={selectedClip}
            onAddShape={handleAddShapeClip}
            onUpdateClip={updateClip}
            onOpenAdjust={() => {
              setMobileSheet(null);
              setMobileEditTool('adjust');
            }}
            onClose={() => setMobileSheet(null)}
          />
        </BottomSheet>
      )}
      {mobileSheet === 'overlay' && (
        <BottomSheet
          title="Наложение и ключи движения"
          onClose={() => setMobileSheet(null)}
        >
          <OverlayPanel
            selectedClip={selectedClip}
            currentTime={currentTime}
            onSeek={handleSeek}
            onAddMediaClip={handleAddMediaClip}
            onUpdateClip={(id, patch) => updateClip(id, patch)}
            onClose={() => setMobileSheet(null)}
          />
        </BottomSheet>
      )}
      {mobileSheet === 'text' && (
        <BottomSheet title="Текст и стилизация" onClose={() => setMobileSheet(null)}>
          <TextPanel
            selectedClip={selectedClip}
            clips={project.clips}
            customFonts={project.customFonts ?? []}
            currentTime={currentTime}
            autoFocusTrigger={textFocusTrigger}
            activeColorPickerField={
              isTextColorPickerActive && textColorPicker
                ? textColorPicker.field
                : null
            }
            onRequestColorPicker={(field) => {
              if (!selectedClip || selectedClip.track !== 'text' || !field) {
                setTextColorPicker(null);
                return;
              }
              setMobileSheet(null);
              setMobileEditTool('text');
              setBgColorPickerActive(false);
              setTextColorPicker({clipId: selectedClip.id, field});
            }}
            curveEditActive={curveEditActive}
            onSetCurveEditActive={setCurveEditActive}
            selectedCurvePointId={selectedCurvePointId}
            onSelectCurvePoint={setSelectedCurvePointId}
            onSelectClip={(id) => {
              setSelectedClipId(id);
              setMobileSheet(null);
              setMobileEditTool('text');
              setTextFocusTrigger((n) => n + 1);
            }}
            onAddText={handleAddText}
            onUpdateClip={updateClip}
            onAddCustomFont={addCustomFont}
            onOpenTrackpad={() => {
              setMobileSheet(null);
              setShowTrackpad(true);
            }}
            onAddKeyframe={handleAddKeyframeAtPlayhead}
            hasKeyframeAtPlayhead={hasKeyframeAtPlayhead}
            onOpenStickers={handleOpenStickers}
          />
        </BottomSheet>
      )}
      {mobileSheet === 'effects' && (
        <BottomSheet
          title="Фильтры и анимация"
          onClose={() => setMobileSheet(null)}
        >
          <EffectsPanel
            selectedClip={selectedClip}
            onUpdateClip={(id, patch) => updateClip(id, patch)}
            onAddAdjustmentLayer={handleAddAdjustmentLayer}
          />
        </BottomSheet>
      )}
      {mobileSheet === 'audio' && (
        <BottomSheet
          title="Звук, голос и эффекты"
          onClose={() => setMobileSheet(null)}
        >
          <AudioPanel
            selectedClip={selectedClip}
            allClips={project.clips}
            tracks={project.tracks}
            duration={duration}
            onAddAudioClip={handleAddAudioClip}
            onUpdateClip={updateClip}
            onOpenRecorder={() => {
              setMobileSheet(null);
              setMobileEditTool(null);
              setShowTrackpad(false);
              setShowVoiceRecorder(true);
            }}
            onNotify={showTransientNotice}
            onClose={() => setMobileSheet(null)}
          />
        </BottomSheet>
      )}
      {mobileSheet === 'settings' && (
        <BottomSheet
          title="Настройки проекта и сети"
          onClose={() => setMobileSheet(null)}
        >
          <ProjectSettingsPanel
            aspectRatio={project.aspectRatio}
            backgroundColor={project.backgroundColor}
            canvasBackground={project.canvasBackground}
            user={user}
            bgColorPickerActive={bgColorPickerActive}
            onToggleBgColorPicker={(active) => {
              if (active) {
                setTextColorPicker(null);
                setShowChromaKeyPanel(false);
                setMobileSheet(null);
              }
              setBgColorPickerActive(active);
            }}
            onUpdateProjectMeta={updateProjectMeta}
            onUpdateProfile={updateUserProfile}
            onGiphyKeyChanged={() => setGiphyKeyVersion((v) => v + 1)}
            onNotify={showTransientNotice}
          />
        </BottomSheet>
      )}
      {mobileSheet === 'team' && (
        <BottomSheet
          title="Чат и сеть (LAN / ZeroTier)"
          onClose={() => setMobileSheet(null)}
        >
          <TeamPanel
            roomId={roomId}
            serverUrl={serverUrl}
            p2pMode={p2pMode}
            networkInterfaces={networkInterfaces}
            hostPort={hostPort}
            udpRooms={udpRooms}
            pingMs={pingMs}
            ktorStatus={ktorStatus}
            downloadQueue={downloadQueue}
            user={user}
            allCollaborators={allCollaborators}
            availableRooms={availableRooms}
            chat={project.chat}
            status={status}
            onUpdateProfile={updateUserProfile}
            onOpenLobby={() => {
              setMobileSheet(null);
              setShowLobbyModal(true);
            }}
            onSwitchRoom={switchRoom}
            onSendChat={sendChatMessage}
            onUpdateServerUrl={updateServerConnection}
            onStartHost={startHostRoom}
            onStopHost={stopHostRoom}
            onConnectToHostIp={connectToHostIp}
            onRefreshNetwork={() => {
              void refreshNetworkInfo();
            }}
            onForceSyncProject={forceSyncProject}
            onRetryDownload={retryMediaDownload}
          />
        </BottomSheet>
      )}

      {/* Minecraft-style LAN / ZeroTier Room Browser Modal */}
      {showLobbyModal && (
        <RoomsLobbyModal
          currentRoomId={roomId}
          serverUrl={serverUrl}
          p2pMode={p2pMode}
          networkInterfaces={networkInterfaces}
          hostPort={hostPort}
          udpRooms={udpRooms}
          status={status}
          availableRooms={availableRooms}
          onSelectRoom={(nextId) => switchRoom(nextId)}
          onCreateRoom={handleCreateRoom}
          onRefreshRooms={() => {
            void refreshRooms();
          }}
          onConnectServer={(url) => updateServerConnection(url)}
          onStartHost={startHostRoom}
          onStopHost={stopHostRoom}
          onConnectToHostIp={connectToHostIp}
          onClose={() => setShowLobbyModal(false)}
        />
      )}

      {/* Export Settings Modal */}
      {showExportModal && (
        <div
          onClick={() => setShowExportModal(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md space-y-4 rounded-2xl border border-white/15 bg-[#141418] p-5 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Download className="h-4 w-4 text-cyan-400" />
                <h3 className="text-base font-semibold text-white">
                  Параметры экспорта
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowExportModal(false)}
                className="rounded-lg bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300 hover:text-white"
              >
                Закрыть
              </button>
            </div>

            {/* Format */}
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-zinc-400">Формат файла</p>
              <div className="grid grid-cols-5 gap-1.5">
                {EXPORT_FORMAT_OPTIONS.map((fmt) => {
                  const active = exportFormat === fmt.id;
                  return (
                    <button
                      key={fmt.id}
                      type="button"
                      onClick={() => setExportFormat(fmt.id)}
                      className={`flex flex-col items-center justify-center rounded-xl border px-1.5 py-2 text-center transition ${
                        active
                          ? 'border-cyan-400 bg-cyan-500/20 text-cyan-200'
                          : 'border-white/10 bg-zinc-900 text-zinc-300 hover:border-white/25'
                      }`}
                    >
                      <span className="text-xs font-bold">{fmt.label}</span>
                      <span className="text-[10px] text-zinc-400">
                        {fmt.ext}
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px] text-zinc-400">
                {
                  EXPORT_FORMAT_OPTIONS.find((f) => f.id === exportFormat)
                    ?.hint
                }
              </p>
            </div>

            {/* Resolution */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-zinc-400">Разрешение</span>
                <span className="font-mono text-[11px] text-cyan-300">
                  {getExportDimensions(project.aspectRatio, exportResolution).width}
                  ×
                  {getExportDimensions(project.aspectRatio, exportResolution).height}
                </span>
              </div>
              <div className="grid grid-cols-5 gap-1.5">
                {EXPORT_RESOLUTION_OPTIONS.map((resOpt) => {
                  const active = exportResolution === resOpt.id;
                  return (
                    <button
                      key={resOpt.id}
                      type="button"
                      onClick={() => setExportResolution(resOpt.id)}
                      className={`flex flex-col items-center justify-center rounded-xl border px-1 py-2 text-center transition ${
                        active
                          ? 'border-cyan-400 bg-cyan-500/20 text-cyan-200'
                          : 'border-white/10 bg-zinc-900 text-zinc-300 hover:border-white/25'
                      }`}
                    >
                      <span className="text-xs font-bold">
                        {resOpt.id === '1440p'
                          ? '2K'
                          : resOpt.id === '2160p'
                            ? '4K'
                            : resOpt.id}
                      </span>
                      <span className="text-[9px] text-zinc-400">
                        {resOpt.hint}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* FPS (hidden/muted for PNG snapshot) */}
            {exportFormat !== 'png' && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-zinc-400">
                  Частота кадров (FPS)
                </p>
                <div className="grid grid-cols-6 gap-1.5">
                  {EXPORT_FPS_OPTIONS.map((fpsOpt) => {
                    const active = exportFps === fpsOpt;
                    return (
                      <button
                        key={fpsOpt}
                        type="button"
                        onClick={() => setExportFps(fpsOpt)}
                        className={`h-9 rounded-xl border text-xs font-semibold transition ${
                          active
                            ? 'border-cyan-400 bg-cyan-500/20 text-cyan-200'
                            : 'border-white/10 bg-zinc-900 text-zinc-300 hover:border-white/25'
                        }`}
                      >
                        {fpsOpt}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Quality preset */}
            {(exportFormat === 'mp4' ||
              exportFormat === 'webm' ||
              exportFormat === 'webp') && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-zinc-400">Качество</p>
                <div className="grid grid-cols-3 gap-1.5">
                  {(
                    [
                      {id: 'standard', label: 'Эконом'},
                      {id: 'high', label: 'Высокое'},
                      {id: 'ultra', label: 'Максимум'},
                    ] as const
                  ).map((q) => (
                    <button
                      key={q.id}
                      type="button"
                      onClick={() => setExportQuality(q.id)}
                      className={`h-9 rounded-xl border text-xs font-medium transition ${
                        exportQuality === q.id
                          ? 'border-cyan-400 bg-cyan-500/20 text-cyan-200'
                          : 'border-white/10 bg-zinc-900 text-zinc-300 hover:border-white/25'
                      }`}
                    >
                      {q.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {(exportFormat === 'webp' || exportFormat === 'gif') &&
              Math.round(duration * exportFps) > MAX_ANIMATED_IMAGE_FRAMES && (
                <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                  Для {exportFormat.toUpperCase()} лимит{' '}
                  {MAX_ANIMATED_IMAGE_FRAMES} кадров (сейчас ~
                  {Math.round(duration * exportFps)} при {exportFps} fps).
                  Уменьшите FPS или выберите MP4/WebM.
                </div>
              )}

            <button
              type="button"
              onClick={() => void handleExportVideo()}
              disabled={
                (exportFormat === 'webp' || exportFormat === 'gif') &&
                Math.round(duration * exportFps) > MAX_ANIMATED_IMAGE_FRAMES
              }
              className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-cyan-500 text-sm font-semibold text-zinc-950 hover:bg-cyan-400 disabled:opacity-45 active:scale-[0.99]"
            >
              <Download className="h-4 w-4" />
              Начать экспорт (.{exportFormat})
            </button>
          </div>
        </div>
      )}

      {/* Video Export Progress / Result Modal */}
      {(exportProgress !== null || exportError) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs">
          <div className="w-full max-w-sm space-y-4 rounded-2xl border border-white/15 bg-[#141418] p-5 shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-white">
                {exportError
                  ? 'Ошибка экспорта'
                  : exportProgress === 100
                    ? exportFormat === 'png'
                      ? 'Кадр готов'
                      : 'Экспорт завершён'
                    : 'Экспорт...'}
              </h3>
              {exportProgress === 100 || exportError ? (
                <button
                  type="button"
                  onClick={() => {
                    setExportProgress(null);
                    setExportError(null);
                  }}
                  className="text-xs text-zinc-400 hover:text-white"
                >
                  Закрыть
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => exportAbortRef.current?.abort()}
                  className="rounded-lg border border-rose-500/40 bg-rose-500/15 px-2.5 py-1 text-xs font-medium text-rose-300 hover:bg-rose-500/25"
                >
                  Отменить
                </button>
              )}
            </div>

            {exportError ? (
              <p className="text-sm text-rose-400">{exportError}</p>
            ) : (
              <>
                <div className="h-2.5 w-full overflow-hidden rounded-full bg-zinc-800">
                  <div
                    style={{width: `${exportProgress ?? 0}%`}}
                    className="h-full bg-cyan-400 transition-all duration-150"
                  />
                </div>
                <div className="flex items-center justify-between text-xs text-zinc-400">
                  <span className="truncate pr-2">
                    {exportProgress === 100 && exportedUrl
                      ? `${exportedUrl.width}×${exportedUrl.height}${
                          exportedUrl.ext === 'png'
                            ? ''
                            : ` · ${exportedUrl.fps} fps`
                        }`
                      : exportStage ||
                        `${getExportDimensions(project.aspectRatio, exportResolution).width}×${getExportDimensions(project.aspectRatio, exportResolution).height}${
                          exportFormat === 'png' ? '' : ` · ${exportFps} fps`
                        }`}
                  </span>
                  <span className="shrink-0 font-mono tabular-nums text-white">
                    {exportProgress}%
                  </span>
                </div>
              </>
            )}

            {exportedUrl && (
              <div className="space-y-3">
                {exportedUrl.ext === 'webp' ||
                exportedUrl.ext === 'gif' ||
                exportedUrl.ext === 'png' ? (
                  <img
                    src={exportedUrl.url}
                    alt={exportedUrl.filename}
                    className="max-h-56 w-full rounded-xl border border-white/10 bg-black object-contain"
                  />
                ) : (
                  <video
                    src={exportedUrl.url}
                    controls
                    playsInline
                    className="max-h-56 w-full rounded-xl border border-white/10 bg-black"
                  />
                )}
                <a
                  href={exportedUrl.url}
                  download={exportedUrl.filename}
                  className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-cyan-500 text-sm font-semibold text-zinc-950 hover:bg-cyan-400"
                >
                  <Download className="h-4 w-4" />
                  Скачать {exportedUrl.filename}
                </a>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Media Compression Quality Dialog (Media3 Transformer / Browser Fallback) */}
      {showCompressModal &&
        selectedClip &&
        (selectedClip.kind === 'video' || selectedClip.kind === 'image') && (
          <CompressMediaModal
            clip={selectedClip}
            onApplyCompressed={(res) =>
              handleApplyCompressedMedia(selectedClip, res)
            }
            onClose={() => setShowCompressModal(false)}
          />
        )}

      {showCropModal &&
        selectedClip &&
        (selectedClip.kind === 'video' || selectedClip.kind === 'image') && (
          <CropEditorModal
            clip={selectedClip}
            currentTime={currentTime}
            onApplyCrop={(crop) => updateClip(selectedClip.id, {crop})}
            onClose={() => setShowCropModal(false)}
          />
        )}

      {showStickersSheet && (
        <StickersSheet
          keyVersion={giphyKeyVersion}
          onSelectSticker={(st) => {
            handleAddMediaClip({
              name: st.name,
              kind: 'image',
              src: st.src,
              fileName: st.fileName,
              remoteUrl: st.remoteUrl,
              fileSize: st.fileSize,
              fileHash: st.fileHash,
              duration: 5,
              track: 'overlay',
              isSticker: true,
            });
            setShowStickersSheet(false);
            showTransientNotice('Стикер добавлен на холст');
          }}
          onOpenSettings={() => setShowAppSettings(true)}
          onClose={() => setShowStickersSheet(false)}
        />
      )}

      {showAppSettings && (
        <AppSettingsModal
          onClose={() => setShowAppSettings(false)}
          onKeyChanged={() => setGiphyKeyVersion((v) => v + 1)}
          onStorageChanged={() => void refreshStorageSummary()}
        />
      )}

      <AIModelManagerModal />

      <input
        ref={overlayFileInputRef}
        type="file"
        accept="video/*,image/*"
        multiple
        onChange={handleOverlayPickerChange}
        className="hidden"
      />
      <OfflineIndicator />
    </div>
  );
}
