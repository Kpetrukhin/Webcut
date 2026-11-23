export type ClientStorageMode = 'app-root' | 'custom-fs';

export interface CleanupMediaResult {
  deletedCount: number;
  freedBytes: number;
  remainingCount: number;
  remainingBytes: number;
}

export interface ClientStorageSummary {
  mode: ClientStorageMode;
  folderName: string;
  isDefault: boolean;
  supportsDirectoryPicker: boolean;
  hasCustomHandle: boolean;
  needsPermission: boolean;
  filesCount: number;
  totalBytes: number;
}

export interface ServerStorageConfig {
  currentDir: string;
  defaultDir: string;
  isDefault: boolean;
  filesCount: number;
  totalBytes: number;
  canNativePick: boolean;
  presets: Array<{
    label: string;
    path: string;
    isDefault?: boolean;
  }>;
}

const META_STORAGE_KEY = 'cutsync_client_media_storage_v1';
const IDB_NAME = 'cutsync_storage_handles_db';
const IDB_STORE = 'handles';
const IDB_HANDLE_KEY = 'media_sync_dir';
const OPFS_SUBDIR = 'cutsync-media';

interface PersistedClientMeta {
  mode: ClientStorageMode;
  folderName: string;
}

interface FsDirHandleLike {
  name: string;
  kind: 'directory';
  queryPermission?: (desc?: {mode?: 'read' | 'readwrite'}) => Promise<PermissionState>;
  requestPermission?: (desc?: {mode?: 'read' | 'readwrite'}) => Promise<PermissionState>;
  getDirectoryHandle: (
    name: string,
    opts?: {create?: boolean}
  ) => Promise<FsDirHandleLike>;
  getFileHandle: (
    name: string,
    opts?: {create?: boolean}
  ) => Promise<FsFileHandleLike>;
  removeEntry?: (name: string) => Promise<void>;
  values?: () => AsyncIterable<FsDirHandleLike | FsFileHandleLike>;
}

interface FsFileHandleLike {
  name: string;
  kind: 'file';
  getFile: () => Promise<File>;
  createWritable: () => Promise<{
    write: (data: Blob | Uint8Array) => Promise<void>;
    close: () => Promise<void>;
  }>;
}

function getWindowWithPicker(): (Window & {
  showDirectoryPicker?: (opts?: {
    id?: string;
    mode?: 'read' | 'readwrite';
  }) => Promise<FsDirHandleLike>;
}) | null {
  if (typeof window === 'undefined') return null;
  return window as unknown as Window & {
    showDirectoryPicker?: (opts?: {
      id?: string;
      mode?: 'read' | 'readwrite';
    }) => Promise<FsDirHandleLike>;
  };
}

export function supportsBrowserDirectoryPicker(): boolean {
  const win = getWindowWithPicker();
  return Boolean(win && typeof win.showDirectoryPicker === 'function');
}

function readClientMeta(): PersistedClientMeta {
  try {
    const raw = localStorage.getItem(META_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedClientMeta>;
      if (parsed.mode === 'custom-fs' && typeof parsed.folderName === 'string') {
        return {mode: 'custom-fs', folderName: parsed.folderName};
      }
    }
  } catch {
    // ignore
  }
  return {mode: 'app-root', folderName: 'Корень приложения'};
}

function writeClientMeta(meta: PersistedClientMeta): void {
  try {
    localStorage.setItem(META_STORAGE_KEY, JSON.stringify(meta));
  } catch {
    // ignore
  }
}

function sanitizeSafeFileName(fileName: string): string {
  const normalized = fileName.trim().replace(/\\/g, '/').split('?')[0];
  const stripped = normalized.startsWith('media/')
    ? normalized.slice('media/'.length)
    : normalized;
  const base = stripped.split('/').pop() || stripped || 'media.bin';
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned || `media-${Date.now()}.bin`;
}

