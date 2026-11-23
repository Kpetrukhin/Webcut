import type {
  AspectRatio,
  CanvasBackground,
  Clip,
  MotionTrackerBeacon,
  ProjectFont,
  ProjectState,
  Track,
} from '../shared/types.ts';
import {
  createDefaultTracks,
  normalizeProjectTracks,
} from '../shared/types.ts';
import {extractMediaFileName, resolveMediaSrc} from './serverConfig.ts';

export interface LocalProjectRecord {
  roomId: string;
  title: string;
  aspectRatio: AspectRatio;
  backgroundColor: string;
  canvasBackground?: CanvasBackground;
  updatedAt: number;
  clipsCount: number;
  tracksCount: number;
  snapshot?: {
    tracks: Track[];
    clips: Clip[];
    customFonts?: ProjectFont[];
    trackers?: MotionTrackerBeacon[];
  };
}

const STORAGE_KEY = 'cutsync_local_projects';

export function isBuiltinOrInlineMediaRef(raw?: string): boolean {
  if (!raw) return true;
  const trimmed = raw.trim();
  return (
    !trimmed ||
    trimmed.startsWith('synth:') ||
    trimmed.startsWith('data:') ||
    trimmed.startsWith('/src/') ||
    trimmed.startsWith('/assets/')
  );
}

export function isPortableLocalMediaRef(raw?: string): boolean {
  if (!raw) return false;
  const trimmed = raw.trim().replace(/\\/g, '/');
  if (isBuiltinOrInlineMediaRef(trimmed)) return false;
  return (
    trimmed.startsWith('media/') ||
    trimmed.startsWith('/media/') ||
    trimmed.startsWith('/uploads/') ||
    trimmed.includes('/media/') ||
    trimmed.includes('/uploads/')
  );
}

export function toRelativeMediaPath(
  raw?: string,
  explicitFileName?: string
): string | undefined {
  if (raw && isBuiltinOrInlineMediaRef(raw)) {
    return raw;
  }
  if (explicitFileName && explicitFileName.trim()) {
    const base = extractMediaFileName(undefined, explicitFileName);
    if (base) return `media/${base}`;
  }
  if (raw && isPortableLocalMediaRef(raw)) {
    const base = extractMediaFileName(raw);
    if (base) return `media/${base}`;
  }
  return raw;
}

export function dehydrateProjectForStorage(project: ProjectState): ProjectState {
  const cloned = structuredClone(normalizeProjectTracks(project));
  const fontByFamily = new Map<string, string>();

  const dehydratedFonts: ProjectFont[] = (cloned.customFonts || []).map((f) => {
    const rel = toRelativeMediaPath(f.src, f.fileName);
    const baseName = rel?.startsWith('media/')
      ? rel.slice('media/'.length)
      : f.fileName;
    const finalSrc = rel || f.src;
    if (f.fontFamily && finalSrc && !isBuiltinOrInlineMediaRef(finalSrc)) {
      fontByFamily.set(f.fontFamily, finalSrc);
    }
    return {
      ...f,
      src: finalSrc,
      fileName: rel?.startsWith('media/') ? rel : baseName,
    };
  });

  const dehydratedClips: Clip[] = cloned.clips.map((clip) => {
    const next: Clip = {...clip};
    delete next.lockedByUserId;
    delete next.lockedByUserName;
    delete next.lockedByUserColor;
    delete next.mediaError;
    delete next.downloadProgress;
    delete next.mediaStatus;

    if (!isBuiltinOrInlineMediaRef(next.src) || next.mediaFileName) {
      const relSrc = toRelativeMediaPath(next.src, next.mediaFileName);
      if (relSrc) {
        next.src = relSrc;
      }
      if (next.mediaFileName) {
        const relName = toRelativeMediaPath(undefined, next.mediaFileName);
        if (relName) next.mediaFileName = relName;
      } else if (relSrc?.startsWith('media/')) {
        next.mediaFileName = relSrc;
      }
    }

    if (next.mediaRemoteUrl && (isPortableLocalMediaRef(next.mediaRemoteUrl) || next.mediaRemoteUrl.startsWith('blob:'))) {
      const relRemote = toRelativeMediaPath(next.mediaRemoteUrl, next.mediaFileName);
      if (relRemote) next.mediaRemoteUrl = relRemote;
    }

    if (next.textStyle) {
      const fontFamily = next.textStyle.fontFamily;
      const mappedFontRel = fontFamily ? fontByFamily.get(fontFamily) : undefined;
      const relFontSrc = toRelativeMediaPath(next.textStyle.fontSrc, mappedFontRel);
      if (relFontSrc) {
        next.textStyle = {
          ...next.textStyle,
          fontSrc: relFontSrc,
        };
      } else if (mappedFontRel) {
        next.textStyle = {
          ...next.textStyle,
          fontSrc: mappedFontRel,
        };
      }
    }

    return next;
  });

  return {
    ...cloned,
    customFonts: dehydratedFonts,
    clips: dehydratedClips,
  };
}

