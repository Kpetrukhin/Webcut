import type {ClipWarp, WarpMode, WarpPoint} from '../shared/types.ts';

export function createIdentityCorners(): [
  WarpPoint,
  WarpPoint,
  WarpPoint,
  WarpPoint,
] {
  return [
    {x: 0, y: 0},
    {x: 1, y: 0},
    {x: 1, y: 1},
    {x: 0, y: 1},
  ];
}

export function createIdentityMeshPoints(meshSize: 3 | 4): WarpPoint[] {
  const pts: WarpPoint[] = [];
  for (let r = 0; r < meshSize; r++) {
    const v = r / (meshSize - 1);
    for (let c = 0; c < meshSize; c++) {
      const u = c / (meshSize - 1);
      pts.push({x: u, y: v});
    }
  }
  return pts;
}

export function createDefaultWarp(
  mode: WarpMode = 'none',
  meshSize: 3 | 4 = 4
): ClipWarp {
  return {
    mode,
    corners: createIdentityCorners(),
    meshSize,
    meshPoints: createIdentityMeshPoints(meshSize),
  };
}

export function cloneWarp(warp: ClipWarp): ClipWarp {
  return {
    mode: warp.mode,
    corners: [
      {...warp.corners[0]},
      {...warp.corners[1]},
      {...warp.corners[2]},
      {...warp.corners[3]},
    ],
    meshSize: warp.meshSize,
    meshPoints: warp.meshPoints.map((p) => ({x: p.x, y: p.y})),
  };
}

export function normalizeWarp(raw?: ClipWarp): ClipWarp {
  if (!raw) return createDefaultWarp('none', 4);
  const meshSize: 3 | 4 = raw.meshSize === 3 ? 3 : 4;
  const expectedCount = meshSize * meshSize;
  const corners: [WarpPoint, WarpPoint, WarpPoint, WarpPoint] =
    Array.isArray(raw.corners) && raw.corners.length === 4
      ? [
          {x: raw.corners[0].x, y: raw.corners[0].y},
          {x: raw.corners[1].x, y: raw.corners[1].y},
          {x: raw.corners[2].x, y: raw.corners[2].y},
          {x: raw.corners[3].x, y: raw.corners[3].y},
        ]
      : createIdentityCorners();

  const meshPoints =
    Array.isArray(raw.meshPoints) && raw.meshPoints.length === expectedCount
      ? raw.meshPoints.map((p) => ({x: p.x, y: p.y}))
      : createIdentityMeshPoints(meshSize);

  return {
    mode: raw.mode ?? 'none',
    corners,
    meshSize,
    meshPoints,
  };
}

export function resampleMeshGrid(
  oldPoints: WarpPoint[],
  oldSize: 3 | 4,
  newSize: 3 | 4
): WarpPoint[] {
  if (oldSize === newSize && oldPoints.length === newSize * newSize) {
    return oldPoints.map((p) => ({x: p.x, y: p.y}));
  }
  const normalizedOld =
    oldPoints.length === oldSize * oldSize
      ? oldPoints
      : createIdentityMeshPoints(oldSize);
  const out: WarpPoint[] = [];
  for (let r = 0; r < newSize; r++) {
    const v = r / (newSize - 1);
    for (let c = 0; c < newSize; c++) {
      const u = c / (newSize - 1);
      out.push(evalMeshSplinePoint(normalizedOld, oldSize, u, v));
    }
  }
  return out;
}

export function isIdentityWarp(raw?: ClipWarp): boolean {
  if (!raw || raw.mode === 'none') return true;
  const eps = 0.0015;
  if (raw.mode === 'perspective') {
    const def = createIdentityCorners();
    return raw.corners.every(
      (c, i) =>
        Math.abs(c.x - def[i].x) < eps && Math.abs(c.y - def[i].y) < eps
    );
  }
  const meshSize: 3 | 4 = raw.meshSize === 3 ? 3 : 4;
  const defMesh = createIdentityMeshPoints(meshSize);
  if (!raw.meshPoints || raw.meshPoints.length !== defMesh.length) return true;
  return raw.meshPoints.every(
    (p, i) =>
      Math.abs(p.x - defMesh[i].x) < eps && Math.abs(p.y - defMesh[i].y) < eps
  );
}

