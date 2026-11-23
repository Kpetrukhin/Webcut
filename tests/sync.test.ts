import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {WebSocket} from 'ws';

import {
  applyClipDuplicate,
  applyClipPatch,
  applyClipSplit,
  applyTrackReorder,
  createDefaultTracks,
  createStarterClips,
  encodePatchForSync,
  normalizeProjectTracks,
} from '../src/shared/types.ts';
import type {
  Clip,
  MotionTrackerBeacon,
  ProjectState,
  ServerWsMessage,
} from '../src/shared/types.ts';
import {
  evaluateClipTransform,
  upsertKeyframeAtTime,
} from '../src/lib/keyframeEngine.ts';
import {
  buildClipKeyframesFromTracker,
  buildTrackerBeaconFromVitTrack,
  evaluateShapePoints,
  evaluateTrackerAtTime,
  mapCanvasBboxToVideoSource,
} from '../src/lib/trackerEngine.ts';
import {createDefaultWarp} from '../src/lib/warpEngine.ts';
import {sha256Hex, sha256SyncHex} from '../src/lib/sha256.ts';
import {downloadMediaInBackground} from '../src/lib/lanSyncBridge.ts';
import {
  extractMediaFileName,
  resolveMediaCandidateUrls,
} from '../src/lib/serverConfig.ts';

test('JSON Sync: полная сериализация всех слоёв, масок, кривых, шрифтов, аудиоэффектов и ключевых кадров', () => {
  const fullProject: ProjectState = {
    roomId: 'audit-room-1',
    title: 'Полный аудит синхронизации',
    aspectRatio: '16:9',
    backgroundColor: '#121826',
    hostName: 'Pixel-8',
    fps: 60,
    isPublicLan: true,
    customFonts: [
      {
        id: 'font-1',
        name: 'CustomDisplay.ttf',
        fontFamily: 'CutSyncFont_font1',
        src: 'http://10.147.17.5:8080/media/1700000-CustomDisplay.ttf',
        fileName: '1700000-CustomDisplay.ttf',
        fileSize: 48200,
        fileHash: 'a'.repeat(64),
      },
    ],
    tracks: [
      {id: 'track-overlay-1', type: 'overlay', name: 'Слой передний'},
      {id: 'track-video-1', type: 'video', name: 'Основное видео'},
      {id: 'track-text-1', type: 'text', name: 'Титры 4K'},
      {id: 'track-audio-1', type: 'audio', name: 'Голос + Бит'},
    ],
    clips: [
      {
        id: 'clip-video-full',
        track: 'overlay',
        trackId: 'track-overlay-1',
        kind: 'video',
        name: 'Основной клип.mp4',
        src: 'http://192.168.1.50:8080/media/clip.mp4',
        start: 1.5,
        duration: 8.0,
        trimStart: 0.4,
        sourceDuration: 20,
        speed: 1.25,
        pitch: 0.92,
        linkSpeedPitch: false,
        voiceEffect: 'hall',
        volume: 0.85,
        opacity: 0.9,
        filter: 'cinema',
        brightness: 1.12,
        contrast: 1.18,
        saturate: 1.24,
        colorAdjustments: {
          sharpness: 35,
          shadows: -20,
          hue: 15,
          temperature: -18,
          fade: 12,
          grain: 25,
          curves: {
            rgb: [
              {x: 0, y: 0.05},
              {x: 0.5, y: 0.62},
              {x: 1, y: 0.95},
            ],
            r: [
              {x: 0, y: 0},
              {x: 1, y: 1},
            ],
            g: [
              {x: 0, y: 0},
              {x: 1, y: 1},
            ],
            b: [
              {x: 0, y: 0.1},
              {x: 1, y: 0.9},
            ],
          },
        },
        crop: {
          x: 0.1,
          y: 0.05,
          width: 0.8,
          height: 0.9,
          aspectPreset: '9:16',
        },
        blur: 4,
        vignette: 32,
        transitionIn: 'fade',
        transitionOut: 'zoom',
        motionEffect: 'kenburns-in',
        mediaScale: 0.72,
        scaleX: 1.15,
        scaleY: 0.88,
        mediaX: 0.42,
        mediaY: 0.58,
        rotation: -14,
        borderRadius: 18,
        borderWidth: 3,
        borderColor: '#22d3ee',
        flipHorizontal: true,
        flipVertical: false,
        mask: {
          shape: 'heart',
          mode: 'outside',
          x: 0.52,
          y: 0.48,
          scale: 0.65,
          rotation: 12,
          feather: 24,
        },
        blendMode: 'screen',
        chromaKeyEnabled: true,
        chromaKeyColor: '#00ff44',
        chromaKeyIntensity: 48,
        chromaKeySmoothness: 18,
        mediaStatus: 'READY',
        mediaFileName: 'clip.mp4',
        mediaRemoteUrl: 'http://192.168.1.50:8080/media/clip.mp4',
        mediaFileSize: 1048576,
        mediaFileHash: 'b'.repeat(64),
        keyframes: [
          {
            id: 'kf-1',
            timeOffset: 0.2,
            x: 0.3,
            y: 0.5,
            scale: 0.8,
            rotation: -10,
            opacity: 0.7,
            easing: 'ease-in-out',
          },
          {
            id: 'kf-2',
            timeOffset: 5.0,
            x: 0.7,
            y: 0.4,
            scale: 1.2,
            rotation: 15,
            opacity: 1,
            easing: 'bounce',
          },
        ],
      },
      {
        id: 'clip-text-full',
        track: 'text',
        trackId: 'track-text-1',
        kind: 'text',
        name: 'Волнистый текст',
        start: 0,
        duration: 4,
        trimStart: 0,
        sourceDuration: 60,
        speed: 1,
        volume: 1,
        opacity: 1,
        filter: 'none',
        brightness: 1,
        contrast: 1,
        saturate: 1,
        transitionIn: 'none',
        motionEffect: 'none',
        text: 'ПРИВЕТ\nМИР',
        textStyle: {
          fontSize: 48,
          color: '#ffffff',
          bgColor: '#09090b',
          bgMode: 'chars',
          bgOpacity: 0.8,
          fontWeight: 'bold',
          fontStyle: 'italic',
          underline: true,
          fontFamily: 'CutSyncFont_font1',
          fontSrc: 'http://10.147.17.5:8080/media/1700000-CustomDisplay.ttf',
          shadow: true,
          shadowColor: '#000000',
          shadowOffsetX: 2,
          shadowOffsetY: 3,
          shadowBlur: 6,
          outline: true,
          strokeColor: '#22d3ee',
          strokeWidth: 4,
          letterSpacing: 2,
          lineHeight: 1.3,
          spaceWidth: 1.1,
          curveMode: 'custom',
          curveAmplitude: 28,
          curveFrequency: 2,
          curveSmoothness: 85,
          curvePoints: [
            {id: 'pt-1', x: -120, y: 12},
            {id: 'pt-2', x: 0, y: -24},
            {id: 'pt-3', x: 120, y: 12},
          ],
          animIn: 'typewriter',
          animInDuration: 0.8,
          animOut: 'blur-spin',
          animOutDuration: 0.5,
          x: 0.5,
          y: 0.35,
          align: 'center',
        },
      },
    ],
    revision: 42,
    updatedAt: 1700000000000,
    chat: [],
    canvasBackground: {
      type: 'solid',
      color: '#121826',
    },
    trackers: [
      {
        id: 'trk-audit-1',
        name: 'Маяк 1',
        color: '#22d3ee',
        sourceClipId: 'clip-video-full',
        createdAt: 1700000000000,
        points: [{time: 1.5, x: 0.42, y: 0.58, scale: 1, w: 0.2, h: 0.2, score: 0.94}],
      },
    ],
  };

  const roundTripped = normalizeProjectTracks(
    JSON.parse(JSON.stringify(fullProject)) as ProjectState
  );
  assert.deepEqual(roundTripped, fullProject);
});

