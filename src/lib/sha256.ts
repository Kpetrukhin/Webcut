const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256SyncHex(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const len = bytes.length;
  const bitLen = len * 8;
  const paddedLen = Math.ceil((len + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[len] = 0x80;

  const dv = new DataView(padded.buffer);
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  dv.setUint32(paddedLen - 8, hi, false);
  dv.setUint32(paddedLen - 4, lo, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = dv.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 =
        ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^
        ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^
        (w[i - 15] >>> 3);
      const s1 =
        ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^
        ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^
        (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 =
        ((e >>> 6) | (e << 26)) ^
        ((e >>> 11) | (e << 21)) ^
        ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 =
        ((a >>> 2) | (a << 30)) ^
        ((a >>> 13) | (a << 19)) ^
        ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((n) => n.toString(16).padStart(8, '0'))
    .join('');
}

export async function sha256Hex(
  input: ArrayBuffer | Uint8Array
): Promise<string> {
  try {
    if (typeof globalThis.crypto?.subtle?.digest === 'function') {
      const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const digest = await globalThis.crypto.subtle.digest('SHA-256', copy.buffer);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    }
  } catch {
    // subtle unavailable on non-HTTPS LAN origins
  }
  return sha256SyncHex(input);
}

export const FAST_FINGERPRINT_CHUNK_BYTES = 64 * 1024; // 64 KB head + 64 KB tail

export function sanitizeMediaExtension(
  originalName?: string,
  mimeType?: string
): string {
  const cleanName = (originalName || '').split(/[?#]/)[0].trim();
  const dotIdx = cleanName.lastIndexOf('.');
  if (dotIdx !== -1 && dotIdx < cleanName.length - 1) {
    const ext = cleanName
      .slice(dotIdx + 1)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 10);
    if (ext) return ext;
  }
  const mime = (mimeType || '').toLowerCase();
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('quicktime')) return 'mov';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('mpeg')) return 'mp3';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('aac') || mime.includes('mp4a')) return 'm4a';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('ttf')) return 'ttf';
  if (mime.includes('otf')) return 'otf';
  if (mime.includes('woff2')) return 'woff2';
  if (mime.includes('woff')) return 'woff';
  return 'bin';
}

export function buildDedupMediaFileName(
  hash: string,
  size: number,
  originalName?: string,
  mimeType?: string
): {baseName: string; relativePath: string; ext: string} {
  const safeHash = hash.toLowerCase().replace(/[^a-f0-9]/g, '').slice(0, 24) || '0'.repeat(24);
  const safeSize = Math.max(0, Math.trunc(size));
  const ext = sanitizeMediaExtension(originalName, mimeType);
  const baseName = `${safeHash}_${safeSize}.${ext}`;
  return {
    baseName,
    relativePath: `media/${baseName}`,
    ext,
  };
}

export async function computeFastMediaFingerprint(blob: Blob): Promise<{
  hash: string;
  size: number;
  fullHex: string;
}> {
  const size = blob.size;
  let sample: Uint8Array;
  if (size <= FAST_FINGERPRINT_CHUNK_BYTES * 2) {
    sample = new Uint8Array(await blob.arrayBuffer());
  } else {
    const [headBuf, tailBuf] = await Promise.all([
      blob.slice(0, FAST_FINGERPRINT_CHUNK_BYTES).arrayBuffer(),
      blob.slice(size - FAST_FINGERPRINT_CHUNK_BYTES, size).arrayBuffer(),
    ]);
    const head = new Uint8Array(headBuf);
    const tail = new Uint8Array(tailBuf);
    sample = new Uint8Array(head.byteLength + tail.byteLength);
    sample.set(head, 0);
    sample.set(tail, head.byteLength);
  }
  const fullHex = await sha256Hex(sample);
  return {
    hash: fullHex.slice(0, 24),
    size,
    fullHex,
  };
}

