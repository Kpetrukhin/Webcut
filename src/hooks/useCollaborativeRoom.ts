import {useCallback, useEffect, useRef, useState} from 'react';
import {
  applyClipSplit,
  createDefaultTracks,
  createStarterClips,
  createTrackOfType,
  normalizeProjectTracks,
  resolveTrackPlacement,
} from '../shared/types.ts';
import type {
  AspectRatio,
  ChatMessage,
  ClientWsMessage,
  Clip,
  Collaborator,
  ProjectState,
  RoomSummary,
  ServerWsMessage,
  Track,
  TrackType,
} from '../shared/types.ts';
import {
  getApiUrl,
  getSavedServerUrl,
  getWebSocketUrl,
  saveServerUrl,
} from '../lib/serverConfig.ts';

const USER_COLORS = [
  '#22d3ee',
  '#f97316',
  '#a78bfa',
  '#34d399',
  '#fb7185',
  '#facc15',
];

function getInitialUser(): {id: string; name: string; color: string} {
  try {
    const saved = localStorage.getItem('cutsync_user');
    if (saved) {
      const parsed = JSON.parse(saved) as {
        id: string;
        name: string;
        color: string;
      };
      if (parsed.id && parsed.name && parsed.color) return parsed;
    }
  } catch {
    // ignore storage issues
  }
  const id = `u-${Math.random().toString(36).slice(2, 9)}`;
  const color = USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)];
  const isMobile = /iphone|ipad|ipod|android/i.test(navigator.userAgent);
  const name = isMobile
    ? `Телефон ${Math.floor(10 + Math.random() * 89)}`
    : `Редактор ${Math.floor(10 + Math.random() * 89)}`;
  const user = {id, name, color};
  try {
    localStorage.setItem('cutsync_user', JSON.stringify(user));
  } catch {
    // ignore
  }
  return user;
}

export function getRoomIdFromUrl(): string {
  const params = new URLSearchParams(window.location.search);
  const q = params.get('room');
  if (q && q.trim()) return q.trim();
  const match = window.location.pathname.match(/^\/room\/([a-zA-Z0-9_-]+)/);
  if (match && match[1]) return match[1];
  return 'studio-demo';
}

interface UndoSnapshot {
  clips: Clip[];
  tracks: Track[];
}

