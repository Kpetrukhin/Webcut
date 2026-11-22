import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  ChevronLeft,
  CopyPlus,
  Crop,
  Download,
  Droplet,
  FlipHorizontal2,
  Gauge,
  Home,
  Layers,
  MessageSquare,
  Minimize2,
  Move,
  Music,
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
  ColorFilterPreset,
  TextCurvePoint,
} from './shared/types.ts';
import {StudioAudioEngine} from './lib/audioEngine.ts';
import {getCustomColorPresets} from './lib/colorPresets.ts';
import {
  evaluateClipTransform,
  upsertKeyframeAtTime,
} from './lib/keyframeEngine.ts';
import {uploadFileForP2P} from './lib/lanSyncBridge.ts';
import type {CompressedMediaResult} from './lib/lanSyncBridge.ts';
import {
  getLocalProjects,
  removeLocalProject,
  upsertLocalProject,
} from './lib/localProjects.ts';
import type {LocalProjectRecord} from './lib/localProjects.ts';
import {exportProjectToVideo, MediaPool} from './lib/renderEngine.ts';
import {getApiUrl, isNativeCapacitorApp} from './lib/serverConfig.ts';
import {
  colorToHex,
  createDefaultCurvePoints,
  measureBaseTextHalfWidth,
  normalizeTextStyle,
} from './lib/textRenderer.ts';
import {
  hasExplicitRoomInUrl,
  useCollaborativeRoom,
} from './hooks/useCollaborativeRoom.ts';
import {AudioPanel} from './components/AudioPanel.tsx';
import {ChromaKeyPanel} from './components/ChromaKeyPanel.tsx';
import {ColorAdjustPanel} from './components/ColorAdjustPanel.tsx';
import {CropEditorModal} from './components/CropEditorModal.tsx';
import {FilterStripPanel} from './components/FilterStripPanel.tsx';
import {HomeScreen} from './components/HomeScreen.tsx';
import {MaskPanel} from './components/MaskPanel.tsx';
import {PreviewCanvas} from './components/PreviewCanvas.tsx';
import type {CanvasTransformPatch} from './components/PreviewCanvas.tsx';
import {ScrubNumberField} from './components/ScrubNumberField.tsx';
import {Timeline} from './components/Timeline.tsx';
import {TransformPanel} from './components/TransformPanel.tsx';
import {TransformTrackpad} from './components/TransformTrackpad.tsx';
import {VoiceRecorderOverlay} from './components/VoiceRecorderOverlay.tsx';
import {RoomsLobbyModal} from './components/RoomsLobbyModal.tsx';
import {
  BottomSheet,
  CompressMediaModal,
  EffectsPanel,
  KeyframeControls,
  MediaPanel,
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

const ASPECT_OPTIONS: AspectRatio[] = ['9:16', '16:9', '1:1', '4:5'];

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
  const [desktopTab, setDesktopTab] = useState<ActiveToolTab>('media');
  const [mobileSheet, setMobileSheet] = useState<ActiveToolTab | null>(null);
  const [showOpacitySlider, setShowOpacitySlider] = useState(false);
  const [showChromaKeyPanel, setShowChromaKeyPanel] = useState(false);
  const [showTrackpad, setShowTrackpad] = useState(false);
  const [showVoiceRecorder, setShowVoiceRecorder] = useState(false);
  const [showCompressModal, setShowCompressModal] = useState(false);
  const [editSubMode, setEditSubMode] = useState<
    | 'menu'
    | 'transform'
    | 'opacity'
    | 'mask'
    | 'chromakey'
    | 'adjust'
    | 'filters'
  >('menu');
  const [mobileEditTool, setMobileEditTool] = useState<
    | 'transform'
    | 'mask'
    | 'adjust'
    | 'filters'
    | 'audio_speed'
    | 'audio_fx'
    | 'text'
    | null
  >(null);
  const [textFocusTrigger, setTextFocusTrigger] = useState(0);
  const [textColorPicker, setTextColorPicker] = useState<{
    clipId: string;
    field: TextColorField;
  } | null>(null);
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
  const [showLobbyModal, setShowLobbyModal] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(project.title);
  const [exportProgress, setExportProgress] = useState<number | null>(null);
  const [exportedUrl, setExportedUrl] = useState<{
    url: string;
    filename: string;
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

  useEffect(() => {
    setTitleDraft(project.title);
  }, [project.title]);

  useEffect(() => {
    if (selectedClipId && !project.clips.some((c) => c.id === selectedClipId)) {
      setSelectedClipId(null);
    }
  }, [project.clips, selectedClipId]);

  useEffect(() => {
    if (!selectedClip) {
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
      cur && cur.clipId === selectedClip.id && selectedClip.track === 'text'
        ? cur
        : null
    );

    if (selectedClip.track !== 'text') {
      setSelectedCurvePointId(null);
    } else {
      setSelectedCurvePointId((cur) => {
        const pts = selectedClip.textStyle?.curvePoints ?? [];
        if (cur && pts.some((p) => p.id === cur)) return cur;
        return pts[0]?.id ?? null;
      });
    }

    if (selectedClip.track === 'audio') {
      setShowOpacitySlider(false);
      setShowTrackpad(false);
      setTrackpadSnapGuides({x: false, y: false});
      setMobileEditTool((cur) =>
        cur === 'audio_speed' || cur === 'audio_fx' ? cur : null
      );
      setEditSubMode('menu');
    }

    if (selectedClip.kind !== 'image' && selectedClip.kind !== 'video') {
      setShowChromaKeyPanel(false);
      setShowCompressModal(false);
      setShowCropModal(false);
      setMobileEditTool((cur) =>
        cur === 'transform' ||
        cur === 'audio_speed' ||
        cur === 'audio_fx' ||
        (cur === 'text' && selectedClip.track === 'text')
          ? cur
          : null
      );
      setEditSubMode((cur) =>
        cur === 'transform' || cur === 'opacity' ? cur : 'menu'
      );
    }
  }, [selectedClip]);

  useEffect(() => {
    if (screen !== 'editor') return;
    const next = upsertLocalProject({
      roomId: project.roomId || roomId,
      title: project.title,
      aspectRatio: project.aspectRatio,
      backgroundColor: project.backgroundColor || '#09090b',
      updatedAt: Date.now(),
      clipsCount: project.clips.length,
      tracksCount: project.tracks.length,
      snapshot: {
        tracks: project.tracks,
        clips: project.clips,
        customFonts: project.customFonts,
      },
    });
    setLocalProjects(next);
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
        if (next >= duration) {
          setIsPlaying(false);
          return 0;
        }
        audioEngineRef.current?.sync(project.clips, next, true, project.tracks);
        return next;
      });
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      audioEngineRef.current?.stopAll();
    };
  }, [isPlaying, duration, project.clips, project.tracks]);

  const handleSeek = useCallback(
    (time: number) => {
      const clamped = Math.max(0, Math.min(duration, time));
      setCurrentTime(clamped);
      audioEngineRef.current?.sync(
        project.clips,
        clamped,
        isPlaying,
        project.tracks
      );
    },
    [duration, project.clips, project.tracks, isPlaying]
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
      setMobileSheet('media');
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
      duration: number;
      track: 'video' | 'overlay';
      forceNewTrack?: boolean;
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

      const hasRemoteMedia = Boolean(opts.remoteUrl);
      const {clip, newTrack} = addClip(
        {
          id: `clip-${Math.random().toString(36).slice(2, 9)}`,
          track: opts.track,
          kind: opts.kind,
          name: opts.name,
          src: opts.src,
          mediaFileName: opts.fileName,
          mediaRemoteUrl: opts.remoteUrl,
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
          motionEffect:
            opts.kind === 'image' && opts.track === 'video'
              ? 'kenburns-in'
              : 'none',
          mediaScale: opts.track === 'overlay' ? 0.42 : 1,
          mediaX: opts.track === 'overlay' ? 0.72 : 0.5,
          mediaY: opts.track === 'overlay' ? 0.26 : 0.5,
          rotation: 0,
          borderRadius: opts.track === 'overlay' ? 20 : 0,
          blendMode: 'source-over',
        },
        {forceNewTrack: opts.forceNewTrack, skipWs: hasRemoteMedia}
      );

      if (hasRemoteMedia && opts.remoteUrl) {
        sendLayerMediaUpdated({
          layerId: clip.id,
          fileName: opts.fileName || opts.name,
          mediaUrl: opts.remoteUrl,
          localSrc: opts.src,
          clip,
          newTrack,
        });
      }

      setSelectedClipId(clip.id);
      setCurrentTime(start);
    },
    [project.clips, currentTime, addClip, sendLayerMediaUpdated]
  );

  const handleReplaceClipMedia = useCallback(
    async (clipId: string, file: File) => {
      const target = project.clips.find((c) => c.id === clipId);
      if (!target) return;
      if (target.lockedByUserId && target.lockedByUserId !== user.id) return;

      setReplacingMedia(true);
      try {
        const fallbackKind = file.type.startsWith('video/') ? 'video' : 'image';
        const prepared = await uploadFileForP2P(file, fallbackKind);
        const mediaKind = prepared.kind === 'video' ? 'video' : 'image';

        let probedDuration = target.duration;
        if (mediaKind === 'video') {
          probedDuration = await new Promise<number>((resolve) => {
            const v = document.createElement('video');
            v.preload = 'metadata';
            v.onloadedmetadata = () => {
              resolve(
                Number.isFinite(v.duration) && v.duration > 0
                  ? Math.min(60, Math.round(v.duration * 10) / 10)
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
          mediaStatus: 'READY',
          downloadProgress: 100,
          trimStart: 0,
          sourceDuration: mediaKind === 'image' ? 60 : probedDuration,
        };

        sendLayerMediaUpdated({
          layerId: target.id,
          fileName: prepared.fileName,
          mediaUrl: prepared.shareUrl,
          localSrc: prepared.localSrc,
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
        mediaStatus: 'READY',
        downloadProgress: 100,
      };
      sendLayerMediaUpdated({
        layerId: clip.id,
        fileName: res.fileName,
        mediaUrl: res.shareUrl,
        localSrc: res.localSrc,
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
      updateClip(
        target.id,
        {textStyle: nextStyle},
        {skipUndo: !commit, skipSync: !commit}
      );
    },
    [textColorPicker, project.clips, updateClip]
  );

  const handleUpdateCurvePoints = useCallback(
    (clipId: string, points: TextCurvePoint[], commit: boolean) => {
      const target = project.clips.find((c) => c.id === clipId);
      if (!target || target.track !== 'text') return;
      const base = normalizeTextStyle(target.textStyle);
      const nextStyle: NonNullable<Clip['textStyle']> = {
        ...base,
        curveMode: 'custom',
        curvePoints: points,
      };
      updateClip(
        target.id,
        {textStyle: nextStyle},
        {skipUndo: !commit, skipSync: !commit}
      );
    },
    [project.clips, updateClip]
  );

  const handleAddAudioClip = useCallback(
    (opts: {
      name: string;
      kind: 'audio' | 'synth';
      src: string;
      fileName?: string;
      remoteUrl?: string;
      duration: number;
      startTime?: number;
      forceNewTrack?: boolean;
    }) => {
      const start = Math.max(
        0,
        Math.round((opts.startTime ?? currentTime) * 100) / 100
      );
      const hasRemote = Boolean(opts.remoteUrl);
      const {clip, newTrack} = addClip(
        {
          id: `clip-${Math.random().toString(36).slice(2, 9)}`,
          track: 'audio',
          kind: opts.kind,
          name: opts.name,
          src: opts.src,
          mediaFileName: opts.fileName,
          mediaRemoteUrl: opts.remoteUrl,
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
          clip,
          newTrack,
        });
      }

      setSelectedClipId(clip.id);
    },
    [currentTime, addClip, sendLayerMediaUpdated]
  );

  const handleTransformClipOnCanvas = useCallback(
    (clipId: string, patch: CanvasTransformPatch, commit: boolean) => {
      const target = project.clips.find((c) => c.id === clipId);
      if (!target) return;

      if (target.keyframes && target.keyframes.length > 0) {
        const {keyframes} = upsertKeyframeAtTime(target, currentTime, {
          x: patch.x,
          y: patch.y,
          ...(patch.scale !== undefined ? {scale: patch.scale} : {}),
          ...(patch.rotation !== undefined ? {rotation: patch.rotation} : {}),
        });
        updateClip(
          clipId,
          {keyframes},
          {skipUndo: !commit, skipSync: !commit}
        );
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
          {skipUndo: !commit, skipSync: !commit}
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
          {skipUndo: !commit, skipSync: !commit}
        );
      }
    },
    [project.clips, currentTime, updateClip]
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
          {opacity: clamped, keyframes},
          {skipUndo: !commit, skipSync: !commit}
        );
        return;
      }
      updateClip(
        selectedClip.id,
        {opacity: clamped},
        {skipUndo: !commit, skipSync: !commit}
      );
    },
    [selectedClip, currentTime, updateClip]
  );

  const handlePickChromaKeyColor = useCallback(
    (clipId: string, hexColor: string, commit: boolean) => {
      const target = project.clips.find((c) => c.id === clipId);
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
        {skipUndo: !commit, skipSync: !commit}
      );
    },
    [project.clips, updateClip]
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
      updateClip(clipId, patch, {skipUndo: !commit, skipSync: !commit});
    },
    [updateClip]
  );

  const handleTransformMaskOnCanvas = useCallback(
    (clipId: string, patch: Partial<ClipMask>, commit: boolean) => {
      const target = project.clips.find((c) => c.id === clipId);
      if (!target?.mask) return;
      updateClip(
        clipId,
        {mask: {...target.mask, ...patch}},
        {skipUndo: !commit, skipSync: !commit}
      );
    },
    [project.clips, updateClip]
  );

  const lastTimelineSyncRef = useRef(0);
  const handleClipTransform = useCallback(
    (clipId: string, patch: Partial<Clip>, commit: boolean) => {
      const now = Date.now();
      const shouldSync = commit || now - lastTimelineSyncRef.current >= 70;
      if (shouldSync) lastTimelineSyncRef.current = now;
      updateClip(clipId, patch, {
        skipUndo: !commit,
        skipSync: !shouldSync,
      });
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
    setIsPlaying(false);
    setExportError(null);
    setExportedUrl(null);
    setExportProgress(1);

    try {
      const {blob, ext} = await exportProjectToVideo({
        clips: project.clips,
        tracks: project.tracks,
        aspectRatio: project.aspectRatio,
        backgroundColor: project.backgroundColor,
        customFonts: project.customFonts,
        duration,
        pool: mediaPoolRef.current!,
        audioEngine: audioEngineRef.current!,
        onProgress: (pct) => setExportProgress(pct),
      });

      const url = URL.createObjectURL(blob);
      const safeTitle =
        project.title.replace(/[^a-zA-Zа-яА-Я0-9_-]/g, '_') || 'CutSync';
      const filename = `${safeTitle}.${ext}`;
      setExportedUrl({url, filename});

      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      setExportError(
        err instanceof Error
          ? err.message
          : 'Браузер не поддерживает запись Canvas видео'
      );
    }
  };

  const cycleAspectRatio = () => {
    const idx = ASPECT_OPTIONS.indexOf(project.aspectRatio);
    const next = ASPECT_OPTIONS[(idx + 1) % ASPECT_OPTIONS.length];
    updateProjectMeta({aspectRatio: next});
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

  const selectedOpacityValue = selectedClip
    ? evaluateClipTransform(selectedClip, currentTime).opacity
    : 1;

  const isMaskEditActive = Boolean(
    selectedClip &&
      (selectedClip.kind === 'image' || selectedClip.kind === 'video') &&
      ((desktopTab === 'edit' && editSubMode === 'mask') ||
        mobileEditTool === 'mask')
  );

  const isChromaKeyPickerActive = Boolean(
    selectedClip &&
      (selectedClip.kind === 'image' || selectedClip.kind === 'video') &&
      !textColorPicker &&
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
        />
        <OfflineIndicator />
      </>
    );
  }

  return (
    <div className="flex h-[100dvh] w-full flex-col overflow-hidden bg-[#09090b] text-zinc-100">
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
        <div className="flex items-center gap-1.5">
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

        {/* Right: Background Color, Aspect Ratio, PWA Install, Export */}
        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          <input
            type="color"
            value={project.backgroundColor || '#09090b'}
            onChange={(e) =>
              updateProjectMeta({backgroundColor: e.target.value})
            }
            title="Цвет фона холста"
            className="h-8 w-7 cursor-pointer rounded-md border border-white/15 bg-transparent p-0.5 sm:h-9 sm:w-8"
          />

          <button
            type="button"
            onClick={cycleAspectRatio}
            className="flex h-8 items-center justify-center rounded-lg border border-white/10 bg-zinc-900 px-2 font-mono text-[11px] font-medium text-zinc-200 hover:border-white/25 whitespace-nowrap sm:h-9"
            title="Сменить формат кадра"
          >
            {project.aspectRatio}
          </button>

          <PWAInstallButton />

          <button
            type="button"
            onClick={handleExportVideo}
            disabled={project.clips.length === 0 || exportProgress !== null}
            className="flex h-8 items-center gap-1 rounded-lg bg-cyan-500 px-2.5 text-xs font-semibold text-zinc-950 hover:bg-cyan-400 disabled:opacity-45 active:scale-95 whitespace-nowrap sm:h-9 sm:px-3"
          >
            <Download className="h-3.5 w-3.5" />
            <span>Экспорт</span>
          </button>
        </div>
      </header>

      {/* Main Studio Body */}
      <div className="flex flex-1 min-h-0 flex-col lg:grid lg:grid-cols-[360px_1fr_310px]">
        {/* Desktop Left Sidebar */}
        <aside className="hidden border-r border-white/10 bg-[#111114] lg:flex lg:min-h-0 lg:flex-col">
          <div className="grid grid-cols-7 gap-0.5 border-b border-white/10 p-1.5">
            {TOOL_TABS.map((tab) => {
              const Icon = tab.icon;
              const active = desktopTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
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
                              : 'Аудиодорожка'}
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={handleSplitSelectedOrCurrent}
                        disabled={!canSplitNow}
                        className="flex h-11 items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-zinc-900 px-3 text-xs font-medium text-zinc-200 hover:border-cyan-400 disabled:opacity-35"
                      >
                        <Scissors className="h-4 w-4 text-cyan-400" />
                        Разделить
                      </button>
                      <button
                        type="button"
                        onClick={handleDuplicateSelected}
                        className="flex h-11 items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-zinc-900 px-3 text-xs font-medium text-zinc-200 hover:border-cyan-400"
                      >
                        <CopyPlus className="h-4 w-4 text-cyan-400" />
                        Копия
                      </button>
                      {(selectedClip.kind === 'image' ||
                        selectedClip.kind === 'video') && (
                        <label
                          className={`flex h-11 cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-zinc-900 px-3 text-xs font-medium text-zinc-200 hover:border-cyan-400 ${
                            replacingMedia ? 'opacity-50 pointer-events-none' : ''
                          }`}
                        >
                          <RefreshCw
                            className={`h-4 w-4 text-cyan-400 ${
                              replacingMedia ? 'animate-spin' : ''
                            }`}
                          />
                          Заменить
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
                          className="flex h-11 items-center justify-center gap-1.5 rounded-xl border border-indigo-500/35 bg-indigo-500/10 px-3 text-xs font-medium text-indigo-200 hover:border-indigo-400"
                        >
                          <Layers className="h-4 w-4 text-indigo-400" />
                          {selectedClip.track === 'video'
                            ? 'Наложение'
                            : 'Основное'}
                        </button>
                      )}
                      {(selectedClip.kind === 'image' ||
                        selectedClip.kind === 'video') && (
                        <button
                          type="button"
                          onClick={() => setShowCompressModal(true)}
                          className="flex h-11 items-center justify-center gap-1.5 rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-3 text-xs font-medium text-emerald-200 hover:border-emerald-400"
                        >
                          <Minimize2 className="h-4 w-4 text-emerald-400" />
                          Сжать (Качество)
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          deleteClip(selectedClip.id);
                          setSelectedClipId(null);
                        }}
                        className="flex h-11 items-center justify-center gap-1.5 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 text-xs font-medium text-rose-300 hover:border-rose-400"
                      >
                        <Trash2 className="h-4 w-4" />
                        Удалить
                      </button>
                    </div>

                    {selectedClip.track !== 'audio' && (
                      <>
                        {editSubMode === 'menu' ? (
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
                                    selectedClip.flipHorizontal ||
                                    selectedClip.flipVertical ||
                                    Math.abs((selectedClip.scaleX ?? 1) - 1) >
                                      0.01 ||
                                    Math.abs((selectedClip.scaleY ?? 1) - 1) >
                                      0.01
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

                            {/* Section 2: Mask & Chroma Key (for image/video) */}
                            {(selectedClip.kind === 'image' ||
                              selectedClip.kind === 'video') && (
                              <>
                                <div className="space-y-2 border-t border-white/10 pt-3">
                                  <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                                    Маска и вырезка фона
                                  </p>
                                  <div className="grid grid-cols-2 gap-2">
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
                                  </div>
                                </div>

                                <div className="space-y-2 border-t border-white/10 pt-3">
                                  <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                                    Цвет и кадрирование
                                  </p>
                                  <div className="grid grid-cols-3 gap-2">
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
                                      onClick={() => setShowCropModal(true)}
                                      className={`flex h-16 flex-col items-center justify-center gap-1 rounded-xl border px-2 text-[11px] font-medium transition ${
                                        selectedClip.crop
                                          ? 'border-cyan-400/60 bg-cyan-500/15 text-cyan-200'
                                          : 'border-white/10 bg-zinc-900 text-zinc-200 hover:border-cyan-400'
                                      }`}
                                    >
                                      <Crop className="h-4 w-4 text-cyan-400" />
                                      <span>Кадрировать</span>
                                    </button>
                                  </div>
                                </div>
                              </>
                            )}
                          </div>
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
                                  : editSubMode === 'opacity'
                                    ? 'Прозрачность'
                                    : editSubMode === 'mask'
                                      ? 'Маска'
                                      : editSubMode === 'chromakey'
                                        ? 'Удалить фон (Хромакей)'
                                        : editSubMode === 'adjust'
                                          ? 'Цветокоррекция'
                                          : 'Фильтры'}
                              </span>
                            </div>

                            {editSubMode === 'transform' && (
                              <TransformPanel
                                clip={selectedClip}
                                onUpdateClip={updateClip}
                                onOpenTrackpad={() =>
                                  setShowTrackpad((v) => !v)
                                }
                                trackpadActive={showTrackpad}
                              />
                            )}

                            {editSubMode === 'opacity' && (
                              <div className="space-y-3 rounded-xl border border-white/10 bg-zinc-900/60 p-3">
                                <div className="flex items-center justify-between text-xs text-zinc-300">
                                  <span>Прозрачность слоя</span>
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
                                onUpdateClip={(id, patch) =>
                                  updateClip(id, patch)
                                }
                                onOpenAdjust={() => setEditSubMode('adjust')}
                                onPresetsChanged={setCustomColorPresets}
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
            {desktopTab === 'media' && (
              <MediaPanel onAddMediaClip={handleAddMediaClip} />
            )}
            {desktopTab === 'overlay' && (
              <OverlayPanel
                selectedClip={selectedClip}
                currentTime={currentTime}
                onSeek={handleSeek}
                onAddMediaClip={handleAddMediaClip}
                onUpdateClip={(id, patch) => updateClip(id, patch)}
              />
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
              />
            )}
            {desktopTab === 'effects' && (
              <EffectsPanel
                selectedClip={selectedClip}
                onUpdateClip={(id, patch) => updateClip(id, patch)}
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
            {desktopTab === 'team' && (
              <TeamPanel
                roomId={roomId}
                serverUrl={serverUrl}
                p2pMode={p2pMode}
                networkInterfaces={networkInterfaces}
                hostPort={hostPort}
                udpRooms={udpRooms}
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
              />
            )}
          </div>
        </aside>

        {/* Center Preview Canvas + Transport Bar */}
        <main className="relative flex flex-1 min-h-0 flex-col bg-[#09090b]">
          {(lockWarning || noticeMsg) && (
            <div className="pointer-events-none absolute top-3 left-1/2 z-30 -translate-x-1/2 rounded-full border border-amber-400/50 bg-zinc-950/90 px-3.5 py-1.5 text-xs font-semibold text-amber-300 shadow-lg backdrop-blur-xs">
              {lockWarning || noticeMsg}
            </div>
          )}
          {isTextColorPickerActive && (
            <div className="absolute top-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border border-cyan-400/60 bg-zinc-950/90 px-3 py-1.5 shadow-xl backdrop-blur-xs">
              <span
                className="h-4 w-4 shrink-0 rounded-full border border-white/40"
                style={{backgroundColor: textColorPickerHex}}
              />
              <span className="whitespace-nowrap text-[11px] font-medium text-cyan-200">
                Пипетка ({textColorPickerFieldLabel}): ведите по холсту
              </span>
              <button
                type="button"
                onClick={() => setTextColorPicker(null)}
                className="rounded-full bg-cyan-500 px-2.5 py-0.5 text-[10px] font-bold text-zinc-950 hover:bg-cyan-400"
              >
                Готово
              </button>
            </div>
          )}
          {isCurveEditOverlayActive && selectedClip && (
            <div className="absolute top-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-cyan-400/50 bg-zinc-950/90 px-2.5 py-1 shadow-xl backdrop-blur-xs">
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
          <div className="flex-1 min-h-0">
            <PreviewCanvas
              tracks={project.tracks}
              clips={project.clips}
              aspectRatio={project.aspectRatio}
              backgroundColor={project.backgroundColor}
              customFonts={project.customFonts}
              currentTime={currentTime}
              isPlaying={isPlaying}
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
              colorPickerActive={isTextColorPickerActive}
              colorPickerPreviewHex={textColorPickerHex}
              onPickCanvasColor={handlePickTextCanvasColor}
              maskEditActive={isMaskEditActive}
              onTransformMask={handleTransformMaskOnCanvas}
              curveEditActive={isCurveEditOverlayActive}
              selectedCurvePointId={selectedCurvePointId}
              onSelectCurvePoint={setSelectedCurvePointId}
              onUpdateCurvePoints={handleUpdateCurvePoints}
              onLockLayer={sendLayerLock}
              onSelectClip={setSelectedClipId}
              onDoubleClickTextClip={handleDoubleClickTextClip}
              onTransformClip={handleTransformClipOnCanvas}
            />
          </div>

          {/* Transport Bar */}
          <div className="flex h-11 shrink-0 items-center justify-between border-t border-white/5 bg-[#101013] px-3 sm:px-4">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={undo}
                disabled={!canUndo}
                aria-label="Отменить"
                className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-300 hover:bg-white/10 disabled:opacity-30"
              >
                <Undo2 className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={redo}
                disabled={!canRedo}
                aria-label="Повторить"
                className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-300 hover:bg-white/10 disabled:opacity-30"
              >
                <Redo2 className="h-4 w-4" />
              </button>
            </div>

            <div className="flex items-center gap-2 sm:gap-3">
              <span className="font-mono text-xs tabular-nums text-white">
                {formatTimecode(currentTime)}
              </span>
              <button
                type="button"
                onClick={() => setIsPlaying((p) => !p)}
                aria-label={isPlaying ? 'Пауза' : 'Воспроизвести'}
                className="flex h-9 w-11 items-center justify-center rounded-full bg-white text-zinc-950 shadow hover:bg-zinc-200 active:scale-95"
              >
                {isPlaying ? (
                  <Pause className="h-4 w-4 fill-current" />
                ) : (
                  <Play className="ml-0.5 h-4 w-4 fill-current" />
                )}
              </button>
              <button
                type="button"
                onClick={handleAddKeyframeAtPlayhead}
                disabled={!selectedClip || selectedClip.track === 'audio'}
                title="Поставить ключевой кадр в текущем времени"
                aria-label="Ключевой кадр"
                className={`flex h-8 w-8 items-center justify-center rounded-lg border transition active:scale-95 disabled:opacity-30 ${
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
              <span className="font-mono text-xs tabular-nums text-zinc-500">
                {formatTimecode(duration)}
              </span>
            </div>

            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={handleSplitSelectedOrCurrent}
                disabled={!canSplitNow}
                title="Разделить клип по линии времени (S)"
                className="flex h-9 items-center gap-1 rounded-lg px-2 text-xs font-medium text-zinc-200 hover:bg-white/10 disabled:opacity-30"
              >
                <Scissors className="h-4 w-4 text-cyan-400" />
                <span className="hidden sm:inline">Разделить</span>
              </button>
              <button
                type="button"
                onClick={() =>
                  replaceClips(createStarterClips(), {
                    tracks: createDefaultTracks(),
                  })
                }
                title="Сбросить к демо-проекту"
                className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-400 hover:bg-white/10 hover:text-white"
              >
                <RotateCcw className="h-4 w-4" />
              </button>
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

              <div className="grid grid-cols-3 gap-2">
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
                <button
                  type="button"
                  onClick={handleCycleSpeed}
                  className="flex h-10 flex-col items-center justify-center rounded-lg border border-white/10 bg-zinc-900 text-[11px] text-zinc-200 hover:border-cyan-400"
                >
                  <Gauge className="mb-0.5 h-3.5 w-3.5 text-cyan-400" />
                  {selectedClip.speed}x
                </button>
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
                    className="flex h-9 items-center justify-center gap-1.5 rounded-lg border border-indigo-500/35 bg-indigo-500/10 px-2.5 text-xs font-medium text-indigo-200 hover:border-indigo-400"
                  >
                    <Layers className="h-3.5 w-3.5 text-indigo-400" />
                    <span>
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
                      className="flex h-9 items-center justify-center gap-1.5 rounded-lg border border-emerald-500/35 bg-emerald-500/10 px-2.5 text-xs font-medium text-emerald-200 hover:border-emerald-400"
                    >
                      <Minimize2 className="h-3.5 w-3.5 text-emerald-400" />
                      <span>Сжать</span>
                    </button>
                  )}
                </div>
              )}

              {selectedClip.track !== 'audio' && (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setShowTrackpad((v) => !v)}
                      className={`flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border text-xs font-medium transition ${
                        showTrackpad
                          ? 'border-cyan-400 bg-cyan-500/20 text-cyan-200'
                          : 'border-white/10 bg-zinc-900 text-zinc-200 hover:border-cyan-400/60'
                      }`}
                    >
                      <Move className="h-3.5 w-3.5 text-cyan-400" />
                      <span>Трекпад</span>
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
                          className={`flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border text-xs font-medium transition ${
                            showChromaKeyPanel
                              ? 'border-emerald-400 bg-emerald-500/20 text-emerald-200'
                              : selectedClip.chromaKeyEnabled
                                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                                : 'border-white/10 bg-zinc-900 text-zinc-200 hover:border-emerald-400/60'
                          }`}
                        >
                          <Pipette className="h-3.5 w-3.5 text-emerald-400" />
                          <span>Хромакей</span>
                        </button>
                        <label
                          className={`flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-zinc-900 px-2.5 text-xs font-medium text-zinc-200 hover:border-cyan-400/60 ${
                            replacingMedia ? 'opacity-50 pointer-events-none' : ''
                          }`}
                        >
                          <RefreshCw
                            className={`h-3.5 w-3.5 text-cyan-400 ${
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

              {(selectedClip.track === 'overlay' ||
                selectedClip.track === 'text') && (
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
        className={`relative shrink-0 ${
          selectedClip?.track === 'text' &&
          mobileEditTool === 'text' &&
          !isTextColorPickerActive
            ? 'h-[310px] sm:h-[330px] lg:h-[260px]'
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
                  onUpdateClip={updateClip}
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
          (selectedClip.kind === 'image' || selectedClip.kind === 'video') &&
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
              Прозрачность
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
        {selectedClip &&
          (selectedClip.kind === 'image' || selectedClip.kind === 'video') &&
          mobileEditTool === 'filters' && (
            <div className="border-b border-white/10 bg-[#141418] px-3 py-2.5">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold text-white">
                  Фильтры
                </span>
                <button
                  type="button"
                  onClick={() => setMobileEditTool(null)}
                  className="rounded-md bg-white/10 px-2 py-1 text-[10px] font-medium text-zinc-200"
                >
                  Готово
                </button>
              </div>
              <FilterStripPanel
                clip={selectedClip}
                customPresets={customColorPresets}
                onUpdateClip={(id, patch) => updateClip(id, patch)}
                onOpenAdjust={() => setMobileEditTool('adjust')}
                onPresetsChanged={setCustomColorPresets}
              />
            </div>
          )}
        {selectedClip &&
          (selectedClip.kind === 'image' || selectedClip.kind === 'video') &&
          mobileEditTool === 'adjust' && (
            <div className="studio-scrollbar max-h-[45dvh] overflow-y-auto border-b border-white/10 bg-[#141418] px-3 py-3">
              <div className="mb-2.5 flex items-center justify-between">
                <span className="text-xs font-semibold text-white">
                  Настроить (Цветокоррекция)
                </span>
                <button
                  type="button"
                  onClick={() => setMobileEditTool(null)}
                  className="rounded-md bg-white/10 px-2 py-1 text-[10px] font-medium text-zinc-200"
                >
                  Готово
                </button>
              </div>
              <ColorAdjustPanel
                clip={selectedClip}
                onUpdateClip={updateClip}
                onPresetsChanged={setCustomColorPresets}
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
            {selectedClip.track !== 'audio' && (
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
                    : selectedClip.flipHorizontal ||
                        selectedClip.flipVertical ||
                        Math.abs((selectedClip.scaleX ?? 1) - 1) > 0.01 ||
                        Math.abs((selectedClip.scaleY ?? 1) - 1) > 0.01
                      ? 'text-cyan-300 hover:bg-white/5'
                      : 'text-zinc-200 hover:bg-white/5'
                }`}
              >
                <FlipHorizontal2 className="h-4 w-4 text-cyan-400" />
                <span>Трансформ.</span>
              </button>
            )}
            {selectedClip.track !== 'audio' && (
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
                <span>Прозрачность</span>
              </button>
            )}
            {(selectedClip.kind === 'image' ||
              selectedClip.kind === 'video') && (
              <>
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
              </>
            )}
            {selectedClip.track === 'overlay' && (
              <button
                type="button"
                onClick={() => setMobileSheet('overlay')}
                className="flex h-11 min-w-[72px] shrink-0 flex-col items-center justify-center rounded-lg px-2 text-[10px] font-medium text-amber-300 hover:bg-white/5"
              >
                <Layers className="h-4 w-4 text-amber-400" />
                <span>PIP/Ключи</span>
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
          <div className="grid h-14 grid-cols-7 items-center px-0.5">
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
                    } else {
                      setMobileSheet(tab.id);
                    }
                  }}
                  className={`flex h-12 flex-col items-center justify-center gap-0.5 rounded-lg text-[10px] font-medium transition ${
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

      {/* Mobile Bottom Sheets */}
      {mobileSheet === 'media' && (
        <BottomSheet
          title="Добавить видео или фото"
          onClose={() => setMobileSheet(null)}
        >
          <MediaPanel
            onAddMediaClip={handleAddMediaClip}
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

      {/* Video Export Modal */}
      {(exportProgress !== null || exportError) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs">
          <div className="w-full max-w-sm space-y-4 rounded-2xl border border-white/15 bg-[#141418] p-5 shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-white">
                {exportError
                  ? 'Ошибка экспорта'
                  : exportProgress === 100
                    ? 'Видео готово'
                    : 'Рендер видео...'}
              </h3>
              {(exportProgress === 100 || exportError) && (
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
                  <span>Формат {project.aspectRatio} · 30 fps</span>
                  <span className="font-mono tabular-nums text-white">
                    {exportProgress}%
                  </span>
                </div>
              </>
            )}

            {exportedUrl && (
              <div className="space-y-3">
                <video
                  src={exportedUrl.url}
                  controls
                  playsInline
                  className="max-h-56 w-full rounded-xl border border-white/10 bg-black"
                />
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

      <OfflineIndicator />
    </div>
  );
}
