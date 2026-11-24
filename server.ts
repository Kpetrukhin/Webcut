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
  applyClipDuplicate,
  applyClipPatch,
  applyClipSplit,
  applyTrackReorder,
  createDefaultTracks,
  createStarterClips,
  insertTrackAt,
  normalizeProjectTracks,
} from './src/shared/types.ts';
import type {
  AspectRatio,
  CanvasBackground,
  ClientWsMessage,
  Collaborator,
  NetworkInterfaceInfo,
  ProjectState,
  RoomSummary,
  ServerWsMessage,
} from './src/shared/types.ts';
import {validateServerStorageDir} from './src/lib/storagePathRules.ts';

let ACTIVE_PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const DEFAULT_LOCK_TIMEOUT_MS = Number(process.env.LOCK_TIMEOUT_MS) || 5000;
let lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS;

const ROOT_DIR = process.cwd();
const DEFAULT_UPLOADS_DIR = process.env.CUTSYNC_UPLOADS_DIR
  ? path.resolve(process.env.CUTSYNC_UPLOADS_DIR)
  : path.join(ROOT_DIR, 'uploads');
const DATA_DIR = process.env.CUTSYNC_DATA_DIR
  ? path.resolve(process.env.CUTSYNC_DATA_DIR)
  : path.join(ROOT_DIR, 'data');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
const STORAGE_CONFIG_FILE = path.join(DATA_DIR, 'storage-config.json');

fs.mkdirSync(DEFAULT_UPLOADS_DIR, {recursive: true});
fs.mkdirSync(DATA_DIR, {recursive: true});

let activeUploadsDir = DEFAULT_UPLOADS_DIR;

function loadStorageConfigFromDisk() {
  try {
    if (!fs.existsSync(STORAGE_CONFIG_FILE)) return;
    const raw = fs.readFileSync(STORAGE_CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as {customDir?: string | null};
    if (typeof parsed.customDir === 'string' && parsed.customDir.trim()) {
      const check = validateServerStorageDir(parsed.customDir, ROOT_DIR);
      if (check.valid && check.resolvedPath) {
        fs.mkdirSync(check.resolvedPath, {recursive: true});
        activeUploadsDir = check.resolvedPath;
      }
    }
  } catch (err) {
    console.error('Failed to load storage-config.json:', err);
  }
}

function saveStorageConfigToDisk(customDir: string | null) {
  try {
    fs.writeFileSync(
      STORAGE_CONFIG_FILE,
      JSON.stringify({customDir}, null, 2),
      'utf-8'
    );
  } catch (err) {
    console.error('Failed to save storage-config.json:', err);
  }
}

function getActiveUploadsDir(): string {
  try {
    fs.mkdirSync(activeUploadsDir, {recursive: true});
    return activeUploadsDir;
  } catch {
    fs.mkdirSync(DEFAULT_UPLOADS_DIR, {recursive: true});
    return DEFAULT_UPLOADS_DIR;
  }
}

const FAST_FINGERPRINT_CHUNK_BYTES = 64 * 1024;

function sanitizeMediaExt(originalName?: string, mimeType?: string): string {
  const cleanName = (originalName || '').split(/[?#]/)[0].trim();
  const dotIdx = cleanName.lastIndexOf('.');
  if (dotIdx !== -1 && dotIdx < cleanName.length - 1) {
    const ext = cleanName
      .slice(dotIdx + 1)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 10);
    if (ext) return ext;
  }
  const mime = (mimeType || '').toLowerCase();
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('quicktime')) return 'mov';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('mpeg')) return 'mp3';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('aac') || mime.includes('mp4a')) return 'm4a';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('ttf')) return 'ttf';
  if (mime.includes('otf')) return 'otf';
  if (mime.includes('woff2')) return 'woff2';
  if (mime.includes('woff')) return 'woff';
  return 'bin';
}

function buildDedupBaseName(
  hash24: string,
  size: number,
  originalName?: string,
  mimeType?: string
): string {
  const safeHash =
    hash24.toLowerCase().replace(/[^a-f0-9]/g, '').slice(0, 24) || '0'.repeat(24);
  const safeSize = Math.max(0, Math.trunc(size));
  const ext = sanitizeMediaExt(originalName, mimeType);
  return `${safeHash}_${safeSize}.${ext}`;
}