export function interpolateWarp(
  aRaw: ClipWarp | undefined,
  bRaw: ClipWarp | undefined,
  t: number
): ClipWarp | undefined {
  if (!aRaw && !bRaw) return undefined;
  const a = normalizeWarp(aRaw);
  const b = normalizeWarp(bRaw);
  const clampedT = Math.max(0, Math.min(1, t));

  const mode: WarpMode =
    b.mode !== 'none' ? b.mode : a.mode !== 'none' ? a.mode : 'none';
  if (mode === 'none') return createDefaultWarp('none', b.meshSize);
  if (clampedT <= 0.0001 && a.mode === 'none') {
    return createDefaultWarp('none', a.meshSize);
  }
  if (clampedT >= 0.9999 && b.mode === 'none') {
    return createDefaultWarp('none', b.meshSize);
  }

  const targetSize = b.meshSize;
  const aCorners =
    a.mode === 'none' ? createIdentityCorners() : a.corners;
  const bCorners =
    b.mode === 'none' ? createIdentityCorners() : b.corners;

  const corners: [WarpPoint, WarpPoint, WarpPoint, WarpPoint] = [0, 1, 2, 3].map(
    (i) => ({
      x: aCorners[i].x + (bCorners[i].x - aCorners[i].x) * clampedT,
      y: aCorners[i].y + (bCorners[i].y - aCorners[i].y) * clampedT,
    })
  ) as [WarpPoint, WarpPoint, WarpPoint, WarpPoint];

  const aMesh =
    a.mode === 'none'
      ? createIdentityMeshPoints(targetSize)
      : a.meshSize === targetSize
        ? a.meshPoints
        : resampleMeshGrid(a.meshPoints, a.meshSize, targetSize);
  const bMesh =
    b.mode === 'none'
      ? createIdentityMeshPoints(targetSize)
      : b.meshPoints;

  const meshPoints = bMesh.map((bp, i) => {
    const ap = aMesh[i] ?? bp;
    return {
      x: ap.x + (bp.x - ap.x) * clampedT,
      y: ap.y + (bp.y - ap.y) * clampedT,
    };
  });

  return {
    mode,
    corners,
    meshSize: targetSize,
    meshPoints,
  };
}

/**
 * Maps layer-local normalized (u, v) in [0..1] to Canvas pixels using layer center,
 * size, and rotation in degrees.
 */
export function layerUvToCanvasPx(
  u: number,
  v: number,
  centerX: number,
  centerY: number,
  layerW: number,
  layerH: number,
  rotationDeg: number
): {x: number; y: number} {
  const lx = (u - 0.5) * layerW;
  const ly = (v - 0.5) * layerH;
  if (Math.abs(rotationDeg) < 1e-4) {
    return {x: centerX + lx, y: centerY + ly};
  }
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    x: centerX + lx * cos - ly * sin,
    y: centerY + lx * sin + ly * cos,
  };
}

/**
 * Inverse of layerUvToCanvasPx: maps Canvas pixels back to layer-local (u, v).
 */
