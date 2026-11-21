import 'dotenv/config';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import {WebSocket, WebSocketServer} from 'ws';
import {
  applyClipSplit,
  createDefaultTracks,
  createStarterClips,
  normalizeProjectTracks,
} from './src/shared/types.ts';
import type {
  AspectRatio,
  ClientWsMessage,
  Collaborator,
  ProjectState,
  RoomSummary,
  ServerWsMessage,
} from './src/shared/types.ts';

const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

const ROOT_DIR = process.cwd();
const UPLOADS_DIR = path.join(ROOT_DIR, 'uploads');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');

fs.mkdirSync(UPLOADS_DIR, {recursive: true});
fs.mkdirSync(DATA_DIR, {recursive: true});

const rooms = new Map<string, ProjectState>();
const roomConnections = new Map<string, Set<ClientSession>>();
const allSockets = new Set<WebSocket>();

interface ClientSession {
  ws: WebSocket;
  roomId: string;
  user: Collaborator;
  isAlive: boolean;
}

function sanitizeRoomId(raw: string): string {
  const cleaned = raw.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
  return cleaned || 'studio-demo';
}

function createDefaultProject(
  roomId: string,
  opts?: {
    blank?: boolean;
    title?: string;
    aspectRatio?: AspectRatio;
    backgroundColor?: string;
    hostName?: string;
    isPublicLan?: boolean;
  }
): ProjectState {
  const defaultTitle =
    roomId === 'studio-demo' ? 'Ночной ролик' : `Проект ${roomId}`;
  return {
    roomId,
    title: opts?.title?.trim().slice(0, 60) || defaultTitle,
    aspectRatio: opts?.aspectRatio || '9:16',
    backgroundColor: opts?.backgroundColor || '#09090b',
    hostName: opts?.hostName?.trim().slice(0, 28) || undefined,
    fps: 30,
    isPublicLan: opts?.isPublicLan ?? true,
    customFonts: [],
    tracks: createDefaultTracks(),
    clips: opts?.blank ? [] : createStarterClips(),
    revision: 1,
    updatedAt: Date.now(),
    chat: [
      {
        id: 'welcome-msg',
        userId: 'system',
        userName: 'Студия',
        userColor: '#22d3ee',
        text: 'Комната открыта для совместного монтажа. Все участники видят изменения в реальном времени.',
        timestamp: Date.now(),
      },
    ],
  };
}

function loadRoomsFromDisk() {
  try {
    if (fs.existsSync(ROOMS_FILE)) {
      const raw = fs.readFileSync(ROOMS_FILE, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, ProjectState>;
      for (const [key, val] of Object.entries(parsed)) {
        if (val && typeof val.roomId === 'string' && Array.isArray(val.clips)) {
          rooms.set(key, normalizeProjectTracks(val));
        }
      }
    }
  } catch (err) {
    console.error('Failed to load rooms.json:', err);
  }
  if (!rooms.has('studio-demo')) {
    rooms.set('studio-demo', createDefaultProject('studio-demo'));
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSaveRooms() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const obj: Record<string, ProjectState> = {};
    for (const [k, v] of rooms.entries()) {
      obj[k] = v;
    }
    fs.writeFile(ROOMS_FILE, JSON.stringify(obj, null, 2), (err) => {
      if (err) console.error('Failed to persist rooms.json:', err);
    });
  }, 400);
}

function getOrCreateRoom(
  roomId: string,
  opts?: {
    blank?: boolean;
    title?: string;
    aspectRatio?: AspectRatio;
    backgroundColor?: string;
    hostName?: string;
    isPublicLan?: boolean;
  }
): ProjectState {
  const safeId = sanitizeRoomId(roomId);
  let project = rooms.get(safeId);
  if (!project) {
    project = createDefaultProject(safeId, opts);
    rooms.set(safeId, project);
    scheduleSaveRooms();
  }
  return project;
}

function getRoomCollaborators(roomId: string): Collaborator[] {
  const set = roomConnections.get(roomId);
  if (!set) return [];
  const list: Collaborator[] = [];
  for (const conn of set) {
    list.push(conn.user);
  }
  return list;
}

