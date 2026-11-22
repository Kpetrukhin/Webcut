export type AspectRatio = '9:16' | '16:9' | '1:1' | '4:5';

export type TrackType = 'video' | 'overlay' | 'text' | 'audio';

export type ClipKind = 'video' | 'image' | 'text' | 'audio' | 'synth';

export type BuiltinFilterPreset =
  | 'none'
  | 'cinema'
  | 'warm'
  | 'cool'
  | 'bw'
  | 'sepia'
  | 'vintage'
  | 'vivid';

export type FilterPreset = BuiltinFilterPreset | (string & {});

export interface CurvePoint {
  x: number; // normalized 0..1
  y: number; // normalized 0..1
}

export interface ColorCurves {
  rgb: CurvePoint[];
  r: CurvePoint[];
  g: CurvePoint[];
  b: CurvePoint[];
}

export interface ColorAdjustments {
  sharpness: number; // 0..100
  shadows: number; // -100..100
  hue: number; // -180..180
  temperature: number; // -100..100
  fade: number; // 0..100
  grain: number; // 0..100
  curves?: ColorCurves;
}

export interface ClipCrop {
  x: number; // normalized 0..1 from left
  y: number; // normalized 0..1 from top
  width: number; // normalized 0..1
  height: number; // normalized 0..1
  aspectPreset?: 'free' | '1:1' | '9:16' | '16:9' | '4:5';
}

export type MaskShape =
  | 'horizon'
  | 'mirror'
  | 'circle'
  | 'rectangle'
  | 'heart'
  | 'star';

export type MaskMode = 'inside' | 'outside';

export interface ClipMask {
  shape: MaskShape;
  mode: MaskMode;
  x: number; // normalized 0..1 on canvas
  y: number; // normalized 0..1 on canvas
  scale: number; // 0.08..2.5
  rotation: number; // degrees -180..180
  feather: number; // 0..100
}

export interface ColorFilterPreset {
  id: string;
  name: string;
  isBuiltin?: boolean;
  brightness: number; // 0..2 (1 = 0%)
  contrast: number; // 0..2 (1 = 0%)
  saturate: number; // 0..2 (1 = 0%)
  adjustments: ColorAdjustments;
  createdAt?: number;
}

export type TransitionType = 'none' | 'fade' | 'zoom' | 'slide';

export type MotionEffect =
  | 'none'
  | 'kenburns-in'
  | 'kenburns-out'
  | 'pan-left'
  | 'pan-right';

export type BlendMode =
  | 'source-over'
  | 'screen'
  | 'multiply'
  | 'overlay'
  | 'lighten';

export type KeyframeEasing =
  | 'linear'
  | 'ease-in'
  | 'ease-out'
  | 'ease-in-out'
  | 'bounce';

export interface ClipKeyframe {
  id: string;
  timeOffset: number; // seconds relative to clip.start
  x: number; // normalized 0..1
  y: number; // normalized 0..1
  scale: number;
  rotation: number; // degrees -180..180
  opacity: number; // 0..1
  easing: KeyframeEasing;
}

export interface ProjectFont {
  id: string;
  name: string;
  fontFamily: string;
  src: string;
}

export interface Track {
  id: string;
  type: TrackType;
  name: string;
  muted?: boolean;
  hidden?: boolean;
}

export interface TextStyle {
  fontSize: number;
  color: string;
  bgColor: string;
  fontWeight: 'normal' | 'bold';
  fontFamily?: string;
  fontSrc?: string;
  shadow?: boolean;
  outline?: boolean;
  letterSpacing?: number;
  x: number; // normalized 0..1
  y: number; // normalized 0..1
  align: 'left' | 'center' | 'right';
}