function computeFastFileFingerprint(filePath: string): {hash: string; size: number} {
  const stat = fs.statSync(filePath);
  const size = stat.size;
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    if (size <= FAST_FINGERPRINT_CHUNK_BYTES * 2) {
      const buf = Buffer.allocUnsafe(size);
      let total = 0;
      while (total < size) {
        const n = fs.readSync(fd, buf, total, size - total, total);
        if (n <= 0) break;
        total += n;
      }
      hash.update(buf.subarray(0, total));
    } else {
      const head = Buffer.allocUnsafe(FAST_FINGERPRINT_CHUNK_BYTES);
      const headRead = fs.readSync(fd, head, 0, FAST_FINGERPRINT_CHUNK_BYTES, 0);
      hash.update(head.subarray(0, headRead));
      const tail = Buffer.allocUnsafe(FAST_FINGERPRINT_CHUNK_BYTES);
      const tailRead = fs.readSync(
        fd,
        tail,
        0,
        FAST_FINGERPRINT_CHUNK_BYTES,
        size - FAST_FINGERPRINT_CHUNK_BYTES
      );
      hash.update(tail.subarray(0, tailRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return {hash: hash.digest('hex').slice(0, 24), size};
}

function getMediaDirFor(baseDir = getActiveUploadsDir()): string {
  const dir = path.join(baseDir, 'media');
  fs.mkdirSync(dir, {recursive: true});
  return dir;
}

function getProjectsDirFor(baseDir = getActiveUploadsDir()): string {
  const dir = path.join(baseDir, 'projects');
  fs.mkdirSync(dir, {recursive: true});
  return dir;
}

function getExportDirFor(baseDir = getActiveUploadsDir()): string {
  const dir = path.join(baseDir, 'export');
  fs.mkdirSync(dir, {recursive: true});
  return dir;
}

function sanitizeProjectId(rawId: string): string {
  const cleaned = (rawId || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 64);
  return cleaned || 'studio-demo';
}

function normalizeBaseMediaName(rawName: string): string {
  const clean = rawName.trim().replace(/\\/g, '/').split(/[?#]/)[0];
  const base = clean.split('/').pop() || clean;
  return base.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function findExistingMediaFile(
  rawName: string,
  expectedSize?: number
): {filePath: string; baseName: string; size: number} | null {
  const baseName = normalizeBaseMediaName(rawName);
  if (!baseName) return null;
  const currentDir = getActiveUploadsDir();
  const candidates = [
    path.join(currentDir, 'media', baseName),
    path.join(currentDir, baseName),
    path.join(DEFAULT_UPLOADS_DIR, 'media', baseName),
    path.join(DEFAULT_UPLOADS_DIR, baseName),
  ];
  for (const candidate of candidates) {
    try {
      const st = fs.statSync(candidate);
      if (st.isFile() && st.size > 0) {
        if (expectedSize && expectedSize > 0 && st.size !== expectedSize) {
          continue;
        }
        return {filePath: candidate, baseName, size: st.size};
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

function moveFileReplaceSync(src: string, dst: string) {
  try {
    if (fs.existsSync(dst)) fs.unlinkSync(dst);
    fs.renameSync(src, dst);
  } catch {
    fs.copyFileSync(src, dst);
    fs.unlinkSync(src);
  }
}

function computeDirStats(dirPath: string): {filesCount: number; totalBytes: number} {
  let filesCount = 0;
  let totalBytes = 0;
  const scanFlat = (targetDir: string, skipJson: boolean) => {
    try {
      const entries = fs.readdirSync(targetDir, {withFileTypes: true});
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (entry.name.startsWith('.')) continue;
        if (entry.name.endsWith('.part')) continue;
        if (skipJson && entry.name.toLowerCase().endsWith('.json')) continue;
        try {
          const st = fs.statSync(path.join(targetDir, entry.name));
          if (st.isFile()) {
            filesCount += 1;
            totalBytes += st.size;
          }
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  };
  scanFlat(path.join(dirPath, 'media'), false);
  scanFlat(dirPath, true);
  return {filesCount, totalBytes};
}

function copyMediaFilesBetweenDirs(fromDir: string, toDir: string): number {
  if (path.resolve(fromDir) === path.resolve(toDir)) return 0;
  let migratedCount = 0;
  const copyFlat = (srcDir: string, dstDir: string, overwrite: boolean) => {
    try {
      if (!fs.existsSync(srcDir)) return;
      fs.mkdirSync(dstDir, {recursive: true});
      const entries = fs.readdirSync(srcDir, {withFileTypes: true});
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (entry.name.startsWith('.')) continue;
        if (entry.name.endsWith('.part')) continue;
        const srcPath = path.join(srcDir, entry.name);
        const dstPath = path.join(dstDir, entry.name);
        try {
          if (overwrite || !fs.existsSync(dstPath)) {
            fs.copyFileSync(srcPath, dstPath);
            migratedCount += 1;
          }
        } catch {
          // ignore individual copy error
        }
      }
    } catch {
      // ignore
    }
  };
  copyFlat(path.join(fromDir, 'media'), path.join(toDir, 'media'), false);
  copyFlat(path.join(fromDir, 'projects'), path.join(toDir, 'projects'), true);
  // Migrate legacy flat files into structured subdirs
  try {
    fs.mkdirSync(path.join(toDir, 'media'), {recursive: true});
    const entries = fs.readdirSync(fromDir, {withFileTypes: true});
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name.startsWith('.') || entry.name.endsWith('.part')) continue;
      const srcPath = path.join(fromDir, entry.name);
      const isJson = entry.name.toLowerCase().endsWith('.json');
      const dstSub = isJson ? path.join(toDir, 'projects') : path.join(toDir, 'media');
      fs.mkdirSync(dstSub, {recursive: true});
      const dstPath = path.join(dstSub, entry.name);
      try {
        if (isJson || !fs.existsSync(dstPath)) {
          fs.copyFileSync(srcPath, dstPath);
          migratedCount += 1;
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  return migratedCount;
}

function getServerStorageSummary() {
  const currentDir = getActiveUploadsDir();
  const stats = computeDirStats(currentDir);
  const canNativePick =
    typeof (globalThis as {__cutsyncPickDirectory?: unknown})
      .__cutsyncPickDirectory === 'function';
  const presets: Array<{label: string; path: string; isDefault?: boolean}> = [
    {
      label: 'По стандарту (корень приложения)',
      path: DEFAULT_UPLOADS_DIR,
      isDefault: true,
    },
    {
      label: 'Папка media-sync в корне приложения',
      path: path.join(ROOT_DIR, 'media-sync'),
    },
    {
      label: 'Домашняя папка / CutSyncMedia',
      path: path.join(os.homedir(), 'CutSyncMedia'),
    },
  ];
  return {
    currentDir,
    defaultDir: DEFAULT_UPLOADS_DIR,
    isDefault: path.resolve(currentDir) === path.resolve(DEFAULT_UPLOADS_DIR),
    filesCount: stats.filesCount,
    totalBytes: stats.totalBytes,
    canNativePick,
    presets,
  };
}

loadStorageConfigFromDisk();

const rooms = new Map<string, ProjectState>();
const roomConnections = new Map<string, Set<ClientSession>>();
const roomLockTimestamps = new Map<string, Map<string, number>>();
const allSockets = new Set<WebSocket>();
const fileHashCache = new Map<string, string>();

function computeFileSha256(filePath: string): string {
  try {
    const stat = fs.statSync(filePath);
    const cacheKey = `${filePath}:${stat.size}:${stat.mtimeMs}`;
    const cached = fileHashCache.get(cacheKey);
    if (cached) return cached;
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.allocUnsafe(64 * 1024);
    try {
      let bytesRead = 0;
      while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
        hash.update(buf.subarray(0, bytesRead));
      }
    } finally {
      fs.closeSync(fd);
    }
    const digest = hash.digest('hex');
    fileHashCache.set(cacheKey, digest);
    return digest;
  } catch {
    return '';
  }
}

function touchLayerLock(roomId: string, layerId: string) {
  let map = roomLockTimestamps.get(roomId);
  if (!map) {
    map = new Map();
    roomLockTimestamps.set(roomId, map);
  }
  map.set(layerId, Date.now());
}

function clearLayerLockTimestamp(roomId: string, layerId: string) {
  const map = roomLockTimestamps.get(roomId);
  if (!map) return;
  map.delete(layerId);
  if (map.size === 0) {
    roomLockTimestamps.delete(roomId);
  }
}

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
    canvasBackground?: CanvasBackground;
    hostName?: string;
    isPublicLan?: boolean;
  }
): ProjectState {
  const defaultTitle =
    roomId === 'studio-demo' ? 'Ночной ролик' : `Проект ${roomId}`;
  const bg = opts?.backgroundColor || '#09090b';
  return {
    roomId,
    title: opts?.title?.trim().slice(0, 60) || defaultTitle,
    aspectRatio: opts?.aspectRatio || '9:16',
    backgroundColor: bg,
    canvasBackground: opts?.canvasBackground ?? {type: 'solid', color: bg},
    hostName: opts?.hostName?.trim().slice(0, 28) || undefined,
    fps: 30,
    isPublicLan: opts?.isPublicLan ?? true,
    customFonts: [],
    trackers: [],
    tracks: createDefaultTracks(),
    clips: opts?.blank ? [] : createStarterClips(),
    revision: 0,
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
function serializeRoomsState(): string {
  const obj: Record<string, ProjectState> = {};
  for (const [k, v] of rooms.entries()) {
    obj[k] = v;
  }
  return JSON.stringify(obj, null, 2);
}

function flushRoomsToDiskSync() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    fs.writeFileSync(ROOMS_FILE, serializeRoomsState(), 'utf-8');
  } catch (err) {
    console.error('Failed to flush rooms.json:', err);
  }
}

function scheduleSaveRooms() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(ROOMS_FILE, serializeRoomsState(), (err) => {
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
    canvasBackground?: CanvasBackground;
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
      canvasBackground: project.canvasBackground,
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

function sendSyncAck(
  ws: WebSocket,
  revision: number,
  prevRevision: number,
  opType?: string
) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        type: 'sync:ack',
        revision,
        prevRevision,
        opType,
      } satisfies ServerWsMessage)
    );
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

function getNetworkInterfacesList(): NetworkInterfaceInfo[] {
  const nets = os.networkInterfaces();
  const list: NetworkInterfaceInfo[] = [];
  for (const [name, addrs] of Object.entries(nets)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        const lower = name.toLowerCase();
        const isVpn =
          lower.startsWith('zt') ||
          lower.startsWith('tun') ||
          lower.startsWith('tap');
        const isWifi =
          lower.startsWith('wl') ||
          lower.startsWith('wifi') ||
          lower.startsWith('wi-fi') ||
          lower.startsWith('ap') ||
          lower.startsWith('en');
        const type: NetworkInterfaceInfo['type'] = isVpn
          ? 'zerotier'
          : isWifi || addr.address.startsWith('192.168.')
            ? 'wifi'
            : addr.address.startsWith('10.')
              ? 'zerotier'
              : 'lan';
        const label = lower.startsWith('zt')
          ? `ZeroTier (${name})`
          : type === 'zerotier'
            ? `VPN / ZeroTier (${name})`
            : type === 'wifi'
              ? `Wi-Fi (${name})`
              : `LAN (${name})`;
        list.push({name, ip: addr.address, type, label});
      }
    }
  }
  return list.sort((a, b) => {
    const rank = (t: NetworkInterfaceInfo['type']) =>
      t === 'zerotier' ? 0 : t === 'wifi' ? 1 : 2;
    return rank(a.type) - rank(b.type);
  });
}

function getLocalLanIps(): string[] {
  return getNetworkInterfacesList().map((n) => n.ip);
}

loadRoomsFromDisk();

const app = express();
app.set('trust proxy', true);

// Allow APK (http://localhost) and LAN devices to connect freely to API & uploads
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header(
    'Access-Control-Expose-Headers',
    'X-File-Size, X-Content-Sha256, Content-Length'
  );
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(express.json({limit: '10mb'}));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, getMediaDirFor());
  },
  filename: (_req, file, cb) => {
    const ext = sanitizeMediaExt(file.originalname, file.mimetype);
    const token = crypto.randomBytes(8).toString('hex');
    cb(null, `.upload-${Date.now()}-${token}.${ext}.part`);
  },
});

const FONT_EXTS = new Set(['.ttf', '.otf', '.woff', '.woff2']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v', '.3gp']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.aac', '.m4a', '.ogg', '.opus', '.flac']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif']);

const upload = multer({
  storage,
  limits: {fileSize: 2 * 1024 * 1024 * 1024},
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (
      file.mimetype.startsWith('video/') ||
      file.mimetype.startsWith('image/') ||
      file.mimetype.startsWith('audio/') ||
      file.mimetype.startsWith('font/') ||
      file.mimetype.includes('font') ||
      FONT_EXTS.has(ext) ||
      VIDEO_EXTS.has(ext) ||
      AUDIO_EXTS.has(ext) ||
      IMAGE_EXTS.has(ext)
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

const staticMediaHeaders = (
  res: express.Response,
  filePath: string
) => {
  try {
    const stat = fs.statSync(filePath);
    if (stat.isFile()) {
      res.setHeader('X-File-Size', String(stat.size));
      const hash = computeFileSha256(filePath);
      if (hash) {
        res.setHeader('X-Content-Sha256', hash);
      }
    }
  } catch {
    // ignore
  }
};

let cachedStaticDir = '';
let cachedMediaSubHandler: express.RequestHandler | null = null;
let cachedRootHandler: express.RequestHandler | null = null;
const defaultMediaSubHandler = express.static(path.join(DEFAULT_UPLOADS_DIR, 'media'), {
  acceptRanges: true,
  maxAge: '1d',
  setHeaders: staticMediaHeaders,
});
const defaultStaticHandler = express.static(DEFAULT_UPLOADS_DIR, {
  acceptRanges: true,
  maxAge: '1d',
  setHeaders: staticMediaHeaders,
});

function dynamicMediaStatic(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const currentDir = getActiveUploadsDir();
  if (!cachedMediaSubHandler || !cachedRootHandler || cachedStaticDir !== currentDir) {
    cachedStaticDir = currentDir;
    cachedMediaSubHandler = express.static(path.join(currentDir, 'media'), {
      acceptRanges: true,
      maxAge: '1d',
      setHeaders: staticMediaHeaders,
    });
    cachedRootHandler = express.static(currentDir, {
      acceptRanges: true,
      maxAge: '1d',
      setHeaders: staticMediaHeaders,
    });
  }
  cachedMediaSubHandler(req, res, (err) => {
    if (err) {
      next(err);
      return;
    }
    cachedRootHandler!(req, res, (err2) => {
      if (err2) {
        next(err2);
        return;
      }
      if (path.resolve(currentDir) !== path.resolve(DEFAULT_UPLOADS_DIR)) {
        defaultMediaSubHandler(req, res, (err3) => {
          if (err3) {
            next(err3);
            return;
          }
          defaultStaticHandler(req, res, next);
        });
        return;
      }
      next();
    });
  });
}

app.use('/uploads', dynamicMediaStatic);
app.use('/media', dynamicMediaStatic);

app.get('/api/media/exists', (req, res) => {
  const hashParam = typeof req.query.hash === 'string' ? req.query.hash.trim() : '';
  const sizeParam = Number(req.query.size || req.query.expectedSize || 0);
  const extParam = typeof req.query.ext === 'string' ? req.query.ext.trim() : '';
  const rawName =
    (typeof req.query.fileName === 'string' ? req.query.fileName : '').trim() ||
    (hashParam && Number.isFinite(sizeParam) && sizeParam >= 0
      ? buildDedupBaseName(hashParam, sizeParam, `file.${extParam || 'bin'}`)
      : '');
  const expectedSize = sizeParam;
  if (!rawName) {
    res.json({exists: false});
    return;
  }
  const found = findExistingMediaFile(
    rawName,
    Number.isFinite(expectedSize) && expectedSize > 0 ? expectedSize : undefined
  );
  if (!found) {
    res.json({exists: false});
    return;
  }
  const fileHash = computeFileSha256(found.filePath);
  const relPath = `media/${found.baseName}`;
  res.json({
    exists: true,
    fileName: relPath,
    baseName: found.baseName,
    relativePath: relPath,
    localUrl: `/media/${found.baseName}`,
    fileSize: found.size,
    fileHash,
  });
});

app.post('/media/upload', (req, res, next) => {
  const rawName = req.query.fileName;
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('multipart/form-data')) {
    return next();
  }
  const origName =
    typeof rawName === 'string' && rawName.trim()
      ? path.basename(rawName).replace(/[^a-zA-Z0-9._-]/g, '_')
      : `media-${Date.now()}.bin`;
  const mediaDir = getMediaDirFor();
  const tempPath = path.resolve(
    mediaDir,
    `.upload-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.part`
  );
  if (!tempPath.startsWith(path.resolve(mediaDir) + path.sep)) {
    res.status(400).json({error: 'Недопустимое имя файла'});
    return;
  }
  const ws = fs.createWriteStream(tempPath);
  req.pipe(ws);
  ws.on('finish', () => {
    try {
      const fp = computeFastFileFingerprint(tempPath);
      const dedupBase = buildDedupBaseName(fp.hash, fp.size, origName, contentType);
      const destPath = path.resolve(mediaDir, dedupBase);
      let deduplicated = false;
      if (fs.existsSync(destPath)) {
        try {
          if (fs.statSync(destPath).size === fp.size) {
            fs.unlinkSync(tempPath);
            deduplicated = true;
          }
        } catch {
          // proceed to overwrite
        }
      }
      if (!deduplicated) {
        moveFileReplaceSync(tempPath, destPath);
      }

      const ifaces = getNetworkInterfacesList();
      const primaryIp =
        ifaces.find((i) => i.type === 'wifi')?.ip ||
        ifaces[0]?.ip ||
        '127.0.0.1';
      const relPath = `media/${dedupBase}`;
      const fileHash = computeFileSha256(destPath);
      res.json({
        ok: true,
        deduplicated,
        fileName: relPath,
        baseName: dedupBase,
        relativePath: relPath,
        localUrl: `/media/${dedupBase}`,
        shareUrl: `http://${primaryIp}:${ACTIVE_PORT}/media/${dedupBase}`,
        fileSize: fp.size,
        fileHash,
      });
    } catch (err) {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {
        // ignore
      }
      res.status(500).json({error: err instanceof Error ? err.message : String(err)});
    }
  });
  ws.on('error', (err) => {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // ignore
    }
    res.status(500).json({error: err.message});
  });
});

app.post('/api/export/prepare', (_req, res) => {
  const exportDir = getExportDirFor();
  res.json({
    ok: true,
    exportDir,
    relativePath: 'export',
  });
});

app.post('/api/export/upload', (req, res) => {
  const rawName = req.query.fileName;
  const rawExt = typeof req.query.ext === 'string' ? req.query.ext : 'mp4';
  const cleanExt = rawExt.toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';
  const fallbackStamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, '')
    .slice(0, 15);
  const safeName =
    typeof rawName === 'string' && rawName.trim()
      ? path.basename(rawName).replace(/[^a-zA-Z0-9._-]/g, '_')
      : `Webcut_${fallbackStamp}.${cleanExt}`;
  const exportDir = getExportDirFor();
  const tempPath = path.resolve(
    exportDir,
    `.export-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.part`
  );
  const destPath = path.resolve(exportDir, safeName);
  if (
    !tempPath.startsWith(path.resolve(exportDir) + path.sep) ||
    !destPath.startsWith(path.resolve(exportDir) + path.sep)
  ) {
    res.status(400).json({error: 'Недопустимое имя файла экспорта'});
    return;
  }
  const ws = fs.createWriteStream(tempPath);
  req.pipe(ws);
  ws.on('finish', () => {
    try {
      moveFileReplaceSync(tempPath, destPath);
      const stat = fs.statSync(destPath);
      res.json({
        ok: true,
        fileName: safeName,
        relativePath: `export/${safeName}`,
        savedPath: destPath,
        fileSize: stat.size,
      });
    } catch (err) {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {
        // ignore
      }
      res.status(500).json({error: err instanceof Error ? err.message : String(err)});
    }
  });
  ws.on('error', (err) => {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // ignore
    }
    res.status(500).json({error: err.message});
  });
});

app.get('/api/storage/config', (_req, res) => {
  res.json(getServerStorageSummary());
});

app.post('/api/storage/pick-folder', async (_req, res) => {
  const picker = (
    globalThis as {__cutsyncPickDirectory?: () => Promise<string | null>}
  ).__cutsyncPickDirectory;
  if (typeof picker !== 'function') {
    res.json({supported: false, canceled: true, dirPath: null});
    return;
  }
  try {
    const picked = await picker();
    res.json({supported: true, canceled: !picked, dirPath: picked});
  } catch (err) {
    res.status(500).json({
      supported: true,
      error: err instanceof Error ? err.message : 'Не удалось открыть диалог выбора папки',
    });
  }
});

app.post('/api/storage/config', (req, res) => {
  const reset = Boolean(req.body?.reset);
  const migrateExisting = req.body?.migrateExisting !== false;
  const prevDir = getActiveUploadsDir();

  if (reset) {
    activeUploadsDir = DEFAULT_UPLOADS_DIR;
    fs.mkdirSync(activeUploadsDir, {recursive: true});
    const migratedCount = migrateExisting
      ? copyMediaFilesBetweenDirs(prevDir, activeUploadsDir)
      : 0;
    saveStorageConfigToDisk(null);
    res.json({
      ok: true,
      migratedCount,
      ...getServerStorageSummary(),
    });
    return;
  }

  const rawDirPath =
    typeof req.body?.dirPath === 'string' ? req.body.dirPath : '';
  const validation = validateServerStorageDir(rawDirPath, ROOT_DIR);
  if (!validation.valid || !validation.resolvedPath) {
    res.status(400).json({
      error: validation.error || 'Некорректный путь к папке',
    });
    return;
  }

  const nextDir = validation.resolvedPath;
  try {
    fs.mkdirSync(nextDir, {recursive: true});
    const probeFile = path.join(nextDir, `.cutsync-probe-${Date.now()}`);
    fs.writeFileSync(probeFile, 'ok');
    fs.unlinkSync(probeFile);
  } catch (err) {
    res.status(400).json({
      error: `Папка недоступна для записи: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
    return;
  }

  activeUploadsDir = nextDir;
  const isDefault =
    path.resolve(nextDir) === path.resolve(DEFAULT_UPLOADS_DIR);
  saveStorageConfigToDisk(isDefault ? null : nextDir);
  const migratedCount = migrateExisting
    ? copyMediaFilesBetweenDirs(prevDir, nextDir)
    : 0;

  res.json({
    ok: true,
    migratedCount,
    ...getServerStorageSummary(),
  });
});

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
  const interfaces = getNetworkInterfacesList();
  const ips = interfaces.map((i) => i.ip);
  const primaryIp =
    interfaces.find((i) => i.type === 'wifi')?.ip ||
    interfaces[0]?.ip ||
    '127.0.0.1';
  const protocol = req.protocol;
  const host = req.get('host');
  res.json({
    origin: `${protocol}://${host}`,
    interfaces,
    primaryIp,
    port: ACTIVE_PORT,
    udpPort: 8081,
    lanUrls: ips.map((ip) => `http://${ip}:${ACTIVE_PORT}`),
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
  const canvasBackground =
    req.body?.canvasBackground && typeof req.body.canvasBackground === 'object'
      ? (req.body.canvasBackground as CanvasBackground)
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
    canvasBackground,
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
    canvasBackground: project.canvasBackground,
    collaboratorsCount: roomConnections.get(safeId)?.size ?? 0,
  });
});

function collectReferencedMediaNamesFromProjectObj(
  proj: unknown,
  outNames: Set<string>
) {
  if (!proj || typeof proj !== 'object') return;
  const p = proj as {
    clips?: Array<{
      src?: string;
      mediaFileName?: string;
      mediaRemoteUrl?: string;
      textStyle?: {fontSrc?: string};
    }>;
    customFonts?: Array<{src?: string; fileName?: string}>;
  };
  const addRef = (raw?: string) => {
    if (!raw || typeof raw !== 'string') return;
    const trimmed = raw.trim().replace(/\\/g, '/');
    if (
      !trimmed ||
      trimmed.startsWith('synth:') ||
      trimmed.startsWith('data:') ||
      trimmed.startsWith('/src/') ||
      trimmed.startsWith('/assets/')
    ) {
      return;
    }
    if (
      trimmed.startsWith('media/') ||
      trimmed.includes('/media/') ||
      trimmed.includes('/uploads/') ||
      !trimmed.includes('/')
    ) {
      const base = normalizeBaseMediaName(trimmed);
      if (base) outNames.add(base);
    }
  };
  if (Array.isArray(p.clips)) {
    for (const c of p.clips) {
      addRef(c.src);
      addRef(c.mediaFileName);
      addRef(c.mediaRemoteUrl);
      addRef(c.textStyle?.fontSrc);
    }
  }
  if (Array.isArray(p.customFonts)) {
    for (const f of p.customFonts) {
      addRef(f.src);
      addRef(f.fileName);
    }
  }
}

function toPortableMediaRefForDisk(raw?: string, explicitFileName?: string): string | undefined {
  const pickBase = (input?: string): string | undefined => {
    if (!input) return undefined;
    const trimmed = input.trim();
    if (!trimmed) return undefined;
    if (
      trimmed.startsWith('synth:') ||
      trimmed.startsWith('data:') ||
      trimmed.startsWith('/src/') ||
      trimmed.startsWith('/assets/')
    ) {
      return undefined;
    }
    if (trimmed.startsWith('blob:')) return undefined;
    if (trimmed.startsWith('media/')) {
      const base = normalizeBaseMediaName(trimmed.slice('media/'.length));
      return base ? `media/${base}` : undefined;
    }
    const clean = trimmed.split(/[?#]/)[0].replace(/\\/g, '/');
    const mediaIdx = clean.lastIndexOf('/media/');
    if (mediaIdx !== -1) {
      const base = normalizeBaseMediaName(clean.slice(mediaIdx + '/media/'.length));
      return base ? `media/${base}` : undefined;
    }
    const uploadsIdx = clean.lastIndexOf('/uploads/');
    if (uploadsIdx !== -1) {
      const base = normalizeBaseMediaName(clean.slice(uploadsIdx + '/uploads/'.length));
      return base ? `media/${base}` : undefined;
    }
    if (!trimmed.includes('://') && !trimmed.startsWith('/')) {
      const base = normalizeBaseMediaName(trimmed);
      return base ? `media/${base}` : undefined;
    }
    return undefined;
  };
  return pickBase(explicitFileName) || pickBase(raw);
}

function dehydrateProjectForDisk(project: ProjectState): ProjectState {
  const normalized = normalizeProjectTracks(project);
  return {
    ...normalized,
    customFonts: (normalized.customFonts || []).map((f) => {
      const rel = toPortableMediaRefForDisk(f.src, f.fileName);
      if (!rel) return f;
      return {
        ...f,
        src: rel,
        fileName: rel,
      };
    }),
    clips: normalized.clips.map((c) => {
      const next = {...c};
      const relMedia = toPortableMediaRefForDisk(
        next.src || next.mediaRemoteUrl,
        next.mediaFileName
      );
      if (
        relMedia &&
        next.kind !== 'text' &&
        next.kind !== 'shape' &&
        next.kind !== 'adjustment' &&
        next.kind !== 'synth'
      ) {
        next.src = relMedia;
        next.mediaFileName = relMedia;
        if (next.mediaRemoteUrl) {
          next.mediaRemoteUrl = toPortableMediaRefForDisk(next.mediaRemoteUrl, relMedia) || relMedia;
        }
      }
      if (next.textStyle?.fontSrc) {
        const relFont = toPortableMediaRefForDisk(next.textStyle.fontSrc);
        if (relFont) {
          next.textStyle = {
            ...next.textStyle,
            fontSrc: relFont,
          };
        }
      }
      return next;
    }),
  };
}

function listProjectsJsonFromDisk(): ProjectState[] {
  const projDir = path.join(getActiveUploadsDir(), 'projects');
  if (!fs.existsSync(projDir)) return [];
  const items: ProjectState[] = [];
  try {
    const entries = fs.readdirSync(projDir, {withFileTypes: true});
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
      if (entry.name.startsWith('.')) continue;
      try {
        const raw = fs.readFileSync(path.join(projDir, entry.name), 'utf-8');
        const parsed = JSON.parse(raw) as ProjectState;
        if (parsed && typeof parsed.roomId === 'string') {
          items.push(normalizeProjectTracks(parsed));
        }
      } catch {
        // ignore malformed project file
      }
    }
  } catch {
    // ignore
  }
  return items.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

function cleanupUnusedMediaOnDisk(): {
  ok: boolean;
  deletedCount: number;
  freedBytes: number;
  remainingCount: number;
  remainingBytes: number;
} {
  const referenced = new Set<string>();
  for (const proj of listProjectsJsonFromDisk()) {
    collectReferencedMediaNamesFromProjectObj(proj, referenced);
  }
  for (const [rId, proj] of rooms.entries()) {
    if ((roomConnections.get(rId)?.size ?? 0) > 0) {
      collectReferencedMediaNamesFromProjectObj(proj, referenced);
    }
  }

  let deletedCount = 0;
  let freedBytes = 0;
  let remainingCount = 0;
  let remainingBytes = 0;

  const cleanFlatDir = (dirPath: string, skipJson: boolean) => {
    if (!fs.existsSync(dirPath)) return;
    try {
      const entries = fs.readdirSync(dirPath, {withFileTypes: true});
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (entry.name.startsWith('.') || entry.name.endsWith('.part')) continue;
        if (skipJson && entry.name.toLowerCase().endsWith('.json')) continue;
        const fullPath = path.join(dirPath, entry.name);
        let size = 0;
        try {
          size = fs.statSync(fullPath).size;
        } catch {
          size = 0;
        }
        if (referenced.has(entry.name)) {
          remainingCount += 1;
          remainingBytes += size;
        } else {
          try {
            fs.unlinkSync(fullPath);
            deletedCount += 1;
            freedBytes += size;
          } catch {
            remainingCount += 1;
            remainingBytes += size;
          }
        }
      }
    } catch {
      // ignore
    }
  };

  const currentDir = getActiveUploadsDir();
  cleanFlatDir(path.join(currentDir, 'media'), false);
  cleanFlatDir(currentDir, true);

  return {
    ok: true,
    deletedCount,
    freedBytes,
    remainingCount,
    remainingBytes,
  };
}

app.get('/api/projects', (_req, res) => {
  res.json({projects: listProjectsJsonFromDisk()});
});

app.get('/api/projects/:projectId', (req, res) => {
  const safeId = sanitizeProjectId(req.params.projectId);
  const filePath = path.join(getActiveUploadsDir(), 'projects', `${safeId}.json`);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({found: false});
    return;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ProjectState;
    res.json({found: true, project: normalizeProjectTracks(parsed)});
  } catch {
    res.status(500).json({found: false, error: 'Не удалось прочитать проект'});
  }
});

app.post('/api/projects/:projectId', (req, res) => {
  const safeId = sanitizeProjectId(req.params.projectId);
  const body = req.body as Partial<ProjectState> | undefined;
  if (!body || typeof body !== 'object' || !Array.isArray(body.clips)) {
    res.status(400).json({error: 'Некорректная структура проекта'});
    return;
  }
  const portable = dehydrateProjectForDisk({
    ...body,
    roomId: safeId,
    updatedAt: typeof body.updatedAt === 'number' ? body.updatedAt : Date.now(),
  } as ProjectState);
  const projDir = getProjectsDirFor();
  const target = path.join(projDir, `${safeId}.json`);
  const tmp = path.join(projDir, `.${safeId}-${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(portable, null, 2), 'utf-8');
    moveFileReplaceSync(tmp, target);
    res.json({
      ok: true,
      projectId: safeId,
      relativePath: `projects/${safeId}.json`,
    });
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    res.status(500).json({error: err instanceof Error ? err.message : String(err)});
  }
});

app.delete('/api/projects/:projectId', (req, res) => {
  const safeId = sanitizeProjectId(req.params.projectId);
  const filePath = path.join(getActiveUploadsDir(), 'projects', `${safeId}.json`);
  let deleted = false;
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
      deleted = true;
    } catch {
      deleted = false;
    }
  }
  res.json({ok: true, deleted});
});

app.post('/api/storage/cleanup', (_req, res) => {
  res.json(cleanupUnusedMediaOnDisk());
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
      : file.mimetype.startsWith('video/') || VIDEO_EXTS.has(ext)
        ? 'video'
        : file.mimetype.startsWith('audio/') || AUDIO_EXTS.has(ext)
          ? 'audio'
          : 'image';

  let displayName = file.originalname;
  try {
    displayName = Buffer.from(file.originalname, 'latin1').toString('utf8');
  } catch {
    displayName = file.originalname;
  }

  const mediaDir = getMediaDirFor();
  const fp = computeFastFileFingerprint(file.path);
  const dedupBase = buildDedupBaseName(
    fp.hash,
    fp.size,
    displayName,
    file.mimetype
  );
  const destPath = path.resolve(mediaDir, dedupBase);
  let deduplicated = false;
  if (fs.existsSync(destPath)) {
    try {
      if (fs.statSync(destPath).size === fp.size) {
        fs.unlinkSync(file.path);
        deduplicated = true;
      }
    } catch {
      // proceed to overwrite
    }
  }
  if (!deduplicated) {
    moveFileReplaceSync(file.path, destPath);
  }

  const fileHash = computeFileSha256(destPath);
  const relPath = `media/${dedupBase}`;

  res.json({
    ok: true,
    id: crypto.randomBytes(6).toString('hex'),
    deduplicated,
    name: displayName,
    kind,
    fileName: relPath,
    baseName: dedupBase,
    relativePath: relPath,
    src: `/media/${dedupBase}`,
    sizeBytes: fp.size,
    fileHash,
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
let wss = new WebSocketServer({noServer: true});
let wssClosed = false;
let viteDevWsActive = false;
let viteServer: {close: () => Promise<void>} | null = null;

server.on('upgrade', (request, socket, head) => {
  const pathname = (request.url || '').split('?')[0];
  if (pathname === '/ws' || pathname === '/sync') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else if (viteDevWsActive && pathname === '/__vite_ws') {
    // Handled by Vite's WebSocket upgrade listener attached to `server`
    return;
  } else {
    socket.destroy();
  }
});

function removeSession(session: ClientSession | null) {
  if (!session) return;
  const project = rooms.get(session.roomId);
  if (project) {
    for (const clip of project.clips) {
      if (clip.lockedByUserId === session.user.id) {
        clip.lockedByUserId = null;
        clip.lockedByUserName = null;
        clip.lockedByUserColor = null;
        clearLayerLockTimestamp(session.roomId, clip.id);
        broadcastToRoom(session.roomId, {
          type: 'LAYER_LOCK',
          layerId: clip.id,
          userId: session.user.id,
          userName: '',
          userColor: '',
          locked: false,
        });
      }
    }
  }

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

function attachWssConnectionHandler(targetWss: WebSocketServer) {
targetWss.on('connection', (ws) => {
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

    if (msg.type === 'ping') {
      ws.send(
        JSON.stringify({
          type: 'pong',
          ts: typeof msg.ts === 'number' ? msg.ts : Date.now(),
          serverTime: Date.now(),
        } satisfies ServerWsMessage)
      );
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
        revision: project.revision,
        prevRevision: project.revision,
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

    if (msg.type === 'REQUEST_SYNC' || msg.type === 'SYNC_FULL_STATE') {
      ws.send(
        JSON.stringify({
          type: 'SYNC_FULL_STATE',
          project,
          revision: project.revision,
          prevRevision: project.revision,
          collaborators: getRoomCollaborators(session.roomId),
          rooms: getPublicRoomSummaries(),
        } satisfies ServerWsMessage)
      );
      return;
    }

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
        project.tracks = insertTrackAt(project.tracks, msg.track, msg.insertAt);
        const prevRevision = project.revision;
        project.revision += 1;
        project.updatedAt = Date.now();
        scheduleSaveRooms();
        broadcastToRoom(
          session.roomId,
          {
            type: 'op:track_add',
            track: msg.track,
            insertAt: msg.insertAt,
            revision: project.revision,
            prevRevision,
            senderId: session.user.id,
          },
          ws
        );
        sendSyncAck(ws, project.revision, prevRevision, msg.type);
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
        const prevRevision = project.revision;
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
            prevRevision,
            senderId: session.user.id,
          },
          ws
        );
        sendSyncAck(ws, project.revision, prevRevision, msg.type);
        break;
      }

      case 'op:track_delete': {
        if (project.tracks.length <= 1) return;
        project.tracks = project.tracks.filter((t) => t.id !== msg.trackId);
        project.clips = project.clips.filter((c) => c.trackId !== msg.trackId);
        const prevRevision = project.revision;
        project.revision += 1;
        project.updatedAt = Date.now();
        scheduleSaveRooms();
        broadcastToRoom(
          session.roomId,
          {
            type: 'op:track_delete',
            trackId: msg.trackId,
            revision: project.revision,
            prevRevision,
            senderId: session.user.id,
          },
          ws
        );
        sendSyncAck(ws, project.revision, prevRevision, msg.type);
        broadcastLobbyRooms();
        break;
      }

      case 'op:track_reorder': {
        project.tracks = applyTrackReorder(project.tracks, msg.trackIds);
        const prevRevision = project.revision;
        project.revision += 1;
        project.updatedAt = Date.now();
        scheduleSaveRooms();
        broadcastToRoom(
          session.roomId,
          {
            type: 'op:track_reorder',
            trackIds: msg.trackIds,
            revision: project.revision,
            prevRevision,
            senderId: session.user.id,
          },
          ws
        );
        sendSyncAck(ws, project.revision, prevRevision, msg.type);
        break;
      }

      case 'op:clip_add': {
        if (project.clips.some((c) => c.id === msg.clip.id)) return;
        if (msg.newTrack) {
          project.tracks = insertTrackAt(
            project.tracks,
            msg.newTrack,
            msg.insertAt
          );
        }
        project.clips.push(msg.clip);
        const prevRevision = project.revision;
        project.revision += 1;
        project.updatedAt = Date.now();
        scheduleSaveRooms();
        broadcastToRoom(
          session.roomId,
          {
            type: 'op:clip_add',
            clip: msg.clip,
            newTrack: msg.newTrack,
            insertAt: msg.insertAt,
            revision: project.revision,
            prevRevision,
            senderId: session.user.id,
          },
          ws
        );
        sendSyncAck(ws, project.revision, prevRevision, msg.type);
        broadcastLobbyRooms();
        break;
      }

      case 'op:clip_update': {
        const idx = project.clips.findIndex((c) => c.id === msg.clipId);
        if (idx === -1) return;
        if (project.clips[idx].lockedByUserId === session.user.id) {
          touchLayerLock(session.roomId, msg.clipId);
        }
        if (msg.ephemeral === true) {
          broadcastToRoom(
            session.roomId,
            {
              type: 'op:clip_update',
              clipId: msg.clipId,
              patch: msg.patch,
              ephemeral: true,
              revision: project.revision,
              prevRevision: project.revision,
              senderId: session.user.id,
            },
            ws
          );
          break;
        }
        project.clips[idx] = applyClipPatch(
          project.clips[idx],
          msg.patch as Record<string, unknown>
        );
        const prevRevision = project.revision;
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
            prevRevision,
            senderId: session.user.id,
          },
          ws
        );
        sendSyncAck(ws, project.revision, prevRevision, msg.type);
        break;
      }

      case 'op:clip_delete': {
        const prevLen = project.clips.length;
        project.clips = project.clips.filter((c) => c.id !== msg.clipId);
        if (project.clips.length === prevLen) return;
        const prevRevision = project.revision;
        project.revision += 1;
        project.updatedAt = Date.now();
        scheduleSaveRooms();
        broadcastToRoom(
          session.roomId,
          {
            type: 'op:clip_delete',
            clipId: msg.clipId,
            revision: project.revision,
            prevRevision,
            senderId: session.user.id,
          },
          ws
        );
        sendSyncAck(ws, project.revision, prevRevision, msg.type);
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
        const prevRevision = project.revision;
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
            prevRevision,
            senderId: session.user.id,
          },
          ws
        );
        sendSyncAck(ws, project.revision, prevRevision, msg.type);
        break;
      }

      case 'op:clip_duplicate': {
        const nextClips = applyClipDuplicate(
          project.clips,
          msg.clipId,
          msg.newClipId
        );
        if (nextClips === project.clips) return;
        project.clips = nextClips;
        const prevRevision = project.revision;
        project.revision += 1;
        project.updatedAt = Date.now();
        scheduleSaveRooms();
        broadcastToRoom(
          session.roomId,
          {
            type: 'op:clip_duplicate',
            clipId: msg.clipId,
            newClipId: msg.newClipId,
            revision: project.revision,
            prevRevision,
            senderId: session.user.id,
          },
          ws
        );
        sendSyncAck(ws, project.revision, prevRevision, msg.type);
        broadcastLobbyRooms();
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
        if (msg.patch.canvasBackground && typeof msg.patch.canvasBackground === 'object') {
          project.canvasBackground = msg.patch.canvasBackground;
        }
        if (typeof msg.patch.hostName === 'string') {
          project.hostName = msg.patch.hostName.slice(0, 28);
        }
        if (Array.isArray(msg.patch.customFonts)) {
          project.customFonts = msg.patch.customFonts;
        }
        if (Array.isArray(msg.patch.trackers)) {
          project.trackers = msg.patch.trackers;
        }
        if (typeof msg.patch.isPublicLan === 'boolean') {
          project.isPublicLan = msg.patch.isPublicLan;
        }
        const prevRevision = project.revision;
        project.revision += 1;
        project.updatedAt = Date.now();
        scheduleSaveRooms();
        broadcastToRoom(
          session.roomId,
          {
            type: 'op:project_meta',
            patch: msg.patch,
            revision: project.revision,
            prevRevision,
            senderId: session.user.id,
          },
          ws
        );
        sendSyncAck(ws, project.revision, prevRevision, msg.type);
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
        if (msg.canvasBackground && typeof msg.canvasBackground === 'object') {
          project.canvasBackground = msg.canvasBackground;
        }
        if (Array.isArray(msg.customFonts)) {
          project.customFonts = msg.customFonts;
        }
        if (Array.isArray(msg.trackers)) {
          project.trackers = msg.trackers;
        }
        const prevRevision = project.revision;
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
            canvasBackground: project.canvasBackground,
            customFonts: project.customFonts,
            trackers: project.trackers,
            revision: project.revision,
            prevRevision,
            senderId: session.user.id,
          },
          ws
        );
        sendSyncAck(ws, project.revision, prevRevision, msg.type);
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

      case 'LAYER_MEDIA_UPDATED': {
        if (msg.newTrack) {
          project.tracks = insertTrackAt(
            project.tracks,
            msg.newTrack,
            msg.insertAt
          );
        }
        const idx = project.clips.findIndex((c) => c.id === msg.layerId);
        if (idx !== -1) {
          if (project.clips[idx].lockedByUserId === session.user.id) {
            touchLayerLock(session.roomId, msg.layerId);
          }
          project.clips[idx] = {
            ...project.clips[idx],
            src: msg.mediaUrl,
            mediaRemoteUrl: msg.mediaUrl,
            mediaFileName: msg.fileName,
            mediaFileSize: msg.fileSize ?? project.clips[idx].mediaFileSize,
            mediaFileHash: msg.fileHash ?? project.clips[idx].mediaFileHash,
            mediaError: undefined,
            ...(msg.clip
              ? {
                  name: msg.clip.name,
                  kind: msg.clip.kind,
                  trimStart: msg.clip.trimStart,
                  sourceDuration: msg.clip.sourceDuration,
                }
              : {}),
          };
        } else if (msg.clip) {
          project.clips.push({
            ...msg.clip,
            id: msg.layerId,
            src: msg.mediaUrl,
            mediaRemoteUrl: msg.mediaUrl,
            mediaFileName: msg.fileName,
            mediaFileSize: msg.fileSize ?? msg.clip.mediaFileSize,
            mediaFileHash: msg.fileHash ?? msg.clip.mediaFileHash,
          });
        }
        const prevRevision = project.revision;
        project.revision += 1;
        project.updatedAt = Date.now();
        scheduleSaveRooms();
        broadcastToRoom(
          session.roomId,
          {
            type: 'LAYER_MEDIA_UPDATED',
            layerId: msg.layerId,
            fileName: msg.fileName,
            mediaUrl: msg.mediaUrl,
            fileSize: msg.fileSize,
            fileHash: msg.fileHash,
            senderId: session.user.id,
            clip: msg.clip,
            newTrack: msg.newTrack,
            insertAt: msg.insertAt,
            revision: project.revision,
            prevRevision,
          },
          ws
        );
        sendSyncAck(ws, project.revision, prevRevision, msg.type);
        broadcastLobbyRooms();
        break;
      }

      case 'LAYER_LOCK': {
        const idx = project.clips.findIndex((c) => c.id === msg.layerId);
        let applied = true;
        if (idx !== -1) {
          const curHolder = project.clips[idx].lockedByUserId;
          if (msg.locked) {
            if (curHolder && curHolder !== session.user.id) {
              applied = false;
            } else {
              project.clips[idx] = {
                ...project.clips[idx],
                lockedByUserId: session.user.id,
                lockedByUserName: session.user.name,
                lockedByUserColor: session.user.color,
              };
              touchLayerLock(session.roomId, msg.layerId);
            }
          } else if (curHolder === session.user.id || !curHolder) {
            project.clips[idx] = {
              ...project.clips[idx],
              lockedByUserId: null,
              lockedByUserName: null,
              lockedByUserColor: null,
            };
            clearLayerLockTimestamp(session.roomId, msg.layerId);
          }
        }
        if (applied) {
          broadcastToRoom(
            session.roomId,
            {
              type: 'LAYER_LOCK',
              layerId: msg.layerId,
              userId: session.user.id,
              userName: msg.locked ? session.user.name : '',
              userColor: msg.locked ? session.user.color : '',
              locked: msg.locked,
            },
            ws
          );
        }
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
}

attachWssConnectionHandler(wss);

let wsHealthTimer: ReturnType<typeof setInterval> | null = null;
let lockSweepTimer: ReturnType<typeof setInterval> | null = null;

function ensureServerTimers() {
  if (!wsHealthTimer) {
    wsHealthTimer = setInterval(() => {
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
    wsHealthTimer.unref?.();
  }

  if (!lockSweepTimer) {
    lockSweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [roomId, layerMap] of roomLockTimestamps.entries()) {
        const project = rooms.get(roomId);
        if (!project) {
          roomLockTimestamps.delete(roomId);
          continue;
        }
        for (const [layerId, lastActive] of layerMap.entries()) {
          if (now - lastActive < lockTimeoutMs) continue;
          layerMap.delete(layerId);
          const idx = project.clips.findIndex((c) => c.id === layerId);
          if (idx !== -1 && project.clips[idx].lockedByUserId) {
            const ownerId = project.clips[idx].lockedByUserId!;
            project.clips[idx] = {
              ...project.clips[idx],
              lockedByUserId: null,
              lockedByUserName: null,
              lockedByUserColor: null,
            };
            broadcastToRoom(roomId, {
              type: 'LAYER_LOCK',
              layerId,
              userId: ownerId,
              userName: '',
              userColor: '',
              locked: false,
            });
          }
        }
        if (layerMap.size === 0) {
          roomLockTimestamps.delete(roomId);
        }
      }
    }, 500);
    lockSweepTimer.unref?.();
  }
}

// Minecraft-style UDP LAN discovery beacon on port 8081
let udpBeaconSocket: dgram.Socket | null = null;
let udpBeaconInterval: ReturnType<typeof setInterval> | null = null;

function startLanBeacon() {
  if (udpBeaconSocket) return;
  try {
    const udp = dgram.createSocket('udp4');
    udpBeaconSocket = udp;
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
    udpBeaconInterval = setInterval(() => {
      const publicRooms = getPublicRoomSummaries();
      if (publicRooms.length === 0) return;
      const ifaces = getNetworkInterfacesList();
      const primary = publicRooms[0];
      const primaryIp =
        ifaces.find((i) => i.type === 'wifi')?.ip ||
        ifaces[0]?.ip ||
        '127.0.0.1';
      const packet = Buffer.from(
        JSON.stringify({
          app: 'CutSync',
          roomId: primary.roomId,
          title: primary.title,
          hostName: primary.hostName || os.hostname(),
          ip: primaryIp,
          ips: ifaces.map((i) => i.ip),
          port: ACTIVE_PORT,
          aspectRatio: primary.aspectRatio,
          participants: primary.collaboratorsCount,
          roomsCount: publicRooms.length,
        })
      );
      try {
        udp.send(packet, 8081, '255.255.255.255');
      } catch {
        // ignore
      }
    }, 1500);
    udpBeaconInterval.unref?.();
  } catch {
    // ignore
  }
}

export async function startServer(opts?: {
  port?: number;
  isProd?: boolean;
  lockTimeoutMs?: number;
  disableVite?: boolean;
  disableBeacon?: boolean;
  fallbackToRandomPort?: boolean;
}): Promise<{port: number; server: http.Server}> {
  if (wssClosed) {
    wss = new WebSocketServer({noServer: true});
    wssClosed = false;
    attachWssConnectionHandler(wss);
  }
  ensureServerTimers();

  if (typeof opts?.lockTimeoutMs === 'number' && opts.lockTimeoutMs > 0) {
    lockTimeoutMs = opts.lockTimeoutMs;
  }
  const prodMode = opts?.isProd ?? IS_PROD;
  if (!opts?.disableVite) {
    if (!prodMode) {
      viteDevWsActive = true;
      const {createServer: createViteServer} = await import('vite');
      const vite = await createViteServer({
        server: {
          middlewareMode: true,
          hmr: false,
          allowedHosts: true,
          ws: {server, path: '/__vite_ws'},
        },
        appType: 'spa',
      });
      viteServer = vite;
      app.use(vite.middlewares);
    } else {
      const distDir = process.env.CUTSYNC_DIST_DIR
        ? path.resolve(process.env.CUTSYNC_DIST_DIR)
        : path.join(ROOT_DIR, 'dist');
      app.use(express.static(distDir));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  }

  const listenPort = opts?.port ?? ACTIVE_PORT;
  await new Promise<void>((resolve, reject) => {
    const attemptListen = (targetPort: number, allowFallback: boolean) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off('listening', onListening);
        if (err.code === 'EADDRINUSE' && allowFallback && targetPort !== 0) {
          attemptListen(0, false);
          return;
        }
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          ACTIVE_PORT = addr.port;
        }
        if (!opts?.disableBeacon) {
          startLanBeacon();
        }
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(targetPort, '0.0.0.0');
    };
    attemptListen(listenPort, Boolean(opts?.fallbackToRandomPort));
  });

  if (process.env.CUTSYNC_NO_AUTOSTART !== '1') {
    console.log(`CutSync server listening on http://0.0.0.0:${ACTIVE_PORT}`);
  }
  return {port: ACTIVE_PORT, server};
}

export async function stopServer(): Promise<void> {
  if (saveTimer) {
    flushRoomsToDiskSync();
  }
  if (wsHealthTimer) {
    clearInterval(wsHealthTimer);
    wsHealthTimer = null;
  }
  if (lockSweepTimer) {
    clearInterval(lockSweepTimer);
    lockSweepTimer = null;
  }
  if (udpBeaconInterval) {
    clearInterval(udpBeaconInterval);
    udpBeaconInterval = null;
  }
  if (udpBeaconSocket) {
    try {
      udpBeaconSocket.close();
    } catch {
      // ignore
    }
    udpBeaconSocket = null;
  }
  for (const ws of allSockets) {
    try {
      ws.terminate();
    } catch {
      // ignore
    }
  }
  allSockets.clear();
  wssClosed = true;
  viteDevWsActive = false;
  if (viteServer) {
    await viteServer.close();
    viteServer = null;
  }
  await new Promise<void>((resolve) => {
    wss.close(() => {
      server.close(() => resolve());
    });
  });
}

if (process.env.CUTSYNC_NO_AUTOSTART !== '1') {
  startServer().catch((err) => {
    console.error('Failed to start CutSync server:', err);
    process.exit(1);
  });
}