test('Patch Encoding, Null Deletion, Split/Duplicate Deep-Clone & Track Reorder', () => {
  const baseTracks = createDefaultTracks();
  const reordered = applyTrackReorder(baseTracks, [
    'track-text-1',
    'track-overlay-1',
    'track-video-1',
  ]);
  assert.deepEqual(
    reordered.map((t) => t.id),
    ['track-text-1', 'track-overlay-1', 'track-video-1', 'track-audio-1']
  );

  const originalClip: Clip = {
    id: 'c1',
    track: 'video',
    trackId: 'track-video-1',
    kind: 'video',
    name: 'Clip',
    start: 0,
    duration: 6,
    trimStart: 0,
    sourceDuration: 10,
    speed: 1,
    volume: 1,
    opacity: 1,
    filter: 'none',
    brightness: 1,
    contrast: 1,
    saturate: 1,
    transitionIn: 'none',
    motionEffect: 'none',
    mask: {
      shape: 'circle',
      mode: 'inside',
      x: 0.5,
      y: 0.5,
      scale: 0.5,
      rotation: 0,
      feather: 10,
    },
    crop: {x: 0.1, y: 0.1, width: 0.8, height: 0.8},
    colorAdjustments: {
      sharpness: 10,
      shadows: 0,
      hue: 0,
      temperature: 0,
      fade: 0,
      grain: 0,
      curves: {
        rgb: [
          {x: 0, y: 0},
          {x: 1, y: 1},
        ],
        r: [
          {x: 0, y: 0},
          {x: 1, y: 1},
        ],
        g: [
          {x: 0, y: 0},
          {x: 1, y: 1},
        ],
        b: [
          {x: 0, y: 0},
          {x: 1, y: 1},
        ],
      },
    },
    textStyle: {
      fontSize: 40,
      color: '#fff',
      bgColor: 'transparent',
      fontWeight: 'bold',
      x: 0.5,
      y: 0.5,
      align: 'center',
      curvePoints: [{id: 'p1', x: -10, y: 5}],
    },
    keyframes: [
      {
        id: 'kf-orig-1',
        timeOffset: 1,
        x: 0.2,
        y: 0.2,
        scale: 1,
        rotation: 0,
        opacity: 1,
        easing: 'linear',
      },
      {
        id: 'kf-orig-2',
        timeOffset: 4.5,
        x: 0.8,
        y: 0.8,
        scale: 1.2,
        rotation: 10,
        opacity: 0.8,
        easing: 'ease-out',
      },
    ],
    lockedByUserId: 'u1',
  };

  // Explicit undefined -> null over JSON -> deletes keys in applyClipPatch
  const wirePatch = JSON.parse(
    JSON.stringify(
      encodePatchForSync<Clip>({
        mask: undefined,
        crop: undefined,
        lockedByUserId: null,
        rotation: 25,
      })
    )
  ) as Record<string, unknown>;

  const patched = applyClipPatch(originalClip, wirePatch);
  assert.equal('mask' in patched, false);
  assert.equal('crop' in patched, false);
  assert.equal(patched.lockedByUserId, null);
  assert.equal(patched.rotation, 25);

  // Split deep clones nested objects and isolates keyframe IDs
  const splitClips = applyClipSplit([originalClip], 'c1', 3.0, 'c2');
  assert.equal(splitClips.length, 2);
  assert.equal(splitClips[0].keyframes?.length, 1);
  assert.equal(splitClips[1].keyframes?.length, 1);
  assert.notEqual(splitClips[0].keyframes![0].id, splitClips[1].keyframes![0].id);
  assert.equal(splitClips[1].keyframes![0].timeOffset, 1.5);

  splitClips[1].colorAdjustments!.curves!.rgb[0].y = 0.77;
  assert.equal(splitClips[0].colorAdjustments!.curves!.rgb[0].y, 0);

  // Duplicate deep clones and shifts subsequent clips
  const duped = applyClipDuplicate([originalClip], 'c1', 'c-dup');
  assert.equal(duped.length, 2);
  assert.equal(duped[1].start, 6);
  assert.equal(duped[1].lockedByUserId, null);
  duped[1].textStyle!.curvePoints![0].y = 99;
  assert.equal(duped[0].textStyle!.curvePoints![0].y, 5);
});

test('Dual-Channel HTTP Media: SHA-256 целостность, 3 автоповтора и отказ при битом хеше', async () => {
  const payload = Buffer.from('CutSync P2P Binary Media Payload 0123456789');
  const expectedSha = crypto.createHash('sha256').update(payload).digest('hex');

  assert.equal(sha256SyncHex(payload), expectedSha);
  assert.equal(await sha256Hex(payload), expectedSha);

  assert.equal(
    extractMediaFileName('http://10.147.17.10:8080/media/123-demo%20video.mp4?t=1'),
    '123-demo video.mp4'
  );
  const candidates = resolveMediaCandidateUrls(
    'http://192.168.1.25:8080/media/123-clip.mp4',
    '123-clip.mp4',
    'http://10.147.17.10:8080'
  );
  assert.deepEqual(candidates, [
    'http://192.168.1.25:8080/media/123-clip.mp4',
    'http://10.147.17.10:8080/media/123-clip.mp4',
  ]);

  let flakyAttempts = 0;
  let badHashMode = false;

  const mockMediaServer = http.createServer((req, res) => {
    if (req.url?.startsWith('/media/flaky.bin')) {
      flakyAttempts += 1;
      if (flakyAttempts < 3) {
        res.statusCode = 503;
        res.end('Temporary P2P network blip');
        return;
      }
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(payload.length));
      res.setHeader('X-File-Size', String(payload.length));
      res.setHeader('X-Content-Sha256', expectedSha);
      res.end(payload);
      return;
    }

    if (req.url?.startsWith('/media/corrupt.bin')) {
      const body = badHashMode
        ? Buffer.from(
            'XutSync P2P Binary Media Payload 0123456789'.slice(
              0,
              payload.length
            )
          )
        : payload;
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(body.length));
      res.setHeader('X-File-Size', String(body.length));
      res.setHeader('X-Content-Sha256', expectedSha);
      res.end(body);
      return;
    }

    if (req.url?.startsWith('/media/truncated.bin')) {
      const body = payload.subarray(0, 12);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(body.length));
      res.setHeader('X-File-Size', String(body.length));
      res.setHeader('X-Content-Sha256', expectedSha);
      res.end(body);
      return;
    }

    if (req.url?.startsWith('/media/bad-header.bin')) {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(payload.length));
      res.setHeader('X-File-Size', String(payload.length));
      res.setHeader('X-Content-Sha256', '0'.repeat(64));
      res.end(payload);
      return;
    }

    res.statusCode = 404;
    res.end();
  });

  await new Promise<void>((resolve) =>
    mockMediaServer.listen(0, '127.0.0.1', () => resolve())
  );
  const addr = mockMediaServer.address();
  assert(addr && typeof addr === 'object');
  const base = `http://127.0.0.1:${addr.port}`;

  try {
    const attemptLog: number[] = [];
    const blobUrl = await downloadMediaInBackground({
      layerId: 'layer-flaky',
      remoteUrl: `${base}/media/flaky.bin`,
      fileName: 'flaky.bin',
      expectedSize: payload.length,
      expectedHash: expectedSha,
      serverBaseOverride: base,
      maxAttempts: 3,
      onAttempt: (a) => attemptLog.push(a),
    });

    assert.equal(flakyAttempts, 3);
    assert.deepEqual(attemptLog, [1, 2, 3]);
    assert.ok(blobUrl.startsWith('blob:'));
    URL.revokeObjectURL(blobUrl);

    // Verify integrity rejection when same-length bytes are corrupted (SHA-256)
    badHashMode = true;
    await assert.rejects(
      () =>
        downloadMediaInBackground({
          layerId: 'layer-corrupt',
          remoteUrl: `${base}/media/corrupt.bin`,
          fileName: 'corrupt.bin',
          expectedSize: payload.length,
          expectedHash: expectedSha,
          serverBaseOverride: base,
          maxAttempts: 2,
        }),
      /Контрольная сумма файла/
    );

    // Verify rejection when file size is truncated
    await assert.rejects(
      () =>
        downloadMediaInBackground({
          layerId: 'layer-truncated',
          remoteUrl: `${base}/media/truncated.bin`,
          fileName: 'truncated.bin',
          expectedSize: payload.length,
          expectedHash: expectedSha,
          serverBaseOverride: base,
          maxAttempts: 2,
        }),
      /Размер файла не совпал/
    );

    // Verify integrity rejection when server header X-Content-Sha256 disagrees
    await assert.rejects(
      () =>
        downloadMediaInBackground({
          layerId: 'layer-bad-header',
          remoteUrl: `${base}/media/bad-header.bin`,
          fileName: 'bad-header.bin',
          expectedSize: payload.length,
          expectedHash: expectedSha,
          serverBaseOverride: base,
          maxAttempts: 2,
        }),
      /Контрольная сумма сервера/
    );
  } finally {
    await new Promise<void>((resolve) => mockMediaServer.close(() => resolve()));
  }
});