export interface Clip {
  id: string;
  track: TrackType;
  trackId: string;
  kind: ClipKind;
  name: string;
  src?: string;
  start: number;
  duration: number;
  trimStart: number;
  sourceDuration: number;
  speed: number;
  volume: number;
  opacity: number;
  filter: FilterPreset;
  brightness: number;
  contrast: number;
  saturate: number;
  colorAdjustments?: ColorAdjustments;
  crop?: ClipCrop;
  blur?: number;
  vignette?: number;
  transitionIn: TransitionType;
  transitionOut?: TransitionType;
  motionEffect: MotionEffect;
  text?: string;
  textStyle?: TextStyle;
  mediaScale?: number;
  scaleX?: number;
  scaleY?: number;
  mediaX?: number;
  mediaY?: number;
  rotation?: number; // degrees -180..180
  borderRadius?: number; // px
  borderWidth?: number;
  borderColor?: string;
  flipHorizontal?: boolean;
  flipVertical?: boolean;
  mask?: ClipMask;
  blendMode?: BlendMode;
  chromaKeyEnabled?: boolean;
  chromaKeyColor?: string;
  chromaKeyIntensity?: number;
  chromaKeySmoothness?: number;
  mediaStatus?: 'READY' | 'DOWNLOADING' | 'ERROR';
  mediaFileName?: string;
  mediaRemoteUrl?: string;
  downloadProgress?: number;
  lockedByUserId?: string | null;
  lockedByUserName?: string | null;
  lockedByUserColor?: string | null;
  keyframes?: ClipKeyframe[];
  updatedBy?: string;
}

export interface NetworkInterfaceInfo {
  name: string;
  ip: string;
  type: 'zerotier' | 'wifi' | 'lan';
  label: string;
}

export interface DiscoveredUdpRoom {
  roomId: string;
  title: string;
  hostName: string;
  ip: string;
  ips?: string[];
  port: number;
  aspectRatio: AspectRatio;
  participants: number;
  lastSeen: number;
}

export interface Collaborator {
  id: string;
  name: string;
  color: string;
  playhead: number;
  selectedClipId: string | null;
  isPlaying: boolean;
  lastActive: number;
}

export interface ChatMessage {
  id: string;
  userId: string;
  userName: string;
  userColor: string;
  text: string;
  timestamp: number;
}

export interface ProjectState {
  roomId: string;
  title: string;
  aspectRatio: AspectRatio;
  backgroundColor: string;
  hostName?: string;
  fps: number;
  isPublicLan: boolean;
  customFonts?: ProjectFont[];
  tracks: Track[];
  clips: Clip[];
  revision: number;
  updatedAt: number;
  chat: ChatMessage[];
}

export interface RoomSummary {
  roomId: string;
  title: string;
  aspectRatio: AspectRatio;
  backgroundColor: string;
  hostName?: string;
  collaboratorsCount: number;
  collaborators: Array<{name: string; color: string}>;
  clipsCount: number;
  tracksCount: number;
  updatedAt: number;
  isPublicLan: boolean;
}

export interface MediaAsset {
  id: string;
  name: string;
  kind: 'video' | 'image' | 'audio';
  src: string;
  duration: number;
  sizeBytes?: number;
}

export type ClientWsMessage =
  | {
      type: 'join';
      roomId: string;
      user: {id: string; name: string; color: string};
    }
  | {type: 'presence:profile'; name: string; color: string}
  | {type: 'lobby:get_rooms'}
  | {type: 'op:track_add'; track: Track}
  | {type: 'op:track_update'; trackId: string; patch: Partial<Track>}
  | {type: 'op:track_delete'; trackId: string}
  | {type: 'op:track_reorder'; trackIds: string[]}
  | {type: 'op:clip_add'; clip: Clip; newTrack?: Track}
  | {type: 'op:clip_update'; clipId: string; patch: Partial<Clip>}
  | {type: 'op:clip_delete'; clipId: string}
  | {type: 'op:clip_duplicate'; clipId: string; newClipId: string}
  | {
      type: 'op:clip_split';
      clipId: string;
      splitTime: number;
      newClipId: string;
    }
  | {
      type: 'op:project_meta';
      patch: Partial<
        Pick<
          ProjectState,
          | 'title'
          | 'aspectRatio'
          | 'isPublicLan'
          | 'backgroundColor'
          | 'hostName'
          | 'customFonts'
        >
      >;
    }
  | {
      type: 'op:project_replace';
      clips: Clip[];
      tracks?: Track[];
      aspectRatio?: AspectRatio;
      title?: string;
      backgroundColor?: string;
      customFonts?: ProjectFont[];
    }
  | {
      type: 'presence:cursor';
      playhead: number;
      selectedClipId: string | null;
      isPlaying: boolean;
    }
  | {type: 'chat:send'; text: string; messageId: string}
  | {
      type: 'LAYER_MEDIA_UPDATED';
      layerId: string;
      fileName: string;
      mediaUrl: string;
      senderId: string;
      clip?: Clip;
      newTrack?: Track;
    }
  | {
      type: 'LAYER_LOCK';
      layerId: string;
      userId: string;
      userName: string;
      userColor: string;
      locked: boolean;
    };

