import {Capacitor, registerPlugin} from '@capacitor/core';
import type {PluginListenerHandle} from '@capacitor/core';
import type {
  DiscoveredUdpRoom,
  NetworkInterfaceInfo,
  ProjectState,
} from '../shared/types.ts';
import {
  getApiUrl,
  getSavedServerUrl,
  isNativeCapacitorApp,
  resolveMediaCandidateUrls,
} from './serverConfig.ts';
import {sha256Hex} from './sha256.ts';

export interface NetworkInfoSnapshot {
  interfaces: NetworkInterfaceInfo[];
  primaryIp: string;
  port: number;
  udpPort: number;
}

export interface KtorServerStatus {
  state: 'running' | 'port_error' | 'stopped' | 'web';
  port: number;
  preferredPort: number;
  hosting: boolean;
  error?: string;
}

interface LanSyncPluginInterface {
  getNetworkInfo(): Promise<NetworkInfoSnapshot>;
  getServerStatus(): Promise<KtorServerStatus>;
  ensureMediaServer(): Promise<
    NetworkInfoSnapshot & {
      localUploadUrl: string;
      serverState?: string;
      serverError?: string;
    }
  >;
  startHostServer(options: {
    snapshotJson?: string;
  }): Promise<
    NetworkInfoSnapshot & {
      ok: boolean;
      wsUrl: string;
      localUploadUrl: string;
      serverState?: string;
      serverError?: string;
    }
  >;
  syncHostSnapshot(options: {snapshotJson: string}): Promise<void>;
  stopHostServer(): Promise<void>;
  startUdpDiscovery(): Promise<void>;
  stopUdpDiscovery(): Promise<void>;
  downloadMedia(options: {
    layerId: string;
    url: string;
    fallbackUrl?: string;
    fileName: string;
    expectedSize?: number;
    expectedHash?: string;
    maxRetries?: number;
  }): Promise<{started: boolean}>;
  compressVideo(options: {
    layerId: string;
    sourceUrl: string;
    fileName: string;
    targetHeight: number;
    targetBitrate: number;
  }): Promise<{started: boolean}>;
  cancelCompressVideo(options: {layerId: string}): Promise<void>;
  requestAudioPermission(): Promise<{granted: boolean}>;
  extractAudio(options: {
    sourceUrl: string;
    fileName: string;
    trimStartMs?: number;
    durationMs?: number;
  }): Promise<{
    fileName: string;
    localUrl: string;
    shareUrl: string;
    durationSec: number;
    fileSize?: number;
    fileHash?: string;
  }>;
  addListener(
    eventName: 'udpRoomsUpdate',
    listenerFunc: (data: {rooms: DiscoveredUdpRoom[]}) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'mediaDownloadProgress',
    listenerFunc: (data: {layerId: string; progress: number}) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'mediaDownloadComplete',
    listenerFunc: (data: {
      layerId: string;
      fileName: string;
      localUrl: string;
    }) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'mediaDownloadError',
    listenerFunc: (data: {layerId: string; message: string}) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'mediaCompressProgress',
    listenerFunc: (data: {layerId: string; progress: number}) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'mediaCompressComplete',
    listenerFunc: (data: {
      layerId: string;
      fileName: string;
      localUrl: string;
      shareUrl: string;
      originalSizeBytes: number;
      compressedSizeBytes: number;
    }) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'mediaCompressError',
    listenerFunc: (data: {layerId: string; message: string}) => void
  ): Promise<PluginListenerHandle>;
}

const LanSync = registerPlugin<LanSyncPluginInterface>('LanSync');

function hasNativeLanPlugin(): boolean {
  try {
    return isNativeCapacitorApp() && Capacitor.isPluginAvailable('LanSync');
  } catch {
    return false;
  }
}