function getPublicRoomSummaries(): RoomSummary[] {
  const summaries: RoomSummary[] = [];
  for (const project of rooms.values()) {
    const active = getRoomCollaborators(project.roomId);
    if (project.isPublicLan === false && active.length === 0) continue;
    summaries.push({
      roomId: project.roomId,
      title: project.title,
      aspectRatio: project.aspectRatio,
      backgroundColor: project.backgroundColor || '#09090b',
      hostName: project.hostName,
      collaboratorsCount: active.length,
      collaborators: active.slice(0, 5).map((u) => ({name: u.name, color: u.color})),
      clipsCount: project.clips.length,
      tracksCount: project.tracks.length,
      updatedAt: project.updatedAt,
      isPublicLan: project.isPublicLan !== false,
    });
  }
  summaries.sort((a, b) => {
    if (b.collaboratorsCount !== a.collaboratorsCount) {
      return b.collaboratorsCount - a.collaboratorsCount;
    }
    return b.updatedAt - a.updatedAt;
  });
  return summaries;
}

function broadcastToRoom(
  roomId: string,
  payload: ServerWsMessage,
  excludeWs?: WebSocket
) {
  const set = roomConnections.get(roomId);
  if (!set) return;
  const serialized = JSON.stringify(payload);
  for (const conn of set) {
    if (excludeWs && conn.ws === excludeWs) continue;
    if (conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(serialized);
    }
  }
}

let lobbyBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
function broadcastLobbyRooms() {
  if (lobbyBroadcastTimer) return;
  lobbyBroadcastTimer = setTimeout(() => {
    lobbyBroadcastTimer = null;
    const payload = JSON.stringify({
      type: 'lobby:rooms_update',
      rooms: getPublicRoomSummaries(),
    } satisfies ServerWsMessage);
    for (const ws of allSockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }, 120);
}

function getLocalLanIps(): string[] {
  const nets = os.networkInterfaces();
  const ips: string[] = [];
  for (const iface of Object.values(nets)) {
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        ips.push(addr.address);
      }
    }
  }
  return ips;
}

loadRoomsFromDisk();

const app = express();
app.set('trust proxy', true);

// Allow APK (http://localhost) and LAN devices to connect freely to API & uploads
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(express.json({limit: '10mb'}));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (_req, file, cb) => {
    const ext =
      path
        .extname(file.originalname)
        .replace(/[^a-zA-Z0-9.]/g, '')
        .slice(0, 10) || '.bin';
    const token = crypto.randomBytes(8).toString('hex');
    cb(null, `${Date.now()}-${token}${ext}`);
  },
});

const FONT_EXTS = new Set(['.ttf', '.otf', '.woff', '.woff2']);

const upload = multer({
  storage,
  limits: {fileSize: 150 * 1024 * 1024},
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (
      file.mimetype.startsWith('video/') ||
      file.mimetype.startsWith('image/') ||
      file.mimetype.startsWith('audio/') ||
      file.mimetype.startsWith('font/') ||
      file.mimetype.includes('font') ||
      FONT_EXTS.has(ext)
    ) {
      cb(null, true);
    } else {
      cb(
        new Error(
          'Разрешены только видео, изображения, аудио и шрифты (.ttf/.otf/.woff2)'
        )
      );
    }
  },
});

app.use(
  '/uploads',
  express.static(UPLOADS_DIR, {
    acceptRanges: true,
    maxAge: '1d',
  })
);

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    app: 'CutSync',
    host: os.hostname(),
    roomsCount: rooms.size,
    onlineUsers: allSockets.size,
    uptime: Math.round(process.uptime()),
  });
});

app.get('/api/network-info', (req, res) => {
  const ips = getLocalLanIps();
  const protocol = req.protocol;
  const host = req.get('host');
  res.json({
    origin: `${protocol}://${host}`,
    lanUrls: ips.map((ip) => `http://${ip}:${PORT}`),
    hostName: os.hostname(),
  });
});

// Minecraft-style LAN Room Browser list
app.get('/api/rooms', (_req, res) => {
  res.json({
    rooms: getPublicRoomSummaries(),
    host: os.hostname(),
  });
});

app.post('/api/rooms', (req, res) => {
  const blank = Boolean(req.body?.blank);
  const title = typeof req.body?.title === 'string' ? req.body.title : undefined;
  const aspectRatio =
    typeof req.body?.aspectRatio === 'string'
      ? (req.body.aspectRatio as AspectRatio)
      : undefined;
  const backgroundColor =
    typeof req.body?.backgroundColor === 'string'
      ? req.body.backgroundColor
      : undefined;
  const hostName =
    typeof req.body?.hostName === 'string' ? req.body.hostName : undefined;
  const isPublicLan =
    typeof req.body?.isPublicLan === 'boolean' ? req.body.isPublicLan : true;
  const customId = typeof req.body?.roomId === 'string' ? req.body.roomId : '';
  const roomId = customId
    ? sanitizeRoomId(customId)
    : `cut-${crypto.randomBytes(3).toString('hex')}`;
  const project = getOrCreateRoom(roomId, {
    blank,
    title,
    aspectRatio,
    backgroundColor,
    hostName,
    isPublicLan,
  });
  broadcastLobbyRooms();
  res.json({roomId: project.roomId, title: project.title});
});