export type ServerWsMessage =
  | {
      type: 'room:init';
      project: ProjectState;
      collaborators: Collaborator[];
      rooms: RoomSummary[];
    }
  | {type: 'lobby:rooms_update'; rooms: RoomSummary[]}
  | {type: 'op:track_add'; track: Track; revision: number; senderId: string}
  | {
      type: 'op:track_update';
      trackId: string;
      patch: Partial<Track>;
      revision: number;
      senderId: string;
    }
  | {type: 'op:track_delete'; trackId: string; revision: number; senderId: string}
  | {
      type: 'op:track_reorder';
      trackIds: string[];
      revision: number;
      senderId: string;
    }
  | {
      type: 'op:clip_add';
      clip: Clip;
      newTrack?: Track;
      revision: number;
      senderId: string;
    }
  | {
      type: 'op:clip_update';
      clipId: string;
      patch: Partial<Clip>;
      revision: number;
      senderId: string;
    }
  | {type: 'op:clip_delete'; clipId: string; revision: number; senderId: string}
  | {
      type: 'op:clip_duplicate';
      clipId: string;
      newClipId: string;
      revision: number;
      senderId: string;
    }
  | {
      type: 'op:clip_split';
      clipId: string;
      splitTime: number;
      newClipId: string;
      revision: number;
      senderId: string;
    }
  | {
      type: 'op:project_meta';
      patch: Partial<
        Pick<
          ProjectState,
          | 'title'
          | 'aspectRatio'
          | 'isPublicLan'
          | 'backgroundColor'
          | 'hostName'
          | 'customFonts'
        >
      >;
      revision: number;
      senderId: string;
    }
  | {
      type: 'op:project_replace';
      clips: Clip[];
      tracks: Track[];
      aspectRatio: AspectRatio;
      title: string;
      backgroundColor?: string;
      customFonts?: ProjectFont[];
      revision: number;
      senderId: string;
    }
  | {type: 'presence:update'; collaborators: Collaborator[]}
  | {type: 'chat:message'; message: ChatMessage}
  | {
      type: 'LAYER_MEDIA_UPDATED';
      layerId: string;
      fileName: string;
      mediaUrl: string;
      senderId: string;
      clip?: Clip;
      newTrack?: Track;
      revision?: number;
    }
  | {
      type: 'LAYER_LOCK';
      layerId: string;
      userId: string;
      userName: string;
      userColor: string;
      locked: boolean;
    }
  | {type: 'error'; message: string};

export const SAMPLE_MEDIA_ASSETS: MediaAsset[] = [
  {
    id: 'sample-urban',
    name: 'Ночной город (дождь)',
    kind: 'image',
    src: '/src/assets/images/clip_urban_night_1795264604482.jpg',
    duration: 4.5,
  },
  {
    id: 'sample-alpine',
    name: 'Рассвет в горах',
    kind: 'image',
    src: '/src/assets/images/clip_alpine_dawn_1795264604499.jpg',
    duration: 4.5,
  },
  {
    id: 'sample-studio',
    name: 'Съёмка в студии',
    kind: 'image',
    src: '/src/assets/images/clip_studio_portrait_1795264604488.jpg',
    duration: 4.5,
  },
];

export const SYNTH_AUDIO_PRESETS: Array<{
  id: string;
  name: string;
  src: string;
  duration: number;
  bpm: number;
}> = [
  {
    id: 'synth-lofi',
    name: 'Lo-Fi Ночной бит',
    src: 'synth:lofi',
    duration: 14,
    bpm: 86,
  },
  {
    id: 'synth-pulse',
    name: 'Динамичный Vlog Pulse',
    src: 'synth:pulse',
    duration: 14,
    bpm: 118,
  },
  {
    id: 'synth-cinema',
    name: 'Кинематографичный эмбиент',
    src: 'synth:cinema',
    duration: 14,
    bpm: 72,
  },
];