export async function getP2PNetworkInfo(): Promise<NetworkInfoSnapshot> {
  if (hasNativeLanPlugin()) {
    try {
      return await LanSync.getNetworkInfo();
    } catch {
      // fall through
    }
  }
  const endpoint = getApiUrl('/api/network-info');
  if (endpoint) {
    try {
      const res = await fetch(endpoint);
      if (res.ok) {
        const data = (await res.json()) as {
          interfaces?: NetworkInterfaceInfo[];
          primaryIp?: string;
          port?: number;
          udpPort?: number;
        };
        return {
          interfaces: Array.isArray(data.interfaces) ? data.interfaces : [],
          primaryIp: data.primaryIp || '127.0.0.1',
          port: data.port || 3000,
          udpPort: data.udpPort || 8081,
        };
      }
    } catch {
      // ignore
    }
  }
  return {
    interfaces: [],
    primaryIp: '127.0.0.1',
    port: isNativeCapacitorApp()
      ? 8080
      : typeof window !== 'undefined'
        ? Number(window.location.port) || 3000
        : 3000,
    udpPort: 8081,
  };
}

export async function getKtorServerStatus(): Promise<KtorServerStatus> {
  if (hasNativeLanPlugin()) {
    try {
      const s = await LanSync.getServerStatus();
      return {
        state:
          s.state === 'port_error'
            ? 'port_error'
            : s.state === 'running'
              ? 'running'
              : 'stopped',
        port: s.port || 8080,
        preferredPort: s.preferredPort || 8080,
        hosting: Boolean(s.hosting),
        error: s.error,
      };
    } catch (err) {
      return {
        state: 'port_error',
        port: 8080,
        preferredPort: 8080,
        hosting: false,
        error: err instanceof Error ? err.message : 'Ktor недоступен',
      };
    }
  }
  const healthUrl = getApiUrl('/api/health');
  if (healthUrl) {
    try {
      const res = await fetch(healthUrl);
      if (res.ok) {
        const port =
          typeof window !== 'undefined'
            ? Number(window.location.port) || 3000
            : 3000;
        return {
          state: 'web',
          port,
          preferredPort: port,
          hosting: false,
        };
      }
    } catch {
      // ignore
    }
  }
  return {
    state: isNativeCapacitorApp() ? 'stopped' : 'web',
    port: isNativeCapacitorApp() ? 8080 : 3000,
    preferredPort: isNativeCapacitorApp() ? 8080 : 3000,
    hosting: false,
  };
}

export async function startHostLanServer(
  initialProject: ProjectState
): Promise<{
  ok: boolean;
  wsUrl: string;
  interfaces: NetworkInterfaceInfo[];
  primaryIp: string;
  port: number;
}> {
  if (hasNativeLanPlugin()) {
    const res = await LanSync.startHostServer({
      snapshotJson: JSON.stringify(initialProject),
    });
    return {
      ok: Boolean(res.ok),
      wsUrl: res.wsUrl,
      interfaces: res.interfaces || [],
      primaryIp: res.primaryIp || '127.0.0.1',
      port: res.port || 8080,
    };
  }
  const info = await getP2PNetworkInfo();
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return {
    ok: true,
    wsUrl: `${proto}//${window.location.host}/sync`,
    interfaces: info.interfaces,
    primaryIp: info.primaryIp,
    port: info.port,
  };
}

export async function syncHostLanSnapshot(
  project: ProjectState
): Promise<void> {
  if (!hasNativeLanPlugin()) return;
  try {
    await LanSync.syncHostSnapshot({
      snapshotJson: JSON.stringify(project),
    });
  } catch {
    // ignore
  }
}

export async function stopHostLanServer(): Promise<void> {
  if (!hasNativeLanPlugin()) return;
  try {
    await LanSync.stopHostServer();
  } catch {
    // ignore
  }
}

export async function startUdpRoomDiscovery(
  onRooms: (rooms: DiscoveredUdpRoom[]) => void
): Promise<() => void> {
  if (!hasNativeLanPlugin()) {
    return () => {};
  }
  let handle: PluginListenerHandle | null = null;
  try {
    handle = await LanSync.addListener('udpRoomsUpdate', (payload) => {
      onRooms(Array.isArray(payload.rooms) ? payload.rooms : []);
    });
    await LanSync.startUdpDiscovery();
  } catch {
    // ignore
  }
  return () => {
    void handle?.remove();
    void LanSync.stopUdpDiscovery().catch(() => {});
  };
}