export function canvasPxToLayerUv(
  px: number,
  py: number,
  centerX: number,
  centerY: number,
  layerW: number,
  layerH: number,
  rotationDeg: number
): {u: number; v: number} {
  const dx = px - centerX;
  const dy = py - centerY;
  let lx = dx;
  let ly = dy;
  if (Math.abs(rotationDeg) >= 1e-4) {
    const rad = (-rotationDeg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    lx = dx * cos - dy * sin;
    ly = dx * sin + dy * cos;
  }
  return {
    u: lx / Math.max(1, layerW) + 0.5,
    v: ly / Math.max(1, layerH) + 0.5,
  };
}

function catmullRom1D(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

/**
 * Evaluates a smooth bicubic Catmull-Rom surface through a meshSize x meshSize grid.
 */
export function evalMeshSplinePoint(
  meshPoints: WarpPoint[],
  meshSize: 3 | 4,
  u: number,
  v: number
): WarpPoint {
  const n = meshSize;
  const clampedU = Math.max(0, Math.min(1, u));
  const clampedV = Math.max(0, Math.min(1, v));

  const gx = clampedU * (n - 1);
  const gy = clampedV * (n - 1);

  const col = Math.min(n - 2, Math.floor(gx));
  const row = Math.min(n - 2, Math.floor(gy));
  const tx = gx - col;
  const ty = gy - row;

  const getNode = (r: number, c: number): WarpPoint => {
    // Linear phantom reflection for boundary control points (smooth natural tangent at edges)
    if (r < 0) {
      const p0 = getNode(0, c);
      const p1 = getNode(1, c);
      return {x: p0.x * 2 - p1.x, y: p0.y * 2 - p1.y};
    }
    if (r >= n) {
      const pn1 = getNode(n - 1, c);
      const pn2 = getNode(n - 2, c);
      return {x: pn1.x * 2 - pn2.x, y: pn1.y * 2 - pn2.y};
    }
    if (c < 0) {
      const p0 = getNode(r, 0);
      const p1 = getNode(r, 1);
      return {x: p0.x * 2 - p1.x, y: p0.y * 2 - p1.y};
    }
    if (c >= n) {
      const pn1 = getNode(r, n - 1);
      const pn2 = getNode(r, n - 2);
      return {x: pn1.x * 2 - pn2.x, y: pn1.y * 2 - pn2.y};
    }
    return meshPoints[r * n + c] ?? {x: c / (n - 1), y: r / (n - 1)};
  };

  const rowPtsX: number[] = [];
  const rowPtsY: number[] = [];
  for (let dr = -1; dr <= 2; dr++) {
    const p0 = getNode(row + dr, col - 1);
    const p1 = getNode(row + dr, col);
    const p2 = getNode(row + dr, col + 1);
    const p3 = getNode(row + dr, col + 2);
    rowPtsX.push(catmullRom1D(p0.x, p1.x, p2.x, p3.x, tx));
    rowPtsY.push(catmullRom1D(p0.y, p1.y, p2.y, p3.y, tx));
  }

  return {
    x: catmullRom1D(rowPtsX[0], rowPtsX[1], rowPtsX[2], rowPtsX[3], ty),
    y: catmullRom1D(rowPtsY[0], rowPtsY[1], rowPtsY[2], rowPtsY[3], ty),
  };
}

/**
 * Solves 3x3 planar homography mapping unit square:
 *   (0,0) -> dst[0] (TL)
 *   (1,0) -> dst[1] (TR)
 *   (1,1) -> dst[2] (BR)
 *   (0,1) -> dst[3] (BL)
 * Returns column-major 3x3 Float32Array (or null if degenerate).
 */
export function solveUnitSquareHomography(
  dst: [WarpPoint, WarpPoint, WarpPoint, WarpPoint]
): number[] | null {
  const src: WarpPoint[] = [
    {x: 0, y: 0},
    {x: 1, y: 0},
    {x: 1, y: 1},
    {x: 0, y: 1},
  ];

  // Build 8x9 augmented matrix for Ah = b
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const sx = src[i].x;
    const sy = src[i].y;
    const dx = dst[i].x;
    const dy = dst[i].y;
    A.push([sx, sy, 1, 0, 0, 0, -dx * sx, -dx * sy, dx]);
    A.push([0, 0, 0, sx, sy, 1, -dy * sx, -dy * sy, dy]);
  }

  for (let col = 0; col < 8; col++) {
    let pivotRow = col;
    let maxVal = Math.abs(A[col][col]);
    for (let r = col + 1; r < 8; r++) {
      const v = Math.abs(A[r][col]);
      if (v > maxVal) {
        maxVal = v;
        pivotRow = r;
      }
    }
    if (maxVal < 1e-8) return null;
    if (pivotRow !== col) {
      const tmp = A[col];
      A[col] = A[pivotRow];
      A[pivotRow] = tmp;
    }

    const pivot = A[col][col];
    for (let j = col; j <= 8; j++) {
      A[col][j] /= pivot;
    }

    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const factor = A[r][col];
      if (Math.abs(factor) < 1e-12) continue;
      for (let j = col; j <= 8; j++) {
        A[r][j] -= factor * A[col][j];
      }
    }
  }

  const h00 = A[0][8];
  const h01 = A[1][8];
  const h02 = A[2][8];
  const h10 = A[3][8];
  const h11 = A[4][8];
  const h12 = A[5][8];
  const h20 = A[6][8];
  const h21 = A[7][8];
  const h22 = 1;

  // Row-major: [h00, h01, h02, h10, h11, h12, h20, h21, h22]
  return [h00, h01, h02, h10, h11, h12, h20, h21, h22];
}