export function createDefaultTracks(): Track[] {
  return [
    {id: 'track-video-1', type: 'video', name: 'Видео 1'},
    {id: 'track-overlay-1', type: 'overlay', name: 'Слой 1'},
    {id: 'track-text-1', type: 'text', name: 'Текст 1'},
    {id: 'track-audio-1', type: 'audio', name: 'Аудио 1'},
  ];
}

export function getTrackLabelPrefix(type: TrackType): string {
  switch (type) {
    case 'video':
      return 'Видео';
    case 'overlay':
      return 'Слой';
    case 'text':
      return 'Текст';
    case 'audio':
      return 'Аудио';
  }
}

export function createTrackOfType(
  existingTracks: Track[],
  type: TrackType
): Track {
  const count = existingTracks.filter((t) => t.type === type).length + 1;
  return {
    id: `track-${type}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    name: `${getTrackLabelPrefix(type)} ${count}`,
  };
}

/**
 * Finds a track of the requested type where `[start, start + duration]` does not
 * collide with existing clips. If all existing tracks overlap (or forceNew is true),
 * creates a brand-new track so clips never stack on top of each other on one row.
 */
export function resolveTrackPlacement(
  tracks: Track[],
  clips: Clip[],
  type: TrackType,
  start: number,
  duration: number,
  forceNew = false
): {trackId: string; newTrack?: Track} {
  const matching = tracks.filter((t) => t.type === type);
  if (!forceNew) {
    const end = start + duration;
    for (const track of matching) {
      const overlaps = clips.some((c) => {
        if (c.trackId !== track.id) return false;
        const cEnd = c.start + c.duration;
        return start < cEnd - 0.05 && end > c.start + 0.05;
      });
      if (!overlaps) {
        return {trackId: track.id};
      }
    }
  }
  const newTrack = createTrackOfType(tracks, type);
  return {trackId: newTrack.id, newTrack};
}

export function normalizeProjectTracks(project: ProjectState): ProjectState {
  let tracks =
    Array.isArray(project.tracks) && project.tracks.length > 0
      ? project.tracks.map((t) => ({
          ...t,
          name: t.name.startsWith('Наложение ')
            ? t.name.replace('Наложение ', 'Слой ')
            : t.name,
        }))
      : createDefaultTracks();

  const ensureTrackForType = (type: TrackType): string => {
    const existing = tracks.find((t) => t.type === type);
    if (existing) return existing.id;
    const created = createTrackOfType(tracks, type);
    tracks = [...tracks, created];
    return created.id;
  };

  const clips = (project.clips || []).map((clip) => {
    if (clip.trackId && tracks.some((t) => t.id === clip.trackId)) {
      return clip;
    }
    return {
      ...clip,
      trackId: ensureTrackForType(clip.track),
    };
  });

  return {
    ...project,
    backgroundColor: project.backgroundColor || '#09090b',
    customFonts: Array.isArray(project.customFonts) ? project.customFonts : [],
    isPublicLan: project.isPublicLan ?? true,
    tracks,
    clips,
  };
}

export function createStarterClips(): Clip[] {
  return [
    {
      id: 'clip-v1',
      track: 'video',
      trackId: 'track-video-1',
      kind: 'image',
      name: 'Ночной город',
      src: '/src/assets/images/clip_urban_night_1795264604482.jpg',
      start: 0,
      duration: 4.5,
      trimStart: 0,
      sourceDuration: 60,
      speed: 1,
      volume: 1,
      opacity: 1,
      filter: 'cinema',
      brightness: 1,
      contrast: 1.08,
      saturate: 1.1,
      transitionIn: 'fade',
      motionEffect: 'kenburns-in',
    },
    {
      id: 'clip-v2',
      track: 'video',
      trackId: 'track-video-1',
      kind: 'image',
      name: 'Рассвет в горах',
      src: '/src/assets/images/clip_alpine_dawn_1795264604499.jpg',
      start: 4.5,
      duration: 4.5,
      trimStart: 0,
      sourceDuration: 60,
      speed: 1,
      volume: 1,
      opacity: 1,
      filter: 'warm',
      brightness: 1.03,
      contrast: 1.05,
      saturate: 1.15,
      transitionIn: 'slide',
      motionEffect: 'pan-right',
    },
    {
      id: 'clip-v3',
      track: 'video',
      trackId: 'track-video-1',
      kind: 'image',
      name: 'Съёмка в студии',
      src: '/src/assets/images/clip_studio_portrait_1795264604488.jpg',
      start: 9,
      duration: 4.5,
      trimStart: 0,
      sourceDuration: 60,
      speed: 1,
      volume: 1,
      opacity: 1,
      filter: 'vivid',
      brightness: 1,
      contrast: 1.06,
      saturate: 1.1,
      transitionIn: 'zoom',
      motionEffect: 'kenburns-out',
    },
    {
      id: 'clip-o1',
      track: 'overlay',
      trackId: 'track-overlay-1',
      kind: 'image',
      name: 'Кадр поверх (PIP)',
      src: '/src/assets/images/clip_studio_portrait_1795264604488.jpg',
      start: 1.2,
      duration: 3.0,
      trimStart: 0,
      sourceDuration: 60,
      speed: 1,
      volume: 0,
      opacity: 1,
      filter: 'none',
      brightness: 1,
      contrast: 1.05,
      saturate: 1.1,
      transitionIn: 'none',
      motionEffect: 'none',
      mediaScale: 0.36,
      mediaX: 0.74,
      mediaY: 0.24,
      rotation: -3,
      borderRadius: 24,
      blendMode: 'source-over',
    },
    {
      id: 'clip-t1',
      track: 'text',
      trackId: 'track-text-1',
      kind: 'text',
      name: 'Заголовок',
      start: 0.4,
      duration: 3.8,
      trimStart: 0,
      sourceDuration: 60,
      speed: 1,
      volume: 1,
      opacity: 1,
      filter: 'none',
      brightness: 1,
      contrast: 1,
      saturate: 1,
      transitionIn: 'fade',
      motionEffect: 'none',
      text: 'НОЧНОЙ ЭТЮД',
      textStyle: {
        fontSize: 54,
        color: '#ffffff',
        bgColor: 'rgba(9, 9, 11, 0.72)',
        fontWeight: 'bold',
        fontFamily: 'Plus Jakarta Sans',
        shadow: true,
        x: 0.5,
        y: 0.76,
        align: 'center',
      },
    },
    {
      id: 'clip-t2',
      track: 'text',
      trackId: 'track-text-1',
      kind: 'text',
      name: 'Титр 2',
      start: 4.8,
      duration: 4.0,
      trimStart: 0,
      sourceDuration: 60,
      speed: 1,
      volume: 1,
      opacity: 1,
      filter: 'none',
      brightness: 1,
      contrast: 1,
      saturate: 1,
      transitionIn: 'fade',
      motionEffect: 'none',
      text: 'Снято и смонтировано вместе',
      textStyle: {
        fontSize: 38,
        color: '#22d3ee',
        bgColor: 'rgba(9, 9, 11, 0.78)',
        fontWeight: 'bold',
        fontFamily: 'Plus Jakarta Sans',
        shadow: true,
        x: 0.5,
        y: 0.2,
        align: 'center',
      },
    },
    {
      id: 'clip-a1',
      track: 'audio',
      trackId: 'track-audio-1',
      kind: 'synth',
      name: 'Lo-Fi Ночной бит',
      src: 'synth:lofi',
      start: 0,
      duration: 13.5,
      trimStart: 0,
      sourceDuration: 60,
      speed: 1,
      volume: 0.75,
      opacity: 1,
      filter: 'none',
      brightness: 1,
      contrast: 1,
      saturate: 1,
      transitionIn: 'none',
      motionEffect: 'none',
    },
  ];
}

export function getProjectDuration(clips: Clip[]): number {
  let maxEnd = 5;
  for (const c of clips) {
    const end = c.start + c.duration;
    if (end > maxEnd) maxEnd = end;
  }
  return Math.round(maxEnd * 100) / 100;
}

export function applyClipSplit(
  clips: Clip[],
  clipId: string,
  splitTime: number,
  newClipId: string
): Clip[] {
  const idx = clips.findIndex((c) => c.id === clipId);
  if (idx === -1) return clips;
  if (clips.some((c) => c.id === newClipId)) return clips;

  const target = clips[idx];
  const relOffset = splitTime - target.start;
  if (relOffset <= 0.15 || relOffset >= target.duration - 0.15) {
    return clips;
  }

  const cloneColorAdjustments = (
    adj?: ColorAdjustments
  ): ColorAdjustments | undefined => {
    if (!adj) return undefined;
    return {
      ...adj,
      curves: adj.curves
        ? {
            rgb: adj.curves.rgb.map((p) => ({...p})),
            r: adj.curves.r.map((p) => ({...p})),
            g: adj.curves.g.map((p) => ({...p})),
            b: adj.curves.b.map((p) => ({...p})),
          }
        : undefined,
    };
  };

  const firstHalf: Clip = {
    ...target,
    colorAdjustments: cloneColorAdjustments(target.colorAdjustments),
    crop: target.crop ? {...target.crop} : undefined,
    mask: target.mask ? {...target.mask} : undefined,
    duration: Math.round(relOffset * 100) / 100,
    keyframes: target.keyframes
      ?.filter((k) => k.timeOffset <= relOffset)
      .map((k) => ({...k})),
  };

  const secondHalf: Clip = {
    ...target,
    id: newClipId,
    name: `${target.name} (2)`,
    colorAdjustments: cloneColorAdjustments(target.colorAdjustments),
    crop: target.crop ? {...target.crop} : undefined,
    mask: target.mask ? {...target.mask} : undefined,
    start: Math.round(splitTime * 100) / 100,
    duration: Math.round((target.duration - relOffset) * 100) / 100,
    trimStart:
      Math.round((target.trimStart + relOffset * target.speed) * 100) / 100,
    transitionIn: 'none',
    keyframes: target.keyframes
      ?.filter((k) => k.timeOffset >= relOffset)
      .map((k) => ({
        ...k,
        id: `kf-${Math.random().toString(36).slice(2, 8)}`,
        timeOffset: Math.round((k.timeOffset - relOffset) * 100) / 100,
      })),
  };

  const next = [...clips];
  next.splice(idx, 1, firstHalf, secondHalf);
  return next;
}

export function applyTrackReorder(
  tracks: Track[],
  trackIds: string[]
): Track[] {
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const reordered: Track[] = [];
  for (const id of trackIds) {
    const t = byId.get(id);
    if (t && !seen.has(id)) {
      reordered.push(t);
      seen.add(id);
    }
  }
  for (const t of tracks) {
    if (!seen.has(t.id)) {
      reordered.push(t);
    }
  }
  return reordered;
}

export function applyClipDuplicate(
  clips: Clip[],
  clipId: string,
  newClipId: string
): Clip[] {
  const idx = clips.findIndex((c) => c.id === clipId);
  if (idx === -1) return clips;
  if (clips.some((c) => c.id === newClipId)) return clips;

  const target = clips[idx];
  const copyStart = Math.round((target.start + target.duration) * 100) / 100;

  const clonedKeyframes = target.keyframes?.map((kf) => ({
    ...kf,
    id: `kf-${Math.random().toString(36).slice(2, 8)}`,
  }));

  const copy: Clip = {
    ...target,
    textStyle: target.textStyle ? {...target.textStyle} : undefined,
    colorAdjustments: target.colorAdjustments
      ? {
          ...target.colorAdjustments,
          curves: target.colorAdjustments.curves
            ? {
                rgb: target.colorAdjustments.curves.rgb.map((p) => ({...p})),
                r: target.colorAdjustments.curves.r.map((p) => ({...p})),
                g: target.colorAdjustments.curves.g.map((p) => ({...p})),
                b: target.colorAdjustments.curves.b.map((p) => ({...p})),
              }
            : undefined,
        }
      : undefined,
    crop: target.crop ? {...target.crop} : undefined,
    mask: target.mask ? {...target.mask} : undefined,
    keyframes: clonedKeyframes,
    id: newClipId,
    name: `${target.name} (копия)`,
    start: copyStart,
    lockedByUserId: null,
    lockedByUserName: null,
    lockedByUserColor: null,
  };

  const shifted = clips.map((c) => {
    if (
      c.id !== target.id &&
      c.trackId === target.trackId &&
      c.start >= copyStart - 0.05
    ) {
      return {
        ...c,
        start: Math.round((c.start + target.duration) * 100) / 100,
      };
    }
    return c;
  });

  const next = [...shifted];
  next.splice(idx + 1, 0, copy);
  return next;
}
