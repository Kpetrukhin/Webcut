import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const publicDir = path.resolve(process.cwd(), 'public');
fs.mkdirSync(publicDir, { recursive: true });

// CRC32 table for valid PNG chunks
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function createPngBuffer(size, drawPixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter type None
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = drawPixel(x, y, size);
      const px = rowStart + 1 + x * 4;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
      raw[px + 3] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const compressed = zlib.deflateSync(raw, { level: 9 });
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

function distToRoundedBox(px, py, cx, cy, hw, hh, r) {
  const dx = Math.max(Math.abs(px - cx) - hw + r, 0);
  const dy = Math.max(Math.abs(py - cy) - hh + r, 0);
  return Math.hypot(dx, dy) - r;
}

function renderIconPixel(x, y, size, maskable) {
  const nx = x / size;
  const ny = y / size;
  const scale = maskable ? 0.68 : 0.84;
  const sx = (nx - 0.5) / scale + 0.5;
  const sy = (ny - 0.5) / scale + 0.5;

  // Background deep obsidian #09090b with subtle top-left sheen
  const bgR = Math.round(9 + (1 - ny) * 8);
  const bgG = Math.round(9 + (1 - ny) * 10);
  const bgB = Math.round(11 + (1 - ny) * 14);

  // Outer frame border (only for non-maskable rounded app icon aesthetic)
  let r = bgR;
  let g = bgG;
  let b = bgB;

  // Left film bracket (cyan #22d3ee)
  const leftTop = distToRoundedBox(sx, sy, 0.34, 0.34, 0.14, 0.065, 0.035);
  const leftStem = distToRoundedBox(sx, sy, 0.25, 0.50, 0.055, 0.22, 0.035);
  const leftBot = distToRoundedBox(sx, sy, 0.34, 0.66, 0.14, 0.065, 0.035);
  const leftShape = Math.min(leftTop, leftStem, leftBot);

  // Right interlocking bracket (white #fafafa)
  const rightTop = distToRoundedBox(sx, sy, 0.66, 0.34, 0.14, 0.065, 0.035);
  const rightStem = distToRoundedBox(sx, sy, 0.75, 0.50, 0.055, 0.22, 0.035);
  const rightBot = distToRoundedBox(sx, sy, 0.66, 0.66, 0.14, 0.065, 0.035);
  const rightShape = Math.min(rightTop, rightStem, rightBot);

  // Center playhead blade (coral #f97316)
  const blade = distToRoundedBox(sx, sy, 0.50, 0.50, 0.032, 0.30, 0.02);

  if (leftShape <= 0) {
    r = 34;
    g = 211;
    b = 238;
  }
  if (rightShape <= 0) {
    r = 244;
    g = 244;
    b = 245;
  }
  if (blade <= 0) {
    r = 249;
    g = 115;
    b = 22;
  }

  return [r, g, b, 255];
}

fs.writeFileSync(
  path.join(publicDir, 'pwa-192x192.png'),
  createPngBuffer(192, (x, y, s) => renderIconPixel(x, y, s, false))
);
fs.writeFileSync(
  path.join(publicDir, 'pwa-512x512.png'),
  createPngBuffer(512, (x, y, s) => renderIconPixel(x, y, s, false))
);
fs.writeFileSync(
  path.join(publicDir, 'pwa-maskable-512x512.png'),
  createPngBuffer(512, (x, y, s) => renderIconPixel(x, y, s, true))
);
fs.writeFileSync(
  path.join(publicDir, 'apple-touch-icon.png'),
  createPngBuffer(180, (x, y, s) => renderIconPixel(x, y, s, false))
);

const svgIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="112" fill="#09090b"/>
  <path d="M220 140h-72a28 28 0 0 0-28 28v176a28 28 0 0 0 28 28h72v-48h-52V188h52v-48z" fill="#22d3ee"/>
  <path d="M292 140h72a28 28 0 0 1 28 28v176a28 28 0 0 1-28 28h-72v-48h52V188h-52v-48z" fill="#f4f4f5"/>
  <rect x="242" y="108" width="28" height="296" rx="14" fill="#f97316"/>
</svg>
`;
fs.writeFileSync(path.join(publicDir, 'icon.svg'), svgIcon);

console.log('Generated PWA icons in public/');