app.get('/api/rooms/:roomId', (req, res) => {
  const safeId = sanitizeRoomId(req.params.roomId);
  const project = getOrCreateRoom(safeId);
  res.json({
    roomId: project.roomId,
    title: project.title,
    aspectRatio: project.aspectRatio,
    backgroundColor: project.backgroundColor,
    collaboratorsCount: roomConnections.get(safeId)?.size ?? 0,
  });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({error: 'Файл не получен'});
    return;
  }
  const ext = path.extname(file.originalname).toLowerCase();
  const kind =
    FONT_EXTS.has(ext) ||
    file.mimetype.startsWith('font/') ||
    file.mimetype.includes('font')
      ? 'font'
      : file.mimetype.startsWith('video/')
        ? 'video'
        : file.mimetype.startsWith('audio/')
          ? 'audio'
          : 'image';

  let displayName = file.originalname;
  try {
    displayName = Buffer.from(file.originalname, 'latin1').toString('utf8');
  } catch {
    displayName = file.originalname;
  }

  res.json({
    id: crypto.randomBytes(6).toString('hex'),
    name: displayName,
    kind,
    src: `/uploads/${file.filename}`,
    sizeBytes: file.size,
  });
});

app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    res.status(400).json({error: err.message || 'Ошибка сервера'});
  }
);

const server = http.createServer(app);
const wss = new WebSocketServer({server, path: '/ws'});

function removeSession(session: ClientSession | null) {
  if (!session) return;
  const set = roomConnections.get(session.roomId);
  if (set) {
    set.delete(session);
    if (set.size === 0) {
      roomConnections.delete(session.roomId);
    } else {
      broadcastToRoom(session.roomId, {
        type: 'presence:update',
        collaborators: getRoomCollaborators(session.roomId),
      });
    }
    broadcastLobbyRooms();
  }
}