function pickBestShareIpForRemoteHost(
  interfaces: NetworkInterfaceInfo[],
  fallbackPrimaryIp: string
): string {
  const connectedUrl = getSavedServerUrl();
  if (connectedUrl) {
    const match = connectedUrl.match(/https?:\/\/([^/:]+)/i);
    const hostIp = match?.[1] || '';
    if (hostIp && hostIp !== '127.0.0.1' && hostIp !== 'localhost') {
      const hostPrefix = hostIp.split('.').slice(0, 2).join('.');
      const sameSubnet = interfaces.find((iface) =>
        iface.ip.startsWith(hostPrefix + '.')
      );
      if (sameSubnet) return sameSubnet.ip;

      // ZeroTier commonly uses 10.x.x.x or 172.x.x.x when Wi-Fi is 192.168.x.x
      if (!hostIp.startsWith('192.168.')) {
        const zt = interfaces.find((i) => i.type === 'zerotier');
        if (zt) return zt.ip;
      }
    }
  }
  return (
    interfaces.find((i) => i.type === 'wifi')?.ip ||
    interfaces.find((i) => i.type === 'zerotier')?.ip ||
    fallbackPrimaryIp
  );
}

export interface PreparedP2PMedia {
  name: string;
  fileName: string;
  kind: 'video' | 'image' | 'audio' | 'font';
  localSrc: string;
  shareUrl: string;
  fileSize?: number;
  fileHash?: string;
}

export async function uploadFileForP2P(
  file: File,
  fallbackKind: 'video' | 'image' | 'audio' | 'font'
): Promise<PreparedP2PMedia> {
  const safeBase = file.name.replace(/[^a-zA-Z0-9._-]/g, '_') || 'media.bin';
  const stampedName = `${Date.now()}-${safeBase}`;
  let localHash: string | undefined;
  try {
    localHash = await sha256Hex(await file.arrayBuffer());
  } catch {
    localHash = undefined;
  }
  const localSize = file.size;

  // 1. Native Android Ktor HTTP streaming (/media/upload -> /media/{fileName})
  if (hasNativeLanPlugin()) {
    try {
      const srv = await LanSync.ensureMediaServer();
      const uploadRes = await fetch(
        `${srv.localUploadUrl}?fileName=${encodeURIComponent(stampedName)}`,
        {
          method: 'POST',
          body: file,
        }
      );
      if (uploadRes.ok) {
        const data = (await uploadRes.json()) as {
          fileName: string;
          localUrl: string;
          shareUrl: string;
          fileSize?: number;
          fileHash?: string;
        };
        const shareIp = pickBestShareIpForRemoteHost(
          srv.interfaces || [],
          srv.primaryIp || '127.0.0.1'
        );
        const shareUrl = `http://${shareIp}:${srv.port}/media/${encodeURIComponent(data.fileName)}`;
        return {
          name: file.name,
          fileName: data.fileName,
          kind: fallbackKind,
          localSrc: data.localUrl,
          shareUrl,
          fileSize: data.fileSize ?? localSize,
          fileHash: data.fileHash ?? localHash,
        };
      }
    } catch {
      // fall through
    }
  }

  // 2. Web / Node Express HTTP /api/upload or /media/upload
  const uploadEndpoint = getApiUrl('/api/upload');
  if (uploadEndpoint) {
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(uploadEndpoint, {method: 'POST', body: form});
      const data = (await res.json()) as {
        name?: string;
        kind?: 'video' | 'image' | 'audio' | 'font';
        fileName?: string;
        src?: string;
        sizeBytes?: number;
        fileHash?: string;
      };
      if (res.ok && data.src) {
        const fileName = data.fileName || data.src.split('/').pop() || stampedName;
        const origin =
          isNativeCapacitorApp() && getSavedServerUrl()
            ? getSavedServerUrl()
            : window.location.origin;
        const shareUrl = data.src.startsWith('http')
          ? data.src
          : `${origin}${data.src}`;
        return {
          name: data.name || file.name,
          fileName,
          kind: data.kind || fallbackKind,
          localSrc: data.src,
          shareUrl,
          fileSize: data.sizeBytes ?? localSize,
          fileHash: data.fileHash ?? localHash,
        };
      }
    } catch {
      // fall back to blob URL
    }
  }

  const blobUrl = URL.createObjectURL(file);
  return {
    name: file.name,
    fileName: stampedName,
    kind: fallbackKind,
    localSrc: blobUrl,
    shareUrl: blobUrl,
    fileSize: localSize,
    fileHash: localHash,
  };
}