function sanitizeProjectId(rawId: string): string {
  const cleaned = (rawId || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return cleaned || 'studio-demo';
}

async function getSubDirHandle(
  parent: FsDirHandleLike | null,
  subName: 'media' | 'projects',
  create: boolean
): Promise<FsDirHandleLike | null> {
  if (!parent) return null;
  try {
    return await parent.getDirectoryHandle(subName, {create});
  } catch {
    return null;
  }
}

function openHandlesDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open IDB'));
  });
}

async function getSavedDirHandle(): Promise<FsDirHandleLike | null> {
  try {
    const db = await openHandlesDb();
    return await new Promise<FsDirHandleLike | null>((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const getReq = store.get(IDB_HANDLE_KEY);
      getReq.onsuccess = () => resolve((getReq.result as FsDirHandleLike) || null);
      getReq.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function saveDirHandle(handle: FsDirHandleLike | null): Promise<void> {
  try {
    const db = await openHandlesDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      const req = handle
        ? store.put(handle, IDB_HANDLE_KEY)
        : store.delete(IDB_HANDLE_KEY);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // ignore
  }
}

async function getOpfsMediaDir(create = true): Promise<FsDirHandleLike | null> {
  try {
    if (
      typeof navigator === 'undefined' ||
      !navigator.storage ||
      typeof navigator.storage.getDirectory !== 'function'
    ) {
      return null;
    }
    const root = (await navigator.storage.getDirectory()) as unknown as FsDirHandleLike;
    return await root.getDirectoryHandle(OPFS_SUBDIR, {create});
  } catch {
    return null;
  }
}

async function ensureHandlePermission(
  handle: FsDirHandleLike,
  requestIfNeeded: boolean
): Promise<PermissionState> {
  try {
    if (typeof handle.queryPermission === 'function') {
      const perm = await handle.queryPermission({mode: 'readwrite'});
      if (perm === 'granted') return 'granted';
      if (requestIfNeeded && typeof handle.requestPermission === 'function') {
        return await handle.requestPermission({mode: 'readwrite'});
      }
      return perm;
    }
    return 'granted';
  } catch {
    return 'denied';
  }
}

async function countDirFiles(
  dir: FsDirHandleLike | null
): Promise<{filesCount: number; totalBytes: number}> {
  if (!dir || typeof dir.values !== 'function') {
    return {filesCount: 0, totalBytes: 0};
  }
  let filesCount = 0;
  let totalBytes = 0;

  const scanDir = async (target: FsDirHandleLike, skipJson: boolean) => {
    if (typeof target.values !== 'function') return;
    try {
      for await (const entry of target.values()) {
        if (entry.kind === 'file') {
          if (skipJson && entry.name.toLowerCase().endsWith('.json')) continue;
          if (entry.name.endsWith('.part')) continue;
          try {
            const file = await entry.getFile();
            filesCount += 1;
            totalBytes += file.size;
          } catch {
            // ignore unreadable entry
          }
        }
      }
    } catch {
      // ignore enumeration error
    }
  };

  const mediaSub = await getSubDirHandle(dir, 'media', false);
  if (mediaSub) await scanDir(mediaSub, false);
  await scanDir(dir, true);

  return {filesCount, totalBytes};
}

async function resolveActiveBrowserDir(
  requestIfNeeded = false
): Promise<{
  dir: FsDirHandleLike | null;
  mode: ClientStorageMode;
  folderName: string;
  needsPermission: boolean;
}> {
  const meta = readClientMeta();
  if (meta.mode === 'custom-fs') {
    const custom = await getSavedDirHandle();
    if (custom) {
      const perm = await ensureHandlePermission(custom, requestIfNeeded);
      if (perm === 'granted') {
        return {
          dir: custom,
          mode: 'custom-fs',
          folderName: custom.name || meta.folderName,
          needsPermission: false,
        };
      }
      return {
        dir: null,
        mode: 'custom-fs',
        folderName: custom.name || meta.folderName,
        needsPermission: true,
      };
    }
  }
  const opfs = await getOpfsMediaDir(true);
  return {
    dir: opfs,
    mode: 'app-root',
    folderName: 'Корень приложения',
    needsPermission: false,
  };
}

async function writeBlobToDir(
  dir: FsDirHandleLike,
  fileName: string,
  blob: Blob,
  opts?: {overwrite?: boolean}
): Promise<{ok: boolean; deduplicated: boolean}> {
  try {
    const safeName = sanitizeSafeFileName(fileName);
    if (!opts?.overwrite) {
      try {
        const existingFh = await dir.getFileHandle(safeName, {create: false});
        const existingFile = await existingFh.getFile();
        if (existingFile.size === blob.size && existingFile.size > 0) {
          return {ok: true, deduplicated: true};
        }
      } catch {
        // file does not exist yet
      }
    }
    const fileHandle = await dir.getFileHandle(safeName, {create: true});
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    return {ok: true, deduplicated: false};
  } catch {
    return {ok: false, deduplicated: false};
  }
}

export async function checkMediaInLocalFolder(
  fileName: string,
  expectedSize?: number
): Promise<boolean> {
  const file = await readMediaFromLocalFolder(fileName, expectedSize);
  return Boolean(file);
}

export async function saveMediaToLocalFolder(
  fileName: string,
  blob: Blob
): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  const resolved = await resolveActiveBrowserDir(false);
  if (resolved.dir) {
    const mediaSub = (await getSubDirHandle(resolved.dir, 'media', true)) || resolved.dir;
    const res = await writeBlobToDir(mediaSub, fileName, blob);
    if (res.ok) return true;
  }
  // If custom handle lacked permission during background sync, still persist to app-root OPFS
  if (resolved.mode === 'custom-fs') {
    const opfs = await getOpfsMediaDir(true);
    if (opfs) {
      const opfsMedia = (await getSubDirHandle(opfs, 'media', true)) || opfs;
      const res = await writeBlobToDir(opfsMedia, fileName, blob);
      return res.ok;
    }
  }
  return false;
}

export async function readMediaFromLocalFolder(
  fileName: string,
  expectedSize?: number
): Promise<File | null> {
  if (typeof window === 'undefined' || !fileName) return null;
  const safeName = sanitizeSafeFileName(fileName);
  const rootDirs: FsDirHandleLike[] = [];

  const resolved = await resolveActiveBrowserDir(false);
  if (resolved.dir) rootDirs.push(resolved.dir);
  if (resolved.mode === 'custom-fs') {
    const opfs = await getOpfsMediaDir(false);
    if (opfs) rootDirs.push(opfs);
  }

  for (const root of rootDirs) {
    const subMedia = await getSubDirHandle(root, 'media', false);
    const candidates = subMedia ? [subMedia, root] : [root];
    for (const dir of candidates) {
      try {
        const fh = await dir.getFileHandle(safeName, {create: false});
        const file = await fh.getFile();
        if (file.size <= 0) continue;
        if (expectedSize && expectedSize > 0 && file.size !== expectedSize) {
          continue;
        }
        return file;
      } catch {
        // not present in this dir
      }
    }
  }
  return null;
}

export async function saveProjectJsonToLocalFolder(
  projectId: string,
  projectJson: string
): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  const safeId = sanitizeProjectId(projectId);
  const fileName = `${safeId}.json`;
  const blob = new Blob([projectJson], {type: 'application/json'});

  let saved = false;
  const resolved = await resolveActiveBrowserDir(false);
  if (resolved.dir) {
    const projDir = await getSubDirHandle(resolved.dir, 'projects', true);
    if (projDir) {
      const res = await writeBlobToDir(projDir, fileName, blob, {overwrite: true});
      saved = res.ok;
    }
  }
  // Always keep a copy in OPFS app-root as fallback if custom handle loses permission
  if (resolved.mode === 'custom-fs' || !saved) {
    const opfs = await getOpfsMediaDir(true);
    const opfsProj = await getSubDirHandle(opfs, 'projects', true);
    if (opfsProj) {
      const res = await writeBlobToDir(opfsProj, fileName, blob, {overwrite: true});
      if (res.ok) saved = true;
    }
  }
  return saved;
}

export async function listProjectsJsonFromLocalFolder<T extends {roomId?: string; updatedAt?: number}>(): Promise<T[]> {
  if (typeof window === 'undefined') return [];
  const byId = new Map<string, T>();
  const resolved = await resolveActiveBrowserDir(false);
  const rootDirs: FsDirHandleLike[] = [];
  if (resolved.dir) rootDirs.push(resolved.dir);
  if (resolved.mode === 'custom-fs') {
    const opfs = await getOpfsMediaDir(false);
    if (opfs) rootDirs.push(opfs);
  }

  for (const root of rootDirs) {
    const projDir = await getSubDirHandle(root, 'projects', false);
    if (!projDir || typeof projDir.values !== 'function') continue;
    try {
      for await (const entry of projDir.values()) {
        if (entry.kind !== 'file' || !entry.name.toLowerCase().endsWith('.json')) {
          continue;
        }
        try {
          const file = await entry.getFile();
          const text = await file.text();
          const parsed = JSON.parse(text) as T;
          if (!parsed || typeof parsed.roomId !== 'string') continue;
          const prev = byId.get(parsed.roomId);
          if (!prev || (parsed.updatedAt ?? 0) >= (prev.updatedAt ?? 0)) {
            byId.set(parsed.roomId, parsed);
          }
        } catch {
          // ignore malformed json
        }
      }
    } catch {
      // ignore enumeration error
    }
  }

  return Array.from(byId.values()).sort(
    (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
  );
}

export async function loadProjectJsonFromLocalFolder<T>(
  projectId: string
): Promise<T | null> {
  if (typeof window === 'undefined') return null;
  const safeId = sanitizeProjectId(projectId);
  const fileName = `${safeId}.json`;
  const resolved = await resolveActiveBrowserDir(false);
  const rootDirs: FsDirHandleLike[] = [];
  if (resolved.dir) rootDirs.push(resolved.dir);
  if (resolved.mode === 'custom-fs') {
    const opfs = await getOpfsMediaDir(false);
    if (opfs) rootDirs.push(opfs);
  }

  for (const root of rootDirs) {
    const projDir = await getSubDirHandle(root, 'projects', false);
    if (!projDir) continue;
    try {
      const fh = await projDir.getFileHandle(fileName, {create: false});
      const file = await fh.getFile();
      return JSON.parse(await file.text()) as T;
    } catch {
      // try next root
    }
  }
  return null;
}

export async function deleteProjectJsonFromLocalFolder(
  projectId: string
): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  const safeId = sanitizeProjectId(projectId);
  const fileName = `${safeId}.json`;
  let deleted = false;

  const resolved = await resolveActiveBrowserDir(false);
  const rootDirs: FsDirHandleLike[] = [];
  if (resolved.dir) rootDirs.push(resolved.dir);
  const opfs = await getOpfsMediaDir(false);
  if (opfs && !rootDirs.includes(opfs)) rootDirs.push(opfs);

  for (const root of rootDirs) {
    const projDir = await getSubDirHandle(root, 'projects', false);
    if (!projDir || typeof projDir.removeEntry !== 'function') continue;
    try {
      await projDir.removeEntry(fileName);
      deleted = true;
    } catch {
      // ignore
    }
  }
  return deleted;
}

export function extractReferencedMediaNamesFromProjectObj(
  proj: unknown,
  outNames: Set<string>
): void {
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
      const base = sanitizeSafeFileName(trimmed.split('?')[0]);
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

export async function cleanupUnusedMediaInLocalFolder(): Promise<CleanupMediaResult> {
  if (typeof window === 'undefined') {
    return {deletedCount: 0, freedBytes: 0, remainingCount: 0, remainingBytes: 0};
  }
  const projects = await listProjectsJsonFromLocalFolder<Record<string, unknown>>();
  const referenced = new Set<string>();
  for (const proj of projects) {
    extractReferencedMediaNamesFromProjectObj(proj, referenced);
  }

  let deletedCount = 0;
  let freedBytes = 0;
  let remainingCount = 0;
  let remainingBytes = 0;

  const cleanDir = async (dir: FsDirHandleLike | null, skipJson: boolean) => {
    if (!dir || typeof dir.values !== 'function') return;
    const toDelete: Array<{name: string; size: number}> = [];
    for await (const entry of dir.values()) {
      if (entry.kind !== 'file') continue;
      if (skipJson && entry.name.toLowerCase().endsWith('.json')) continue;
      let size = 0;
      try {
        size = (await entry.getFile()).size;
      } catch {
        size = 0;
      }
      if (!referenced.has(entry.name)) {
        toDelete.push({name: entry.name, size});
      } else {
        remainingCount += 1;
        remainingBytes += size;
      }
    }
    for (const item of toDelete) {
      if (typeof dir.removeEntry === 'function') {
        try {
          await dir.removeEntry(item.name);
          deletedCount += 1;
          freedBytes += item.size;
          continue;
        } catch {
          // keep counted as remaining if delete failed
        }
      }
      remainingCount += 1;
      remainingBytes += item.size;
    }
  };

  const resolved = await resolveActiveBrowserDir(false);
  if (resolved.dir) {
    const mediaSub = await getSubDirHandle(resolved.dir, 'media', false);
    await cleanDir(mediaSub, false);
    await cleanDir(resolved.dir, true);
  }
  if (resolved.mode === 'custom-fs') {
    const opfs = await getOpfsMediaDir(false);
    if (opfs) {
      const opfsMedia = await getSubDirHandle(opfs, 'media', false);
      await cleanDir(opfsMedia, false);
      await cleanDir(opfs, true);
    }
  }

  return {deletedCount, freedBytes, remainingCount, remainingBytes};
}

async function copyFlatEntries(
  fromDir: FsDirHandleLike | null,
  toDir: FsDirHandleLike | null,
  overwrite = false
): Promise<number> {
  if (!fromDir || !toDir || typeof fromDir.values !== 'function') return 0;
  let copied = 0;
  try {
    for await (const entry of fromDir.values()) {
      if (entry.kind !== 'file') continue;
      try {
        const file = await entry.getFile();
        if (file.size <= 0) continue;
        const res = await writeBlobToDir(toDir, entry.name, file, {overwrite});
        if (res.ok && !res.deduplicated) copied += 1;
      } catch {
        // ignore single file errors
      }
    }
  } catch {
    // ignore
  }
  return copied;
}

async function copyAllMediaBetweenDirs(
  fromDir: FsDirHandleLike | null,
  toDir: FsDirHandleLike | null
): Promise<number> {
  if (!fromDir || !toDir || typeof fromDir.values !== 'function') return 0;
  let copied = 0;
  const fromMedia = await getSubDirHandle(fromDir, 'media', false);
  const toMedia = await getSubDirHandle(toDir, 'media', true);
  if (fromMedia && toMedia) {
    copied += await copyFlatEntries(fromMedia, toMedia, false);
  }
  const fromProjects = await getSubDirHandle(fromDir, 'projects', false);
  const toProjects = await getSubDirHandle(toDir, 'projects', true);
  if (fromProjects && toProjects) {
    copied += await copyFlatEntries(fromProjects, toProjects, true);
  }
  // Legacy flat files in root
  if (toMedia) {
    try {
      for await (const entry of fromDir.values()) {
        if (entry.kind !== 'file') continue;
        try {
          const file = await entry.getFile();
          if (file.size <= 0) continue;
          const targetDir = entry.name.toLowerCase().endsWith('.json') && toProjects
            ? toProjects
            : toMedia;
          const res = await writeBlobToDir(targetDir, entry.name, file, {overwrite: false});
          if (res.ok && !res.deduplicated) copied += 1;
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }
  return copied;
}

export async function getClientStorageSummary(): Promise<ClientStorageSummary> {
  const meta = readClientMeta();
  const supportsPicker = supportsBrowserDirectoryPicker();
  const custom = meta.mode === 'custom-fs' ? await getSavedDirHandle() : null;

  if (custom) {
    const perm = await ensureHandlePermission(custom, false);
    const stats = perm === 'granted' ? await countDirFiles(custom) : {filesCount: 0, totalBytes: 0};
    return {
      mode: 'custom-fs',
      folderName: custom.name || meta.folderName,
      isDefault: false,
      supportsDirectoryPicker: supportsPicker,
      hasCustomHandle: true,
      needsPermission: perm !== 'granted',
      filesCount: stats.filesCount,
      totalBytes: stats.totalBytes,
    };
  }

  const opfs = await getOpfsMediaDir(false);
  const stats = await countDirFiles(opfs);
  return {
    mode: 'app-root',
    folderName: 'Корень приложения',
    isDefault: true,
    supportsDirectoryPicker: supportsPicker,
    hasCustomHandle: false,
    needsPermission: false,
    filesCount: stats.filesCount,
    totalBytes: stats.totalBytes,
  };
}

export async function pickClientDirectory(
  migrateExisting = true
): Promise<{summary: ClientStorageSummary; copiedCount: number}> {
  const win = getWindowWithPicker();
  if (!win || typeof win.showDirectoryPicker !== 'function') {
    throw new Error(
      'Выбор произвольной папки на устройстве поддерживается в Chrome / Edge / Desktop-версии'
    );
  }
  const prevHandle = await getSavedDirHandle();
  const prevOpfs = await getOpfsMediaDir(false);

  const picked = await win.showDirectoryPicker({
    id: 'cutsync-media',
    mode: 'readwrite',
  });
  const perm = await ensureHandlePermission(picked, true);
  if (perm !== 'granted') {
    throw new Error('Не выдано разрешение на запись в выбранную папку');
  }

  await saveDirHandle(picked);
  writeClientMeta({
    mode: 'custom-fs',
    folderName: picked.name || 'Выбранная папка',
  });

  let copiedCount = 0;
  if (migrateExisting) {
    copiedCount += await copyAllMediaBetweenDirs(prevOpfs, picked);
    if (prevHandle && prevHandle.name !== picked.name) {
      const prevPerm = await ensureHandlePermission(prevHandle, false);
      if (prevPerm === 'granted') {
        copiedCount += await copyAllMediaBetweenDirs(prevHandle, picked);
      }
    }
  }

  const summary = await getClientStorageSummary();
  return {summary, copiedCount};
}

export async function reauthorizeClientDirectory(): Promise<ClientStorageSummary> {
  const custom = await getSavedDirHandle();
  if (!custom) {
    writeClientMeta({mode: 'app-root', folderName: 'Корень приложения'});
    return await getClientStorageSummary();
  }
  await ensureHandlePermission(custom, true);
  return await getClientStorageSummary();
}

export async function resetClientDirectory(): Promise<ClientStorageSummary> {
  const custom = await getSavedDirHandle();
  if (custom) {
    const perm = await ensureHandlePermission(custom, false);
    if (perm === 'granted') {
      const opfs = await getOpfsMediaDir(true);
      await copyAllMediaBetweenDirs(custom, opfs);
    }
  }
  await saveDirHandle(null);
  writeClientMeta({mode: 'app-root', folderName: 'Корень приложения'});
  return await getClientStorageSummary();
}

export async function clearClientAppRootCache(): Promise<ClientStorageSummary> {
  const opfs = await getOpfsMediaDir(false);
  if (opfs) {
    const clearFlat = async (dir: FsDirHandleLike | null) => {
      if (!dir || typeof dir.values !== 'function' || typeof dir.removeEntry !== 'function') {
        return;
      }
      try {
        const names: string[] = [];
        for await (const entry of dir.values()) {
          if (entry.kind === 'file') names.push(entry.name);
        }
        for (const name of names) {
          await dir.removeEntry(name).catch(() => {});
        }
      } catch {
        // ignore
      }
    };
    const opfsMedia = await getSubDirHandle(opfs, 'media', false);
    await clearFlat(opfsMedia);
    await clearFlat(opfs);
  }
  return await getClientStorageSummary();
}

export function formatStorageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 Б';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} ГБ`;
}