test('WebSocket Sync E2E: Ping/Pong, HTTP Media Upload/Broadcast, SYNC_FULL_STATE и автоснятие LAYER_LOCK', async () => {
  process.env.CUTSYNC_NO_AUTOSTART = '1';

  const roomsFile = path.join(process.cwd(), 'data', 'rooms.json');
  const hadRoomsFile = fs.existsSync(roomsFile);
  const prevRoomsContent = hadRoomsFile
    ? fs.readFileSync(roomsFile, 'utf-8')
    : null;
  const createdUploadPaths: string[] = [];

  const {startServer, stopServer} = await import('../server.ts');
  const {port} = await startServer({
    port: 0,
    disableVite: true,
    disableBeacon: true,
    lockTimeoutMs: 700,
  });

  const baseHttp = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/sync`;
  const testRoomId = `test-room-${Date.now()}`;

  const connectClient = async (user: {
    id: string;
    name: string;
    color: string;
  }) => {
    const ws = new WebSocket(wsUrl);
    const messages: ServerWsMessage[] = [];
    const waiters: Array<{
      pred: (m: ServerWsMessage) => boolean;
      resolve: (m: ServerWsMessage) => void;
      reject: (e: Error) => void;
    }> = [];

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as ServerWsMessage;
      for (let i = 0; i < waiters.length; i++) {
        if (waiters[i].pred(msg)) {
          const w = waiters.splice(i, 1)[0];
          w.resolve(msg);
          return;
        }
      }
      messages.push(msg);
    });

    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });

    const waitFor = <T extends ServerWsMessage['type']>(
      type: T,
      extraPred?: (m: Extract<ServerWsMessage, {type: T}>) => boolean,
      timeoutMs = 3000
    ): Promise<Extract<ServerWsMessage, {type: T}>> => {
      const idx = messages.findIndex(
        (m) =>
          m.type === type &&
          (!extraPred || extraPred(m as Extract<ServerWsMessage, {type: T}>))
      );
      if (idx !== -1) {
        return Promise.resolve(
          messages.splice(idx, 1)[0] as Extract<ServerWsMessage, {type: T}>
        );
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Timeout waiting for WS message ${type}`));
        }, timeoutMs);
        waiters.push({
          pred: (m) =>
            m.type === type &&
            (!extraPred || extraPred(m as Extract<ServerWsMessage, {type: T}>)),
          resolve: (m) => {
            clearTimeout(timer);
            resolve(m as Extract<ServerWsMessage, {type: T}>);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
      });
    };

    ws.send(JSON.stringify({type: 'join', roomId: testRoomId, user}));
    const init = await waitFor('room:init');
    return {ws, init, waitFor};
  };

  let aliceWs: WebSocket | null = null;
  let bobWs: WebSocket | null = null;

  try {
    // Verify network-info and health endpoints
    const healthRes = await fetch(`${baseHttp}/api/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = (await healthRes.json()) as {ok: boolean; app: string};
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.app, 'CutSync');

    const netRes = await fetch(`${baseHttp}/api/network-info`);
    assert.equal(netRes.status, 200);
    const netJson = (await netRes.json()) as {interfaces: unknown[]; port: number};
    assert.equal(Array.isArray(netJson.interfaces), true);
    assert.equal(netJson.port, port);

    const alice = await connectClient({
      id: 'alice-1',
      name: 'Алиса',
      color: '#22d3ee',
    });
    aliceWs = alice.ws;

    const bob = await connectClient({
      id: 'bob-2',
      name: 'Боб',
      color: '#f97316',
    });
    bobWs = bob.ws;

    // 1. Ping / Pong Heartbeat check
    const pingTs = Date.now() - 15;
    alice.ws.send(JSON.stringify({type: 'ping', ts: pingTs}));
    const pongMsg = await alice.waitFor('pong');
    assert.equal(pongMsg.ts, pingTs);
    assert.equal(typeof pongMsg.serverTime, 'number');

    // 2. Two-channel media upload via HTTP (/media/upload) + WS LAYER_MEDIA_UPDATED
    const mediaBytes = Buffer.from('FAKE_MP4_VIDEO_DATA_FOR_E2E_SYNC_TEST');
    const uploadRes = await fetch(
      `${baseHttp}/media/upload?fileName=sync_e2e_test.mp4`,
      {
        method: 'POST',
        body: mediaBytes,
      }
    );
    assert.equal(uploadRes.status, 200);
    const uploaded = (await uploadRes.json()) as {
      ok: boolean;
      fileName: string;
      localUrl: string;
      shareUrl: string;
      fileSize: number;
      fileHash: string;
    };
    assert.equal(uploaded.ok, true);
    assert.equal(uploaded.fileSize, mediaBytes.length);
    createdUploadPaths.push(
      path.join(process.cwd(), 'uploads', uploaded.fileName)
    );

    const stubClip: Clip = {
      id: 'layer-e2e-1',
      track: 'video',
      trackId: 'track-video-1',
      kind: 'video',
      name: 'Тестовый ролик',
      src: uploaded.localUrl,
      start: 0,
      duration: 5,
      trimStart: 0,
      sourceDuration: 5,
      speed: 1,
      volume: 1,
      opacity: 1,
      filter: 'none',
      brightness: 1,
      contrast: 1,
      saturate: 1,
      transitionIn: 'none',
      motionEffect: 'none',
      mask: {
        shape: 'circle',
        mode: 'inside',
        x: 0.5,
        y: 0.5,
        scale: 0.6,
        rotation: 0,
        feather: 15,
      },
    };

    alice.ws.send(
      JSON.stringify({
        type: 'LAYER_MEDIA_UPDATED',
        layerId: stubClip.id,
        fileName: uploaded.fileName,
        mediaUrl: `${baseHttp}${uploaded.localUrl}`,
        fileSize: uploaded.fileSize,
        fileHash: uploaded.fileHash,
        senderId: 'alice-1',
        clip: stubClip,
      })
    );

    const bobMediaMsg = await bob.waitFor('LAYER_MEDIA_UPDATED');
    assert.equal(bobMediaMsg.layerId, 'layer-e2e-1');
    assert.equal(bobMediaMsg.fileSize, uploaded.fileSize);
    assert.equal(bobMediaMsg.fileHash, uploaded.fileHash);

    // Bob downloads the asset using downloadMediaInBackground and verifies SHA-256
    const localBlobUrl = await downloadMediaInBackground({
      layerId: bobMediaMsg.layerId,
      remoteUrl: bobMediaMsg.mediaUrl,
      fileName: bobMediaMsg.fileName,
      expectedSize: bobMediaMsg.fileSize,
      expectedHash: bobMediaMsg.fileHash,
      serverBaseOverride: baseHttp,
    });
    assert.ok(localBlobUrl.startsWith('blob:'));
    URL.revokeObjectURL(localBlobUrl);

    // 3. Partial patch clearing mask + SYNC_FULL_STATE recovery
    alice.ws.send(
      JSON.stringify({
        type: 'op:clip_update',
        clipId: 'layer-e2e-1',
        patch: encodePatchForSync<Clip>({mask: undefined, rotation: 33}),
      })
    );
    const bobPatchMsg = await bob.waitFor('op:clip_update');
    assert.equal(bobPatchMsg.clipId, 'layer-e2e-1');

    bob.ws.send(JSON.stringify({type: 'SYNC_FULL_STATE'}));
    const fullSyncMsg = await bob.waitFor('SYNC_FULL_STATE');
    const syncedClip = fullSyncMsg.project.clips.find(
      (c) => c.id === 'layer-e2e-1'
    );
    assert.ok(syncedClip);
    assert.equal(syncedClip.rotation, 33);
    assert.equal('mask' in syncedClip, false);

    // 4. LAYER_LOCK 700ms inactivity auto-expiry (simulating stuck lock release)
    alice.ws.send(
      JSON.stringify({
        type: 'LAYER_LOCK',
        layerId: 'layer-e2e-1',
        userId: 'alice-1',
        userName: 'Алиса',
        userColor: '#22d3ee',
        locked: true,
      })
    );
    const lockMsg = await bob.waitFor(
      'LAYER_LOCK',
      (m) => m.layerId === 'layer-e2e-1' && m.locked === true
    );
    assert.equal(lockMsg.userId, 'alice-1');

    const autoUnlockMsg = await bob.waitFor(
      'LAYER_LOCK',
      (m) => m.layerId === 'layer-e2e-1' && m.locked === false,
      3000
    );
    assert.equal(autoUnlockMsg.locked, false);

    // 5. Immediate unlock on socket disconnect
    alice.ws.send(
      JSON.stringify({
        type: 'LAYER_LOCK',
        layerId: 'layer-e2e-1',
        userId: 'alice-1',
        userName: 'Алиса',
        userColor: '#22d3ee',
        locked: true,
      })
    );
    await bob.waitFor(
      'LAYER_LOCK',
      (m) => m.layerId === 'layer-e2e-1' && m.locked === true
    );
    alice.ws.terminate();
    const disconnectUnlock = await bob.waitFor(
      'LAYER_LOCK',
      (m) => m.layerId === 'layer-e2e-1' && m.locked === false,
      2000
    );
    assert.equal(disconnectUnlock.locked, false);
  } finally {
    try {
      aliceWs?.terminate();
    } catch {
      // ignore
    }
    try {
      bobWs?.terminate();
    } catch {
      // ignore
    }
    await stopServer();
    for (const p of createdUploadPaths) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        // ignore
      }
    }
    // Wait briefly in case scheduleSaveRooms flushed, then restore rooms.json
    await new Promise((r) => setTimeout(r, 450));
    try {
      if (hadRoomsFile && prevRoomsContent !== null) {
        fs.writeFileSync(roomsFile, prevRoomsContent, 'utf-8');
      } else if (!hadRoomsFile && fs.existsSync(roomsFile)) {
        fs.unlinkSync(roomsFile);
      }
    } catch {
      // ignore
    }
  }
});

test('JSON Sync: фигуры, деформация (warp + keyframe.warp), корр. слои, canvasBackground и выход за границы холста', () => {
  const proj: ProjectState = {
    roomId: 'audit-room-2',
    title: 'Проверка фигур, деформации и координат',
    aspectRatio: '9:16',
    backgroundColor: '#111827',
    canvasBackground: {
      type: 'gradient',
      colors: ['#0f172a', '#164e63'],
      angle: 135,
      label: 'Неон',
    },
    fps: 30,
    isPublicLan: true,
    customFonts: [],
    tracks: [
      {id: 'track-video-1', type: 'video', name: 'Основное видео'},
      {id: 'track-overlay-1', type: 'overlay', name: 'Слой 1'},
      {id: 'track-text-1', type: 'text', name: 'Титры 1'},
      {id: 'track-adj-1', type: 'adjustment', name: 'Коррекция 1'},
    ],
    clips: [
      {
        id: 'shape-oob',
        track: 'overlay',
        trackId: 'track-overlay-1',
        kind: 'shape',
        name: 'Стрелка',
        start: 0,
        duration: 6,
        trimStart: 0,
        sourceDuration: 3600,
        speed: 1,
        volume: 0,
        opacity: 0.9,
        filter: 'none',
        brightness: 1,
        contrast: 1,
        saturate: 1,
        transitionIn: 'none',
        motionEffect: 'none',
        mediaScale: 0.45,
        mediaX: -0.35,
        mediaY: 1.24,
        rotation: 12,
        shapeStyle: {
          shapeType: 'arrow',
          fillColor: '#22d3ee',
          fillOpacity: 0.85,
          strokeColor: '#ffffff',
          strokeWidth: 4,
          cornerRadius: 8,
        },
        adjustmentMask: true,
        colorAdjustments: {
          sharpness: 15,
          shadows: -10,
          hue: 25,
          temperature: -15,
          fade: 5,
          grain: 0,
          invert: 80,
        },
        warp: {
          mode: 'perspective',
          corners: [
            {x: -0.25, y: -0.15},
            {x: 1.35, y: 0.05},
            {x: 1.15, y: 1.4},
            {x: -0.1, y: 0.95},
          ],
          meshSize: 3,
          meshPoints: Array.from({length: 9}, (_, idx) => ({
            x: (idx % 3) / 2,
            y: Math.floor(idx / 3) / 2,
          })),
        },
        keyframes: [
          {
            id: 'kf-1',
            timeOffset: 0.5,
            x: -0.35,
            y: 1.24,
            scale: 0.45,
            rotation: 12,
            opacity: 0.9,
            warp: {
              mode: 'perspective',
              corners: [
                {x: -0.25, y: -0.15},
                {x: 1.35, y: 0.05},
                {x: 1.15, y: 1.4},
                {x: -0.1, y: 0.95},
              ],
              meshSize: 3,
              meshPoints: Array.from({length: 9}, (_, idx) => ({
                x: (idx % 3) / 2,
                y: Math.floor(idx / 3) / 2,
              })),
            },
            easing: 'ease-out',
          },
          {
            id: 'kf-2',
            timeOffset: 4.0,
            x: 1.42,
            y: -0.18,
            scale: 0.65,
            rotation: -18,
            opacity: 1,
            easing: 'linear',
          },
        ],
      },
      {
        id: 'adj-layer-1',
        track: 'adjustment',
        trackId: 'track-adj-1',
        kind: 'adjustment',
        name: 'Корр. слой',
        start: 1,
        duration: 4,
        trimStart: 0,
        sourceDuration: 3600,
        speed: 1,
        volume: 0,
        opacity: 0.75,
        filter: 'cinema',
        brightness: 1.12,
        contrast: 1.2,
        saturate: 0.9,
        transitionIn: 'none',
        motionEffect: 'none',
        colorAdjustments: {
          sharpness: 30,
          shadows: 12,
          hue: 0,
          temperature: 10,
          fade: 15,
          grain: 8,
          invert: 100,
        },
      },
    ],
    revision: 5,
    updatedAt: Date.now(),
    chat: [],
  };

  const wire = JSON.parse(JSON.stringify(proj)) as ProjectState;
  const restored = normalizeProjectTracks(wire);

  assert.deepEqual(restored.canvasBackground, proj.canvasBackground);
  const restoredShape = restored.clips.find((c) => c.id === 'shape-oob')!;
  assert.equal(restoredShape.mediaX, -0.35);
  assert.equal(restoredShape.mediaY, 1.24);
  assert.equal(restoredShape.adjustmentMask, true);
  assert.equal(restoredShape.shapeStyle?.shapeType, 'arrow');
  assert.equal(restoredShape.colorAdjustments?.invert, 80);
  assert.equal(restoredShape.warp?.corners[1].x, 1.35);
  assert.equal(restoredShape.keyframes?.[0].warp?.corners[0].x, -0.25);

  // Split & duplicate must deep-clone shapeStyle and warp (including kf.warp)
  const splitClips = applyClipSplit(restored.clips, 'shape-oob', 2.5, 'shape-oob-2');
  const firstHalf = splitClips.find((c) => c.id === 'shape-oob')!;
  const secondHalf = splitClips.find((c) => c.id === 'shape-oob-2')!;
  secondHalf.shapeStyle!.fillColor = '#f43f5e';
  secondHalf.warp!.corners[0].x = 0.25;
  assert.equal(firstHalf.shapeStyle?.fillColor, '#22d3ee');
  assert.equal(firstHalf.warp?.corners[0].x, -0.25);

  const dupClips = applyClipDuplicate(restored.clips, 'shape-oob', 'shape-oob-copy');
  const dup = dupClips.find((c) => c.id === 'shape-oob-copy')!;
  dup.warp!.corners[2].y = 0.5;
  dup.keyframes![0].warp!.corners[0].x = 0.0;
  assert.equal(restoredShape.warp?.corners[2].y, 1.4);
  assert.equal(restoredShape.keyframes?.[0].warp?.corners[0].x, -0.25);

  // Patch clear test for shapeStyle / warp / adjustmentMask
  const clearPatch = encodePatchForSync<Clip>({
    warp: undefined,
    adjustmentMask: undefined,
    mediaX: 1.55,
    mediaY: -0.4,
  });
  const wireClear = JSON.parse(JSON.stringify(clearPatch)) as Record<string, unknown>;
  const patched = applyClipPatch(restoredShape, wireClear);
  assert.equal('warp' in patched, false);
  assert.equal('adjustmentMask' in patched, false);
  assert.equal(patched.mediaX, 1.55);
  assert.equal(patched.mediaY, -0.4);
});

test('E2E Concurrent Multi-User: 2 участника одновременно редактируют разные объекты (включая выход за границы)', async () => {
  const roomsFile = path.join(process.cwd(), 'data', 'rooms.json');
  const hadRoomsFile = fs.existsSync(roomsFile);
  const prevRoomsContent = hadRoomsFile
    ? fs.readFileSync(roomsFile, 'utf-8')
    : null;

  process.env.CUTSYNC_NO_AUTOSTART = '1';
  const {startServer, stopServer} = await import('../server.ts');

  const {port} = await startServer({
    port: 0,
    isProd: true,
    lockTimeoutMs: 1200,
    disableVite: true,
    disableBeacon: true,
  });
  const baseWs = `ws://127.0.0.1:${port}/ws`;

  let aliceWs: WebSocket | null = null;
  let bobWs: WebSocket | null = null;

  const connectPeer = async (
    id: string,
    name: string,
    roomId: string
  ): Promise<{
    ws: WebSocket;
    waitFor: <T extends ServerWsMessage['type']>(
      type: T,
      predicate?: (m: Extract<ServerWsMessage, {type: T}>) => boolean,
      timeoutMs?: number
    ) => Promise<Extract<ServerWsMessage, {type: T}>>;
  }> => {
    const queue: ServerWsMessage[] = [];
    const waiters: Array<{
      type: ServerWsMessage['type'];
      predicate?: (m: ServerWsMessage) => boolean;
      resolve: (m: ServerWsMessage) => void;
      reject: (err: Error) => void;
    }> = [];

    const ws = new WebSocket(baseWs);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as ServerWsMessage;
      const idx = waiters.findIndex(
        (w) => w.type === msg.type && (!w.predicate || w.predicate(msg))
      );
      if (idx !== -1) {
        const w = waiters.splice(idx, 1)[0];
        w.resolve(msg);
      } else {
        queue.push(msg);
      }
    });

    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => {
        ws.send(
          JSON.stringify({
            type: 'join',
            roomId,
            user: {id, name, color: '#22d3ee'},
          })
        );
        resolve();
      });
      ws.once('error', reject);
    });

    const waitFor = <T extends ServerWsMessage['type']>(
      type: T,
      predicate?: (m: Extract<ServerWsMessage, {type: T}>) => boolean,
      timeoutMs = 4000
    ) => {
      const qIdx = queue.findIndex(
        (m) =>
          m.type === type &&
          (!predicate || predicate(m as Extract<ServerWsMessage, {type: T}>))
      );
      if (qIdx !== -1) {
        return Promise.resolve(
          queue.splice(qIdx, 1)[0] as Extract<ServerWsMessage, {type: T}>
        );
      }
      return new Promise<Extract<ServerWsMessage, {type: T}>>(
        (resolve, reject) => {
          const timer = setTimeout(() => {
            const wIdx = waiters.indexOf(entry);
            if (wIdx !== -1) waiters.splice(wIdx, 1);
            reject(new Error(`Timeout waiting for ${type}`));
          }, timeoutMs);
          const entry = {
            type,
            predicate: predicate as ((m: ServerWsMessage) => boolean) | undefined,
            resolve: (m: ServerWsMessage) => {
              clearTimeout(timer);
              resolve(m as Extract<ServerWsMessage, {type: T}>);
            },
            reject: (err: Error) => {
              clearTimeout(timer);
              reject(err);
            },
          };
          waiters.push(entry);
        }
      );
    };

    await waitFor('room:init');
    return {ws, waitFor};
  };

  try {
    const roomId = `e2e-concurrent-${Date.now()}`;
    const alice = await connectPeer('alice-c', 'Алиса', roomId);
    aliceWs = alice.ws;
    const bob = await connectPeer('bob-c', 'Боб', roomId);
    bobWs = bob.ws;

    // Alice edits clip-o1 (pushing off left/bottom edge + warp), while Bob simultaneously edits clip-t1 (pushing off right/top edge)
    alice.ws.send(
      JSON.stringify({
        type: 'LAYER_LOCK',
        layerId: 'clip-o1',
        userId: 'alice-c',
        userName: 'Алиса',
        userColor: '#22d3ee',
        locked: true,
      })
    );
    bob.ws.send(
      JSON.stringify({
        type: 'LAYER_LOCK',
        layerId: 'clip-t1',
        userId: 'bob-c',
        userName: 'Боб',
        userColor: '#f97316',
        locked: true,
      })
    );

    await Promise.all([
      bob.waitFor('LAYER_LOCK', (m) => m.layerId === 'clip-o1' && m.locked),
      alice.waitFor('LAYER_LOCK', (m) => m.layerId === 'clip-t1' && m.locked),
    ]);

    for (let step = 1; step <= 10; step++) {
      const oobX = -(step * 0.04); // up to -0.40 outside left edge
      alice.ws.send(
        JSON.stringify({
          type: 'op:clip_update',
          clipId: 'clip-o1',
          patch: {mediaX: oobX, mediaY: 1.15, rotation: step * 3},
        })
      );
      bob.ws.send(
        JSON.stringify({
          type: 'op:clip_update',
          clipId: 'clip-t1',
          patch: {
            textStyle: {
              fontSize: 54,
              color: '#ffffff',
              bgColor: 'rgba(9, 9, 11, 0.72)',
              fontWeight: 'bold',
              fontFamily: 'Plus Jakarta Sans',
              shadow: true,
              x: 1.0 + step * 0.03, // up to 1.30 outside right edge
              y: -0.12,
              align: 'center',
            },
          },
        })
      );
    }

    await Promise.all([
      bob.waitFor(
        'op:clip_update',
        (m) => m.clipId === 'clip-o1' && m.patch.mediaX === -0.4
      ),
      alice.waitFor(
        'op:clip_update',
        (m) =>
          m.clipId === 'clip-t1' &&
          Math.abs((m.patch.textStyle?.x ?? 0) - 1.3) < 0.001
      ),
    ]);

    alice.ws.send(JSON.stringify({type: 'SYNC_FULL_STATE'}));
    const full = await alice.waitFor('SYNC_FULL_STATE');
    const cO1 = full.project.clips.find((c) => c.id === 'clip-o1');
    const cT1 = full.project.clips.find((c) => c.id === 'clip-t1');
    assert.ok(cO1);
    assert.ok(cT1);
    assert.equal(cO1.mediaX, -0.4);
    assert.equal(cO1.mediaY, 1.15);
    assert.equal(cO1.rotation, 30);
    assert.ok(Math.abs((cT1.textStyle?.x ?? 0) - 1.3) < 0.001);
    assert.equal(cT1.textStyle?.y, -0.12);
  } finally {
    try {
      aliceWs?.terminate();
    } catch {
      // ignore
    }
    try {
      bobWs?.terminate();
    } catch {
      // ignore
    }
    await stopServer();
    await new Promise((r) => setTimeout(r, 350));
    try {
      if (hadRoomsFile && prevRoomsContent !== null) {
        fs.writeFileSync(roomsFile, prevRoomsContent, 'utf-8');
      } else if (!hadRoomsFile && fs.existsSync(roomsFile)) {
        fs.unlinkSync(roomsFile);
      }
    } catch {
      // ignore
    }
  }
});

