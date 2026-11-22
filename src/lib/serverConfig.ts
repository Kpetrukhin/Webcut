import {Capacitor} from '@capacitor/core';

const STORAGE_KEY = 'cutsync_server_url';
const RECENT_SERVERS_KEY = 'cutsync_recent_servers';

export function isNativeCapacitorApp(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(trimmed)) {
    return `http://${trimmed}:8080`;
  }
  return `http://${trimmed}`;
}

export function getSavedServerUrl(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return normalizeServerUrl(saved);
  } catch {
    // ignore storage access issues
  }
  const envUrl = import.meta.env.VITE_SERVER_URL as string | undefined;
  return envUrl ? normalizeServerUrl(envUrl) : '';
}

export function getRecentServers(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_SERVERS_KEY);
    if (raw) {
      const arr = JSON.parse(raw) as unknown;
      if (Array.isArray(arr)) {
        return arr.filter((x): x is string => typeof x === 'string');
      }
    }
  } catch {
    // ignore
  }
  return [];
}

export function saveServerUrl(raw: string): string {
  const normalized = normalizeServerUrl(raw);
  try {
    if (normalized) {
      localStorage.setItem(STORAGE_KEY, normalized);
      const prev = getRecentServers().filter((u) => u !== normalized);
      localStorage.setItem(
        RECENT_SERVERS_KEY,
        JSON.stringify([normalized, ...prev].slice(0, 6))
      );
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // ignore
  }
  return normalized;
}

export function getApiUrl(path: string): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const base = getSavedServerUrl();
  if (!isNativeCapacitorApp()) {
    return base ? `${base}${cleanPath}` : cleanPath;
  }
  return base ? `${base}${cleanPath}` : '';
}

export function getWebSocketUrl(overrideBaseUrl?: string): string | null {
  const base = overrideBaseUrl ? normalizeServerUrl(overrideBaseUrl) : getSavedServerUrl();
  if (!base) {
    if (!isNativeCapacitorApp()) {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${proto}//${window.location.host}/sync`;
    }
    return null;
  }
  return base.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:') + '/sync';
}

export function resolveMediaSrc(src: string | undefined): string | undefined {
  if (!src) return src;
  if (
    src.startsWith('http://') ||
    src.startsWith('https://') ||
    src.startsWith('blob:') ||
    src.startsWith('data:') ||
    src.startsWith('synth:')
  ) {
    return src;
  }
  if (src.startsWith('/uploads/') || src.startsWith('/media/')) {
    const base = getSavedServerUrl();
    if (base) return `${base}${src}`;
  }
  return src;
}

export interface DiscoveredServer {
  url: string;
  host: string;
  roomsCount: number;
  onlineUsers: number;
}

async function probeServerHost(
  url: string,
  timeoutMs = 700
): Promise<DiscoveredServer | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/api/health`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      ok?: boolean;
      app?: string;
      host?: string;
      roomsCount?: number;
      onlineUsers?: number;
      participants?: number;
    };
    if (!data.ok || data.app !== 'CutSync') return null;
    return {
      url,
      host: data.host || url.replace(/^https?:\/\//, ''),
      roomsCount: data.roomsCount ?? 1,
      onlineUsers: data.onlineUsers ?? data.participants ?? 0,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function detectLocalSubnetPrefix(): Promise<string | null> {
  try {
    const pc = new RTCPeerConnection({iceServers: []});
    pc.createDataChannel('lan');
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const ip = await new Promise<string | null>((resolve) => {
      const timeout = setTimeout(() => resolve(null), 600);
      pc.onicecandidate = (e) => {
        if (!e.candidate) return;
        const match = e.candidate.candidate.match(
          /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/
        );
        if (match && !match[1].startsWith('127.')) {
          clearTimeout(timeout);
          resolve(match[1]);
        }
      };
    });
    pc.close();
    if (!ip) return null;
    const parts = ip.split('.');
    return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}` : null;
  } catch {
    return null;
  }
}

export async function scanLocalLanServers(
  customSubnet?: string,
  onFound?: (server: DiscoveredServer) => void
): Promise<DiscoveredServer[]> {
  const candidates = new Set<string>();

  if (!isNativeCapacitorApp()) {
    candidates.add(window.location.origin);
  }
  const saved = getSavedServerUrl();
  if (saved) candidates.add(saved);
  for (const recent of getRecentServers()) candidates.add(recent);

  const detectedPrefix = customSubnet?.trim() || (await detectLocalSubnetPrefix());
  const prefixes = detectedPrefix
    ? [detectedPrefix]
    : ['192.168.1', '192.168.0', '192.168.43', '192.168.31'];

  // Probe Ktor P2P hosts on port 8080 (and desktop Node hosts on 3000)
  for (const prefix of prefixes) {
    for (let i = 1; i <= 40; i++) {
      candidates.add(`http://${prefix}.${i}:8080`);
      candidates.add(`http://${prefix}.${i}:3000`);
    }
    for (let i = 100; i <= 130; i++) {
      candidates.add(`http://${prefix}.${i}:8080`);
      candidates.add(`http://${prefix}.${i}:3000`);
    }
  }

  const found: DiscoveredServer[] = [];
  const allUrls = Array.from(candidates);
  const batchSize = 24;

  for (let i = 0; i < allUrls.length; i += batchSize) {
    const batch = allUrls.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map((u) => probeServerHost(u, 550))
    );
    for (const item of results) {
      if (item && !found.some((f) => f.url === item.url)) {
        found.push(item);
        onFound?.(item);
      }
    }
  }

  return found;
}