async function fetchAndVerifyMediaOnce(opts: {
  url: string;
  expectedSize?: number;
  expectedHash?: string;
  onProgress?: (pct: number) => void;
}): Promise<Blob> {
  const {url, expectedSize, expectedHash, onProgress} = opts;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const headerSize = Number(
    res.headers.get('x-file-size') || res.headers.get('content-length') || 0
  );
  const headerHash = res.headers.get('x-content-sha256')?.trim().toLowerCase();
  const requiredSize =
    expectedSize && expectedSize > 0
      ? expectedSize
      : Number.isFinite(headerSize) && headerSize > 0
        ? headerSize
        : 0;
  const requiredHash = (expectedHash || headerHash || '').toLowerCase();

  let buffer: ArrayBuffer;
  const mime = res.headers.get('content-type') || 'application/octet-stream';

  if (res.body) {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        loaded += value.byteLength;
        if (requiredSize > 0) {
          onProgress?.(Math.min(98, Math.round((loaded / requiredSize) * 98)));
        }
      }
    }
    const merged = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    buffer = merged.buffer;
  } else {
    buffer = await res.arrayBuffer();
  }

  if (requiredSize > 0 && buffer.byteLength !== requiredSize) {
    throw new Error(
      `Размер файла не совпал: получено ${buffer.byteLength} Б, ожидалось ${requiredSize} Б`
    );
  }
  if (headerSize > 0 && buffer.byteLength !== headerSize) {
    throw new Error(
      `Размер ответа HTTP не совпал: получено ${buffer.byteLength} Б, заголовок ${headerSize} Б`
    );
  }

  if (requiredHash || headerHash) {
    const actualHash = await sha256Hex(buffer);
    if (requiredHash && actualHash !== requiredHash) {
      throw new Error('Контрольная сумма файла (SHA-256) не совпала');
    }
    if (headerHash && actualHash !== headerHash) {
      throw new Error('Контрольная сумма сервера (SHA-256) не совпала');
    }
  }

  onProgress?.(100);
  return new Blob([buffer], {type: mime});
}