test('Основное видео и стартовые клипы не приближаются автоматически без ключевых кадров', () => {
  const starter = createStarterClips();
  for (const c of starter) {
    assert.equal(c.motionEffect, 'none');
    assert.notEqual(c.transitionIn, 'zoom');
    const atStart = evaluateClipTransform(c, c.start);
    const atMid = evaluateClipTransform(c, c.start + c.duration * 0.5);
    const atEnd = evaluateClipTransform(c, c.start + c.duration);
    assert.equal(atStart.scale, atMid.scale);
    assert.equal(atMid.scale, atEnd.scale);
  }
});

test('Экспорт: getExportDimensions возвращает чётные размеры для всех разрешений и соотношений сторон', async () => {
  const {getExportDimensions} = await import('../src/lib/exportEngine.ts');
  const aspects = ['9:16', '16:9', '1:1', '4:5', '3:4', '21:9'] as const;
  const resolutions = ['480p', '720p', '1080p', '1440p', '2160p'] as const;

  for (const aspect of aspects) {
    for (const res of resolutions) {
      const {width, height} = getExportDimensions(aspect, res);
      assert.equal(width % 2, 0, `${aspect} ${res} width (${width}) must be even`);
      assert.equal(height % 2, 0, `${aspect} ${res} height (${height}) must be even`);
      assert.ok(width >= 480 && height >= 480);
    }
  }

  assert.deepEqual(getExportDimensions('16:9', '1080p'), {width: 1920, height: 1080});
  assert.deepEqual(getExportDimensions('9:16', '2160p'), {width: 2160, height: 3840});
});

