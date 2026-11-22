import {
  buildRgbaCurveLut,
  isNeutralColorGrade,
  type EffectiveColorGrade,
} from './colorPresets.ts';

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
  uniform sampler2D u_curveLut;
  uniform vec2 u_texelSize;
  uniform float u_brightness;
  uniform float u_contrast;
  uniform float u_saturate;
  uniform float u_sharpness;
  uniform float u_shadows;
  uniform float u_hueRad;
  uniform float u_temperature;
  uniform float u_fade;
  uniform float u_grain;
  uniform float u_grainSeed;

  void main() {
    vec4 texel = texture2D(u_tex, v_uv);
    vec3 c = texel.rgb;

    // 1. Sharpness (3x3 unsharp mask)
    if (u_sharpness > 0.001) {
      vec3 n = texture2D(u_tex, clamp(v_uv + vec2(0.0, -u_texelSize.y), 0.0, 1.0)).rgb;
      vec3 s = texture2D(u_tex, clamp(v_uv + vec2(0.0,  u_texelSize.y), 0.0, 1.0)).rgb;
      vec3 e = texture2D(u_tex, clamp(v_uv + vec2( u_texelSize.x, 0.0), 0.0, 1.0)).rgb;
      vec3 w = texture2D(u_tex, clamp(v_uv + vec2(-u_texelSize.x, 0.0), 0.0, 1.0)).rgb;
      vec3 blur = (n + s + e + w) * 0.25;
      c = clamp(c + (c - blur) * (u_sharpness * 1.85), 0.0, 1.0);
    }

    // 2. Temperature (warm/cool color balance matrix)
    if (abs(u_temperature) > 0.001) {
      c.r = clamp(c.r + u_temperature * 0.14, 0.0, 1.0);
      c.g = clamp(c.g + u_temperature * 0.025, 0.0, 1.0);
      c.b = clamp(c.b - u_temperature * 0.14, 0.0, 1.0);
    }

    // 3. Hue rotation (Rodrigues rotation around luma diagonal)
    if (abs(u_hueRad) > 0.001) {
      const vec3 k = vec3(0.57735026919);
      float cosA = cos(u_hueRad);
      c = c * cosA + cross(k, c) * sin(u_hueRad) + k * dot(k, c) * (1.0 - cosA);
      c = clamp(c, 0.0, 1.0);
    }

    // 4. Brightness
    if (abs(u_brightness - 1.0) > 0.001) {
      c = clamp(c * u_brightness + (u_brightness - 1.0) * 0.06, 0.0, 1.0);
    }

    // 5. Contrast
    if (abs(u_contrast - 1.0) > 0.001) {
      c = clamp((c - 0.5) * u_contrast + 0.5, 0.0, 1.0);
    }

    // 6. Shadows (lift or deepen dark tones)
    if (abs(u_shadows) > 0.001) {
      float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
      float shadowMask = pow(1.0 - clamp(lum, 0.0, 1.0), 2.0);
      if (u_shadows > 0.0) {
        c = clamp(c + shadowMask * u_shadows * 0.42, 0.0, 1.0);
      } else {
        c = clamp(c * (1.0 + shadowMask * u_shadows * 0.65), 0.0, 1.0);
      }
    }

    // 7. Saturation
    if (abs(u_saturate - 1.0) > 0.001) {
      float lumSat = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = clamp(mix(vec3(lumSat), c, u_saturate), 0.0, 1.0);
    }

    // 8. Fade (matte black-point lift)
    if (u_fade > 0.001) {
      float lift = u_fade * 0.22;
      c = clamp(c * (1.0 - lift * 0.55) + lift, 0.0, 1.0);
    }

    // 9. RGB Curves LUT (256x1 RGBA texture)
    c.r = texture2D(u_curveLut, vec2((c.r * 255.0 + 0.5) / 256.0, 0.5)).r;
    c.g = texture2D(u_curveLut, vec2((c.g * 255.0 + 0.5) / 256.0, 0.5)).g;
    c.b = texture2D(u_curveLut, vec2((c.b * 255.0 + 0.5) / 256.0, 0.5)).b;

    // 10. Film Grain
    if (u_grain > 0.001) {
      float noise = fract(
        sin(dot(v_uv * 960.0 + vec2(u_grainSeed, u_grainSeed * 1.37), vec2(12.9898, 78.233))) * 43758.5453
      );
      float g = (noise - 0.5) * u_grain * 0.22;
      c = clamp(c + vec3(g), 0.0, 1.0);
    }

    gl_FragColor = vec4(c * texel.a, texel.a);
  }
