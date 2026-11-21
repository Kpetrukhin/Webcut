import {useCallback, useEffect, useRef, useState} from 'react';
import {
  applyClipSplit,
  createStarterClips,
} from '../shared/types.ts';
import type {
  AspectRatio,
  ChatMessage,
  ClientWsMessage,
  Clip,
  Collaborator,
  ProjectState,
  ServerWsMessage,
} from '../shared/types.ts';
import {
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

export function useCollaborativeRoom() {
  const [user, setUser] = useState(getInitialUser);
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
    clips: createStarterClips(),
    revision: 0,
    updatedAt: Date.now(),
    chat: [],
  }));
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [undoStack, setUndoStack] = useState<Clip[][]>([]);
  const [redoStack, setRedoStack] = useState<Clip[][]>([]);

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
            user,
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
            setProject(msg.project);
            setCollaborators(msg.collaborators);
            break;

          case 'op:clip_add':
            setProject((prev) => {
              if (prev.clips.some((c) => c.id === msg.clip.id)) return prev;
              return {
                ...prev,
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
        const delay = Math.min(4000, 600 * Math.pow(1.4, attempt));
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
  }, [roomId, user, serverUrl]);

  const pushUndo = useCallback(() => {
    const snapshot = structuredClone(projectRef.current.clips);
    setUndoStack((prev) => [...prev.slice(-29), snapshot]);
    setRedoStack([]);
  }, []);

  const addClip = useCallback(
    (clip: Clip) => {
      pushUndo();
      setProject((prev) => {
        if (prev.clips.some((c) => c.id === clip.id)) return prev;
        return {...prev, clips: [...prev.clips, clip]};
      });
      sendRaw({type: 'op:clip_add', clip});
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
    (patch: {title?: string; aspectRatio?: AspectRatio}) => {
      setProject((prev) => ({...prev, ...patch}));
      sendRaw({type: 'op:project_meta', patch});
    },
    [sendRaw]
  );

  const replaceClips = useCallback(
    (clips: Clip[], meta?: {title?: string; aspectRatio?: AspectRatio}) => {
      pushUndo();
      setProject((prev) => ({
        ...prev,
        clips,
        ...(meta ?? {}),
      }));
      sendRaw({
        type: 'op:project_replace',
        clips,
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
      const current = structuredClone(projectRef.current.clips);
      setRedoStack((r) => [...r, current]);
      setProject((p) => ({...p, clips: last}));
      sendRaw({type: 'op:project_replace', clips: last});
      return prev.slice(0, -1);
    });
  }, [sendRaw]);

  const redo = useCallback(() => {
    setRedoStack((prev) => {
      if (prev.length === 0) return prev;
      const next = prev[prev.length - 1];
      const current = structuredClone(projectRef.current.clips);
      setUndoStack((u) => [...u, current]);
      setProject((p) => ({...p, clips: next}));
      sendRaw({type: 'op:project_replace', clips: next});
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
    const clean = nextRoomId.trim().replace(/[^a-zA-Z0-9_-]/g, '') || 'studio-demo';
    setUndoStack([]);
    setRedoStack([]);
    setRoomId(clean);
    const url = new URL(window.location.href);
    url.searchParams.set('room', clean);
    window.history.replaceState({}, '', url.toString());
  }, []);

  const updateUserProfile = useCallback(
    (name: string, color: string) => {
      const updated = {
        ...user,
        name: name.trim().slice(0, 28) || user.name,
        color,
      };
      setUser(updated);
      try {
        localStorage.setItem('cutsync_user', JSON.stringify(updated));
      } catch {
        // ignore
      }
    },
    [user]
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
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
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
  };
}