export async function hydrateProjectFromStorage(
  project: ProjectState,
  resolveRelativeUrl?: (
    relPath: string,
    expectedSize?: number
  ) => Promise<string | undefined>
): Promise<ProjectState> {
  const normalized = normalizeProjectTracks(structuredClone(project));
  const resolvedCache = new Map<string, string>();

  const resolveRef = async (
    raw?: string,
    explicitFileName?: string,
    expectedSize?: number
  ): Promise<string | undefined> => {
    if (raw && isBuiltinOrInlineMediaRef(raw)) return raw;
    if (raw && (raw.startsWith('blob:') || raw.startsWith('http://') || raw.startsWith('https://'))) {
      if (!isPortableLocalMediaRef(raw)) {
        return raw;
      }
    }
    const rel = toRelativeMediaPath(raw, explicitFileName);
    if (!rel || !rel.startsWith('media/')) return raw;

    const cached = resolvedCache.get(rel);
    if (cached) return cached;

    if (resolveRelativeUrl) {
      try {
        const resolved = await resolveRelativeUrl(rel, expectedSize);
        if (resolved) {
          resolvedCache.set(rel, resolved);
          return resolved;
        }
      } catch {
        // fall through to standard server URL resolution
      }
    }
    const fallback = resolveMediaSrc(rel) || rel;
    resolvedCache.set(rel, fallback);
    return fallback;
  };

  const hydratedFonts: ProjectFont[] = await Promise.all(
    (normalized.customFonts || []).map(async (f) => {
      const resolvedSrc = await resolveRef(f.src, f.fileName, f.fileSize);
      return {
        ...f,
        src: resolvedSrc || f.src,
        fileName: f.fileName ? toRelativeMediaPath(undefined, f.fileName) : undefined,
      };
    })
  );

  const fontSrcByFamily = new Map<string, string>();
  for (const f of hydratedFonts) {
    if (f.fontFamily && f.src) fontSrcByFamily.set(f.fontFamily, f.src);
  }

  const hydratedClips: Clip[] = await Promise.all(
    normalized.clips.map(async (clip) => {
      const next: Clip = {...clip};
      if (
        next.kind !== 'text' &&
        next.kind !== 'shape' &&
        next.kind !== 'adjustment' &&
        next.kind !== 'synth'
      ) {
        const resolvedSrc = await resolveRef(
          next.src,
          next.mediaFileName,
          next.mediaFileSize
        );
        if (resolvedSrc) {
          next.src = resolvedSrc;
          next.mediaStatus = 'READY';
          next.downloadProgress = 100;
        }
        if (next.mediaRemoteUrl) {
          const resolvedRemote = await resolveRef(
            next.mediaRemoteUrl,
            next.mediaFileName,
            next.mediaFileSize
          );
          if (resolvedRemote) next.mediaRemoteUrl = resolvedRemote;
        }
      }
      if (next.textStyle) {
        const resolvedFontSrc = next.textStyle.fontSrc
          ? await resolveRef(next.textStyle.fontSrc)
          : next.textStyle.fontFamily
            ? fontSrcByFamily.get(next.textStyle.fontFamily)
            : undefined;
        if (resolvedFontSrc) {
          next.textStyle = {
            ...next.textStyle,
            fontSrc: resolvedFontSrc,
          };
        }
      }
      return next;
    })
  );

  return {
    ...normalized,
    customFonts: hydratedFonts,
    clips: hydratedClips,
  };
}

export function projectStateToLocalRecord(
  project: ProjectState
): LocalProjectRecord {
  const safe = dehydrateProjectForStorage(project);
  return {
    roomId: safe.roomId,
    title: safe.title || `Проект ${safe.roomId}`,
    aspectRatio: safe.aspectRatio || '9:16',
    backgroundColor: safe.backgroundColor || '#09090b',
    canvasBackground: safe.canvasBackground,
    updatedAt: safe.updatedAt || Date.now(),
    clipsCount: safe.clips.length,
    tracksCount: safe.tracks.length,
    snapshot: {
      tracks: safe.tracks,
      clips: safe.clips,
      customFonts: safe.customFonts,
      trackers: safe.trackers,
    },
  };
}

export function recordToProjectState(record: LocalProjectRecord): ProjectState {
  return normalizeProjectTracks({
    roomId: record.roomId,
    title: record.title,
    aspectRatio: record.aspectRatio,
    backgroundColor: record.backgroundColor || '#09090b',
    canvasBackground: record.canvasBackground,
    fps: 30,
    isPublicLan: true,
    customFonts: record.snapshot?.customFonts || [],
    trackers: record.snapshot?.trackers || [],
    tracks: record.snapshot?.tracks || createDefaultTracks(),
    clips: record.snapshot?.clips || [],
    revision: 0,
    updatedAt: record.updatedAt || Date.now(),
    chat: [],
  });
}

export function saveLocalProjectsList(records: LocalProjectRecord[]): LocalProjectRecord[] {
  const sorted = [...records]
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 50);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sorted));
  } catch {
    // ignore storage quota errors
  }
  return sorted;
}

export function mergeProjectRecords(
  diskProjects: ProjectState[],
  existingRecords: LocalProjectRecord[]
): LocalProjectRecord[] {
  const byId = new Map<string, LocalProjectRecord>();
  for (const r of existingRecords) {
    if (r && typeof r.roomId === 'string') {
      byId.set(r.roomId, r);
    }
  }
  for (const p of diskProjects) {
    if (!p || typeof p.roomId !== 'string') continue;
    const rec = projectStateToLocalRecord(p);
    const prev = byId.get(rec.roomId);
    if (!prev || rec.updatedAt >= (prev.updatedAt || 0)) {
      byId.set(rec.roomId, rec);
    }
  }
  return saveLocalProjectsList(Array.from(byId.values()));
}

export function getLocalProjects(): LocalProjectRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as LocalProjectRecord[];
    if (!Array.isArray(parsed)) return [];
    return parsed.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export function upsertLocalProject(record: LocalProjectRecord): LocalProjectRecord[] {
  const current = getLocalProjects();
  const idx = current.findIndex((p) => p.roomId === record.roomId);
  const next = [...current];
  if (idx !== -1) {
    next[idx] = {...next[idx], ...record};
  } else {
    next.unshift(record);
  }
  return saveLocalProjectsList(next);
}

export function removeLocalProject(roomId: string): LocalProjectRecord[] {
  const next = getLocalProjects().filter((p) => p.roomId !== roomId);
  return saveLocalProjectsList(next);
}