export function useCollaborativeRoom() {
  const [user, setUser] = useState(getInitialUser);
  const userRef = useRef(user);
  userRef.current = user;

  const [roomId, setRoomId] = useState<string>(getRoomIdFromUrl);
  const [serverUrl, setServerUrl] = useState<string>(getSavedServerUrl);
  const [status, setStatus] = useState<
    'connecting' | 'connected' | 'reconnecting' | 'offline'
  >('connecting');
  const [project, setProject] = useState<ProjectState>(() => ({
    roomId: getRoomIdFromUrl(),
    title: 'Ночной ролик',
    aspectRatio: '9:16',
    fps: 30,
    isPublicLan: true,
    tracks: createDefaultTracks(),
    clips: createStarterClips(),
    revision: 0,
    updatedAt: Date.now(),
    chat: [],
  }));
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [availableRooms, setAvailableRooms] = useState<RoomSummary[]>([]);
  const [undoStack, setUndoStack] = useState<UndoSnapshot[]>([]);
  const [redoStack, setRedoStack] = useState<UndoSnapshot[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const projectRef = useRef(project);
  projectRef.current = project;

  const lastPresenceSentRef = useRef(0);
  const pendingPresenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  const sendRaw = useCallback((msg: ClientWsMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const refreshRooms = useCallback(async () => {
    sendRaw({type: 'lobby:get_rooms'});
    const endpoint = getApiUrl('/api/rooms');
    if (!endpoint) return;
    try {
      const res = await fetch(endpoint);
      if (!res.ok) return;
      const data = (await res.json()) as {rooms?: RoomSummary[]};
      if (Array.isArray(data.rooms)) {
        setAvailableRooms(data.rooms);
      }
    } catch {
      // ignore
    }
  }, [sendRaw]);

  useEffect(() => {
    let closedByEffect = false;
    let attempt = 0;

    const wsEndpoint = getWebSocketUrl();
    if (!wsEndpoint) {
      setStatus('offline');
      return;
    }

    const connect = () => {
      if (closedByEffect) return;
      setStatus(attempt === 0 ? 'connecting' : 'reconnecting');
      const ws = new WebSocket(wsEndpoint);
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0;
        setStatus('connected');
        ws.send(
          JSON.stringify({
            type: 'join',
            roomId,
            user: userRef.current,
          } satisfies ClientWsMessage)
        );
      };

      ws.onmessage = (event) => {
        let msg: ServerWsMessage;
        try {
          msg = JSON.parse(event.data as string) as ServerWsMessage;
        } catch {
          return;
        }

        switch (msg.type) {
          case 'room:init':
            setProject(normalizeProjectTracks(msg.project));
            setCollaborators(msg.collaborators);
            if (Array.isArray(msg.rooms)) {
              setAvailableRooms(msg.rooms);
            }
            break;

          case 'lobby:rooms_update':
            setAvailableRooms(msg.rooms);
            break;

          case 'op:track_add':
            setProject((prev) => {
              if (prev.tracks.some((t) => t.id === msg.track.id)) return prev;
              return {
                ...prev,
                tracks: [...prev.tracks, msg.track],
                revision: msg.revision,
              };
            });
            break;

          case 'op:track_update':
            setProject((prev) => ({
              ...prev,
              revision: msg.revision,
              tracks: prev.tracks.map((t) =>
                t.id === msg.trackId ? {...t, ...msg.patch, id: t.id} : t
              ),
            }));
            break;

          case 'op:track_delete':
            setProject((prev) => ({
              ...prev,
              revision: msg.revision,
              tracks: prev.tracks.filter((t) => t.id !== msg.trackId),
              clips: prev.clips.filter((c) => c.trackId !== msg.trackId),
            }));
            break;

          case 'op:clip_add':
            setProject((prev) => {
              if (prev.clips.some((c) => c.id === msg.clip.id)) return prev;
              const nextTracks =
                msg.newTrack &&
                !prev.tracks.some((t) => t.id === msg.newTrack!.id)
                  ? [...prev.tracks, msg.newTrack]
                  : prev.tracks;
              return {
                ...prev,
                tracks: nextTracks,
                clips: [...prev.clips, msg.clip],
                revision: msg.revision,
              };
            });
            break;

          case 'op:clip_update':
            setProject((prev) => ({
              ...prev,
              revision: msg.revision,
              clips: prev.clips.map((c) =>
                c.id === msg.clipId ? {...c, ...msg.patch, id: c.id} : c
              ),
            }));
            break;

          case 'op:clip_delete':
            setProject((prev) => ({
              ...prev,
              revision: msg.revision,
              clips: prev.clips.filter((c) => c.id !== msg.clipId),
            }));
            break;

          case 'op:clip_split':
            setProject((prev) => ({
              ...prev,
              revision: msg.revision,
              clips: applyClipSplit(
                prev.clips,
                msg.clipId,
                msg.splitTime,
                msg.newClipId
              ),
            }));
            break;

          case 'op:project_meta':
            setProject((prev) => ({
              ...prev,
              ...msg.patch,
              revision: msg.revision,
            }));
            break;

          case 'op:project_replace':
            setProject((prev) => ({
              ...prev,
              clips: msg.clips,
              tracks: msg.tracks || prev.tracks,
              aspectRatio: msg.aspectRatio,
              title: msg.title,
              revision: msg.revision,
            }));
            break;

          case 'presence:update':
            setCollaborators(msg.collaborators);
            break;

          case 'chat:message':
            setProject((prev) => {
              if (prev.chat.some((m) => m.id === msg.message.id)) return prev;
              return {
                ...prev,
                chat: [...prev.chat, msg.message].slice(-100),
              };
            });
            break;
        }
      };

      ws.onclose = () => {
        if (closedByEffect) return;
        setStatus('reconnecting');
        attempt += 1;
        const delay = Math.min(2500, 350 * Math.pow(1.4, attempt));
        reconnectTimerRef.current = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      closedByEffect = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (pendingPresenceTimerRef.current)
        clearTimeout(pendingPresenceTimerRef.current);
      wsRef.current?.close();
    };
  }, [roomId, serverUrl]);

  const pushUndo = useCallback(() => {
    const snapshot: UndoSnapshot = {
      clips: structuredClone(projectRef.current.clips),
      tracks: structuredClone(projectRef.current.tracks),
    };
    setUndoStack((prev) => [...prev.slice(-29), snapshot]);
    setRedoStack([]);
  }, []);

  const addTrack = useCallback(
    (type: TrackType): Track => {
      pushUndo();
      const newTrack = createTrackOfType(projectRef.current.tracks, type);
      setProject((prev) => ({
        ...prev,
        tracks: [...prev.tracks, newTrack],
      }));
      sendRaw({type: 'op:track_add', track: newTrack});
      return newTrack;
    },
    [pushUndo, sendRaw]
  );

  const updateTrack = useCallback(
    (trackId: string, patch: Partial<Track>) => {
      setProject((prev) => ({
        ...prev,
        tracks: prev.tracks.map((t) =>
          t.id === trackId ? {...t, ...patch, id: t.id} : t
        ),
      }));
      sendRaw({type: 'op:track_update', trackId, patch});
    },
    [sendRaw]
  );

  const deleteTrack = useCallback(
    (trackId: string) => {
      if (projectRef.current.tracks.length <= 1) return;
      pushUndo();
      setProject((prev) => ({
        ...prev,
        tracks: prev.tracks.filter((t) => t.id !== trackId),
        clips: prev.clips.filter((c) => c.trackId !== trackId),
      }));
      sendRaw({type: 'op:track_delete', trackId});
    },
    [pushUndo, sendRaw]
  );

  const addClip = useCallback(
    (
      clipInput: Omit<Clip, 'trackId'> & {trackId?: string},
      opts?: {forceNewTrack?: boolean}
    ): Clip => {
      pushUndo();
      const curTracks = projectRef.current.tracks;
      const curClips = projectRef.current.clips;

      let resolvedTrackId = clipInput.trackId;
      let newTrack: Track | undefined;

      if (!resolvedTrackId || opts?.forceNewTrack) {
        const placed = resolveTrackPlacement(
          curTracks,
          curClips,
          clipInput.track,
          clipInput.start,
          clipInput.duration,
          Boolean(opts?.forceNewTrack)
        );
        resolvedTrackId = placed.trackId;
        newTrack = placed.newTrack;
      }

      const clip: Clip = {
        ...clipInput,
        trackId: resolvedTrackId,
      };

      setProject((prev) => {
        if (prev.clips.some((c) => c.id === clip.id)) return prev;
        const nextTracks =
          newTrack && !prev.tracks.some((t) => t.id === newTrack!.id)
            ? [...prev.tracks, newTrack]
            : prev.tracks;
        return {
          ...prev,
          tracks: nextTracks,
          clips: [...prev.clips, clip],
        };
      });
      sendRaw({type: 'op:clip_add', clip, newTrack});
      return clip;
    },
    [pushUndo, sendRaw]
  );

  const updateClip = useCallback(
    (
      clipId: string,
      patch: Partial<Clip>,
      opts?: {skipUndo?: boolean; skipSync?: boolean}
    ) => {
      if (!opts?.skipUndo) pushUndo();
      setProject((prev) => ({
        ...prev,
        clips: prev.clips.map((c) =>
          c.id === clipId ? {...c, ...patch, id: c.id} : c
        ),
      }));
      if (!opts?.skipSync) {
        sendRaw({type: 'op:clip_update', clipId, patch});
      }
    },
    [pushUndo, sendRaw]
  );

  const deleteClip = useCallback(
    (clipId: string) => {
      pushUndo();
      setProject((prev) => ({
        ...prev,
        clips: prev.clips.filter((c) => c.id !== clipId),
      }));
      sendRaw({type: 'op:clip_delete', clipId});
    },
    [pushUndo, sendRaw]
  );

  const splitClip = useCallback(
    (clipId: string, splitTime: number): string | null => {
      const target = projectRef.current.clips.find((c) => c.id === clipId);
      if (!target) return null;
      const offset = splitTime - target.start;
      if (offset <= 0.15 || offset >= target.duration - 0.15) return null;

      pushUndo();
      const newClipId = `clip-${Math.random().toString(36).slice(2, 9)}`;
      setProject((prev) => ({
        ...prev,
        clips: applyClipSplit(prev.clips, clipId, splitTime, newClipId),
      }));
      sendRaw({type: 'op:clip_split', clipId, splitTime, newClipId});
      return newClipId;
    },
    [pushUndo, sendRaw]
  );

  const updateProjectMeta = useCallback(
    (patch: {title?: string; aspectRatio?: AspectRatio; isPublicLan?: boolean}) => {
      setProject((prev) => ({...prev, ...patch}));
      sendRaw({type: 'op:project_meta', patch});
    },
    [sendRaw]
  );

  const replaceClips = useCallback(
    (
      clips: Clip[],
      meta?: {title?: string; aspectRatio?: AspectRatio; tracks?: Track[]}
    ) => {
      pushUndo();
      const tracks = meta?.tracks ?? createDefaultTracks();
      setProject((prev) => ({
        ...prev,
        clips,
        tracks,
        ...(meta?.title ? {title: meta.title} : {}),
        ...(meta?.aspectRatio ? {aspectRatio: meta.aspectRatio} : {}),
      }));
      sendRaw({
        type: 'op:project_replace',
        clips,
        tracks,
        title: meta?.title,
        aspectRatio: meta?.aspectRatio,
      });
    },
    [pushUndo, sendRaw]
  );

  const undo = useCallback(() => {
    setUndoStack((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      const current: UndoSnapshot = {
        clips: structuredClone(projectRef.current.clips),
        tracks: structuredClone(projectRef.current.tracks),
      };
      setRedoStack((r) => [...r, current]);
      setProject((p) => ({...p, clips: last.clips, tracks: last.tracks}));
      sendRaw({
        type: 'op:project_replace',
        clips: last.clips,
        tracks: last.tracks,
      });
      return prev.slice(0, -1);
    });
  }, [sendRaw]);

  const redo = useCallback(() => {
    setRedoStack((prev) => {
      if (prev.length === 0) return prev;
      const next = prev[prev.length - 1];
      const current: UndoSnapshot = {
        clips: structuredClone(projectRef.current.clips),
        tracks: structuredClone(projectRef.current.tracks),
      };
      setUndoStack((u) => [...u, current]);
      setProject((p) => ({...p, clips: next.clips, tracks: next.tracks}));
      sendRaw({
        type: 'op:project_replace',
        clips: next.clips,
        tracks: next.tracks,
      });
      return prev.slice(0, -1);
    });
  }, [sendRaw]);

  const sendPresence = useCallback(
    (playhead: number, selectedClipId: string | null, isPlaying: boolean) => {
      const now = Date.now();
      const sendNow = () => {
        lastPresenceSentRef.current = Date.now();
        sendRaw({
          type: 'presence:cursor',
          playhead,
          selectedClipId,
          isPlaying,
        });
      };

      if (now - lastPresenceSentRef.current >= 65) {
        if (pendingPresenceTimerRef.current) {
          clearTimeout(pendingPresenceTimerRef.current);
          pendingPresenceTimerRef.current = null;
        }
        sendNow();
      } else if (!pendingPresenceTimerRef.current) {
        pendingPresenceTimerRef.current = setTimeout(() => {
          pendingPresenceTimerRef.current = null;
          sendNow();
        }, 65);
      }
    },
    [sendRaw]
  );

  const sendChatMessage = useCallback(
    (text: string) => {
      const clean = text.trim();
      if (!clean) return;
      const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const localMsg: ChatMessage = {
        id: messageId,
        userId: user.id,
        userName: user.name,
        userColor: user.color,
        text: clean,
        timestamp: Date.now(),
      };
      setProject((prev) => ({
        ...prev,
        chat: [...prev.chat, localMsg].slice(-100),
      }));
      sendRaw({type: 'chat:send', text: clean, messageId});
    },
    [sendRaw, user]
  );

  const switchRoom = useCallback((nextRoomId: string) => {
    const clean =
      nextRoomId.trim().replace(/[^a-zA-Z0-9_-]/g, '') || 'studio-demo';
    setUndoStack([]);
    setRedoStack([]);
    setRoomId(clean);
    const url = new URL(window.location.href);
    url.searchParams.set('room', clean);
    window.history.replaceState({}, '', url.toString());
  }, []);

  const updateUserProfile = useCallback(
    (name: string, color: string) => {
      const cleanName = name.trim().slice(0, 28) || userRef.current.name;
      const updated = {
        ...userRef.current,
        name: cleanName,
        color,
      };
      setUser(updated);
      try {
        localStorage.setItem('cutsync_user', JSON.stringify(updated));
      } catch {
        // ignore
      }
      sendRaw({type: 'presence:profile', name: cleanName, color});
    },
    [sendRaw]
  );

  const updateServerConnection = useCallback((rawUrl: string) => {
    const saved = saveServerUrl(rawUrl);
    setServerUrl(saved);
  }, []);

  return {
    user,
    roomId,
    serverUrl,
    status,
    project,
    collaborators: collaborators.filter((c) => c.id !== user.id),
    allCollaborators: collaborators,
    availableRooms,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    addTrack,
    updateTrack,
    deleteTrack,
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
    refreshRooms,
  };
}