`;

class WebGLColorGradeProcessor {
  private canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private sourceTex: WebGLTexture | null = null;
  private curveLutTex: WebGLTexture | null = null;
  private lastCurveKey = '';
  private initialized = false;
  private failed = false;

  private uTexLoc: WebGLUniformLocation | null = null;
  private uCurveLutLoc: WebGLUniformLocation | null = null;
  private uTexelSizeLoc: WebGLUniformLocation | null = null;
  private uBrightnessLoc: WebGLUniformLocation | null = null;
  private uContrastLoc: WebGLUniformLocation | null = null;
  private uSaturateLoc: WebGLUniformLocation | null = null;
  private uSharpnessLoc: WebGLUniformLocation | null = null;
  private uShadowsLoc: WebGLUniformLocation | null = null;
  private uHueRadLoc: WebGLUniformLocation | null = null;
  private uTemperatureLoc: WebGLUniformLocation | null = null;
  private uFadeLoc: WebGLUniformLocation | null = null;
  private uGrainLoc: WebGLUniformLocation | null = null;
  private uGrainSeedLoc: WebGLUniformLocation | null = null;

  constructor() {
    this.canvas = document.createElement('canvas');
  }

  private init(): boolean {
    if (this.initialized) return !this.failed;
    this.initialized = true;

    const opts: WebGLContextAttributes = {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      preserveDrawingBuffer: true,
    };
    const gl =
      this.canvas.getContext('webgl', opts) ||
      (this.canvas.getContext('experimental-webgl', opts) as WebGLRenderingContext | null);

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

    const sourceTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, sourceTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    const curveLutTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, curveLutTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    this.gl = gl;
    this.program = program;
    this.sourceTex = sourceTex;
    this.curveLutTex = curveLutTex;

    this.uTexLoc = gl.getUniformLocation(program, 'u_tex');
    this.uCurveLutLoc = gl.getUniformLocation(program, 'u_curveLut');
    this.uTexelSizeLoc = gl.getUniformLocation(program, 'u_texelSize');
    this.uBrightnessLoc = gl.getUniformLocation(program, 'u_brightness');
    this.uContrastLoc = gl.getUniformLocation(program, 'u_contrast');
    this.uSaturateLoc = gl.getUniformLocation(program, 'u_saturate');
    this.uSharpnessLoc = gl.getUniformLocation(program, 'u_sharpness');
    this.uShadowsLoc = gl.getUniformLocation(program, 'u_shadows');
    this.uHueRadLoc = gl.getUniformLocation(program, 'u_hueRad');
    this.uTemperatureLoc = gl.getUniformLocation(program, 'u_temperature');
    this.uFadeLoc = gl.getUniformLocation(program, 'u_fade');
    this.uGrainLoc = gl.getUniformLocation(program, 'u_grain');
    this.uGrainSeedLoc = gl.getUniformLocation(program, 'u_grainSeed');

    return true;
  }

  public process(
    media: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement,
    mw: number,
    mh: number,
    grade: EffectiveColorGrade,
    timeSec: number
  ): HTMLCanvasElement | null {
    if (
      !this.init() ||
      !this.gl ||
      !this.program ||
      !this.sourceTex ||
      !this.curveLutTex
    ) {
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
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);
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

    const curveKey = JSON.stringify(grade.curves);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.curveLutTex);
    if (curveKey !== this.lastCurveKey) {
      this.lastCurveKey = curveKey;
      const rgbaLut = buildRgbaCurveLut(grade.curves);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        256,
        1,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        rgbaLut
      );
    }

    gl.uniform1i(this.uTexLoc, 0);
    gl.uniform1i(this.uCurveLutLoc, 1);
    gl.uniform2f(this.uTexelSizeLoc, 1 / targetW, 1 / targetH);
    gl.uniform1f(this.uBrightnessLoc, Math.max(0, Math.min(2, grade.brightness)));
    gl.uniform1f(this.uContrastLoc, Math.max(0, Math.min(2, grade.contrast)));
    gl.uniform1f(this.uSaturateLoc, Math.max(0, Math.min(2, grade.saturate)));
    gl.uniform1f(
      this.uSharpnessLoc,
      Math.max(0, Math.min(1, grade.sharpness / 100))
    );
    gl.uniform1f(
      this.uShadowsLoc,
      Math.max(-1, Math.min(1, grade.shadows / 100))
    );
    gl.uniform1f(this.uHueRadLoc, (grade.hue * Math.PI) / 180);
    gl.uniform1f(
      this.uTemperatureLoc,
      Math.max(-1, Math.min(1, grade.temperature / 100))
    );
    gl.uniform1f(this.uFadeLoc, Math.max(0, Math.min(1, grade.fade / 100)));
    gl.uniform1f(this.uGrainLoc, Math.max(0, Math.min(1, grade.grain / 100)));
    gl.uniform1f(this.uGrainSeedLoc, Math.floor(timeSec * 24) * 0.17 + 1.3);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }
}

let sharedGradeProcessor: WebGLColorGradeProcessor | null = null;

export function applyColorGradeShader(
  media: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement,
  mw: number,
  mh: number,
  grade: EffectiveColorGrade,
  timeSec: number
): HTMLImageElement | HTMLVideoElement | HTMLCanvasElement {
  if (isNeutralColorGrade(grade)) return media;
  if (!sharedGradeProcessor) {
    sharedGradeProcessor = new WebGLColorGradeProcessor();
  }
  const processed = sharedGradeProcessor.process(
    media,
    mw,
    mh,
    grade,
    timeSec
  );
  return processed ?? media;
}