test('Экспорт: buildAnimatedWebp собирает валидный RIFF WEBP (VP8X + ANIM + ANMF) с нечётным выравниванием', async () => {
  const {buildAnimatedWebp} = await import('../src/lib/webpMuxer.ts');

  const makeMockSingleWebp = (fourcc: 'VP8 ' | 'VP8L', payload: number[]): Uint8Array => {
    const padded = payload.length + (payload.length & 1);
    const total = 12 + 8 + padded;
    const buf = new Uint8Array(total);
    buf.set(Buffer.from('RIFF'), 0);
    new DataView(buf.buffer).setUint32(4, total - 8, true);
    buf.set(Buffer.from('WEBP'), 8);
    buf.set(Buffer.from(fourcc), 12);
    new DataView(buf.buffer).setUint32(16, payload.length, true);
    buf.set(payload, 20);
    return buf;
  };

  // Odd-length VP8 payload + VP8L payload with alpha bit (byte 4 & 0x10)
  const frame1 = makeMockSingleWebp('VP8 ', [1, 2, 3, 4, 5]);
  const frame2 = makeMockSingleWebp('VP8L', [0x2f, 0, 0, 0, 0x10, 9]);

  const animated = buildAnimatedWebp(
    [
      {webpBytes: frame1, durationMs: 33},
      {webpBytes: frame2, durationMs: 33},
    ],
    720,
    1280,
    0
  );

  const ascii = (offset: number, len: number) =>
    Buffer.from(animated.subarray(offset, offset + len)).toString('ascii');

  assert.equal(ascii(0, 4), 'RIFF');
  assert.equal(ascii(8, 4), 'WEBP');
  assert.equal(
    new DataView(animated.buffer, animated.byteOffset, animated.byteLength).getUint32(4, true),
    animated.length - 8
  );
  assert.equal(ascii(12, 4), 'VP8X');
  // Animation (0x02) + Alpha (0x10) detected from VP8L frame2
  assert.equal(animated[20], 0x12);
  // VP8X canvas width - 1 = 719, height - 1 = 1279
  const canvasWMinus1 = animated[24] | (animated[25] << 8) | (animated[26] << 16);
  const canvasHMinus1 = animated[27] | (animated[28] << 8) | (animated[29] << 16);
  assert.equal(canvasWMinus1, 719);
  assert.equal(canvasHMinus1, 1279);
  assert.equal(ascii(30, 4), 'ANIM');
  assert.equal(ascii(44, 4), 'ANMF');
});

