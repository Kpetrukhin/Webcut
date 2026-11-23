import type {
  AspectRatio,
  CanvasBackground,
  Clip,
  MotionTrackerBeacon,
  ProjectFont,
  Track,
} from '../shared/types.ts';

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
  const trimmed = next.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 25);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // ignore storage quota errors
  }
  return trimmed;
}

export function removeLocalProject(roomId: string): LocalProjectRecord[] {
  const next = getLocalProjects().filter((p) => p.roomId !== roomId);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
  return next;
}