export async function downloadMediaInBackground(opts: {
  layerId: string;
  remoteUrl: string;
  fileName: string;
  expectedSize?: number;
  expectedHash?: string;
  serverBaseOverride?: string;
  maxAttempts?: number;
  onProgress?: (pct: number) => void;
  onAttempt?: (attempt: number, maxAttempts: number) => void;
}): Promise<string> {
  const {
    layerId,
    remoteUrl,
    fileName,
    expectedSize,
    expectedHash,
    serverBaseOverride,
    maxAttempts = 3,
    onProgress,
    onAttempt,
  } = opts;

  if (!remoteUrl || remoteUrl.startsWith('blob:') || remoteUrl.startsWith('data:')) {
    return remoteUrl;
  }

  const candidates = resolveMediaCandidateUrls(
    remoteUrl,
    fileName,
    serverBaseOverride
  );
  const primaryUrl = candidates[0] || remoteUrl;
  const fallbackUrl = candidates[1];

  if (hasNativeLanPlugin()) {
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let progressHandle: PluginListenerHandle | null = null;
      let completeHandle: PluginListenerHandle | null = null;
      let errorHandle: PluginListenerHandle | null = null;

      const cleanup = () => {
        void progressHandle?.remove();
        void completeHandle?.remove();
        void errorHandle?.remove();
      };

      const setup = async () => {
        progressHandle = await LanSync.addListener(
          'mediaDownloadProgress',
          (ev) => {
            if (ev.layerId === layerId) {
              onProgress?.(ev.progress);
            }
          }
        );
        completeHandle = await LanSync.addListener(
          'mediaDownloadComplete',
          (ev) => {
            if (ev.layerId === layerId && !settled) {
              settled = true;
              cleanup();
              onProgress?.(100);
              resolve(ev.localUrl);
            }
          }
        );
        errorHandle = await LanSync.addListener('mediaDownloadError', (ev) => {
          if (ev.layerId === layerId && !settled) {
            settled = true;
            cleanup();
            reject(new Error(ev.message || 'Ошибка загрузки медиа'));
          }
        });

        await LanSync.downloadMedia({
          layerId,
          url: primaryUrl,
          fallbackUrl,
          fileName,
          expectedSize: expectedSize && expectedSize > 0 ? expectedSize : undefined,
          expectedHash: expectedHash || undefined,
          maxRetries: maxAttempts,
        });
      };

      setup().catch((err) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(err);
        }
      });
    });
  }

  // Browser / PWA / Node path: stream fetch with size + SHA-256 verification and up to 3 attempts
  let lastError: Error = new Error('Не удалось скачать медиафайл');
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    onAttempt?.(attempt, maxAttempts);
    const targetUrl = candidates[(attempt - 1) % candidates.length] || primaryUrl;
    try {
      const blob = await fetchAndVerifyMediaOnce({
        url: targetUrl,
        expectedSize,
        expectedHash,
        onProgress,
      });
      return URL.createObjectURL(blob);
    } catch (err) {
      lastError =
        err instanceof Error ? err : new Error('Ошибка загрузки по сети');
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 350 * attempt));
      }
    }
  }
  throw lastError;
}

export interface CompressedMediaResult {
  fileName: string;
  localSrc: string;
  shareUrl: string;
  originalSizeBytes: number;
  compressedSizeBytes: number;
  engine: 'media3' | 'browser';
}

export function isNativeMedia3Available(): boolean {
  return hasNativeLanPlugin();
}

export async function cancelNativeVideoCompression(
  layerId: string
): Promise<void> {
  if (!hasNativeLanPlugin()) return;
  try {
    await LanSync.cancelCompressVideo({layerId});
  } catch {
    // ignore
  }
}

export async function requestNativeAudioPermission(): Promise<boolean> {
  if (!hasNativeLanPlugin()) return true;
  try {
    const res = await LanSync.requestAudioPermission();
    return Boolean(res.granted);
  } catch {
    return true;
  }
}

export async function extractAudioNative(opts: {
  sourceUrl: string;
  fileName: string;
  trimStartSec?: number;
  durationSec?: number;
}): Promise<{
  fileName: string;
  localSrc: string;
  shareUrl: string;
  durationSec: number;
  fileSize?: number;
  fileHash?: string;
} | null> {
  if (!hasNativeLanPlugin()) return null;
  const res = await LanSync.extractAudio({
    sourceUrl: opts.sourceUrl,
    fileName: opts.fileName,
    trimStartMs: Math.round((opts.trimStartSec ?? 0) * 1000),
    durationMs: opts.durationSec ? Math.round(opts.durationSec * 1000) : -1,
  });
  return {
    fileName: res.fileName,
    localSrc: res.localUrl,
    shareUrl: res.shareUrl,
    durationSec: res.durationSec,
    fileSize: res.fileSize,
    fileHash: res.fileHash,
  };
}