test('Хранилище медиа: validateServerStorageDir блокирует traversal и системные каталоги', async () => {
  const {validateServerStorageDir} = await import(
    '../src/lib/storagePathRules.ts'
  );
  const appRoot = process.cwd();

  const validRel = validateServerStorageDir('custom-media/team', appRoot);
  assert.equal(validRel.valid, true);
  assert.equal(
    validRel.resolvedPath,
    path.resolve(appRoot, 'custom-media/team')
  );

  const validAbs = validateServerStorageDir('/tmp/cutsync-test-media', appRoot);
  assert.equal(validAbs.valid, true);

  assert.equal(validateServerStorageDir('../../etc/passwd', appRoot).valid, false);
  assert.equal(validateServerStorageDir('/etc', appRoot).valid, false);
  assert.equal(validateServerStorageDir('/usr/local', appRoot).valid, false);
  assert.equal(validateServerStorageDir('/', appRoot).valid, false);
  assert.equal(validateServerStorageDir('C:\\Windows\\System32', appRoot).valid, false);
  assert.equal(validateServerStorageDir('node_modules/cache', appRoot).valid, false);
  assert.equal(validateServerStorageDir('.git/objects', appRoot).valid, false);
  assert.equal(validateServerStorageDir('bad\0path', appRoot).valid, false);
});