export function invertMat3RowMajor(m: number[]): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const D = -(b * i - c * h);
  const E = a * i - c * g;
  const F = -(a * h - b * g);
  const G = b * f - c * e;
  const H = -(a * f - c * d);
  const I = a * e - b * d;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-9) return null;
  const invDet = 1 / det;
  return [
    A * invDet,
    D * invDet,
    G * invDet,
    B * invDet,
    E * invDet,
    H * invDet,
    C * invDet,
    F * invDet,
    I * invDet,
  ];
}

export function projectMat3(m: number[], x: number, y: number): {
  x: number;
  y: number;
  w: number;
} {
  const rx = m[0] * x + m[1] * y + m[2];
  const ry = m[3] * x + m[4] * y + m[5];
  const rw = m[6] * x + m[7] * y + m[8];
  return {
    x: Math.abs(rw) > 1e-6 ? rx / rw : rx,
    y: Math.abs(rw) > 1e-6 ? ry / rw : ry,
    w: rw,
  };
}

const PERSP_VS = `
  attribute vec2 a_ndc;
  attribute vec2 a_canvasPos;
  varying vec2 v_canvasPos;
  void main() {
    v_canvasPos = a_canvasPos;
    gl_Position = vec4(a_ndc, 0.0, 1.0);
  }
`;

const PERSP_FS = `
  precision highp float;
  varying vec2 v_canvasPos;
  uniform sampler2D u_tex;
  uniform mat3 u_invH;
  uniform vec4 u_cropRect;
  uniform float u_flipH;
  uniform float u_flipV;
  uniform float u_centerW;

  void main() {
    vec3 srcHom = u_invH * vec3(v_canvasPos, 1.0);
    if (abs(srcHom.z) < 0.0001) discard;
    if (srcHom.z * u_centerW <= 0.0) discard;
    vec2 uv = srcHom.xy / srcHom.z;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
    vec2 flippedUv = vec2(
      u_flipH > 0.5 ? (1.0 - uv.x) : uv.x,
      u_flipV > 0.5 ? (1.0 - uv.y) : uv.y
    );
    vec2 texUv = u_cropRect.xy + flippedUv * u_cropRect.zw;
    gl_FragColor = texture2D(u_tex, texUv);
  }
`;

const MESH_VS = `
  attribute vec2 a_ndc;
  attribute vec2 a_uv;
  varying vec2 v_uv;
  void main() {
    v_uv = a_uv;
    gl_Position = vec4(a_ndc, 0.0, 1.0);
  }
`;

const MESH_FS = `
  precision mediump float;
  varying vec2 v_uv;
  uniform sampler2D u_tex;
  uniform vec4 u_cropRect;
  uniform float u_flipH;
  uniform float u_flipV;

  void main() {
    vec2 flippedUv = vec2(
      u_flipH > 0.5 ? (1.0 - v_uv.x) : v_uv.x,
      u_flipV > 0.5 ? (1.0 - v_uv.y) : v_uv.y
    );
    vec2 texUv = u_cropRect.xy + flippedUv * u_cropRect.zw;
    gl_FragColor = texture2D(u_tex, texUv);
  }
`;

export interface WarpedRenderResult {
  canvas: HTMLCanvasElement;
  outX: number;
  outY: number;
  outW: number;
  outH: number;
}

class WebGLWarpProcessor {
  private canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext | null = null;
  private perspProgram: WebGLProgram | null = null;
  private meshProgram: WebGLProgram | null = null;
  private tex: WebGLTexture | null = null;
  private posBuf: WebGLBuffer | null = null;
  private auxBuf: WebGLBuffer | null = null;
  private initialized = false;
  private failed = false;

  constructor() {
    this.canvas = document.createElement('canvas');
  }

