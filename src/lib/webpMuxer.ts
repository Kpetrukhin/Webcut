/**
 * Pure TypeScript RIFF Animated WebP muxer.
 * Takes single-frame WebP blobs (e.g. from canvas.toBlob('image/webp'))
 * and assembles a spec-compliant animated WebP container (VP8X + ANIM + ANMF...).
 */

export interface AnimatedWebpFrame {
  webpBytes: Uint8Array;
  durationMs: number;
}

interface ParsedWebpChunks {
  bitstreamChunks: Uint8Array[];
  hasAlpha: boolean;
}

function readFourCC(buf: Uint8Array, offset: number): string {
  return String.fromCharCode(
    buf[offset],
    buf[offset + 1],
    buf[offset + 2],
    buf[offset + 3]
  );
}

function readUint32LE(buf: Uint8Array, offset: number): number {
  return (
    (buf[offset] |
      (buf[offset + 1] << 8) |
      (buf[offset + 2] << 16) |
      (buf[offset + 3] << 24)) >>>
    0
  );
}

function writeFourCC(buf: Uint8Array, offset: number, fourcc: string) {
  buf[offset] = fourcc.charCodeAt(0);
  buf[offset + 1] = fourcc.charCodeAt(1);
  buf[offset + 2] = fourcc.charCodeAt(2);
  buf[offset + 3] = fourcc.charCodeAt(3);
}

function writeUint16LE(buf: Uint8Array, offset: number, val: number) {
  buf[offset] = val & 0xff;
  buf[offset + 1] = (val >> 8) & 0xff;
}

function writeUint24LE(buf: Uint8Array, offset: number, val: number) {
  buf[offset] = val & 0xff;
  buf[offset + 1] = (val >> 8) & 0xff;
  buf[offset + 2] = (val >> 16) & 0xff;
}

function writeUint32LE(buf: Uint8Array, offset: number, val: number) {
  buf[offset] = val & 0xff;
  buf[offset + 1] = (val >> 8) & 0xff;
  buf[offset + 2] = (val >> 16) & 0xff;
  buf[offset + 3] = (val >>> 24) & 0xff;
}

function parseSingleWebpFrame(bytes: Uint8Array): ParsedWebpChunks {
  if (
    bytes.length < 16 ||
    readFourCC(bytes, 0) !== 'RIFF' ||
    readFourCC(bytes, 8) !== 'WEBP'
  ) {
    throw new Error('Браузер вернул неподдерживаемый формат WebP');
  }

  const bitstreamChunks: Uint8Array[] = [];
  let hasAlpha = false;
  let offset = 12;

  while (offset + 8 <= bytes.length) {
    const fourcc = readFourCC(bytes, offset);
    const payloadSize = readUint32LE(bytes, offset + 4);
    const paddedSize = payloadSize + (payloadSize & 1);
    const chunkEnd = offset + 8 + paddedSize;
    if (offset + 8 + payloadSize > bytes.length) break;

    if (fourcc === 'ALPH') {
      hasAlpha = true;
      bitstreamChunks.push(bytes.subarray(offset, Math.min(bytes.length, chunkEnd)));
    } else if (fourcc === 'VP8 ' || fourcc === 'VP8L') {
      if (fourcc === 'VP8L' && offset + 12 < bytes.length) {
        // VP8L bit 4 of byte 4 of bitstream header indicates alpha
        if ((bytes[offset + 12] & 0x10) !== 0) {
          hasAlpha = true;
        }
      }
      bitstreamChunks.push(bytes.subarray(offset, Math.min(bytes.length, chunkEnd)));
    } else if (fourcc === 'VP8X' && payloadSize >= 1) {
      if ((bytes[offset + 8] & 0x10) !== 0) {
        hasAlpha = true;
      }
    }

    offset = chunkEnd;
  }

  if (bitstreamChunks.length === 0) {
    throw new Error('Не удалось прочитать видеопоток кадра WebP');
  }

  return {bitstreamChunks, hasAlpha};
}

export function buildAnimatedWebp(
  frames: AnimatedWebpFrame[],
  width: number,
  height: number,
  loopCount = 0
): Uint8Array {
  if (frames.length === 0) {
    throw new Error('Нет кадров для сборки WebP');
  }

  const parsedFrames = frames.map((f) => ({
    parsed: parseSingleWebpFrame(f.webpBytes),
    durationMs: Math.max(10, Math.min(0xffffff, Math.round(f.durationMs))),
  }));

  const anyAlpha = parsedFrames.some((f) => f.parsed.hasAlpha);

  // VP8X chunk: 8 header + 10 payload = 18 bytes
  const vp8xSize = 18;
  // ANIM chunk: 8 header + 6 payload = 14 bytes
  const animSize = 14;

  let anmfTotalSize = 0;
  const anmfChunkSizes: number[] = [];
  for (const frame of parsedFrames) {
    let subTotal = 0;
    for (const c of frame.parsed.bitstreamChunks) {
      subTotal += c.length + (c.length & 1);
    }
    const payloadSize = 16 + subTotal;
    const paddedPayload = payloadSize + (payloadSize & 1);
    anmfChunkSizes.push(payloadSize);
    anmfTotalSize += 8 + paddedPayload;
  }

  const totalSize = 12 + vp8xSize + animSize + anmfTotalSize;
  const out = new Uint8Array(totalSize);

  // RIFF header
  writeFourCC(out, 0, 'RIFF');
  writeUint32LE(out, 4, totalSize - 8);
  writeFourCC(out, 8, 'WEBP');

  let pos = 12;

  // VP8X chunk
  writeFourCC(out, pos, 'VP8X');
  writeUint32LE(out, pos + 4, 10);
  // Flags: Animation (0x02) + Alpha if any (0x10)
  out[pos + 8] = 0x02 | (anyAlpha ? 0x10 : 0x00);
  out[pos + 9] = 0;
  out[pos + 10] = 0;
  out[pos + 11] = 0;
  writeUint24LE(out, pos + 12, Math.max(0, width - 1));
  writeUint24LE(out, pos + 15, Math.max(0, height - 1));
  pos += vp8xSize;

  // ANIM chunk
  writeFourCC(out, pos, 'ANIM');
  writeUint32LE(out, pos + 4, 6);
  // Background color BGRA (0, 0, 0, 0)
  out[pos + 8] = 0;
  out[pos + 9] = 0;
  out[pos + 10] = 0;
  out[pos + 11] = 0;
  writeUint16LE(out, pos + 12, loopCount & 0xffff);
  pos += animSize;

  // ANMF chunks
  for (let i = 0; i < parsedFrames.length; i++) {
    const frame = parsedFrames[i];
    const payloadSize = anmfChunkSizes[i];

    writeFourCC(out, pos, 'ANMF');
    writeUint32LE(out, pos + 4, payloadSize);
    // Frame X/2, Y/2
    writeUint24LE(out, pos + 8, 0);
    writeUint24LE(out, pos + 11, 0);
    // Frame width-1, height-1
    writeUint24LE(out, pos + 14, Math.max(0, width - 1));
    writeUint24LE(out, pos + 17, Math.max(0, height - 1));
    // Duration ms
    writeUint24LE(out, pos + 20, frame.durationMs);
    // Flags: bit 1 = 1 (do not blend with previous frame), bit 0 = 0 (do not dispose to bg)
    out[pos + 23] = 0x02;

    let subPos = pos + 24;
    for (const chunk of frame.parsed.bitstreamChunks) {
      out.set(chunk, subPos);
      subPos += chunk.length + (chunk.length & 1);
    }

    pos += 8 + payloadSize + (payloadSize & 1);
  }

  return out;
}