test('Хранилище медиа E2E: выбор папки сохранений, загрузка в неё и сброс на корень приложения', async () => {
  process.env.CUTSYNC_NO_AUTOSTART = '1';
  const os = await import('node:os');
  const storageConfigFile = path.join(
    process.cwd(),
    'data',
    'storage-config.json'
  );
  const hadStorageConfig = fs.existsSync(storageConfigFile);
  const prevStorageConfig = hadStorageConfig
    ? fs.readFileSync(storageConfigFile, 'utf-8')
    : null;

  const customDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'cutsync-custom-media-')
  );
  const {startServer, stopServer} = await import('../server.ts');
  const {port} = await startServer({
    port: 0,
    disableVite: true,
    disableBeacon: true,
  });

  const baseHttp = `http://127.0.0.1:${port}`;
  try {
    // 1. Default is app root uploads folder
    const initRes = await fetch(`${baseHttp}/api/storage/config`);
    assert.equal(initRes.status, 200);
    const initCfg = (await initRes.json()) as {
      currentDir: string;
      defaultDir: string;
      isDefault: boolean;
    };
    assert.equal(initCfg.isDefault, true);
    assert.equal(
      path.resolve(initCfg.currentDir),
      path.resolve(process.cwd(), 'uploads')
    );

    // 2. Reject invalid system directory
    const badRes = await fetch(`${baseHttp}/api/storage/config`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({dirPath: '/etc'}),
    });
    assert.equal(badRes.status, 400);

    // 3. Switch to custom folder
    const setRes = await fetch(`${baseHttp}/api/storage/config`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({dirPath: customDir, migrateExisting: false}),
    });
    assert.equal(setRes.status, 200);
    const setCfg = (await setRes.json()) as {
      currentDir: string;
      isDefault: boolean;
    };
    assert.equal(setCfg.isDefault, false);
    assert.equal(path.resolve(setCfg.currentDir), path.resolve(customDir));

    // 4. Upload a sample media payload and verify it lands inside customDir
    const sampleBytes = Buffer.from('CUSTOM-DIR-MEDIA-PAYLOAD-123');
    const upRes = await fetch(
      `${baseHttp}/media/upload?fileName=sync-photo.jpg`,
      {
        method: 'POST',
        body: sampleBytes,
      }
    );
    assert.equal(upRes.status, 200);
    const upJson = (await upRes.json()) as {
      ok: boolean;
      fileName: string;
      localUrl: string;
    };
    assert.equal(upJson.ok, true);
    const storedOnDisk = path.join(customDir, upJson.fileName);
    assert.equal(fs.existsSync(storedOnDisk), true);

    // File is served directly from customDir
    const dlCustomRes = await fetch(`${baseHttp}${upJson.localUrl}`);
    assert.equal(dlCustomRes.status, 200);
    assert.deepEqual(Buffer.from(await dlCustomRes.arrayBuffer()), sampleBytes);

    // 5. Reset back to app root default with migration enabled
    const resetRes = await fetch(`${baseHttp}/api/storage/config`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({reset: true, migrateExisting: true}),
    });
    assert.equal(resetRes.status, 200);
    const resetCfg = (await resetRes.json()) as {
      isDefault: boolean;
      migratedCount: number;
    };
    assert.equal(resetCfg.isDefault, true);
    assert.ok(resetCfg.migratedCount >= 1);

    const migratedDefaultFile = path.join(
      process.cwd(),
      'uploads',
      upJson.fileName
    );
    assert.equal(fs.existsSync(migratedDefaultFile), true);
    const dlAfterReset = await fetch(`${baseHttp}${upJson.localUrl}`);
    assert.equal(dlAfterReset.status, 200);
    assert.deepEqual(Buffer.from(await dlAfterReset.arrayBuffer()), sampleBytes);
    if (fs.existsSync(migratedDefaultFile)) {
      fs.unlinkSync(migratedDefaultFile);
    }
  } finally {
    await stopServer();
    fs.rmSync(customDir, {recursive: true, force: true});
    if (hadStorageConfig && prevStorageConfig !== null) {
      fs.writeFileSync(storageConfigFile, prevStorageConfig, 'utf-8');
    } else if (fs.existsSync(storageConfigFile)) {
      fs.unlinkSync(storageConfigFile);
    }
  }
});

test('Трансформация по ключам: интерполяция scaleX/scaleY, flip, warp (включая переход к/от Обычной) и изоляция базовых свойств', () => {
  const baseWarp = createDefaultWarp('none', 4);
  const clip: Clip = {
    id: 'kf-transform-1',
    track: 'overlay',
    trackId: 'track-o1',
    kind: 'image',
    name: 'Морфинг.png',
    start: 1,
    duration: 4,
    trimStart: 0,
    sourceDuration: 60,
    speed: 1,
    volume: 1,
    opacity: 1,
    filter: 'none',
    brightness: 1,
    contrast: 1,
    saturate: 1,
    transitionIn: 'none',
    motionEffect: 'none',
    mediaX: 0.5,
    mediaY: 0.5,
    mediaScale: 0.5,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    flipHorizontal: false,
    flipVertical: false,
    warp: baseWarp,
  };

  // Add first keyframe at t=1.0 (offset 0)
  const step1 = upsertKeyframeAtTime(clip, 1.0, {
    scaleX: 1,
    scaleY: 1,
    flipHorizontal: false,
    warp: createDefaultWarp('none', 4),
  });
  let current: Clip = {...clip, keyframes: step1.keyframes};

  // Add second keyframe at t=3.0 (offset 2.0) with stretched scaleX/scaleY, flip, and perspective warp
  const perspWarp = createDefaultWarp('perspective', 4);
  perspWarp.corners[0] = {x: 0.2, y: 0.1};
  perspWarp.corners[1] = {x: 0.8, y: 0.2};
  const step2 = upsertKeyframeAtTime(current, 3.0, {
    scaleX: 2.0,
    scaleY: 0.6,
    flipHorizontal: true,
    warp: perspWarp,
    easing: 'linear',
  });
  current = {...current, keyframes: step2.keyframes};

  // Base clip.warp and clip.scaleX must remain untouched so keyframe #1 stays unwarped
  assert.equal(current.warp?.mode, 'none');
  assert.equal(current.scaleX, 1);

  // Add third keyframe at t=5.0 (offset 4.0) morphing BACK to normal ('none') with flipVertical
  const step3 = upsertKeyframeAtTime(current, 5.0, {
    scaleX: 1.0,
    scaleY: 1.4,
    flipHorizontal: false,
    flipVertical: true,
    warp: createDefaultWarp('none', 4),
    easing: 'linear',
  });
  current = {...current, keyframes: step3.keyframes};

  // At t=1.0 (kf1): identity scale & no warp
  const atStart = evaluateClipTransform(current, 1.0);
  assert.equal(atStart.scaleX, 1);
  assert.equal(atStart.scaleY, 1);
  assert.equal(atStart.flipHorizontal, false);
  assert.equal(atStart.warp?.mode, 'none');

  // At t=2.0 (midpoint between kf1 and kf2): smooth interpolation from identity
  const atMid12 = evaluateClipTransform(current, 2.0);
  assert.ok(Math.abs(atMid12.scaleX - 1.5) < 0.001);
  assert.ok(Math.abs(atMid12.scaleY - 0.8) < 0.001);
  assert.equal(atMid12.flipHorizontal, false);
  assert.equal(atMid12.warp?.mode, 'perspective');
  assert.ok(Math.abs((atMid12.warp?.corners[0].x ?? 0) - 0.1) < 0.001);
  assert.ok(Math.abs((atMid12.warp?.corners[1].x ?? 0) - 0.9) < 0.001);

  // At t=3.0 (exact kf2)
  const atKf2 = evaluateClipTransform(current, 3.0);
  assert.ok(Math.abs(atKf2.scaleX - 2.0) < 0.001);
  assert.ok(Math.abs(atKf2.scaleY - 0.6) < 0.001);
  assert.equal(atKf2.flipHorizontal, true);
  assert.equal(atKf2.flipVertical, false);
  assert.ok(Math.abs((atKf2.warp?.corners[0].x ?? 0) - 0.2) < 0.001);

  // At t=4.0 (midpoint between kf2 and kf3): morphing back toward identity corners (even if kf3 had stale coords)
  const atMid23 = evaluateClipTransform(current, 4.0);
  assert.ok(Math.abs(atMid23.scaleX - 1.5) < 0.001);
  assert.ok(Math.abs(atMid23.scaleY - 1.0) < 0.001);
  assert.equal(atMid23.warp?.mode, 'perspective');
  assert.ok(Math.abs((atMid23.warp?.corners[0].x ?? 0) - 0.1) < 0.001);
  assert.ok(Math.abs((atMid23.warp?.corners[1].x ?? 0) - 0.9) < 0.001);

  // At t=5.0 (kf3): cleanly back to 'none' & flipVertical true
  const atEnd = evaluateClipTransform(current, 5.0);
  assert.equal(atEnd.scaleX, 1.0);
  assert.equal(atEnd.scaleY, 1.4);
  assert.equal(atEnd.flipHorizontal, false);
  assert.equal(atEnd.flipVertical, true);
  assert.equal(atEnd.warp?.mode, 'none');

  // Verify JSON sync & split/duplicate preserve new ClipKeyframe fields
  const patch = encodePatchForSync<Clip>({keyframes: current.keyframes});
  const synced = applyClipPatch(clip, JSON.parse(JSON.stringify(patch)));
  assert.equal(synced.keyframes?.length, 3);
  assert.equal(synced.keyframes?.[1].scaleX, 2.0);
  assert.equal(synced.keyframes?.[1].flipHorizontal, true);
  assert.equal(synced.keyframes?.[2].flipVertical, true);

  const split = applyClipSplit([synced], synced.id, 3.0, 'kf-transform-split-2');
  assert.equal(split.length, 2);
  assert.equal(split[1].keyframes?.[0].scaleX, 2.0);
  assert.equal(split[1].keyframes?.[0].flipHorizontal, true);
});