  private init(): boolean {
    if (this.initialized) return !this.failed;
    this.initialized = true;

    const opts: WebGLContextAttributes = {
      alpha: true,
      premultipliedAlpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
    };
    const gl =
      this.canvas.getContext('webgl', opts) ||
      (this.canvas.getContext('experimental-webgl', opts) as WebGLRenderingContext | null);
    if (!gl) {
      this.failed = true;
      return false;
    }

    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type);
      if (!sh) return null;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        gl.deleteShader(sh);
        return null;
      }
      return sh;
    };

    const link = (vsSrc: string, fsSrc: string) => {
      const vs = compile(gl.VERTEX_SHADER, vsSrc);
      const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
      if (!vs || !fs) return null;
      const prog = gl.createProgram();
      if (!prog) return null;
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
      return prog;
    };

    this.perspProgram = link(PERSP_VS, PERSP_FS);
    this.meshProgram = link(MESH_VS, MESH_FS);
    if (!this.perspProgram || !this.meshProgram) {
      this.failed = true;
      return false;
    }

    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    this.posBuf = gl.createBuffer();
    this.auxBuf = gl.createBuffer();
    this.gl = gl;
    return true;
  }

  public render(opts: {
    source: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement;
    cropRect: {x: number; y: number; w: number; h: number};
    flipH: boolean;
    flipV: boolean;
    centerX: number;
    centerY: number;
    layerW: number;
    layerH: number;
    rotationDeg: number;
    warp: ClipWarp;
    cw: number;
    ch: number;
  }): WarpedRenderResult | null {
    if (!this.init() || !this.gl || !this.tex || !this.posBuf || !this.auxBuf) {
      return null;
    }
    const gl = this.gl;
    const {
      source,
      cropRect,
      flipH,
      flipV,
      centerX,
      centerY,
      layerW,
      layerH,
      rotationDeg,
      warp,
      cw,
      ch,
    } = opts;

    // Upload texture with premultiplied alpha so soft borders stay clean
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } catch {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
      return null;
    }
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);

    if (warp.mode === 'perspective') {
      const canvasCorners = warp.corners.map((pt) =>
        layerUvToCanvasPx(pt.x, pt.y, centerX, centerY, layerW, layerH, rotationDeg)
      ) as [WarpPoint, WarpPoint, WarpPoint, WarpPoint];

      const H = solveUnitSquareHomography(canvasCorners);
      const invH = H ? invertMat3RowMajor(H) : null;
      if (!H || !invH) return null;

      // Center of unit square (0.5, 0.5) projected back through invH gives valid half-plane w sign
      const midP = projectMat3(H, 0.5, 0.5);
      const centerCheck =
        invH[6] * midP.x + invH[7] * midP.y + invH[8];
      const centerW = centerCheck >= 0 ? 1 : -1;

      const pad = 4;
      let minX = Math.floor(Math.min(...canvasCorners.map((p) => p.x))) - pad;
      let minY = Math.floor(Math.min(...canvasCorners.map((p) => p.y))) - pad;
      let maxX = Math.ceil(Math.max(...canvasCorners.map((p) => p.x))) + pad;
      let maxY = Math.ceil(Math.max(...canvasCorners.map((p) => p.y))) + pad;

      // Clamp to a reasonable viewport around the composition canvas
      minX = Math.max(-cw, minX);
      minY = Math.max(-ch, minY);
      maxX = Math.min(cw * 2, maxX);
      maxY = Math.min(ch * 2, maxY);

      const outW = Math.max(2, Math.min(2400, maxX - minX));
      const outH = Math.max(2, Math.min(2400, maxY - minY));
      const outX = minX;
      const outY = minY;

      if (this.canvas.width !== outW || this.canvas.height !== outH) {
        this.canvas.width = outW;
        this.canvas.height = outH;
      }

      gl.viewport(0, 0, outW, outH);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      const prog = this.perspProgram!;
      gl.useProgram(prog);

      const ndcArr = new Float32Array([-1, 1, 1, 1, -1, -1, 1, -1]);
      const posArr = new Float32Array([
        outX,
        outY,
        outX + outW,
        outY,
        outX,
        outY + outH,
        outX + outW,
        outY + outH,
      ]);

      const aNdc = gl.getAttribLocation(prog, 'a_ndc');
      const aCanvasPos = gl.getAttribLocation(prog, 'a_canvasPos');

      gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
      gl.bufferData(gl.ARRAY_BUFFER, ndcArr, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(aNdc);
      gl.vertexAttribPointer(aNdc, 2, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.auxBuf);
      gl.bufferData(gl.ARRAY_BUFFER, posArr, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(aCanvasPos);
      gl.vertexAttribPointer(aCanvasPos, 2, gl.FLOAT, false, 0, 0);

      // WebGL mat3 expects column-major order
      const colMajorInvH = new Float32Array([
        invH[0],
        invH[3],
        invH[6],
        invH[1],
        invH[4],
        invH[7],
        invH[2],
        invH[5],
        invH[8],
      ]);

      gl.uniform1i(gl.getUniformLocation(prog, 'u_tex'), 0);
      gl.uniformMatrix3fv(gl.getUniformLocation(prog, 'u_invH'), false, colMajorInvH);
      gl.uniform4f(
        gl.getUniformLocation(prog, 'u_cropRect'),
        cropRect.x,
        cropRect.y,
        cropRect.w,
        cropRect.h
      );
      gl.uniform1f(gl.getUniformLocation(prog, 'u_flipH'), flipH ? 1 : 0);
      gl.uniform1f(gl.getUniformLocation(prog, 'u_flipV'), flipV ? 1 : 0);
      gl.uniform1f(gl.getUniformLocation(prog, 'u_centerW'), centerW);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.disableVertexAttribArray(aNdc);
      gl.disableVertexAttribArray(aCanvasPos);
      return {canvas: this.canvas, outX, outY, outW, outH};
    }

    if (warp.mode === 'mesh') {
      const steps = 22;
      const stride = steps + 1;
      const gridPx: Array<{x: number; y: number; u: number; v: number}> = [];
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;

      for (let r = 0; r <= steps; r++) {
        const v = r / steps;
        for (let c = 0; c <= steps; c++) {
          const u = c / steps;
          const warpedUv = evalMeshSplinePoint(
            warp.meshPoints,
            warp.meshSize,
            u,
            v
          );
          const p = layerUvToCanvasPx(
            warpedUv.x,
            warpedUv.y,
            centerX,
            centerY,
            layerW,
            layerH,
            rotationDeg
          );
          if (p.x < minX) minX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.x > maxX) maxX = p.x;
          if (p.y > maxY) maxY = p.y;
          gridPx.push({x: p.x, y: p.y, u, v});
        }
      }

      const pad = 4;
      const outX = Math.max(-cw, Math.floor(minX) - pad);
      const outY = Math.max(-ch, Math.floor(minY) - pad);
      const clampMaxX = Math.min(cw * 2, Math.ceil(maxX) + pad);
      const clampMaxY = Math.min(ch * 2, Math.ceil(maxY) + pad);
      const outW = Math.max(2, Math.min(2400, clampMaxX - outX));
      const outH = Math.max(2, Math.min(2400, clampMaxY - outY));

      if (this.canvas.width !== outW || this.canvas.height !== outH) {
        this.canvas.width = outW;
        this.canvas.height = outH;
      }

      const triCount = steps * steps * 2;
      const ndcVerts = new Float32Array(triCount * 3 * 2);
      const uvVerts = new Float32Array(triCount * 3 * 2);

      const toNdcX = (px: number) => ((px - outX) / outW) * 2 - 1;
      const toNdcY = (py: number) => 1 - ((py - outY) / outH) * 2;

      let ptr = 0;
      const pushVert = (g: {x: number; y: number; u: number; v: number}) => {
        ndcVerts[ptr] = toNdcX(g.x);
        ndcVerts[ptr + 1] = toNdcY(g.y);
        uvVerts[ptr] = g.u;
        uvVerts[ptr + 1] = g.v;
        ptr += 2;
      };

      for (let r = 0; r < steps; r++) {
        for (let c = 0; c < steps; c++) {
          const i0 = r * stride + c;
          const i1 = i0 + 1;
          const i2 = i0 + stride;
          const i3 = i2 + 1;
          // Triangle 1
          pushVert(gridPx[i0]);
          pushVert(gridPx[i1]);
          pushVert(gridPx[i2]);
          // Triangle 2
          pushVert(gridPx[i1]);
          pushVert(gridPx[i3]);
          pushVert(gridPx[i2]);
        }
      }

      gl.viewport(0, 0, outW, outH);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      const prog = this.meshProgram!;
      gl.useProgram(prog);

      const aNdc = gl.getAttribLocation(prog, 'a_ndc');
      const aUv = gl.getAttribLocation(prog, 'a_uv');

      gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
      gl.bufferData(gl.ARRAY_BUFFER, ndcVerts, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(aNdc);
      gl.vertexAttribPointer(aNdc, 2, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.auxBuf);
      gl.bufferData(gl.ARRAY_BUFFER, uvVerts, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(aUv);
      gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);

      gl.uniform1i(gl.getUniformLocation(prog, 'u_tex'), 0);
      gl.uniform4f(
        gl.getUniformLocation(prog, 'u_cropRect'),
        cropRect.x,
        cropRect.y,
        cropRect.w,
        cropRect.h
      );
      gl.uniform1f(gl.getUniformLocation(prog, 'u_flipH'), flipH ? 1 : 0);
      gl.uniform1f(gl.getUniformLocation(prog, 'u_flipV'), flipV ? 1 : 0);

      gl.drawArrays(gl.TRIANGLES, 0, triCount * 3);
      gl.disableVertexAttribArray(aNdc);
      gl.disableVertexAttribArray(aUv);
      return {canvas: this.canvas, outX, outY, outW, outH};
    }

    return null;
  }
}

