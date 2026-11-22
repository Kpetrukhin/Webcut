export function parseHexRgb(hex: string): [number, number, number] {
  const cleaned = hex.replace('#', '').trim();
  if (cleaned.length === 3) {
    const r = parseInt(cleaned[0] + cleaned[0], 16);
    const g = parseInt(cleaned[1] + cleaned[1], 16);
    const b = parseInt(cleaned[2] + cleaned[2], 16);
    if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
      return [r / 255, g / 255, b / 255];
    }
  }
  if (cleaned.length >= 6) {
    const r = parseInt(cleaned.slice(0, 2), 16);
    const g = parseInt(cleaned.slice(2, 4), 16);
    const b = parseInt(cleaned.slice(4, 6), 16);
    if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
      return [r / 255, g / 255, b / 255];
    }
  }
  return [0, 1, 0];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

const VERTEX_SHADER_SRC = `
  attribute vec2 a_pos;
  varying vec2 v_uv;
  void main() {
    v_uv = vec2(a_pos.x * 0.5 + 0.5, 1.0 - (a_pos.y * 0.5 + 0.5));
    gl_Position = vec4(a_pos, 0.0, 1.0);
  }
`;

const FRAGMENT_SHADER_SRC = `
  precision mediump float;
  varying vec2 v_uv;
  uniform sampler2D u_tex;
  uniform vec3 u_keyColor;
  uniform float u_intensity;
  uniform float u_smoothness;

  vec3 rgb2ycbcr(vec3 c) {
    float y  =  0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
    float cb = -0.168736 * c.r - 0.331264 * c.g + 0.5 * c.b;
    float cr =  0.5 * c.r - 0.418688 * c.g - 0.081312 * c.b;
    return vec3(y, cb, cr);
  }

  void main() {
    vec4 texel = texture2D(u_tex, v_uv);
    if (u_intensity <= 0.001) {
      gl_FragColor = vec4(texel.rgb * texel.a, texel.a);
      return;
    }

    vec3 pxYcc = rgb2ycbcr(texel.rgb);
    vec3 keyYcc = rgb2ycbcr(u_keyColor);

    float chromaDist = distance(pxYcc.yz, keyYcc.yz);
    float rgbDist = distance(texel.rgb, u_keyColor) / 1.73205;
    float colorDist = mix(chromaDist * 1.35, rgbDist, 0.45);

    float threshold = u_intensity * 0.65;
    float feather = max(0.004, u_smoothness * 0.35);
    float mask = smoothstep(threshold, threshold + feather, colorDist);

    float edgeFactor = 1.0 - mask;
    float luma = dot(texel.rgb, vec3(0.299, 0.587, 0.114));
    vec3 despilled = mix(texel.rgb, vec3(luma), clamp(edgeFactor * 0.5, 0.0, 0.5));

    float finalAlpha = texel.a * mask;
    gl_FragColor = vec4(despilled * finalAlpha, finalAlpha);
  }
`;

class WebGLChromaKeyProcessor {
  private canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private texture: WebGLTexture | null = null;
  private uTexLoc: WebGLUniformLocation | null = null;
  private uKeyColorLoc: WebGLUniformLocation | null = null;
  private uIntensityLoc: WebGLUniformLocation | null = null;
  private uSmoothnessLoc: WebGLUniformLocation | null = null;
  private initialized = false;
  private failed = false;

  constructor() {
    this.canvas = document.createElement('canvas');
  }

  private init(): boolean {
    if (this.initialized) return !this.failed;
    this.initialized = true;

    const gl =
      this.canvas.getContext('webgl', {
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        preserveDrawingBuffer: true,
      }) ||
      (this.canvas.getContext('experimental-webgl', {
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        preserveDrawingBuffer: true,
      }) as WebGLRenderingContext | null);

    if (!gl) {
      this.failed = true;
      return false;
    }

    const compileShader = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const vs = compileShader(gl.VERTEX_SHADER, VERTEX_SHADER_SRC);
    const fs = compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SRC);
    if (!vs || !fs) {
      this.failed = true;
      return false;
    }

    const program = gl.createProgram();
    if (!program) {
      this.failed = true;
      return false;
    }

    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      this.failed = true;
      return false;
    }

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW
    );

    const aPos = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    this.gl = gl;
    this.program = program;
    this.texture = texture;
    this.uTexLoc = gl.getUniformLocation(program, 'u_tex');
    this.uKeyColorLoc = gl.getUniformLocation(program, 'u_keyColor');
    this.uIntensityLoc = gl.getUniformLocation(program, 'u_intensity');
    this.uSmoothnessLoc = gl.getUniformLocation(program, 'u_smoothness');

    return true;
  }

  public process(
    media: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement,
    mw: number,
    mh: number,
    keyHex: string,
    intensity: number,
    smoothness: number
  ): HTMLCanvasElement | null {
    if (!this.init() || !this.gl || !this.program || !this.texture) {
      return null;
    }

    const gl = this.gl;
    const maxDim = 1280;
    const scale = Math.min(1, maxDim / Math.max(mw, mh));
    const targetW = Math.max(2, Math.round(mw * scale));
    const targetH = Math.max(2, Math.round(mh * scale));

    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
    }

    gl.viewport(0, 0, targetW, targetH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    try {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        media
      );
    } catch {
      return null;
    }

    const [kr, kg, kb] = parseHexRgb(keyHex);
    gl.uniform1i(this.uTexLoc, 0);
    gl.uniform3f(this.uKeyColorLoc, kr, kg, kb);
    gl.uniform1f(this.uIntensityLoc, Math.max(0, Math.min(1, intensity)));
    gl.uniform1f(this.uSmoothnessLoc, Math.max(0, Math.min(1, smoothness)));

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }
}

let sharedProcessor: WebGLChromaKeyProcessor | null = null;

export function applyChromaKeyShader(
  media: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement,
  mw: number,
  mh: number,
  keyHex: string,
  intensity: number,
  smoothness: number
): HTMLImageElement | HTMLVideoElement | HTMLCanvasElement {
  if (intensity <= 0.001) return media;
  if (!sharedProcessor) {
    sharedProcessor = new WebGLChromaKeyProcessor();
  }
  const processed = sharedProcessor.process(
    media,
    mw,
    mh,
    keyHex,
    intensity,
    smoothness
  );
  return processed ?? media;
}
