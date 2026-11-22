export const GIPHY_API_KEY: string =
  (import.meta.env.VITE_GIPHY_API_KEY as string | undefined)?.trim() || '';

const GIPHY_STORAGE_KEY = 'cutsync_giphy_api_key';

export interface GiphyStickerItem {
  id: string;
  title: string;
  previewUrl: string;
  stickerUrl: string;
  fallbackGifUrl: string;
  width: number;
  height: number;
  isWebp: boolean;
}

export interface GiphyStickersPage {
  items: GiphyStickerItem[];
  totalCount: number;
  offset: number;
}

export class GiphyApiError extends Error {
  public readonly code: 'MISSING_KEY' | 'INVALID_KEY' | 'RATE_LIMIT' | 'NETWORK';

  constructor(
    code: 'MISSING_KEY' | 'INVALID_KEY' | 'RATE_LIMIT' | 'NETWORK',
    message: string
  ) {
    super(message);
    this.name = 'GiphyApiError';
    this.code = code;
  }
}

export function getCustomGiphyApiKey(): string {
  try {
    return (localStorage.getItem(GIPHY_STORAGE_KEY) ?? '').trim();
  } catch {
    return '';
  }
}

export function saveCustomGiphyApiKey(key: string): string {
  const trimmed = key.trim();
  try {
    if (trimmed) {
      localStorage.setItem(GIPHY_STORAGE_KEY, trimmed);
    } else {
      localStorage.removeItem(GIPHY_STORAGE_KEY);
    }
  } catch {
    // ignore storage errors
  }
  return trimmed;
}

export function getEffectiveGiphyApiKey(): string {
  return getCustomGiphyApiKey() || GIPHY_API_KEY;
}

interface RawGiphyRendition {
  url?: string;
  webp?: string;
  width?: string;
  height?: string;
}

interface RawGiphyItem {
  id?: string;
  title?: string;
  images?: {
    fixed_width?: RawGiphyRendition;
    fixed_width_small?: RawGiphyRendition;
    fixed_height?: RawGiphyRendition;
    original?: RawGiphyRendition;
  };
}

interface RawGiphyResponse {
  data?: RawGiphyItem[];
  pagination?: {
    total_count?: number;
    count?: number;
    offset?: number;
  };
  meta?: {
    status?: number;
    msg?: string;
  };
}

function mapGiphyItem(raw: RawGiphyItem): GiphyStickerItem | null {
  const id = raw.id?.trim();
  if (!id || !raw.images) return null;

  const fw = raw.images.fixed_width;
  const fws = raw.images.fixed_width_small;
  const fh = raw.images.fixed_height;
  const orig = raw.images.original;

  const webpUrl = fw?.webp || fh?.webp || orig?.webp || fws?.webp || '';
  const gifUrl = fw?.url || fh?.url || orig?.url || fws?.url || '';
  const stickerUrl = webpUrl || gifUrl;
  if (!stickerUrl) return null;

  const previewUrl =
    fws?.webp || fws?.url || fw?.webp || fw?.url || orig?.webp || orig?.url || stickerUrl;

  const width = Math.max(1, Number(fw?.width || orig?.width || 200) || 200);
  const height = Math.max(1, Number(fw?.height || orig?.height || 200) || 200);

  return {
    id,
    title: (raw.title || 'Стикер').trim(),
    previewUrl,
    stickerUrl,
    fallbackGifUrl: gifUrl || stickerUrl,
    width,
    height,
    isWebp: Boolean(webpUrl),
  };
}

async function requestGiphyEndpoint(
  url: string,
  signal?: AbortSignal
): Promise<GiphyStickersPage> {
  const res = await fetch(url, {signal});
  if (res.status === 401 || res.status === 403) {
    throw new GiphyApiError(
      'INVALID_KEY',
      'Неверный или неактивный Giphy API ключ. Проверьте ключ в настройках.'
    );
  }
  if (res.status === 429) {
    throw new GiphyApiError(
      'RATE_LIMIT',
      'Превышен лимит запросов к Giphy API. Попробуйте чуть позже или укажите свой ключ.'
    );
  }
  if (!res.ok) {
    throw new GiphyApiError(
      'NETWORK',
      `Ошибка Giphy API (${res.status}). Проверьте подключение к интернету.`
    );
  }

  const json = (await res.json()) as RawGiphyResponse;
  const items = (json.data ?? [])
    .map(mapGiphyItem)
    .filter((item): item is GiphyStickerItem => Boolean(item));

  return {
    items,
    totalCount: json.pagination?.total_count ?? items.length,
    offset: json.pagination?.offset ?? 0,
  };
}

export async function fetchTrendingStickers(opts?: {
  apiKey?: string;
  limit?: number;
  offset?: number;
  signal?: AbortSignal;
}): Promise<GiphyStickersPage> {
  const key = (opts?.apiKey ?? getEffectiveGiphyApiKey()).trim();
  if (!key) {
    throw new GiphyApiError(
      'MISSING_KEY',
      'Не задан Giphy API ключ. Укажите бесплатный ключ в настройках приложения.'
    );
  }
  const limit = opts?.limit ?? 30;
  const offset = opts?.offset ?? 0;
  const params = new URLSearchParams({
    api_key: key,
    limit: String(limit),
    offset: String(offset),
    rating: 'pg-13',
  });
  return requestGiphyEndpoint(
    `https://api.giphy.com/v1/stickers/trending?${params.toString()}`,
    opts?.signal
  );
}

export async function searchStickers(opts: {
  query: string;
  apiKey?: string;
  limit?: number;
  offset?: number;
  signal?: AbortSignal;
}): Promise<GiphyStickersPage> {
  const trimmed = opts.query.trim();
  if (!trimmed) {
    return fetchTrendingStickers({
      apiKey: opts.apiKey,
      limit: opts.limit,
      offset: opts.offset,
      signal: opts.signal,
    });
  }
  const key = (opts.apiKey ?? getEffectiveGiphyApiKey()).trim();
  if (!key) {
    throw new GiphyApiError(
      'MISSING_KEY',
      'Не задан Giphy API ключ. Укажите бесплатный ключ в настройках приложения.'
    );
  }
  const limit = opts.limit ?? 30;
  const offset = opts.offset ?? 0;
  const params = new URLSearchParams({
    api_key: key,
    q: trimmed,
    limit: String(limit),
    offset: String(offset),
    rating: 'pg-13',
  });
  return requestGiphyEndpoint(
    `https://api.giphy.com/v1/stickers/search?${params.toString()}`,
    opts.signal
  );
}

export async function downloadStickerAsFile(
  sticker: GiphyStickerItem
): Promise<File> {
  const tryDownload = async (url: string): Promise<Blob> => {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return res.blob();
  };

  let blob: Blob;
  let usedWebp = sticker.isWebp;
  try {
    blob = await tryDownload(sticker.stickerUrl);
  } catch {
    if (sticker.fallbackGifUrl && sticker.fallbackGifUrl !== sticker.stickerUrl) {
      blob = await tryDownload(sticker.fallbackGifUrl);
      usedWebp = false;
    } else {
      throw new Error('Не удалось скачать файл стикера');
    }
  }

  const normalizedType = blob.type.toLowerCase();
  const isWebp =
    normalizedType.includes('webp') || (usedWebp && !normalizedType.includes('gif'));
  const ext = isWebp ? 'webp' : 'gif';
  const mime = isWebp ? 'image/webp' : 'image/gif';

  return new File([blob], `sticker_${sticker.id}.${ext}`, {type: mime});
}
