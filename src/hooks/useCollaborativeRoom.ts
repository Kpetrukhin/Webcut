import {useCallback, useEffect, useRef, useState} from 'react';
import {
  applyClipDuplicate,
  applyClipSplit,
  applyTrackReorder,
  createDefaultTracks,
  createStarterClips,
  createTrackOfType,
  insertTrackAt,
  normalizeProjectTracks,
  resolveTrackPlacement,
} from '../shared/types.ts';
import type {
  AspectRatio,
  CanvasBackground,
  ChatMessage,
  ClientWsMessage,
  Clip,
  Collaborator,
  DiscoveredUdpRoom,
  NetworkInterfaceInfo,
  ProjectFont,
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
  isNativeCapacitorApp,
  saveServerUrl,
} from '../lib/serverConfig.ts';
import {
  downloadMediaInBackground,
  getP2PNetworkInfo,
  startHostLanServer,
  startUdpRoomDiscovery,
  stopHostLanServer,
  syncHostLanSnapshot,
} from '../lib/lanSyncBridge.ts';

export const USER_COLORS = [
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

export function hasExplicitRoomInUrl(): boolean {
  const params = new URLSearchParams(window.location.search);
  if (params.get('room')) return true;
  return /^\/room\/([a-zA-Z0-9_-]+)/.test(window.location.pathname);
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
  const [p2pMode, setP2pMode] = useState<'idle' | 'host' | 'client'>(() =>
    getSavedServerUrl() ? 'client' : 'idle'
  );
  const [networkInterfaces, setNetworkInterfaces] = useState<
    NetworkInterfaceInfo[]
  >([]);
  const [hostPort, setHostPort] = useState<number>(() =>
    isNativeCapacitorApp() ? 8080 : Number(window.location.port) || 3000
  );
  const [udpRooms, setUdpRooms] = useState<DiscoveredUdpRoom[]>([]);
  const [lockWarning, setLockWarning] = useState<string | null>(null);

  const [status, setStatus] = useState<
    'connecting' | 'connected' | 'reconnecting' | 'offline'
  >('connecting');
  const [project, setProject] = useState<ProjectState>(() => ({
    roomId: getRoomIdFromUrl(),
    title: 'Ночной ролик',
    aspectRatio: '9:16',
    backgroundColor: '#09090b',
    canvasBackground: {type: 'solid', color: '#09090b'},
    fps: 30,
    isPublicLan: true,
    customFonts: [],
    tracks: createDefaultTracks(),
    clips: createStarterClips(),
    revision: 1,
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
  const activeDownloadsRef = useRef<Set<string>>(new Set());

  const lastPresenceSentRef = useRef(0);
  const pendingPresenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  const refreshNetworkInfo = useCallback(async () => {
    const info = await getP2PNetworkInfo();
    setNetworkInterfaces(info.interfaces);
    setHostPort(info.port);
  }, []);

  useEffect(() => {
    void refreshNetworkInfo();
    let stopDiscovery: (() => void) | undefined;
    void startUdpRoomDiscovery((rooms) => {
      setUdpRooms(rooms);
    }).then((stop) => {
      stopDiscovery = stop;
    });
    return () => {
      stopDiscovery?.();
    };
  }, [refreshNetworkInfo]);

  const triggerBackgroundDownload = useCallback(
    (layerId: string, remoteUrl: string, fileName: string) => {
      if (!remoteUrl || remoteUrl.startsWith('synth:')) return;
      if (
        remoteUrl.startsWith('http://127.0.0.1') &&
        !isNativeCapacitorApp()
      ) {
        return;
      }
      const key = `${layerId}:${remoteUrl}`;
      if (activeDownloadsRef.current.has(key)) return;
      activeDownloadsRef.current.add(key);

      let lastPct = -1;
      downloadMediaInBackground({
        layerId,
        remoteUrl,
        fileName: fileName || `${layerId}.bin`,
        onProgress: (pct) => {
          if (pct - lastPct < 5 && pct < 99) return;
          lastPct = pct;
          setProject((prev) => ({
            ...prev,
            clips: prev.clips.map((c) =>
              c.id === layerId
                ? {
                    ...c,
                    mediaStatus: 'DOWNLOADING',
                    downloadProgress: pct,
                  }
                : c
            ),
          }));
        },
      })
        .then((localUrl) => {
          activeDownloadsRef.current.delete(key);
          setProject((prev) => ({
            ...prev,
            clips: prev.clips.map((c) =>
              c.id === layerId
                ? {
                    ...c,
                    src: localUrl,
                    mediaStatus: 'READY',
                    downloadProgress: 100,
                  }
                : c
            ),
          }));
        })
        .catch(() => {
          activeDownloadsRef.current.delete(key);
          setProject((prev) => ({
            ...prev,
            clips: prev.clips.map((c) =>
              c.id === layerId
                ? {
                    ...c,
                    src: remoteUrl,
                    mediaStatus: 'ERROR',
                  }
                : c
            ),
          }));
        });
    },
    []
  );

  const sendRaw = useCallback((msg: ClientWsMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const refreshRooms = useCallback(async () => {
    sendRaw({type: 'lobby:get_rooms'});
    await refreshNetworkInfo();
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
  }, [sendRaw, refreshNetworkInfo]);

  useEffect(() => {
    if (p2pMode !== 'host' || !isNativeCapacitorApp()) return;
    const t = setTimeout(() => {
      void syncHostLanSnapshot(project);
    }, 150);
    return () => clearTimeout(t);
  }, [p2pMode, project]);

  useEffect(() => {
    let closedByEffect = false;
    let attempt = 0;

    const wsEndpoint = getWebSocketUrl(serverUrl || undefined);
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
          case 'room:init': {
            const normalized = normalizeProjectTracks(msg.project);
            // If joining an existing peer session with remote /media/ clips, cache them smoothly
            const hydratedClips = normalized.clips.map((c) => {
              const remote = c.mediaRemoteUrl || c.src;
              if (
                remote &&
                (remote.includes('/media/') || c.mediaFileName) &&
                !remote.startsWith('blob:') &&
                !remote.startsWith('http://127.0.0.1') &&
                c.kind !== 'text' &&
                c.kind !== 'synth' &&
                c.kind !== 'adjustment'
              ) {
                triggerBackgroundDownload(
                  c.id,
                  remote,
                  c.mediaFileName || `${c.id}.bin`
                );
                return {
                  ...c,
                  mediaRemoteUrl: remote,
                  mediaStatus: 'DOWNLOADING' as const,
                  downloadProgress: 0,
                };
              }
              return c;
            });
            setProject({...normalized, clips: hydratedClips});
            setCollaborators(msg.collaborators);
            if (Array.isArray(msg.rooms)) {
              setAvailableRooms(msg.rooms);
            }
            break;
          }

          case 'lobby:rooms_update':
            setAvailableRooms(msg.rooms);
            break;

          case 'op:track_add':
            setProject((prev) => {
              if (prev.tracks.some((t) => t.id === msg.track.id)) return prev;
              return {
                ...prev,
                tracks: insertTrackAt(prev.tracks, msg.track, msg.insertAt),
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

          case 'op:track_reorder':
            setProject((prev) => ({
              ...prev,
              revision: msg.revision,
              tracks: applyTrackReorder(prev.tracks, msg.trackIds),
            }));
            break;

          case 'op:clip_add':
            setProject((prev) => {
              if (prev.clips.some((c) => c.id === msg.clip.id)) return prev;
              const nextTracks = msg.newTrack
                ? insertTrackAt(prev.tracks, msg.newTrack, msg.insertAt)
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

          case 'op:clip_duplicate':
            setProject((prev) => ({
              ...prev,
              revision: msg.revision,
              clips: applyClipDuplicate(
                prev.clips,
                msg.clipId,
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
              backgroundColor: msg.backgroundColor || prev.backgroundColor,
              canvasBackground:
                msg.canvasBackground ?? prev.canvasBackground,
              customFonts: msg.customFonts || prev.customFonts,
              revision: msg.revision,
            }));
            break;

          case 'LAYER_MEDIA_UPDATED': {
            const isFromSelf = msg.senderId === userRef.current.id;
            setProject((prev) => {
              const nextTracks = msg.newTrack
                ? insertTrackAt(prev.tracks, msg.newTrack, msg.insertAt)
                : prev.tracks;
              const exists = prev.clips.some((c) => c.id === msg.layerId);
              if (exists) {
                return {
                  ...prev,
                  tracks: nextTracks,
                  revision: msg.revision ?? prev.revision + 1,
                  clips: prev.clips.map((c) =>
                    c.id === msg.layerId
                      ? {
                          ...c,
                          mediaFileName: msg.fileName,
                          mediaRemoteUrl: msg.mediaUrl,
                          mediaStatus: isFromSelf ? 'READY' : 'DOWNLOADING',
                          downloadProgress: isFromSelf ? 100 : 0,
                          ...(msg.clip
                            ? {
                                name: msg.clip.name,
                                kind: msg.clip.kind,
                                trimStart: msg.clip.trimStart,
                                sourceDuration: msg.clip.sourceDuration,
                              }
                            : {}),
                        }
                      : c
                  ),
                };
              }
              if (!msg.clip) return prev;
              const stubClip: Clip = {
                ...msg.clip,
                id: msg.layerId,
                src: isFromSelf ? msg.clip.src || msg.mediaUrl : undefined,
                mediaFileName: msg.fileName,
                mediaRemoteUrl: msg.mediaUrl,
                mediaStatus: isFromSelf ? 'READY' : 'DOWNLOADING',
                downloadProgress: isFromSelf ? 100 : 0,
              };
              return {
                ...prev,
                tracks: nextTracks,
                clips: [...prev.clips, stubClip],
                revision: msg.revision ?? prev.revision + 1,
              };
            });

            if (!isFromSelf) {
              triggerBackgroundDownload(
                msg.layerId,
                msg.mediaUrl,
                msg.fileName
              );
            }
            break;
          }

          case 'LAYER_LOCK': {
            setProject((prev) => ({
              ...prev,
              clips: prev.clips.map((c) =>
                c.id === msg.layerId
                  ? {
                      ...c,
                      lockedByUserId: msg.locked ? msg.userId : null,
                      lockedByUserName: msg.locked ? msg.userName : null,
                      lockedByUserColor: msg.locked ? msg.userColor : null,
                    }
                  : c
              ),
            }));
            break;
          }

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
  }, [roomId, serverUrl, triggerBackgroundDownload]);

  const showLockWarning = useCallback((ownerName: string) => {
    setLockWarning(`Слой редактирует ${ownerName}`);
    setTimeout(() => {
      setLockWarning((cur) =>
        cur === `Слой редактирует ${ownerName}` ? null : cur
      );
    }, 1800);
  }, []);

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
      const curTracks = projectRef.current.tracks;
      const newTrack = createTrackOfType(curTracks, type);
      let insertAt: number | undefined;
      if (type === 'adjustment') {
        const firstAudio = curTracks.findIndex((t) => t.type === 'audio');
        insertAt = firstAudio !== -1 ? firstAudio : curTracks.length;
      } else if (type === 'overlay') {
        const firstPostOverlay = curTracks.findIndex(
          (t) => t.type === 'text' || t.type === 'adjustment' || t.type === 'audio'
        );
        if (firstPostOverlay !== -1) insertAt = firstPostOverlay;
      } else if (type === 'text') {
        const firstPostText = curTracks.findIndex(
          (t) => t.type === 'adjustment' || t.type === 'audio'
        );
        if (firstPostText !== -1) insertAt = firstPostText;
      }
      setProject((prev) => ({
        ...prev,
        tracks: insertTrackAt(prev.tracks, newTrack, insertAt),
      }));
      sendRaw({type: 'op:track_add', track: newTrack, insertAt});
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

  const reorderTracks = useCallback(
    (
      trackIds: string[],
      opts?: {commit?: boolean; undoTracks?: Track[]}
    ) => {
      const commit = opts?.commit ?? true;
      if (commit) {
        const snapshot: UndoSnapshot = {
          clips: structuredClone(projectRef.current.clips),
          tracks: structuredClone(opts?.undoTracks ?? projectRef.current.tracks),
        };
        setUndoStack((prev) => [...prev.slice(-29), snapshot]);
        setRedoStack([]);
      }
      setProject((prev) => ({
        ...prev,
        tracks: applyTrackReorder(prev.tracks, trackIds),
      }));
      if (commit) {
        sendRaw({type: 'op:track_reorder', trackIds});
      }
    },
    [sendRaw]
  );

  const addClip = useCallback(
    (
      clipInput: Omit<Clip, 'trackId'> & {trackId?: string},
      opts?: {forceNewTrack?: boolean; minTrackIndex?: number; skipWs?: boolean}
    ): {clip: Clip; newTrack?: Track; insertAt?: number} => {
      pushUndo();
      const curTracks = projectRef.current.tracks;
      const curClips = projectRef.current.clips;

      let resolvedTrackId = clipInput.trackId;
      let newTrack: Track | undefined;
      let insertAt: number | undefined;

      if (!resolvedTrackId || opts?.forceNewTrack) {
        const placed = resolveTrackPlacement(
          curTracks,
          curClips,
          clipInput.track,
          clipInput.start,
          clipInput.duration,
          Boolean(opts?.forceNewTrack),
          opts?.minTrackIndex ?? -1
        );
        resolvedTrackId = placed.trackId;
        newTrack = placed.newTrack;
        insertAt = placed.insertAt;
      }

      const clip: Clip = {
        ...clipInput,
        trackId: resolvedTrackId,
      };

      setProject((prev) => {
        if (prev.clips.some((c) => c.id === clip.id)) return prev;
        const nextTracks = newTrack
          ? insertTrackAt(prev.tracks, newTrack, insertAt)
          : prev.tracks;
        return {
          ...prev,
          tracks: nextTracks,
          clips: [...prev.clips, clip],
        };
      });
      if (!opts?.skipWs) {
        sendRaw({type: 'op:clip_add', clip, newTrack, insertAt});
      }
      return {clip, newTrack, insertAt};
    },
    [pushUndo, sendRaw]
  );

  const sendLayerMediaUpdated = useCallback(
    (opts: {
      layerId: string;
      fileName: string;
      mediaUrl: string;
      localSrc?: string;
      clip?: Clip;
      newTrack?: Track;
      insertAt?: number;
    }) => {
      const localUrl = opts.localSrc || opts.mediaUrl;
      const alreadyExists = projectRef.current.clips.some(
        (c) => c.id === opts.layerId
      );
      if (alreadyExists) {
        pushUndo();
      }
      setProject((prev) => {
        const nextTracks = opts.newTrack
          ? insertTrackAt(prev.tracks, opts.newTrack, opts.insertAt)
          : prev.tracks;
        const exists = prev.clips.some((c) => c.id === opts.layerId);
        if (exists) {
          return {
            ...prev,
            tracks: nextTracks,
            clips: prev.clips.map((c) =>
              c.id === opts.layerId
                ? {
                    ...c,
                    src: localUrl,
                    mediaFileName: opts.fileName,
                    mediaRemoteUrl: opts.mediaUrl,
                    mediaStatus: 'READY',
                    downloadProgress: 100,
                    ...(opts.clip
                      ? {
                          name: opts.clip.name,
                          kind: opts.clip.kind,
                          trimStart: opts.clip.trimStart,
                          sourceDuration: opts.clip.sourceDuration,
                        }
                      : {}),
                  }
                : c
            ),
          };
        }
        return prev;
      });

      const remoteClip = opts.clip
        ? {
            ...opts.clip,
            src: opts.mediaUrl,
            mediaFileName: opts.fileName,
            mediaRemoteUrl: opts.mediaUrl,
            mediaStatus: 'DOWNLOADING' as const,
            downloadProgress: 0,
          }
        : undefined;

      sendRaw({
        type: 'LAYER_MEDIA_UPDATED',
        layerId: opts.layerId,
        fileName: opts.fileName,
        mediaUrl: opts.mediaUrl,
        senderId: userRef.current.id,
        clip: remoteClip,
        newTrack: opts.newTrack,
        insertAt: opts.insertAt,
      });
    },
    [pushUndo, sendRaw]
  );

  const sendLayerLock = useCallback(
    (layerId: string, locked: boolean) => {
      const target = projectRef.current.clips.find((c) => c.id === layerId);
      if (
        locked &&
        target?.lockedByUserId &&
        target.lockedByUserId !== userRef.current.id
      ) {
        showLockWarning(target.lockedByUserName || 'другой участник');
        return false;
      }

      setProject((prev) => ({
        ...prev,
        clips: prev.clips.map((c) =>
          c.id === layerId
            ? {
                ...c,
                lockedByUserId: locked ? userRef.current.id : null,
                lockedByUserName: locked ? userRef.current.name : null,
                lockedByUserColor: locked ? userRef.current.color : null,
              }
            : c
        ),
      }));

      sendRaw({
        type: 'LAYER_LOCK',
        layerId,
        userId: userRef.current.id,
        userName: locked ? userRef.current.name : '',
        userColor: locked ? userRef.current.color : '',
        locked,
      });
      return true;
    },
    [sendRaw, showLockWarning]
  );

  const updateClip = useCallback(
    (
      clipId: string,
      patch: Partial<Clip>,
      opts?: {skipUndo?: boolean; skipSync?: boolean}
    ) => {
      const target = projectRef.current.clips.find((c) => c.id === clipId);
      if (
        target?.lockedByUserId &&
        target.lockedByUserId !== userRef.current.id
      ) {
        showLockWarning(target.lockedByUserName || 'другой участник');
        return;
      }
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
    [pushUndo, sendRaw, showLockWarning]
  );

  const deleteClip = useCallback(
    (clipId: string) => {
      const target = projectRef.current.clips.find((c) => c.id === clipId);
      if (
        target?.lockedByUserId &&
        target.lockedByUserId !== userRef.current.id
      ) {
        showLockWarning(target.lockedByUserName || 'другой участник');
        return;
      }
      pushUndo();
      setProject((prev) => ({
        ...prev,
        clips: prev.clips.filter((c) => c.id !== clipId),
      }));
      sendRaw({type: 'op:clip_delete', clipId});
    },
    [pushUndo, sendRaw, showLockWarning]
  );

  const splitClip = useCallback(
    (clipId: string, splitTime: number): string | null => {
      const target = projectRef.current.clips.find((c) => c.id === clipId);
      if (!target) return null;
      if (
        target.lockedByUserId &&
        target.lockedByUserId !== userRef.current.id
      ) {
        showLockWarning(target.lockedByUserName || 'другой участник');
        return null;
      }
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
    [pushUndo, sendRaw, showLockWarning]
  );

  const duplicateClip = useCallback(
    (clipId: string): string | null => {
      const target = projectRef.current.clips.find((c) => c.id === clipId);
      if (!target) return null;
      if (
        target.lockedByUserId &&
        target.lockedByUserId !== userRef.current.id
      ) {
        showLockWarning(target.lockedByUserName || 'другой участник');
        return null;
      }
      pushUndo();
      const newClipId = `clip-${Math.random().toString(36).slice(2, 9)}`;
      setProject((prev) => ({
        ...prev,
        clips: applyClipDuplicate(prev.clips, clipId, newClipId),
      }));
      sendRaw({type: 'op:clip_duplicate', clipId, newClipId});
      return newClipId;
    },
    [pushUndo, sendRaw, showLockWarning]
  );

  const moveClipTrackType = useCallback(
    (clipId: string, targetTrackType: 'video' | 'overlay') => {
      const target = projectRef.current.clips.find((c) => c.id === clipId);
      if (!target || target.track === targetTrackType) return;
      if (target.track !== 'video' && target.track !== 'overlay') return;
      if (
        target.lockedByUserId &&
        target.lockedByUserId !== userRef.current.id
      ) {
        showLockWarning(target.lockedByUserName || 'другой участник');
        return;
      }

      pushUndo();
      const placed = resolveTrackPlacement(
        projectRef.current.tracks,
        projectRef.current.clips.filter((c) => c.id !== clipId),
        targetTrackType,
        target.start,
        target.duration,
        false
      );

      const patch: Partial<Clip> =
        targetTrackType === 'overlay'
          ? {
              track: 'overlay',
              trackId: placed.trackId,
              mediaScale:
                target.mediaScale !== undefined && target.mediaScale < 0.99
                  ? target.mediaScale
                  : 0.48,
              mediaX: target.mediaX ?? 0.5,
              mediaY: target.mediaY ?? 0.5,
              borderRadius:
                target.borderRadius && target.borderRadius > 0
                  ? target.borderRadius
                  : 16,
            }
          : {
              track: 'video',
              trackId: placed.trackId,
              mediaScale: 1,
              mediaX: 0.5,
              mediaY: 0.5,
              borderRadius: 0,
            };

      setProject((prev) => {
        const nextTracks = placed.newTrack
          ? insertTrackAt(prev.tracks, placed.newTrack, placed.insertAt)
          : prev.tracks;
        return {
          ...prev,
          tracks: nextTracks,
          clips: prev.clips.map((c) =>
            c.id === clipId ? {...c, ...patch, id: c.id} : c
          ),
        };
      });

      if (placed.newTrack) {
        sendRaw({
          type: 'op:track_add',
          track: placed.newTrack,
          insertAt: placed.insertAt,
        });
      }
      sendRaw({type: 'op:clip_update', clipId, patch});
    },
    [pushUndo, sendRaw, showLockWarning]
  );

  const updateProjectMeta = useCallback(
    (
      patch: Partial<
        Pick<
          ProjectState,
          | 'title'
          | 'aspectRatio'
          | 'isPublicLan'
          | 'backgroundColor'
          | 'canvasBackground'
          | 'hostName'
          | 'customFonts'
        >
      >,
      options?: {skipSync?: boolean}
    ) => {
      setProject((prev) => ({...prev, ...patch}));
      if (!options?.skipSync) {
        sendRaw({type: 'op:project_meta', patch});
      }
    },
    [sendRaw]
  );

  const addCustomFont = useCallback(
    (font: ProjectFont) => {
      const nextFonts = [...(projectRef.current.customFonts ?? []), font];
      setProject((prev) => ({...prev, customFonts: nextFonts}));
      sendRaw({type: 'op:project_meta', patch: {customFonts: nextFonts}});
    },
    [sendRaw]
  );

  const replaceClips = useCallback(
    (
      clips: Clip[],
      meta?: {
        title?: string;
        aspectRatio?: AspectRatio;
        backgroundColor?: string;
        canvasBackground?: CanvasBackground;
        customFonts?: ProjectFont[];
        tracks?: Track[];
      }
    ) => {
      pushUndo();
      const tracks = meta?.tracks ?? createDefaultTracks();
      setProject((prev) => ({
        ...prev,
        clips,
        tracks,
        ...(meta?.title ? {title: meta.title} : {}),
        ...(meta?.aspectRatio ? {aspectRatio: meta.aspectRatio} : {}),
        ...(meta?.backgroundColor
          ? {backgroundColor: meta.backgroundColor}
          : {}),
        ...(meta?.canvasBackground
          ? {canvasBackground: meta.canvasBackground}
          : {}),
        ...(meta?.customFonts ? {customFonts: meta.customFonts} : {}),
      }));
      sendRaw({
        type: 'op:project_replace',
        clips,
        tracks,
        title: meta?.title,
        aspectRatio: meta?.aspectRatio,
        backgroundColor: meta?.backgroundColor,
        canvasBackground: meta?.canvasBackground,
        customFonts: meta?.customFonts,
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
    setP2pMode(saved ? 'client' : 'idle');
  }, []);

  const startHostRoom = useCallback(
    async (customInitial?: Partial<ProjectState>) => {
      const merged: ProjectState = {
        ...projectRef.current,
        ...customInitial,
        hostName: userRef.current.name,
        isPublicLan: true,
        updatedAt: Date.now(),
      };
      setProject(merged);
      const res = await startHostLanServer(merged);
      setNetworkInterfaces(res.interfaces);
      setHostPort(res.port);
      setP2pMode('host');

      if (isNativeCapacitorApp()) {
        const localUrl = `http://127.0.0.1:${res.port}`;
        saveServerUrl(localUrl);
        setServerUrl(localUrl);
      } else {
        saveServerUrl('');
        setServerUrl('');
      }
      return res;
    },
    []
  );

  const stopHostRoom = useCallback(async () => {
    await stopHostLanServer();
    setP2pMode('idle');
  }, []);

  const connectToHostIp = useCallback(
    (ipOrUrl: string, targetRoomId?: string) => {
      void stopHostLanServer();
      const saved = saveServerUrl(ipOrUrl);
      setP2pMode('client');
      setServerUrl(saved);
      if (targetRoomId) {
        switchRoom(targetRoomId);
      }
    },
    [switchRoom]
  );

  return {
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
    collaborators: collaborators.filter((c) => c.id !== user.id),
    allCollaborators: collaborators,
    availableRooms,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
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
  };
}
