export type ClientStorageMode = 'app-root' | 'custom-fs';

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
  const base = fileName.split(/[\\/]/).pop() || fileName || 'media.bin';
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned || `media-${Date.now()}.bin`;
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
  try {
    for await (const entry of dir.values()) {
      if (entry.kind === 'file') {
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
  blob: Blob
): Promise<boolean> {
  try {
    const safeName = sanitizeSafeFileName(fileName);
    const fileHandle = await dir.getFileHandle(safeName, {create: true});
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  } catch {
    return false;
  }
}

export async function saveMediaToLocalFolder(
  fileName: string,
  blob: Blob
): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  const resolved = await resolveActiveBrowserDir(false);
  if (resolved.dir) {
    const ok = await writeBlobToDir(resolved.dir, fileName, blob);
    if (ok) return true;
  }
  // If custom handle lacked permission during background sync, still persist to app-root OPFS
  if (resolved.mode === 'custom-fs') {
    const opfs = await getOpfsMediaDir(true);
    if (opfs) {
      return await writeBlobToDir(opfs, fileName, blob);
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
  const dirsToCheck: FsDirHandleLike[] = [];

  const resolved = await resolveActiveBrowserDir(false);
  if (resolved.dir) dirsToCheck.push(resolved.dir);
  if (resolved.mode === 'custom-fs') {
    const opfs = await getOpfsMediaDir(false);
    if (opfs) dirsToCheck.push(opfs);
  }

  for (const dir of dirsToCheck) {
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
  return null;
}

async function copyAllMediaBetweenDirs(
  fromDir: FsDirHandleLike | null,
  toDir: FsDirHandleLike | null
): Promise<number> {
  if (!fromDir || !toDir || typeof fromDir.values !== 'function') return 0;
  let copied = 0;
  try {
    for await (const entry of fromDir.values()) {
      if (entry.kind !== 'file') continue;
      try {
        const file = await entry.getFile();
        if (file.size <= 0) continue;
        // Skip if target already has file of same size
        try {
          const existing = await (await toDir.getFileHandle(entry.name, {create: false})).getFile();
          if (existing.size === file.size) continue;
        } catch {
          // target does not have file yet
        }
        const ok = await writeBlobToDir(toDir, entry.name, file);
        if (ok) copied += 1;
      } catch {
        // ignore single file errors
      }
    }
  } catch {
    // ignore
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
  if (opfs && typeof opfs.values === 'function' && typeof opfs.removeEntry === 'function') {
    try {
      const names: string[] = [];
      for await (const entry of opfs.values()) {
        names.push(entry.name);
      }
      for (const name of names) {
        await opfs.removeEntry(name).catch(() => {});
      }
    } catch {
      // ignore
    }
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
