import type {ProjectFont} from '../shared/types.ts';
import {
  resolveMediaCandidateUrls,
  resolveMediaSrc,
} from './serverConfig.ts';
import {sha256Hex} from './sha256.ts';

export const BUILTIN_FONTS: Array<{name: string; family: string; css: string}> = [
  {name: 'Jakarta (Стандарт)', family: 'Plus Jakarta Sans', css: '"Plus Jakarta Sans", sans-serif'},
  {name: 'Montserrat (Модерн)', family: 'Montserrat', css: '"Montserrat", sans-serif'},
  {name: 'Oswald (Плакат)', family: 'Oswald', css: '"Oswald", sans-serif'},
  {name: 'Ударный (Impact)', family: 'Impact', css: 'Impact, "Arial Black", sans-serif'},
  {name: 'Playfair (Журнал)', family: 'Playfair Display', css: '"Playfair Display", Georgia, serif'},
  {name: 'Классика (Serif)', family: 'Georgia', css: 'Georgia, "Times New Roman", serif'},
  {name: 'Моно (Код/Титр)', family: 'JetBrains Mono', css: '"JetBrains Mono", ui-monospace, monospace'},
  {name: 'Lobster (Леттеринг)', family: 'Lobster', css: '"Lobster", cursive'},
  {name: 'Системный (Sans)', family: 'system-ui', css: 'system-ui, -apple-system, sans-serif'},
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

export interface LoadCustomFontOptions {
  fileName?: string;
  fileSize?: number;
  fileHash?: string;
}

export function loadCustomFont(
  fontFamily: string,
  src?: string,
  opts?: LoadCustomFontOptions
): Promise<void> {
  if (!fontFamily || !src) return Promise.resolve();
  const primary = resolveMediaSrc(src) || src;
  const cacheKey = `${fontFamily}::${opts?.fileName || primary}`;
  if (loadedFontKeys.has(cacheKey)) return Promise.resolve();

  const existing = loadingFontPromises.get(cacheKey);
  if (existing) return existing;

  const candidates =
    src.startsWith('blob:') || src.startsWith('data:')
      ? [src]
      : resolveMediaCandidateUrls(src, opts?.fileName);
  if (candidates.length === 0) candidates.push(primary);

  const promise = (async () => {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const targetUrl =
        candidates[(attempt - 1) % candidates.length] || primary;
      try {
        if (targetUrl.startsWith('blob:') || targetUrl.startsWith('data:')) {
          const face = new FontFace(fontFamily, `url("${targetUrl}")`);
          const loaded = await face.load();
          document.fonts.add(loaded);
          loadedFontKeys.add(cacheKey);
          notifyFontLoaded();
          return;
        }

        const res = await fetch(targetUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        const headerSize = Number(res.headers.get('x-file-size') || 0);
        const expectedSize = opts?.fileSize || headerSize;
        if (expectedSize > 0 && buf.byteLength !== expectedSize) {
          throw new Error(
            `Размер шрифта не совпал (${buf.byteLength} !== ${expectedSize})`
          );
        }
        const headerHash = res.headers.get('x-content-sha256')?.trim();
        const expectedHash = (opts?.fileHash || headerHash || '').toLowerCase();
        if (expectedHash) {
          const actualHash = await sha256Hex(buf);
          if (actualHash !== expectedHash) {
            throw new Error('Контрольная сумма шрифта повреждена');
          }
        }

        const face = new FontFace(fontFamily, buf);
        const loaded = await face.load();
        document.fonts.add(loaded);
        loadedFontKeys.add(cacheKey);
        notifyFontLoaded();
        return;
      } catch {
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 300 * attempt));
        }
      }
    }
  })().finally(() => {
    loadingFontPromises.delete(cacheKey);
  });

  loadingFontPromises.set(cacheKey, promise);
  return promise;
}

export async function preloadProjectFonts(fonts?: ProjectFont[]): Promise<void> {
  if (!fonts || fonts.length === 0) return;
  await Promise.all(
    fonts.map((f) =>
      loadCustomFont(f.fontFamily, f.src, {
        fileName: f.fileName,
        fileSize: f.fileSize,
        fileHash: f.fileHash,
      })
    )
  );
}