export async function compressClipMedia(opts: {
  layerId: string;
  kind: 'video' | 'image';
  sourceUrl: string;
  fileName: string;
  targetHeight: number;
  targetBitrate: number;
  onProgress?: (pct: number) => void;
  signal?: AbortSignal;
}): Promise<CompressedMediaResult> {
  const {
    layerId,
    kind,
    sourceUrl,
    fileName,
    targetHeight,
    targetBitrate,
    onProgress,
    signal,
  } = opts;

  if (kind === 'video' && hasNativeLanPlugin()) {
    let resolvedUrl = sourceUrl;
    if (sourceUrl.startsWith('blob:')) {
      const resp = await fetch(sourceUrl);
      const blob = await resp.blob();
      const uploaded = await uploadFileForP2P(
        new File([blob], fileName || 'clip.mp4', {
          type: blob.type || 'video/mp4',
        }),
        'video'
      );
      resolvedUrl = uploaded.localSrc;
    }

    const netInfo = await getP2PNetworkInfo();
    return new Promise<CompressedMediaResult>((resolve, reject) => {
      let settled = false;
      let progressHandle: PluginListenerHandle | null = null;
      let completeHandle: PluginListenerHandle | null = null;
      let errorHandle: PluginListenerHandle | null = null;

      const cleanup = () => {
        void progressHandle?.remove();
        void completeHandle?.remove();
        void errorHandle?.remove();
        signal?.removeEventListener('abort', onAbort);
      };

      const onAbort = () => {
        if (!settled) {
          settled = true;
          cleanup();
          void LanSync.cancelCompressVideo({layerId}).catch(() => {});
          reject(new Error('Сжатие отменено'));
        }
      };
      signal?.addEventListener('abort', onAbort);

      const setup = async () => {
        progressHandle = await LanSync.addListener(
          'mediaCompressProgress',
          (ev) => {
            if (ev.layerId === layerId) {
              onProgress?.(ev.progress);
            }
          }
        );
        completeHandle = await LanSync.addListener(
          'mediaCompressComplete',
          (ev) => {
            if (ev.layerId === layerId && !settled) {
              settled = true;
              cleanup();
              const shareIp = pickBestShareIpForRemoteHost(
                netInfo.interfaces || [],
                netInfo.primaryIp || '127.0.0.1'
              );
              const port = netInfo.port || 8080;
              const bestShareUrl = `http://${shareIp}:${port}/media/${encodeURIComponent(ev.fileName)}`;
              onProgress?.(100);
              resolve({
                fileName: ev.fileName,
                localSrc: ev.localUrl,
                shareUrl: bestShareUrl || ev.shareUrl,
                originalSizeBytes: ev.originalSizeBytes,
                compressedSizeBytes: ev.compressedSizeBytes,
                engine: 'media3',
              });
            }
          }
        );
        errorHandle = await LanSync.addListener('mediaCompressError', (ev) => {
          if (ev.layerId === layerId && !settled) {
            settled = true;
            cleanup();
            reject(new Error(ev.message || 'Ошибка сжатия Media3 Transformer'));
          }
        });

        await LanSync.compressVideo({
          layerId,
          sourceUrl: resolvedUrl,
          fileName: fileName || 'clip.mp4',
          targetHeight,
          targetBitrate,
        });
      };

      setup().catch((err) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(err);
        }
      });
    });
  }

  // Browser / PWA fallback
  if (kind === 'image') {
    onProgress?.(15);
    const res = await fetch(sourceUrl);
    const origBlob = await res.blob();
    const imgUrl = URL.createObjectURL(origBlob);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('Не удалось загрузить изображение'));
        el.src = imgUrl;
      });
      if (signal?.aborted) throw new Error('Сжатие отменено');
      const scale =
        targetHeight > 0 && img.naturalHeight > targetHeight
          ? targetHeight / img.naturalHeight
          : 1;
      const w = Math.max(2, Math.round(img.naturalWidth * scale));
      const h = Math.max(2, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas недоступен');
      ctx.drawImage(img, 0, 0, w, h);
      const quality =
        targetBitrate <= 700_000 ? 0.55 : targetBitrate <= 1_400_000 ? 0.72 : 0.84;
      onProgress?.(60);
      const outBlob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('Не удалось сжать фото'))),
          'image/jpeg',
          quality
        );
      });
      const base = (fileName || 'image').replace(/\.[^.]+$/, '');
      const outFile = new File([outBlob], `${base}_${targetHeight}p.jpg`, {
        type: 'image/jpeg',
      });
      const uploaded = await uploadFileForP2P(outFile, 'image');
      onProgress?.(100);
      return {
        fileName: uploaded.fileName,
        localSrc: uploaded.localSrc,
        shareUrl: uploaded.shareUrl,
        originalSizeBytes: origBlob.size,
        compressedSizeBytes: outBlob.size,
        engine: 'browser',
      };
    } finally {
      URL.revokeObjectURL(imgUrl);
    }
  }

  // Browser Video fallback via MediaRecorder
  onProgress?.(5);
  const srcResp = await fetch(sourceUrl);
  const origVideoBlob = await srcResp.blob();
  const srcBlobUrl = URL.createObjectURL(origVideoBlob);

  try {
    const vid = document.createElement('video');
    vid.muted = false;
    vid.playsInline = true;
    vid.src = srcBlobUrl;

    await new Promise<void>((resolve, reject) => {
      vid.onloadedmetadata = () => resolve();
      vid.onerror = () => reject(new Error('Не удалось прочитать видео'));
    });

    if (signal?.aborted) throw new Error('Сжатие отменено');

    const srcW = vid.videoWidth || 1280;
    const srcH = vid.videoHeight || 720;
    const scale =
      targetHeight > 0 && srcH > targetHeight ? targetHeight / srcH : 1;
    const outW = Math.max(2, Math.round((srcW * scale) / 2) * 2);
    const outH = Math.max(2, Math.round((srcH * scale) / 2) * 2);

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D недоступен');

    const stream = canvas.captureStream(30);
    const mimeCandidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
      'video/mp4',
    ];
    const mimeType =
      mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
    const recorder = new MediaRecorder(
      stream,
      mimeType
        ? {mimeType, videoBitsPerSecond: targetBitrate}
        : {videoBitsPerSecond: targetBitrate}
    );

    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    const donePromise = new Promise<Blob>((resolve) => {
      recorder.onstop = () => {
        resolve(new Blob(chunks, {type: mimeType || 'video/webm'}));
      };
    });

    recorder.start(200);
    vid.currentTime = 0;
    await vid.play().catch(() => {});

    const totalDur = Math.max(0.2, vid.duration || 5);
    await new Promise<void>((resolve, reject) => {
      let raf = 0;
      const cleanupLoop = () => {
        cancelAnimationFrame(raf);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        cleanupLoop();
        vid.pause();
        if (recorder.state !== 'inactive') recorder.stop();
        reject(new Error('Сжатие отменено'));
      };
      signal?.addEventListener('abort', onAbort);

      const draw = () => {
        if (signal?.aborted) return;
        ctx.drawImage(vid, 0, 0, outW, outH);
        const pct = Math.min(95, Math.round((vid.currentTime / totalDur) * 95));
        onProgress?.(pct);
        if (vid.ended || vid.currentTime >= totalDur - 0.04) {
          cleanupLoop();
          if (recorder.state !== 'inactive') recorder.stop();
          resolve();
          return;
        }
        raf = requestAnimationFrame(draw);
      };
      raf = requestAnimationFrame(draw);
    });

    const outBlob = await donePromise;
    const ext = (mimeType || '').includes('mp4') ? 'mp4' : 'webm';
    const base = (fileName || 'video').replace(/\.[^.]+$/, '');
    const outFile = new File([outBlob], `${base}_${targetHeight}p.${ext}`, {
      type: outBlob.type || 'video/webm',
    });
    const uploaded = await uploadFileForP2P(outFile, 'video');
    onProgress?.(100);
    return {
      fileName: uploaded.fileName,
      localSrc: uploaded.localSrc,
      shareUrl: uploaded.shareUrl,
      originalSizeBytes: origVideoBlob.size,
      compressedSizeBytes: outBlob.size,
      engine: 'browser',
    };
  } finally {
    URL.revokeObjectURL(srcBlobUrl);
  }
}