wss.on('connection', (ws) => {
  allSockets.add(ws);
  let session: ClientSession | null = null;

  ws.on('pong', () => {
    if (session) session.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg: ClientWsMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientWsMessage;
    } catch {
      return;
    }

    if (msg.type === 'lobby:get_rooms') {
      ws.send(
        JSON.stringify({
          type: 'lobby:rooms_update',
          rooms: getPublicRoomSummaries(),
        } satisfies ServerWsMessage)
      );
      return;
    }

    if (msg.type === 'join') {
      if (session) {
        removeSession(session);
      }
      const roomId = sanitizeRoomId(msg.roomId);
      const project = getOrCreateRoom(roomId);
      const user: Collaborator = {
        id: String(msg.user.id).slice(0, 48),
        name: String(msg.user.name || 'Редактор').slice(0, 28),
        color: String(msg.user.color || '#22d3ee').slice(0, 16),
        playhead: 0,
        selectedClipId: null,
        isPlaying: false,
        lastActive: Date.now(),
      };
      session = {ws, roomId, user, isAlive: true};

      let set = roomConnections.get(roomId);
      if (!set) {
        set = new Set();
        roomConnections.set(roomId, set);
      }
      set.add(session);

      const initPayload: ServerWsMessage = {
        type: 'room:init',
        project,
        collaborators: getRoomCollaborators(roomId),
        rooms: getPublicRoomSummaries(),
      };
      ws.send(JSON.stringify(initPayload));

      broadcastToRoom(
        roomId,
        {
          type: 'presence:update',
          collaborators: getRoomCollaborators(roomId),
        },
        ws
      );
      broadcastLobbyRooms();
      return;
    }

    if (!session) return;
    const project = rooms.get(session.roomId);
    if (!project) return;
    session.user.lastActive = Date.now();

    switch (msg.type) {
      case 'presence:profile': {
        session.user.name = String(msg.name || 'Редактор').slice(0, 28);
        session.user.color = String(msg.color || '#22d3ee').slice(0, 16);
        broadcastToRoom(session.roomId, {
          type: 'presence:update',
          collaborators: getRoomCollaborators(session.roomId),
        });
        broadcastLobbyRooms();
        break;
      }

      case 'op:track_add': {
        if (project.tracks.some((t) => t.id === msg.track.id)) return;
        project.tracks.push(msg.track);
        project.revision += 1;
        project.updatedAt = Date.now();
        scheduleSaveRooms();
        broadcastToRoom(
          session.roomId,
          {
            type: 'op:track_add',
            track: msg.track,
            revision: project.revision,
            senderId: session.user.id,
          },
          ws
        );
        broadcastLobbyRooms();
        break;
      }

      case 'op:track_update': {
        const idx = project.tracks.findIndex((t) => t.id === msg.trackId);
        if (idx === -1) return;
        project.tracks[idx] = {
          ...project.tracks[idx],
          ...msg.patch,
          id: project.tracks[idx].id,
        };
        project.revision += 1;
        project.updatedAt = Date.now();
        scheduleSaveRooms();
        broadcastToRoom(
          session.roomId,
          {
            type: 'op:track_update',
            trackId: msg.trackId,
            patch: msg.patch,
            revision: project.revision,
            senderId: session.user.id,
          },
          ws
        );
        break;
      }

      case 'op:track_delete': {
        if (project.tracks.length <= 1) return;
        project.tracks = project.tracks.filter((t) => t.id !== msg.trackId);
        project.clips = project.clips.filter((c) => c.trackId !== msg.trackId);
        project.revision += 1;
        project.updatedAt = Date.now();
        scheduleSaveRooms();
        broadcastToRoom(
          session.roomId,
          {
            type: 'op:track_delete',
            trackId: msg.trackId,
            revision: project.revision,
            senderId: session.user.id,
          },
          ws
        );
        broadcastLobbyRooms();
        break;
      }

      case 'op:clip_add': {
        if (project.clips.some((c) => c.id === msg.clip.id)) return;
        if (
          msg.newTrack &&
          !project.tracks.some((t) => t.id === msg.newTrack!.id)
        ) {
          project.tracks.push(msg.newTrack);
        }
        project.clips.push(msg.clip);
        project.revision += 1;
        project.updatedAt = Date.now();
        scheduleSaveRooms();
        broadcastToRoom(
          session.roomId,
          {
            type: 'op:clip_add',
            clip: msg.clip,
            newTrack: msg.newTrack,
            revision: project.revision,
            senderId: session.user.id,
          },
          ws
        );
        broadcastLobbyRooms();
        break;
      }

      case 'op:clip_update': {
        const idx = project.clips.findIndex((c) => c.id === msg.clipId);
        if (idx === -1) return;
        project.clips[idx] = {
          ...project.clips[idx],
          ...msg.patch,
          id: project.clips[idx].id,
        };
        project.revision += 1;
        project.updatedAt = Date.now();
        scheduleSaveRooms();
        broadcastToRoom(
          session.roomId,
          {
            type: 'op:clip_update',
            clipId: msg.clipId,
            patch: msg.patch,
            revision: project.revision,
            senderId: session.user.id,
          },
          ws
        );
        break;
      }

      case 'op:clip_delete': {
        const prevLen = project.clips.length;
        project.clips = project.clips.filter((c) => c.id !== msg.clipId);
        if (project.clips.length === prevLen) return;
        project.revision += 1;
        project.updatedAt = Date.now();
        scheduleSaveRooms();
        broadcastToRoom(
          session.roomId,
          {
            type: 'op:clip_delete',
            clipId: msg.clipId,
            revision: project.revision,
            senderId: session.user.id,
          },
          ws
        );
        broadcastLobbyRooms();
        break;
      }

      case 'op:clip_split': {
        const nextClips = applyClipSplit(
          project.clips,
          msg.clipId,
          msg.splitTime,
          msg.newClipId
        );
        if (nextClips === project.clips) return;
        project.clips = nextClips;
        project.revision += 1;
        project.updatedAt = Date.now();
        scheduleSaveRooms();
        broadcastToRoom(
          session.roomId,
          {
            type: 'op:clip_split',
            clipId: msg.clipId,
            splitTime: msg.splitTime,
            newClipId: msg.newClipId,
            revision: project.revision,
            senderId: session.user.id,
          },
          ws
        );
        break;
      }

      case 'op:project_meta': {
        if (typeof msg.patch.title === 'string') {
          project.title = msg.patch.title.slice(0, 60);
        }
        if (msg.patch.aspectRatio) {
          project.aspectRatio = msg.patch.aspectRatio;
        }
        if (typeof msg.patch.backgroundColor === 'string') {
          project.backgroundColor = msg.patch.backgroundColor.slice(0, 32);
        }
        if (typeof msg.patch.hostName === 'string') {
          project.hostName = msg.patch.hostName.slice(0, 28);
        }
        if (Array.isArray(msg.patch.customFonts)) {
          project.customFonts = msg.patch.customFonts;
        }
        if (typeof msg.patch.isPublicLan === 'boolean') {
          project.isPublicLan = msg.patch.isPublicLan;
        }
        project.revision += 1;
        project.updatedAt = Date.now();
        scheduleSaveRooms();
        broadcastToRoom(
          session.roomId,
          {
            type: 'op:project_meta',
            patch: msg.patch,
            revision: project.revision,
            senderId: session.user.id,
          },
          ws
        );
        broadcastLobbyRooms();
        break;
      }

      case 'op:project_replace': {
        project.clips = msg.clips;
        if (msg.tracks) project.tracks = msg.tracks;
        if (msg.aspectRatio) project.aspectRatio = msg.aspectRatio;
        if (typeof msg.title === 'string') project.title = msg.title.slice(0, 60);
        if (typeof msg.backgroundColor === 'string') {
          project.backgroundColor = msg.backgroundColor.slice(0, 32);
        }
        if (Array.isArray(msg.customFonts)) {
          project.customFonts = msg.customFonts;
        }
        project.revision += 1;
        project.updatedAt = Date.now();
        scheduleSaveRooms();
        broadcastToRoom(
          session.roomId,
          {
            type: 'op:project_replace',
            clips: project.clips,
            tracks: project.tracks,
            aspectRatio: project.aspectRatio,
            title: project.title,
            backgroundColor: project.backgroundColor,
            customFonts: project.customFonts,
            revision: project.revision,
            senderId: session.user.id,
          },
          ws
        );
        broadcastLobbyRooms();
        break;
      }

      case 'presence:cursor': {
        session.user.playhead = msg.playhead;
        session.user.selectedClipId = msg.selectedClipId;
        session.user.isPlaying = msg.isPlaying;
        broadcastToRoom(
          session.roomId,
          {
            type: 'presence:update',
            collaborators: getRoomCollaborators(session.roomId),
          },
          ws
        );
        break;
      }

      case 'chat:send': {
        const cleanText = String(msg.text || '').trim().slice(0, 400);
        if (!cleanText) return;
        if (project.chat.some((m) => m.id === msg.messageId)) return;
        const chatMsg = {
          id: msg.messageId,
          userId: session.user.id,
          userName: session.user.name,
          userColor: session.user.color,
          text: cleanText,
          timestamp: Date.now(),
        };
        project.chat.push(chatMsg);
        if (project.chat.length > 100) {
          project.chat = project.chat.slice(-100);
        }
        scheduleSaveRooms();
        broadcastToRoom(session.roomId, {
          type: 'chat:message',
          message: chatMsg,
        });
        break;
      }
    }
  });

  ws.on('close', () => {
    allSockets.delete(ws);
    removeSession(session);
    session = null;
  });

  ws.on('error', () => {
    allSockets.delete(ws);
    removeSession(session);
    session = null;
  });
});

