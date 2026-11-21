import {Capacitor} from '@capacitor/core';

const STORAGE_KEY = 'cutsync_server_url';

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

export function saveServerUrl(raw: string): string {
  const normalized = normalizeServerUrl(raw);
  try {
    if (normalized) {
      localStorage.setItem(STORAGE_KEY, normalized);
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
  if (!isNativeCapacitorApp()) {
    return cleanPath;
  }
  const base = getSavedServerUrl();
  return base ? `${base}${cleanPath}` : '';
}

export function getWebSocketUrl(): string | null {
  if (!isNativeCapacitorApp()) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/ws`;
  }
  const base = getSavedServerUrl();
  if (!base) return null;
  return base.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:') + '/ws';
}

export function resolveMediaSrc(src: string | undefined): string | undefined {
  if (!src) return src;
  if (src.startsWith('/uploads/') && isNativeCapacitorApp()) {
    const base = getSavedServerUrl();
    return base ? `${base}${src}` : src;
  }
  return src;
}
