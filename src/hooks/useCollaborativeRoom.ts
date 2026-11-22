import {useCallback, useEffect, useRef, useState} from 'react';
import {
  applyClipDuplicate,
  applyClipPatch,
  applyClipSplit,
  applyTrackReorder,
  createDefaultTracks,
  createStarterClips,
  createTrackOfType,
  encodePatchForSync,
  normalizeProjectTracks,
  resolveTrackPlacement,
} from '../shared/types.ts';
import type {
  AspectRatio,
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
  getKtorServerStatus,
  getP2PNetworkInfo,
  startHostLanServer,
  startUdpRoomDiscovery,
  stopHostLanServer,
  syncHostLanSnapshot,
} from '../lib/lanSyncBridge.ts';
import type {KtorServerStatus} from '../lib/lanSyncBridge.ts';
import {loadCustomFont, preloadProjectFonts} from '../lib/fontLoader.ts';

export interface DownloadQueueItem {
  layerId: string;
  fileName: string;
  progress: number;
  status: 'DOWNLOADING' | 'ERROR';
  attempt?: number;
  maxAttempts?: number;
  error?: string;
}

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
  const [pingMs, setPingMs] = useState<number | null>(null);
  const [ktorStatus, setKtorStatus] = useState<KtorServerStatus>(() => ({
    state: isNativeCapacitorApp() ? 'stopped' : 'web',
    port: isNativeCapacitorApp() ? 8080 : 3000,
    preferredPort: isNativeCapacitorApp() ? 8080 : 3000,
    hosting: false,
  }));
  const [downloadQueue, setDownloadQueue] = useState<DownloadQueueItem[]>([]);

  const [status, setStatus] = useState<
    'connecting' | 'connected' | 'reconnecting' | 'offline'
  >('connecting');
  const [project, setProject] = useState<ProjectState>(() => ({
    roomId: getRoomIdFromUrl(),
    title: 'Ночной ролик',
    aspectRatio: '9:16',
    backgroundColor: '#09090b',
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
  const localLockTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map()
  );

  const lastPresenceSentRef = useRef(0);
  const pendingPresenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  const upsertDownloadQueue = useCallback((item: DownloadQueueItem) => {
    setDownloadQueue((prev) => {
      const idx = prev.findIndex((x) => x.layerId === item.layerId);
      if (idx === -1) return [...prev, item];
      const next = [...prev];
      next[idx] = item;
      return next;
    });
  }, []);

  const removeDownloadQueueItem = useCallback((layerId: string) => {
    setDownloadQueue((prev) => prev.filter((x) => x.layerId !== layerId));
  }, []);

  const refreshServerStatus = useCallback(async () => {
    const s = await getKtorServerStatus();
    setKtorStatus(s);
    return s;
  }, []);

  const refreshNetworkInfo = useCallback(async () => {
    const [info, srvStatus] = await Promise.all([
      getP2PNetworkInfo(),
      getKtorServerStatus(),
    ]);
    setNetworkInterfaces(info.interfaces);
    setHostPort(info.port);
    setKtorStatus(srvStatus);
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
    (
      layerId: string,
      remoteUrl: string,
      fileName: string,
      opts?: {expectedSize?: number; expectedHash?: string}
    ) => {
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

      upsertDownloadQueue({
        layerId,
        fileName: fileName || `${layerId}.bin`,
        progress: 0,
        status: 'DOWNLOADING',
        attempt: 1,
        maxAttempts: 3,
      });

      let lastPct = -1;
      downloadMediaInBackground({
        layerId,
        remoteUrl,
        fileName: fileName || `${layerId}.bin`,
        expectedSize: opts?.expectedSize,
        expectedHash: opts?.expectedHash,
        maxAttempts: 3,
        onAttempt: (attempt, maxAttempts) => {
          upsertDownloadQueue({
            layerId,
            fileName: fileName || `${layerId}.bin`,
            progress: Math.max(0, lastPct),
            status: 'DOWNLOADING',
            attempt,
            maxAttempts,
          });
        },
        onProgress: (pct) => {
          if (pct - lastPct < 5 && pct < 99) return;
          lastPct = pct;
          upsertDownloadQueue({
            layerId,
            fileName: fileName || `${layerId}.bin`,
            progress: pct,
            status: 'DOWNLOADING',
          });
          setProject((prev) => ({
            ...prev,
            clips: prev.clips.map((c) =>
              c.id === layerId
                ? {
                    ...c,
                    mediaStatus: 'DOWNLOADING',
                    mediaError: undefined,
                    downloadProgress: pct,
                  }
                : c
            ),
          }));
        },
      })
        .then((localUrl) => {
          activeDownloadsRef.current.delete(key);
          removeDownloadQueueItem(layerId);
          setProject((prev) => ({
            ...prev,
            clips: prev.clips.map((c) =>
              c.id === layerId
                ? {
                    ...c,
                    src: localUrl,
                    mediaStatus: 'READY',
                    mediaError: undefined,
                    downloadProgress: 100,
                  }
                : c
            ),
          }));
        })
        .catch((err) => {
          activeDownloadsRef.current.delete(key);
          const message =
            err instanceof Error ? err.message : 'Ошибка скачивания по сети';
          upsertDownloadQueue({
            layerId,
            fileName: fileName || `${layerId}.bin`,
            progress: 0,
            status: 'ERROR',
            error: message,
          });
          setProject((prev) => ({
            ...prev,
            clips: prev.clips.map((c) =>
              c.id === layerId
                ? {
                    ...c,
                    mediaRemoteUrl: remoteUrl,
                    mediaStatus: 'ERROR',
                    mediaError: message,
                    downloadProgress: 0,
                  }
                : c
            ),
          }));
        });
    },
    [removeDownloadQueueItem, upsertDownloadQueue]
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

  const hydrateProjectState = useCallback(
    (rawProject: ProjectState, existingClips: Clip[]): ProjectState => {
      const normalized = normalizeProjectTracks(rawProject);
      void preloadProjectFonts(normalized.customFonts);

      const existingMap = new Map(existingClips.map((c) => [c.id, c]));
      const hydratedClips = normalized.clips.map((c) => {
        if (c.textStyle?.fontFamily && c.textStyle?.fontSrc) {
          const fontMeta = normalized.customFonts?.find(
            (f) => f.fontFamily === c.textStyle?.fontFamily
          );
          void loadCustomFont(c.textStyle.fontFamily, c.textStyle.fontSrc, {
            fileName: fontMeta?.fileName,
            fileSize: fontMeta?.fileSize,
            fileHash: fontMeta?.fileHash,
          });
        }

        const remote = c.mediaRemoteUrl || c.src;
        const prev = existingMap.get(c.id);
        const prevRemote = prev?.mediaRemoteUrl || prev?.src;
        if (
          prev &&
          prev.mediaStatus === 'READY' &&
          prev.src &&
          (prev.src.startsWith('blob:') ||
            prev.src.startsWith('http://127.0.0.1')) &&
          prevRemote === remote
        ) {
          return {
            ...c,
            src: prev.src,
            mediaStatus: 'READY' as const,
            downloadProgress: 100,
            mediaError: undefined,
          };
        }

        if (
          remote &&
          (remote.includes('/media/') ||
            remote.includes('/uploads/') ||
            c.mediaFileName) &&
          !remote.startsWith('blob:') &&
          !remote.startsWith('http://127.0.0.1') &&
          c.kind !== 'text' &&
          c.kind !== 'synth'
        ) {
          triggerBackgroundDownload(
            c.id,
            remote,
            c.mediaFileName || `${c.id}.bin`,
            {
              expectedSize: c.mediaFileSize,
              expectedHash: c.mediaFileHash,
            }
          );
          return {
            ...c,
            mediaRemoteUrl: remote,
            mediaStatus: 'DOWNLOADING' as const,
            downloadProgress: 0,
            mediaError: undefined,
          };
        }
        return c;
      });

      return {...normalized, clips: hydratedClips};
    },
    [triggerBackgroundDownload]
  );

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

      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
      let lastPongAt = Date.now();
      let awaitingPong = false;

      const clearHeartbeat = () => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
      };

      ws.onopen = () => {
        attempt = 0;
        lastPongAt = Date.now();
        awaitingPong = false;
        setStatus('connected');
        ws.send(
          JSON.stringify({
            type: 'join',
            roomId,
            user: userRef.current,
          } satisfies ClientWsMessage)
        );
        ws.send(
          JSON.stringify({
            type: 'ping',
            ts: Date.now(),
          } satisfies ClientWsMessage)
        );
        awaitingPong = true;

        clearHeartbeat();
        heartbeatTimer = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (awaitingPong && Date.now() - lastPongAt > 7500) {
            clearHeartbeat();
            ws.close();
            return;
          }
          awaitingPong = true;
          ws.send(
            JSON.stringify({
              type: 'ping',
              ts: Date.now(),
            } satisfies ClientWsMessage)
          );
        }, 3000);
      };

      ws.onmessage = (event) => {
        let msg: ServerWsMessage;
        try {
          msg = JSON.parse(event.data as string) as ServerWsMessage;
        } catch {
          return;
        }

        switch (msg.type) {
          case 'pong': {
            lastPongAt = Date.now();
            awaitingPong = false;
            if (typeof msg.ts === 'number') {
              setPingMs(Math.max(1, Date.now() - msg.ts));
            }
            break;
          }

          case 'room:init':
          case 'SYNC_FULL_STATE': {
            const hydrated = hydrateProjectState(
              msg.project,
              projectRef.current.clips
            );
            setProject(hydrated);
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

          case 'op:track_reorder':
            setProject((prev) => ({
              ...prev,
              revision: msg.revision,
              tracks: applyTrackReorder(prev.tracks, msg.trackIds),
            }));
            break;

          case 'op:clip_add': {
            if (msg.clip.textStyle?.fontFamily && msg.clip.textStyle?.fontSrc) {
              void loadCustomFont(
                msg.clip.textStyle.fontFamily,
                msg.clip.textStyle.fontSrc
              );
            }
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
          }

          case 'op:clip_update': {
            const patchObj = msg.patch as Record<string, unknown>;
            const nextTextStyle = patchObj.textStyle as
              | {fontFamily?: string; fontSrc?: string}
              | undefined;
            if (nextTextStyle?.fontFamily && nextTextStyle?.fontSrc) {
              void loadCustomFont(
                nextTextStyle.fontFamily,
                nextTextStyle.fontSrc
              );
            }
            setProject((prev) => ({
              ...prev,
              revision: msg.revision,
              clips: prev.clips.map((c) =>
                c.id === msg.clipId ? applyClipPatch(c, patchObj) : c
              ),
            }));
            break;
          }

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
            if (Array.isArray(msg.patch.customFonts)) {
              void preloadProjectFonts(msg.patch.customFonts);
            }
            setProject((prev) => ({
              ...prev,
              ...msg.patch,
              revision: msg.revision,
            }));
            break;

          case 'op:project_replace': {
            const hydrated = hydrateProjectState(
              {
                ...projectRef.current,
                clips: msg.clips,
                tracks: msg.tracks || projectRef.current.tracks,
                aspectRatio: msg.aspectRatio,
                title: msg.title,
                backgroundColor:
                  msg.backgroundColor || projectRef.current.backgroundColor,
                customFonts:
                  msg.customFonts || projectRef.current.customFonts,
                revision: msg.revision,
              },
              projectRef.current.clips
            );
            setProject(hydrated);
            break;
          }

          case 'LAYER_MEDIA_UPDATED': {
            const isFromSelf = msg.senderId === userRef.current.id;
            setProject((prev) => {
              const nextTracks =
                msg.newTrack &&
                !prev.tracks.some((t) => t.id === msg.newTrack!.id)
                  ? [...prev.tracks, msg.newTrack]
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
                          mediaFileSize: msg.fileSize ?? c.mediaFileSize,
                          mediaFileHash: msg.fileHash ?? c.mediaFileHash,
                          mediaError: undefined,
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
                mediaFileSize: msg.fileSize ?? msg.clip.mediaFileSize,
                mediaFileHash: msg.fileHash ?? msg.clip.mediaFileHash,
                mediaError: undefined,
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
                msg.fileName,
                {
                  expectedSize: msg.fileSize,
                  expectedHash: msg.fileHash,
                }
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
        clearHeartbeat();
        setPingMs(null);
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
  }, [roomId, serverUrl, hydrateProjectState, triggerBackgroundDownload]);

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
      opts?: {forceNewTrack?: boolean; skipWs?: boolean}
    ): {clip: Clip; newTrack?: Track} => {
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
      if (!opts?.skipWs) {
        sendRaw({type: 'op:clip_add', clip, newTrack});
      }
      return {clip, newTrack};
    },
    [pushUndo, sendRaw]
  );

  const sendLayerMediaUpdated = useCallback(
    (opts: {
      layerId: string;
      fileName: string;
      mediaUrl: string;
      localSrc?: string;
      fileSize?: number;
      fileHash?: string;
      clip?: Clip;
      newTrack?: Track;
    }) => {
      const localUrl = opts.localSrc || opts.mediaUrl;
      const alreadyExists = projectRef.current.clips.some(
        (c) => c.id === opts.layerId
      );
      if (alreadyExists) {
        pushUndo();
      }
      setProject((prev) => {
        const nextTracks =
          opts.newTrack &&
          !prev.tracks.some((t) => t.id === opts.newTrack!.id)
            ? [...prev.tracks, opts.newTrack]
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
                    mediaFileSize: opts.fileSize ?? c.mediaFileSize,
                    mediaFileHash: opts.fileHash ?? c.mediaFileHash,
                    mediaError: undefined,
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
            mediaFileSize: opts.fileSize ?? opts.clip.mediaFileSize,
            mediaFileHash: opts.fileHash ?? opts.clip.mediaFileHash,
            mediaStatus: 'DOWNLOADING' as const,
            downloadProgress: 0,
          }
        : undefined;

      sendRaw({
        type: 'LAYER_MEDIA_UPDATED',
        layerId: opts.layerId,
        fileName: opts.fileName,
        mediaUrl: opts.mediaUrl,
        fileSize: opts.fileSize,
        fileHash: opts.fileHash,
        senderId: userRef.current.id,
        clip: remoteClip,
        newTrack: opts.newTrack,
      });
    },
    [pushUndo, sendRaw]
  );

  const clearLocalLockTimer = useCallback((layerId: string) => {
    const existing = localLockTimersRef.current.get(layerId);
    if (existing) {
      clearTimeout(existing);
      localLockTimersRef.current.delete(layerId);
    }
  }, []);

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

      clearLocalLockTimer(layerId);

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

      if (locked) {
        const timer = setTimeout(() => {
          localLockTimersRef.current.delete(layerId);
          const current = projectRef.current.clips.find((c) => c.id === layerId);
          if (current?.lockedByUserId === userRef.current.id) {
            setProject((prev) => ({
              ...prev,
              clips: prev.clips.map((c) =>
                c.id === layerId
                  ? {
                      ...c,
                      lockedByUserId: null,
                      lockedByUserName: null,
                      lockedByUserColor: null,
                    }
                  : c
              ),
            }));
            sendRaw({
              type: 'LAYER_LOCK',
              layerId,
              userId: userRef.current.id,
              userName: '',
              userColor: '',
              locked: false,
            });
          }
        }, 5000);
        localLockTimersRef.current.set(layerId, timer);
      }
      return true;
    },
    [clearLocalLockTimer, sendRaw, showLockWarning]
  );

  const releaseAllLocalLocks = useCallback(() => {
    for (const timer of localLockTimersRef.current.values()) {
      clearTimeout(timer);
    }
    localLockTimersRef.current.clear();

    const lockedByMe = projectRef.current.clips.filter(
      (c) => c.lockedByUserId === userRef.current.id
    );
    if (lockedByMe.length === 0) return;

    setProject((prev) => ({
      ...prev,
      clips: prev.clips.map((c) =>
        c.lockedByUserId === userRef.current.id
          ? {
              ...c,
              lockedByUserId: null,
              lockedByUserName: null,
              lockedByUserColor: null,
            }
          : c
      ),
    }));

    for (const c of lockedByMe) {
      sendRaw({
        type: 'LAYER_LOCK',
        layerId: c.id,
        userId: userRef.current.id,
        userName: '',
        userColor: '',
        locked: false,
      });
    }
  }, [sendRaw]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        releaseAllLocalLocks();
      }
    };
    const onBlurOrHide = () => {
      releaseAllLocalLocks();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onBlurOrHide);
    window.addEventListener('blur', onBlurOrHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onBlurOrHide);
      window.removeEventListener('blur', onBlurOrHide);
      releaseAllLocalLocks();
    };
  }, [releaseAllLocalLocks]);

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
      if (target?.lockedByUserId === userRef.current.id) {
        // Refresh 5s inactivity timer while user is actively dragging/editing
        sendLayerLock(clipId, true);
      }
      if (!opts?.skipUndo) pushUndo();
      const encodedPatch = encodePatchForSync(patch);
      setProject((prev) => ({
        ...prev,
        clips: prev.clips.map((c) =>
          c.id === clipId ? applyClipPatch(c, encodedPatch) : c
        ),
      }));
      if (!opts?.skipSync) {
        sendRaw({
          type: 'op:clip_update',
          clipId,
          patch: encodedPatch as Partial<Clip>,
        });
      }
    },
    [pushUndo, sendLayerLock, sendRaw, showLockWarning]
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

      const encodedPatch = encodePatchForSync(patch);
      setProject((prev) => {
        const nextTracks =
          placed.newTrack &&
          !prev.tracks.some((t) => t.id === placed.newTrack!.id)
            ? [...prev.tracks, placed.newTrack]
            : prev.tracks;
        return {
          ...prev,
          tracks: nextTracks,
          clips: prev.clips.map((c) =>
            c.id === clipId ? applyClipPatch(c, encodedPatch) : c
          ),
        };
      });

      if (placed.newTrack) {
        sendRaw({type: 'op:track_add', track: placed.newTrack});
      }
      sendRaw({
        type: 'op:clip_update',
        clipId,
        patch: encodedPatch as Partial<Clip>,
      });
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
          | 'hostName'
          | 'customFonts'
        >
      >
    ) => {
      setProject((prev) => ({...prev, ...patch}));
      sendRaw({type: 'op:project_meta', patch});
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
        ...(meta?.customFonts ? {customFonts: meta.customFonts} : {}),
      }));
      sendRaw({
        type: 'op:project_replace',
        clips,
        tracks,
        title: meta?.title,
        aspectRatio: meta?.aspectRatio,
        backgroundColor: meta?.backgroundColor,
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
      void refreshServerStatus();

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
    [refreshServerStatus]
  );

  const stopHostRoom = useCallback(async () => {
    await stopHostLanServer();
    setP2pMode('idle');
    void refreshServerStatus();
  }, [refreshServerStatus]);

  const connectToHostIp = useCallback(
    (ipOrUrl: string, targetRoomId?: string) => {
      void stopHostLanServer();
      const saved = saveServerUrl(ipOrUrl);
      setP2pMode('client');
      setServerUrl(saved);
      if (targetRoomId) {
        switchRoom(targetRoomId);
      }
      void refreshServerStatus();
    },
    [refreshServerStatus, switchRoom]
  );

  const forceSyncProject = useCallback(() => {
    sendRaw({type: 'SYNC_FULL_STATE'});
    void refreshNetworkInfo();
  }, [refreshNetworkInfo, sendRaw]);

  const retryMediaDownload = useCallback(
    (clipId: string) => {
      const clip = projectRef.current.clips.find((c) => c.id === clipId);
      if (!clip) return;
      const remote = clip.mediaRemoteUrl || clip.src;
      if (!remote || remote.startsWith('synth:')) return;
      const key = `${clip.id}:${remote}`;
      activeDownloadsRef.current.delete(key);
      setProject((prev) => ({
        ...prev,
        clips: prev.clips.map((c) =>
          c.id === clipId
            ? {
                ...c,
                mediaStatus: 'DOWNLOADING',
                mediaError: undefined,
                downloadProgress: 0,
              }
            : c
        ),
      }));
      triggerBackgroundDownload(
        clip.id,
        remote,
        clip.mediaFileName || `${clip.id}.bin`,
        {
          expectedSize: clip.mediaFileSize,
          expectedHash: clip.mediaFileHash,
        }
      );
    },
    [triggerBackgroundDownload]
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
    pingMs,
    ktorStatus,
    downloadQueue,
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
  };
}