setInterval(() => {
  for (const set of roomConnections.values()) {
    for (const conn of set) {
      if (!conn.isAlive) {
        conn.ws.terminate();
        removeSession(conn);
        continue;
      }
      conn.isAlive = false;
      conn.ws.ping();
    }
  }
}, 25000);

// Minecraft-style UDP LAN discovery beacon on local Wi-Fi networks
function startLanBeacon() {
  try {
    const udp = dgram.createSocket('udp4');
    udp.on('error', () => {
      // Ignore if container/OS restricts UDP broadcast
    });
    udp.bind(() => {
      try {
        udp.setBroadcast(true);
      } catch {
        // ignore
      }
    });
    setInterval(() => {
      const publicRooms = getPublicRoomSummaries();
      if (publicRooms.length === 0) return;
      const packet = Buffer.from(
        JSON.stringify({
          app: 'CutSync',
          port: PORT,
          host: os.hostname(),
          roomsCount: publicRooms.length,
        })
      );
      try {
        udp.send(packet, 41234, '255.255.255.255');
      } catch {
        // ignore
      }
    }, 2500);
  } catch {
    // ignore
  }
}

async function startServer() {
  if (!IS_PROD) {
    const {createServer: createViteServer} = await import('vite');
    const vite = await createViteServer({
      server: {middlewareMode: true, hmr: false},
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(ROOT_DIR, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`CutSync server listening on http://0.0.0.0:${PORT}`);
    startLanBeacon();
  });
}

startServer().catch((err) => {
  console.error('Failed to start CutSync server:', err);
  process.exit(1);
});
