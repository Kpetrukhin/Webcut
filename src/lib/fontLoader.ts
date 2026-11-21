import type {ProjectFont} from '../shared/types.ts';
import {resolveMediaSrc} from './serverConfig.ts';

export const BUILTIN_FONTS: Array<{name: string; family: string; css: string}> = [
  {name: 'Jakarta (Стандарт)', family: 'Plus Jakarta Sans', css: '"Plus Jakarta Sans", sans-serif'},
  {name: 'Системный жирный', family: 'system-ui', css: 'system-ui, -apple-system, sans-serif'},
  {name: 'Классика (Serif)', family: 'Georgia', css: 'Georgia, "Times New Roman", serif'},
  {name: 'Моно (Код/Титр)', family: 'JetBrains Mono', css: '"JetBrains Mono", ui-monospace, monospace'},
  {name: 'Ударный (Impact)', family: 'Impact', css: 'Impact, "Arial Black", sans-serif'},
  {name: 'Рукописный', family: 'cursive', css: 'cursive, sans-serif'},
];

const loadedFontKeys = new Set<string>();
const loadingFontPromises = new Map<string, Promise<void>>();
const fontLoadListeners = new Set<() => void>();

export function subscribeFontLoads(cb: () => void): () => void {
  fontLoadListeners.add(cb);
  return () => {
    fontLoadListeners.delete(cb);
  };
}

function notifyFontLoaded() {
  for (const cb of fontLoadListeners) {
    cb();
  }
}

export function sanitizeFontFamilyName(raw: string): string {
  const cleaned = raw
    .replace(/\.(ttf|otf|woff2?|eot)$/i, '')
    .replace(/[^a-zA-Zа-яА-Я0-9 _-]/g, '')
    .trim()
    .slice(0, 32);
  return cleaned || 'CustomFont';
}

export function loadCustomFont(fontFamily: string, src?: string): Promise<void> {
  if (!fontFamily || !src) return Promise.resolve();
  const resolved = resolveMediaSrc(src) || src;
  const cacheKey = `${fontFamily}::${resolved}`;
  if (loadedFontKeys.has(cacheKey)) return Promise.resolve();

  const existing = loadingFontPromises.get(cacheKey);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const face = new FontFace(fontFamily, `url("${resolved}")`);
      const loaded = await face.load();
      document.fonts.add(loaded);
      loadedFontKeys.add(cacheKey);
      notifyFontLoaded();
    } catch {
      // ignore invalid font files
    } finally {
      loadingFontPromises.delete(cacheKey);
    }
  })();

  loadingFontPromises.set(cacheKey, promise);
  return promise;
}

export async function preloadProjectFonts(fonts?: ProjectFont[]): Promise<void> {
  if (!fonts || fonts.length === 0) return;
  await Promise.all(fonts.map((f) => loadCustomFont(f.fontFamily, f.src)));
}
