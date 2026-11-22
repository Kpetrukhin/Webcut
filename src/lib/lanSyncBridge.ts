import {Capacitor, registerPlugin} from '@capacitor/core';
import type {PluginListenerHandle} from '@capacitor/core';
import type {
  DiscoveredUdpRoom,
  NetworkInterfaceInfo,
  ProjectState,
} from '../shared/types.ts';
import {getApiUrl, getSavedServerUrl, isNativeCapacitorApp} from './serverConfig.ts';

export interface NetworkInfoSnapshot {
  interfaces: NetworkInterfaceInfo[];
  primaryIp: string;
  port: number;
  udpPort: number;
}

interface LanSyncPluginInterface {
  getNetworkInfo(): Promise<NetworkInfoSnapshot>;
  ensureMediaServer(): Promise<
    NetworkInfoSnapshot & {localUploadUrl: string}
  >;
  startHostServer(options: {
    snapshotJson?: string;
  }): Promise<
    NetworkInfoSnapshot & {
      ok: boolean;
      wsUrl: string;
      localUploadUrl: string;
    }
  >;
  syncHostSnapshot(options: {snapshotJson: string}): Promise<void>;
  stopHostServer(): Promise<void>;
  startUdpDiscovery(): Promise<void>;
  stopUdpDiscovery(): Promise<void>;
  downloadMedia(options: {
    layerId: string;
    url: string;
    fileName: string;
  }): Promise<{started: boolean}>;
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
    port: isNativeCapacitorApp() ? 8080 : Number(window.location.port) || 3000,
    udpPort: 8081,
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
}

export async function uploadFileForP2P(
  file: File,
  fallbackKind: 'video' | 'image' | 'audio' | 'font'
): Promise<PreparedP2PMedia> {
  const safeBase = file.name.replace(/[^a-zA-Z0-9._-]/g, '_') || 'media.bin';
  const stampedName = `${Date.now()}-${safeBase}`;

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
  };
}

export async function downloadMediaInBackground(opts: {
  layerId: string;
  remoteUrl: string;
  fileName: string;
  onProgress?: (pct: number) => void;
}): Promise<string> {
  const {layerId, remoteUrl, fileName, onProgress} = opts;

  if (!remoteUrl || remoteUrl.startsWith('blob:') || remoteUrl.startsWith('data:')) {
    return remoteUrl;
  }

  // Resolve relative /media/... or /uploads/... URLs against connected server
  const resolvedUrl =
    remoteUrl.startsWith('/') && isNativeCapacitorApp() && getSavedServerUrl()
      ? `${getSavedServerUrl()}${remoteUrl}`
      : remoteUrl.startsWith('/')
        ? `${window.location.origin}${remoteUrl}`
        : remoteUrl;

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
          url: resolvedUrl,
          fileName,
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

  // Browser / PWA fallback: stream fetch with progress and return cached Blob URL
  const res = await fetch(resolvedUrl);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const total = Number(res.headers.get('content-length') || 0);
  if (!res.body || !total) {
    const blob = await res.blob();
    onProgress?.(100);
    return URL.createObjectURL(blob);
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      onProgress?.(Math.min(99, Math.round((loaded / total) * 100)));
    }
  }
  const mime = res.headers.get('content-type') || 'application/octet-stream';
  const blobParts: BlobPart[] = chunks.map(
    (c) =>
      c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength) as ArrayBuffer
  );
  const blob = new Blob(blobParts, {type: mime});
  onProgress?.(100);
  return URL.createObjectURL(blob);
}