let sharedWarpProcessor: WebGLWarpProcessor | null = null;

export function renderWarpedLayer(opts: {
  source: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement;
  cropRect?: {x: number; y: number; w: number; h: number};
  flipH?: boolean;
  flipV?: boolean;
  centerX: number;
  centerY: number;
  layerW: number;
  layerH: number;
  rotationDeg: number;
  warp: ClipWarp;
  cw: number;
  ch: number;
}): WarpedRenderResult | null {
  if (isIdentityWarp(opts.warp)) return null;
  if (!sharedWarpProcessor) {
    sharedWarpProcessor = new WebGLWarpProcessor();
  }
  return sharedWarpProcessor.render({
    source: opts.source,
    cropRect: opts.cropRect ?? {x: 0, y: 0, w: 1, h: 1},
    flipH: Boolean(opts.flipH),
    flipV: Boolean(opts.flipV),
    centerX: opts.centerX,
    centerY: opts.centerY,
    layerW: opts.layerW,
    layerH: opts.layerH,
    rotationDeg: opts.rotationDeg,
    warp: opts.warp,
    cw: opts.cw,
    ch: opts.ch,
  });
}

/**
 * Computes screen-space polygon outline for a warped layer (useful for selection frames & hit testing).
 */
export function getWarpedOutlinePolygon(
  centerX: number,
  centerY: number,
  layerW: number,
  layerH: number,
  rotationDeg: number,
  warp: ClipWarp
): Array<{x: number; y: number}> {
  if (warp.mode === 'perspective') {
    return warp.corners.map((pt) =>
      layerUvToCanvasPx(pt.x, pt.y, centerX, centerY, layerW, layerH, rotationDeg)
    );
  }
  if (warp.mode === 'mesh') {
    const pts: Array<{x: number; y: number}> = [];
    const steps = 10;
    for (let i = 0; i <= steps; i++) {
      const p = evalMeshSplinePoint(warp.meshPoints, warp.meshSize, i / steps, 0);
      pts.push(layerUvToCanvasPx(p.x, p.y, centerX, centerY, layerW, layerH, rotationDeg));
    }
    for (let i = 1; i <= steps; i++) {
      const p = evalMeshSplinePoint(warp.meshPoints, warp.meshSize, 1, i / steps);
      pts.push(layerUvToCanvasPx(p.x, p.y, centerX, centerY, layerW, layerH, rotationDeg));
    }
    for (let i = steps - 1; i >= 0; i--) {
      const p = evalMeshSplinePoint(warp.meshPoints, warp.meshSize, i / steps, 1);
      pts.push(layerUvToCanvasPx(p.x, p.y, centerX, centerY, layerW, layerH, rotationDeg));
    }
    for (let i = steps - 1; i >= 1; i--) {
      const p = evalMeshSplinePoint(warp.meshPoints, warp.meshSize, 0, i / steps);
      pts.push(layerUvToCanvasPx(p.x, p.y, centerX, centerY, layerW, layerH, rotationDeg));
    }
    return pts;
  }
  return [
    layerUvToCanvasPx(0, 0, centerX, centerY, layerW, layerH, rotationDeg),
    layerUvToCanvasPx(1, 0, centerX, centerY, layerW, layerH, rotationDeg),
    layerUvToCanvasPx(1, 1, centerX, centerY, layerW, layerH, rotationDeg),
    layerUvToCanvasPx(0, 1, centerX, centerY, layerW, layerH, rotationDeg),
  ];
}

export function pointInPolygon(
  px: number,
  py: number,
  poly: Array<{x: number; y: number}>
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersect =
      yi > py !== yj > py &&
      px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-9) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
