import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  ChevronLeft,
  CopyPlus,
  Download,
  Gauge,
  Pause,
  Play,
  Redo2,
  RotateCcw,
  Scissors,
  Share2,
  Sparkles,
  Trash2,
  Undo2,
  Users,
} from 'lucide-react';
import {
  createStarterClips,
  getProjectDuration,
} from './shared/types.ts';
import type {AspectRatio, Clip} from './shared/types.ts';
import {StudioAudioEngine} from './lib/audioEngine.ts';
import {exportProjectToVideo, MediaPool} from './lib/renderEngine.ts';
import {getApiUrl} from './lib/serverConfig.ts';
import {useCollaborativeRoom} from './hooks/useCollaborativeRoom.ts';
import {PreviewCanvas} from './components/PreviewCanvas.tsx';
import {Timeline} from './components/Timeline.tsx';
import {
  AudioPanel,
  BottomSheet,
  EffectsPanel,
  MediaPanel,
  TeamPanel,
  TOOL_TABS,
  TextPanel,
} from './components/ToolSheets.tsx';
import type {ActiveToolTab} from './components/ToolSheets.tsx';
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
    status,
    project,
    collaborators,
    allCollaborators,
    canUndo,
    canRedo,
    addClip,
    updateClip,
    deleteClip,
    splitClip,
    updateProjectMeta,
    replaceClips,
    undo,
    redo,
    sendPresence,
    sendChatMessage,
    switchRoom,
    updateUserProfile,
    updateServerConnection,
  } = useCollaborativeRoom();

  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [pxPerSec, setPxPerSec] = useState(64);
  const [desktopTab, setDesktopTab] = useState<ActiveToolTab>('media');
  const [mobileSheet, setMobileSheet] = useState<ActiveToolTab | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(project.title);
  const [exportProgress, setExportProgress] = useState<number | null>(null);
  const [exportedUrl, setExportedUrl] = useState<{
    url: string;
    filename: string;
  } | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [copiedInvite, setCopiedInvite] = useState(false);

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

  // Clear selection if remote user deleted selected clip
  useEffect(() => {
    if (selectedClipId && !project.clips.some((c) => c.id === selectedClipId)) {
      setSelectedClipId(null);
    }
  }, [project.clips, selectedClipId]);

  // Broadcast live playhead & selected clip presence to collaborators
  useEffect(() => {
    sendPresence(currentTime, selectedClipId, isPlaying);
  }, [currentTime, selectedClipId, isPlaying, sendPresence]);

  // Playback loop
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
        audioEngineRef.current?.sync(project.clips, next, true);
        return next;
      });
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      audioEngineRef.current?.stopAll();
    };
  }, [isPlaying, duration, project.clips]);

  const handleSeek = useCallback(
    (time: number) => {
      const clamped = Math.max(0, Math.min(duration, time));
      setCurrentTime(clamped);
      audioEngineRef.current?.sync(project.clips, clamped, isPlaying);
    },
    [duration, project.clips, isPlaying]
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
    const copy: Clip = {
      ...structuredClone(selectedClip),
      id: `clip-${Math.random().toString(36).slice(2, 9)}`,
      name: `${selectedClip.name} (копия)`,
      start: Math.round((selectedClip.start + selectedClip.duration) * 100) / 100,
    };
    addClip(copy);
    setSelectedClipId(copy.id);
  }, [selectedClip, addClip]);

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

  // Keyboard shortcuts for desktop editors
  useEffect(() => {
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
      duration: number;
      track: 'video' | 'overlay';
    }) => {
      const sameTrack = project.clips.filter((c) => c.track === opts.track);
      const trackEnd = sameTrack.reduce(
        (acc, c) => Math.max(acc, c.start + c.duration),
        0
      );
      const start =
        opts.track === 'video'
          ? Math.round(trackEnd * 100) / 100
          : Math.round(currentTime * 100) / 100;

      const clip: Clip = {
        id: `clip-${Math.random().toString(36).slice(2, 9)}`,
        track: opts.track,
        kind: opts.kind,
        name: opts.name,
        src: opts.src,
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
        transitionIn: 'fade',
        motionEffect: opts.kind === 'image' ? 'kenburns-in' : 'none',
        mediaScale: opts.track === 'overlay' ? 0.45 : 1,
        mediaX: opts.track === 'overlay' ? 0.72 : 0.5,
        mediaY: opts.track === 'overlay' ? 0.25 : 0.5,
      };
      addClip(clip);
      setSelectedClipId(clip.id);
      setCurrentTime(start);
    },
    [project.clips, currentTime, addClip]
  );

  const handleAddText = useCallback(
    (text: string) => {
      const clip: Clip = {
        id: `clip-${Math.random().toString(36).slice(2, 9)}`,
        track: 'text',
        kind: 'text',
        name: text.slice(0, 18),
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
        transitionIn: 'fade',
        motionEffect: 'none',
        text,
        textStyle: {
          fontSize: 48,
          color: '#ffffff',
          bgColor: 'rgba(9, 9, 11, 0.72)',
          fontWeight: 'bold',
          x: 0.5,
          y: 0.75,
          align: 'center',
        },
      };
      addClip(clip);
      setSelectedClipId(clip.id);
    },
    [currentTime, addClip]
  );

  const handleAddAudioClip = useCallback(
    (opts: {
      name: string;
      kind: 'audio' | 'synth';
      src: string;
      duration: number;
    }) => {
      const clip: Clip = {
        id: `clip-${Math.random().toString(36).slice(2, 9)}`,
        track: 'audio',
        kind: opts.kind,
        name: opts.name,
        src: opts.src,
        start: Math.round(currentTime * 100) / 100,
        duration: opts.duration,
        trimStart: 0,
        sourceDuration: opts.kind === 'synth' ? 60 : opts.duration,
        speed: 1,
        volume: 0.8,
        opacity: 1,
        filter: 'none',
        brightness: 1,
        contrast: 1,
        saturate: 1,
        transitionIn: 'none',
        motionEffect: 'none',
      };
      addClip(clip);
      setSelectedClipId(clip.id);
    },
    [currentTime, addClip]
  );

  const handleDragClipPosition = useCallback(
    (clipId: string, x: number, y: number, commit: boolean) => {
      const target = project.clips.find((c) => c.id === clipId);
      if (!target) return;
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
          {textStyle: {...baseStyle, x, y}},
          {skipUndo: !commit, skipSync: !commit}
        );
      } else {
        updateClip(
          clipId,
          {mediaX: x, mediaY: y},
          {skipUndo: !commit, skipSync: !commit}
        );
      }
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

  const handleCreateNewRoom = async (blank: boolean) => {
    const endpoint = getApiUrl('/api/rooms');
    if (!endpoint) {
      const localId = `cut-${Math.random().toString(36).slice(2, 8)}`;
      if (blank) replaceClips([]);
      switchRoom(localId);
      return;
    }
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({blank}),
      });
      const data = (await res.json()) as {roomId?: string};
      if (data.roomId) {
        switchRoom(data.roomId);
      }
    } catch {
      const localId = `cut-${Math.random().toString(36).slice(2, 8)}`;
      switchRoom(localId);
    }
  };

  const handleCopyInvite = async () => {
    const url = `${window.location.origin}/?room=${encodeURIComponent(roomId)}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedInvite(true);
      setTimeout(() => setCopiedInvite(false), 1800);
    } catch {
      setMobileSheet('team');
    }
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
        aspectRatio: project.aspectRatio,
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

  return (
    <div className="flex h-[100dvh] w-full flex-col overflow-hidden bg-[#09090b] text-zinc-100">
      {/* Top Studio Header */}
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-white/10 bg-[#111114] px-3 sm:h-13 sm:px-4">
        {/* Left: Brand & Project Title */}
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-900 border border-white/10">
            <img
              src="/icon.svg"
              alt="CutSync"
              className="h-6 w-6 rounded"
            />
          </div>
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
              className="h-8 w-32 rounded-md border border-cyan-400 bg-zinc-900 px-2 text-xs font-semibold text-white focus:outline-none sm:w-44 sm:text-sm"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditingTitle(true)}
              className="truncate text-left text-xs font-semibold text-white hover:text-cyan-300 sm:text-sm max-w-[115px] sm:max-w-[220px]"
              title="Нажмите, чтобы переименовать проект"
            >
              {project.title}
            </button>
          )}
        </div>

        {/* Center: Live Collaborators Presence Stack */}
        <button
          type="button"
          onClick={() => {
            setDesktopTab('team');
            setMobileSheet('team');
          }}
          className="flex h-9 items-center gap-2 rounded-lg border border-white/10 bg-zinc-900/90 px-2.5 hover:border-cyan-400/50 active:scale-95"
          title="Участники и приглашение"
        >
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${
              status === 'connected' ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'
            }`}
          />
          <div className="flex -space-x-1.5">
            {allCollaborators.slice(0, 3).map((c) => (
              <span
                key={c.id}
                style={{backgroundColor: c.color}}
                className="flex h-5 w-5 items-center justify-center rounded-full border border-[#111114] text-[10px] font-bold text-zinc-950"
              >
                {c.name.slice(0, 1).toUpperCase()}
              </span>
            ))}
          </div>
          <span className="hidden text-xs font-medium text-zinc-300 sm:inline whitespace-nowrap">
            {allCollaborators.length} в комнате
          </span>
        </button>

        {/* Right: Aspect Ratio, PWA Install, Invite, Export */}
        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
          <button
            type="button"
            onClick={cycleAspectRatio}
            className="flex h-9 items-center justify-center rounded-lg border border-white/10 bg-zinc-900 px-2 font-mono text-[11px] font-medium text-zinc-200 hover:border-white/25 whitespace-nowrap"
            title="Сменить формат кадра"
          >
            {project.aspectRatio}
          </button>

          <PWAInstallButton />

          <button
            type="button"
            onClick={handleCopyInvite}
            aria-label="Поделиться ссылкой"
            className="hidden h-9 items-center gap-1.5 rounded-lg border border-white/10 bg-zinc-900 px-3 text-xs font-medium text-zinc-200 hover:bg-zinc-800 sm:flex whitespace-nowrap"
          >
            <Share2 className="h-3.5 w-3.5 text-cyan-400" />
            <span>{copiedInvite ? 'Скопировано' : 'Поделиться'}</span>
          </button>

          <button
            type="button"
            onClick={handleExportVideo}
            disabled={project.clips.length === 0 || exportProgress !== null}
            className="flex h-9 items-center gap-1.5 rounded-lg bg-cyan-500 px-3 text-xs font-semibold text-zinc-950 hover:bg-cyan-400 disabled:opacity-45 active:scale-95 whitespace-nowrap"
          >
            <Download className="h-3.5 w-3.5" />
            <span>Экспорт</span>
          </button>
        </div>
      </header>

      {/* Main Studio Body */}
      <div className="flex flex-1 min-h-0 flex-col lg:grid lg:grid-cols-[340px_1fr_300px]">
        {/* Desktop Left Sidebar: Tool Tabs & Active Panel */}
        <aside className="hidden border-r border-white/10 bg-[#111114] lg:flex lg:flex-col lg:min-h-0">
          <div className="grid grid-cols-5 border-b border-white/10 p-1.5 gap-1">
            {TOOL_TABS.filter((t) => t.id !== 'edit').map((tab) => {
              const Icon = tab.icon;
              const active = desktopTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setDesktopTab(tab.id)}
                  className={`flex flex-col items-center justify-center gap-1 rounded-lg py-2 text-[11px] font-medium transition ${
                    active
                      ? 'bg-cyan-500/15 text-cyan-300'
                      : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  <span className="truncate">{tab.label}</span>
                </button>
              );
            })}
          </div>
          <div className="studio-scrollbar flex-1 overflow-y-auto p-4">
            {desktopTab === 'media' && (
              <MediaPanel onAddMediaClip={handleAddMediaClip} />
            )}
            {desktopTab === 'text' && (
              <TextPanel
                selectedClip={selectedClip}
                onAddText={handleAddText}
                onUpdateClip={(id, patch) => updateClip(id, patch)}
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
                onAddAudioClip={handleAddAudioClip}
                onUpdateClip={(id, patch) => updateClip(id, patch)}
              />
            )}
            {desktopTab === 'team' && (
              <TeamPanel
                roomId={roomId}
                serverUrl={serverUrl}
                user={user}
                allCollaborators={allCollaborators}
                chat={project.chat}
                status={status}
                onUpdateProfile={updateUserProfile}
                onSwitchRoom={switchRoom}
                onCreateNewRoom={handleCreateNewRoom}
                onSendChat={sendChatMessage}
                onUpdateServerUrl={updateServerConnection}
              />
            )}
          </div>
        </aside>

        {/* Center Preview Canvas + Transport Bar */}
        <main className="flex flex-1 min-h-0 flex-col bg-[#09090b]">
          <div className="flex-1 min-h-0">
            <PreviewCanvas
              clips={project.clips}
              aspectRatio={project.aspectRatio}
              currentTime={currentTime}
              isPlaying={isPlaying}
              selectedClipId={selectedClipId}
              collaborators={collaborators}
              mediaPool={mediaPoolRef.current}
              onSelectClip={setSelectedClipId}
              onDragClipPosition={handleDragClipPosition}
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

            <div className="flex items-center gap-3">
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
                  <Play className="h-4 w-4 fill-current ml-0.5" />
                )}
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
                onClick={() => replaceClips(createStarterClips())}
                title="Сбросить к демо-проекту"
                className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-400 hover:bg-white/10 hover:text-white"
              >
                <RotateCcw className="h-4 w-4" />
              </button>
            </div>
          </div>
        </main>

        {/* Desktop Right Sidebar: Selected Clip Inspector */}
        <aside className="hidden border-l border-white/10 bg-[#111114] p-4 lg:flex lg:flex-col lg:min-h-0 lg:overflow-y-auto studio-scrollbar">
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
                  <Scissors className="h-3.5 w-3.5 mb-0.5 text-cyan-400" />
                  Разделить
                </button>
                <button
                  type="button"
                  onClick={handleDuplicateSelected}
                  className="flex h-10 flex-col items-center justify-center rounded-lg border border-white/10 bg-zinc-900 text-[11px] text-zinc-200 hover:border-cyan-400"
                >
                  <CopyPlus className="h-3.5 w-3.5 mb-0.5 text-cyan-400" />
                  Дубликат
                </button>
                <button
                  type="button"
                  onClick={handleCycleSpeed}
                  className="flex h-10 flex-col items-center justify-center rounded-lg border border-white/10 bg-zinc-900 text-[11px] text-zinc-200 hover:border-cyan-400"
                >
                  <Gauge className="h-3.5 w-3.5 mb-0.5 text-cyan-400" />
                  {selectedClip.speed}x
                </button>
              </div>

              {selectedClip.track === 'overlay' && (
                <label className="block space-y-1 text-xs text-zinc-400">
                  <div className="flex justify-between">
                    <span>Размер слоя (PIP)</span>
                    <span className="font-mono text-zinc-200">
                      {Math.round((selectedClip.mediaScale ?? 0.45) * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0.2}
                    max={0.9}
                    step={0.05}
                    value={selectedClip.mediaScale ?? 0.45}
                    onChange={(e) =>
                      updateClip(selectedClip.id, {
                        mediaScale: Number(e.target.value),
                      })
                    }
                    className="w-full accent-cyan-400"
                  />
                </label>
              )}

              {(selectedClip.track === 'audio' ||
                selectedClip.kind === 'video') && (
                <label className="block space-y-1 text-xs text-zinc-400">
                  <div className="flex justify-between">
                    <span>Громкость</span>
                    <span className="font-mono text-zinc-200">
                      {Math.round(selectedClip.volume * 100)}%
                    </span>
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
                </label>
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
                  Нажмите на любой фрагмент на таймлайне ниже, чтобы обрезать края, разделить, изменить скорость или наложить фильтр.
                </p>
              </div>
              <div className="rounded-xl border border-white/10 bg-zinc-900/70 p-3 space-y-2 text-xs">
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

      {/* Multi-Track Timeline */}
      <div className="h-[206px] shrink-0 sm:h-[235px] lg:h-[250px]">
        <Timeline
          clips={project.clips}
          duration={duration}
          currentTime={currentTime}
          pxPerSec={pxPerSec}
          selectedClipId={selectedClipId}
          collaborators={collaborators}
          onSeek={handleSeek}
          onSelectClip={setSelectedClipId}
          onZoomChange={setPxPerSec}
          onClipTransform={handleClipTransform}
        />
      </div>

      {/* Mobile Bottom Thumb Toolbar (CapCut-style contextual vs primary tabs) */}
      <nav className="shrink-0 border-t border-white/10 bg-[#111114] pb-safe lg:hidden">
        {selectedClip ? (
          <div className="no-scrollbar flex h-14 items-center gap-1 overflow-x-auto px-2">
            <button
              type="button"
              onClick={() => setSelectedClipId(null)}
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
              onClick={handleCycleSpeed}
              className="flex h-11 min-w-[64px] shrink-0 flex-col items-center justify-center rounded-lg px-2 text-[10px] font-medium text-zinc-200 hover:bg-white/5"
            >
              <Gauge className="h-4 w-4 text-cyan-400" />
              <span>{selectedClip.speed}x</span>
            </button>
            <button
              type="button"
              onClick={() =>
                setMobileSheet(
                  selectedClip.track === 'text'
                    ? 'text'
                    : selectedClip.track === 'audio'
                      ? 'audio'
                      : 'effects'
                )
              }
              className="flex h-11 min-w-[64px] shrink-0 flex-col items-center justify-center rounded-lg px-2 text-[10px] font-medium text-zinc-200 hover:bg-white/5"
            >
              <Sparkles className="h-4 w-4 text-cyan-400" />
              <span>
                {selectedClip.track === 'text'
                  ? 'Шрифт'
                  : selectedClip.track === 'audio'
                    ? 'Звук'
                    : 'Эффекты'}
              </span>
            </button>
            <button
              type="button"
              onClick={handleDuplicateSelected}
              className="flex h-11 min-w-[64px] shrink-0 flex-col items-center justify-center rounded-lg px-2 text-[10px] font-medium text-zinc-200 hover:bg-white/5"
            >
              <CopyPlus className="h-4 w-4 text-zinc-300" />
              <span>Дубликат</span>
            </button>
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
          <div className="grid h-14 grid-cols-6 items-center px-1">
            {TOOL_TABS.map((tab) => {
              const Icon = tab.icon;
              const isOpen = mobileSheet === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    if (tab.id === 'edit') {
                      const first = project.clips[0];
                      if (first) setSelectedClipId(first.id);
                      else setMobileSheet('media');
                    } else {
                      setMobileSheet(tab.id);
                    }
                  }}
                  className={`flex h-12 flex-col items-center justify-center gap-0.5 rounded-lg text-[10px] font-medium transition ${
                    isOpen ? 'text-cyan-400' : 'text-zinc-300 active:bg-white/5'
                  }`}
                >
                  <Icon className="h-5 w-5" />
                  <span className="truncate">{tab.label}</span>
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
      {mobileSheet === 'text' && (
        <BottomSheet title="Текст и титры" onClose={() => setMobileSheet(null)}>
          <TextPanel
            selectedClip={selectedClip}
            onAddText={handleAddText}
            onUpdateClip={(id, patch) => updateClip(id, patch)}
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
          title="Музыка и звуковые дорожки"
          onClose={() => setMobileSheet(null)}
        >
          <AudioPanel
            selectedClip={selectedClip}
            onAddAudioClip={handleAddAudioClip}
            onUpdateClip={(id, patch) => updateClip(id, patch)}
            onClose={() => setMobileSheet(null)}
          />
        </BottomSheet>
      )}
      {mobileSheet === 'team' && (
        <BottomSheet
          title="Совместный монтаж"
          onClose={() => setMobileSheet(null)}
        >
          <TeamPanel
            roomId={roomId}
            serverUrl={serverUrl}
            user={user}
            allCollaborators={allCollaborators}
            chat={project.chat}
            status={status}
            onUpdateProfile={updateUserProfile}
            onSwitchRoom={switchRoom}
            onCreateNewRoom={handleCreateNewRoom}
            onSendChat={sendChatMessage}
            onUpdateServerUrl={updateServerConnection}
          />
        </BottomSheet>
      )}

      {/* Video Export Modal */}
      {(exportProgress !== null || exportError) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs">
          <div className="w-full max-w-sm rounded-2xl border border-white/15 bg-[#141418] p-5 shadow-2xl space-y-4">
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

      {/* Quick Mobile Invite FAB-less access via Team tab or top header */}
      {collaborators.length === 0 && !mobileSheet && !selectedClip && (
        <button
          type="button"
          onClick={() => setMobileSheet('team')}
          className="fixed right-3 bottom-16 z-30 flex h-9 items-center gap-1.5 rounded-full border border-white/15 bg-zinc-900/90 px-3 text-[11px] font-medium text-zinc-200 shadow-lg backdrop-blur-md lg:hidden"
        >
          <Users className="h-3.5 w-3.5 text-cyan-400" />
          Пригласить
        </button>
      )}

      <OfflineIndicator />
    </div>
  );
}