test('Трекинг объектов (VitTrack) и полигон «По точкам» с привязкой вершин к трекеру-маяку', () => {
  const videoClip: Clip = {
    id: 'vid-track-1',
    track: 'video',
    trackId: 'track-video-1',
    kind: 'video',
    name: 'TrackClip.mp4',
    start: 1.0,
    duration: 4.0,
    trimStart: 0.5,
    sourceDuration: 10,
    speed: 1,
    volume: 1,
    opacity: 1,
    filter: 'none',
    brightness: 1,
    contrast: 1,
    saturate: 1,
    transitionIn: 'none',
    motionEffect: 'none',
  };

  // Source mapping round-trip
  const srcBox = mapCanvasBboxToVideoSource(
    videoClip,
    {x: 0.25, y: 0.25, w: 0.5, h: 0.5},
    1.0,
    1280,
    720,
    1280,
    720
  );
  assert.ok(Math.abs(srcBox.x - 0.25) < 0.001);
  assert.ok(Math.abs(srcBox.w - 0.5) < 0.001);

  const beacon: MotionTrackerBeacon = buildTrackerBeaconFromVitTrack(
    'Мяч',
    videoClip,
    [
      {timeMs: 500, x: 0.2, y: 0.3, scale: 1.0, w: 0.15, h: 0.15, score: 0.98},
      {timeMs: 2500, x: 0.8, y: 0.7, scale: 1.5, w: 0.225, h: 0.225, score: 0.91},
    ],
    1280,
    720,
    1280,
    720,
    0
  );

  assert.equal(beacon.name, 'Мяч');
  assert.equal(beacon.points.length, 2);
  // trimStart=0.5s -> 500ms maps to clip.start=1.0s; 2500ms maps to 3.0s
  assert.ok(Math.abs(beacon.points[0].time - 1.0) < 0.01);
  assert.ok(Math.abs(beacon.points[1].time - 3.0) < 0.01);

  const midEval = evaluateTrackerAtTime(beacon, 2.0);
  assert.ok(midEval);
  assert.ok(Math.abs(midEval.x - 0.5) < 0.01);
  assert.ok(Math.abs(midEval.y - 0.5) < 0.01);
  assert.ok(Math.abs(midEval.scale - 1.25) < 0.01);

  // Keyframe generation on target layer
  const overlayLayer: Clip = {
    ...videoClip,
    id: 'ov-target',
    track: 'overlay',
    kind: 'image',
    mediaScale: 0.4,
    mediaX: 0.5,
    mediaY: 0.5,
  };
  const kfs = buildClipKeyframesFromTracker(overlayLayer, beacon.points, true);
  assert.equal(kfs.length, 2);
  assert.ok(Math.abs(kfs[1].x - 0.8) < 0.01);
  assert.ok(Math.abs(kfs[1].scale - 0.6) < 0.01);

  const kfsPosOnly = buildClipKeyframesFromTracker(overlayLayer, beacon.points, false);
  assert.equal(kfsPosOnly.length, 2);
  assert.ok(Math.abs(kfsPosOnly[1].x - 0.8) < 0.01);
  assert.ok(Math.abs(kfsPosOnly[1].scale - 0.4) < 0.01);

  const beaconPosOnly = buildTrackerBeaconFromVitTrack(
    'Только XY',
    videoClip,
    [
      {timeMs: 500, x: 0.2, y: 0.3, scale: 1.0, w: 0.15, h: 0.15, score: 0.98},
      {timeMs: 2500, x: 0.8, y: 0.7, scale: 1.5, w: 0.225, h: 0.225, score: 0.91},
    ],
    1280,
    720,
    1280,
    720,
    1,
    false
  );
  assert.equal(beaconPosOnly.trackScale, false);
  assert.equal(beaconPosOnly.points[1].scale, 1);

  // Polygon 'points' clip with 1 manual keyframed vertex + 1 tracker-bound vertex
  const polyClip: Clip = {
    id: 'poly-1',
    track: 'overlay',
    trackId: 'track-overlay-1',
    kind: 'shape',
    name: 'По точкам',
    start: 1.0,
    duration: 4.0,
    trimStart: 0,
    sourceDuration: 3600,
    speed: 1,
    volume: 0,
    opacity: 1,
    filter: 'none',
    brightness: 1,
    contrast: 1,
    saturate: 1,
    transitionIn: 'none',
    motionEffect: 'none',
    shapeStyle: {
      shapeType: 'points',
      fillColor: '#22d3ee',
      fillOpacity: 0.8,
      fillGradient: {enabled: true, color2: '#a855f7', angle: 90},
      strokeColor: '#ffffff',
      strokeWidth: 6,
      cornerRadius: 0,
      points: [
        {id: 'v1', x: 0.1, y: 0.1, trackerId: beacon.id},
        {id: 'v2', x: 0.2, y: 0.8},
        {id: 'v3', x: 0.8, y: 0.8},
      ],
    },
    keyframes: [
      {
        id: 'pkf-1',
        timeOffset: 0,
        x: 0.5,
        y: 0.5,
        scale: 1,
        rotation: 0,
        opacity: 1,
        shapePoints: [
          {id: 'v1', x: 0.1, y: 0.1, trackerId: beacon.id},
          {id: 'v2', x: 0.2, y: 0.8},
          {id: 'v3', x: 0.8, y: 0.8},
        ],
        easing: 'linear',
      },
      {
        id: 'pkf-2',
        timeOffset: 2.0,
        x: 0.5,
        y: 0.5,
        scale: 1,
        rotation: 0,
        opacity: 1,
        shapePoints: [
          {id: 'v1', x: 0.1, y: 0.1, trackerId: beacon.id},
          {id: 'v2', x: 0.4, y: 0.6},
          {id: 'v3', x: 0.8, y: 0.8},
        ],
        easing: 'linear',
      },
    ],
  };

  // At global t=2.0 (offset 1.0): v1 follows beacon (0.5, 0.5), v2 interpolates manually to (0.3, 0.7)
  const resolved = evaluateShapePoints(polyClip, 2.0, [beacon]);
  assert.equal(resolved.length, 3);
  assert.ok(Math.abs(resolved[0].x - 0.5) < 0.01);
  assert.ok(Math.abs(resolved[0].y - 0.5) < 0.01);
  assert.ok(Math.abs(resolved[1].x - 0.3) < 0.01);
  assert.ok(Math.abs(resolved[1].y - 0.7) < 0.01);
  assert.ok(Math.abs(resolved[2].x - 0.8) < 0.01);
});

