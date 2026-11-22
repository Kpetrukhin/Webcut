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
  encodePatchForSync,
  normalizeProjectTracks,
} from '../src/shared/types.ts';
import type {Clip, ProjectState, ServerWsMessage} from '../src/shared/types.ts';
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
