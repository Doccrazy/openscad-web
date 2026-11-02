import type { M4 } from './math';
import type { PreparedMesh } from './prepare';
import type { RGBA, ViewerTheme } from './theme';

export interface FrameParams {
  viewProj: M4;
  view: M4;
  ortho: boolean;
  /** Canvas size in device pixels. */
  width: number;
  height: number;
  /** Supersampling factor for this frame (>= 1, <= maxSsaa). */
  ssaa: number;
  /** Largest supersampling factor used (render targets are sized for it). */
  maxSsaa: number;
  theme: ViewerTheme;
  showEdges: boolean;
  showGrid: boolean;
  showAxes: boolean;
  peelLayers: number;
  grid: { step: number; extent: number };
  axesLength: number;
}

const MESH_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aColor;
uniform mat4 uViewProj;
uniform mat4 uView;
out vec3 vViewPos;
out vec4 vColor;
void main() {
  vViewPos = (uView * vec4(aPos, 1.0)).xyz;
  vColor = aColor;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

const MESH_FS = `#version 300 es
precision highp float;
in vec3 vViewPos;
in vec4 vColor;
uniform int uPeel;
uniform bool uOrtho;
uniform highp sampler2D uOpaqueDepth;
uniform highp sampler2D uPrevDepth;
out vec4 outColor;
vec3 shade(vec3 base) {
  vec3 n = normalize(cross(dFdx(vViewPos), dFdy(vViewPos)));
  vec3 v = uOrtho ? vec3(0.0, 0.0, 1.0) : normalize(-vViewPos);
  if (dot(n, v) < 0.0) n = -n;
  vec3 l1 = normalize(vec3(0.3, 0.5, 1.0));
  vec3 l2 = normalize(vec3(-0.7, -0.3, 0.35));
  float diff = 0.6 * max(dot(n, l1), 0.0) + 0.2 * max(dot(n, l2), 0.0) + 0.3;
  vec3 h = normalize(l1 + v);
  float spec = pow(max(dot(n, h), 0.0), 48.0) * 0.12;
  return base * diff + vec3(spec);
}
void main() {
  if (uPeel > 0) {
    ivec2 p = ivec2(gl_FragCoord.xy);
    float z = gl_FragCoord.z;
    if (z >= texelFetch(uOpaqueDepth, p, 0).r) discard;
    if (uPeel > 1 && z <= texelFetch(uPrevDepth, p, 0).r) discard;
    outColor = vec4(shade(vColor.rgb) * vColor.a, vColor.a);
  } else {
    outColor = vec4(shade(vColor.rgb), 1.0);
  }
}`;

const LINE_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aColor;
uniform mat4 uViewProj;
uniform vec3 uOffset;
out vec4 vColor;
void main() {
  vColor = aColor;
  gl_Position = uViewProj * vec4(aPos + uOffset, 1.0);
}`;

const LINE_FS = `#version 300 es
precision mediump float;
in vec4 vColor;
out vec4 outColor;
void main() { outColor = vec4(vColor.rgb * vColor.a, vColor.a); }`;

const QUAD_VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Front-to-back accumulation of a peeled layer. */
const PEEL_BLIT_FS = `#version 300 es
precision mediump float;
uniform sampler2D uTex;
out vec4 outColor;
void main() { outColor = texelFetch(uTex, ivec2(gl_FragCoord.xy), 0); }`;

const FINAL_FS = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uOpaque;
uniform sampler2D uAccum;
uniform vec2 uUvScale;
uniform bool uHasAccum;
out vec4 outColor;
void main() {
  vec2 uv = vUv * uUvScale;
  vec4 o = texture(uOpaque, uv);
  if (uHasAccum) {
    vec4 a = texture(uAccum, uv);
    o.rgb = a.rgb + (1.0 - a.a) * o.rgb;
  }
  outColor = vec4(o.rgb, 1.0);
}`;

const BG_FS = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform vec4 uTop;
uniform vec4 uBottom;
out vec4 outColor;
void main() { outColor = mix(uBottom, uTop, vUv.y); }`;

interface GpuMesh {
  vao: WebGLVertexArrayObject;
  buffers: WebGLBuffer[];
  opaque: number;
  transparent: number;
  edgeVao?: WebGLVertexArrayObject;
  edgeCount: number;
}

interface Program {
  prog: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
}

export class WebGLRenderer {
  readonly gl: WebGL2RenderingContext;
  private meshProg!: Program;
  private lineProg!: Program;
  private peelBlitProg!: Program;
  private finalProg!: Program;
  private bgProg!: Program;
  private meshes: GpuMesh[] = [];
  private emptyVao!: WebGLVertexArrayObject;
  private gridVao: WebGLVertexArrayObject | null = null;
  private gridBuf: WebGLBuffer | null = null;
  private gridCount = 0;
  private gridKey = '';
  private targets: {
    w: number;
    h: number;
    opaqueFbo: WebGLFramebuffer;
    opaqueColor: WebGLTexture;
    opaqueDepth: WebGLTexture;
    peelFbo: WebGLFramebuffer[];
    peelColor: WebGLTexture;
    peelDepth: WebGLTexture[];
    accumFbo: WebGLFramebuffer;
    accum: WebGLTexture;
  } | null = null;
  private floatAccum = false;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 not available');
    this.gl = gl;
    this.init();
  }

  private init(): void {
    const gl = this.gl;
    this.floatAccum = !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float');
    this.meshProg = this.program(MESH_VS, MESH_FS, ['uViewProj', 'uView', 'uPeel', 'uOrtho', 'uOpaqueDepth', 'uPrevDepth']);
    this.lineProg = this.program(LINE_VS, LINE_FS, ['uViewProj', 'uOffset']);
    this.peelBlitProg = this.program(QUAD_VS, PEEL_BLIT_FS, ['uTex']);
    this.finalProg = this.program(QUAD_VS, FINAL_FS, ['uOpaque', 'uAccum', 'uUvScale', 'uHasAccum']);
    this.bgProg = this.program(QUAD_VS, BG_FS, ['uTop', 'uBottom']);
    this.emptyVao = gl.createVertexArray()!;
  }

  private program(vs: string, fs: string, uniforms: string[]): Program {
    const gl = this.gl;
    const compile = (type: number, src: string): WebGLShader => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error');
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link error');
    const u: Program['u'] = {};
    for (const name of uniforms) u[name] = gl.getUniformLocation(prog, name);
    return { prog, u };
  }

  setMeshes(meshes: PreparedMesh[]): void {
    const gl = this.gl;
    this.clearMeshes();
    for (const m of meshes) {
      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      const pb = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, pb);
      gl.bufferData(gl.ARRAY_BUFFER, m.positions, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      const cb = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, cb);
      gl.bufferData(gl.ARRAY_BUFFER, m.colors, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 0, 0);
      const gm: GpuMesh = { vao, buffers: [pb, cb], opaque: m.opaqueTriangles, transparent: m.transparentTriangles, edgeCount: 0 };
      if (m.edges && m.edges.length) {
        const evao = gl.createVertexArray()!;
        gl.bindVertexArray(evao);
        const eb = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, eb);
        gl.bufferData(gl.ARRAY_BUFFER, m.edges, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
        gl.disableVertexAttribArray(1);
        gm.edgeVao = evao;
        gm.edgeCount = m.edges.length / 3;
        gm.buffers.push(eb);
      }
      this.meshes.push(gm);
    }
    gl.bindVertexArray(null);
  }

  private clearMeshes(): void {
    const gl = this.gl;
    for (const m of this.meshes) {
      gl.deleteVertexArray(m.vao);
      if (m.edgeVao) gl.deleteVertexArray(m.edgeVao);
      for (const b of m.buffers) gl.deleteBuffer(b);
    }
    this.meshes = [];
  }

  private ensureGrid(step: number, extent: number, theme: ViewerTheme, axesLength: number): void {
    const key = `${step}|${extent}|${theme.grid}|${theme.gridMajor}|${axesLength}`;
    if (key === this.gridKey) return;
    this.gridKey = key;
    const gl = this.gl;
    const data: number[] = [];
    const push = (x: number, y: number, z: number, c: RGBA): void => {
      data.push(x, y, z, c[0], c[1], c[2], c[3]);
    };
    const n = Math.round(extent / step);
    for (let i = -n; i <= n; i++) {
      const c = i % 10 === 0 ? theme.gridMajor : theme.grid;
      const v = i * step;
      push(v, -extent, 0, c); push(v, extent, 0, c);
      push(-extent, v, 0, c); push(extent, v, 0, c);
    }
    this.gridCount = data.length / 7;
    // axes (stored after the grid)
    const L = axesLength;
    const ax: [number, number, number, RGBA][] = [
      [L, 0, 0, [0.85, 0.2, 0.2, 1]], [0, L, 0, [0.2, 0.7, 0.2, 1]], [0, 0, L, [0.2, 0.35, 0.9, 1]],
    ];
    for (const [x, y, z, c] of ax) {
      push(0, 0, 0, c); push(x, y, z, c);
      const cn: RGBA = [c[0], c[1], c[2], 0.35];
      push(0, 0, 0, cn); push(-x, -y, -z, cn);
    }
    if (!this.gridVao) {
      this.gridVao = gl.createVertexArray();
      this.gridBuf = gl.createBuffer();
    }
    gl.bindVertexArray(this.gridVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.gridBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12);
    gl.bindVertexArray(null);
  }

  private texture(w: number, h: number, internal: number, format: number, type: number, filter: number): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    void format; void type;
    return t;
  }

  private fbo(color: WebGLTexture, depth: WebGLTexture | null): WebGLFramebuffer {
    const gl = this.gl;
    const f = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
    if (depth) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Framebuffer incomplete: ' + status);
    return f;
  }

  private ensureTargets(w: number, h: number): void {
    const t = this.targets;
    if (t && t.w === w && t.h === h) return;
    this.deleteTargets();
    const gl = this.gl;
    const opaqueColor = this.texture(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
    const opaqueDepth = this.texture(w, h, gl.DEPTH_COMPONENT32F, gl.DEPTH_COMPONENT, gl.FLOAT, gl.NEAREST);
    const peelColor = this.texture(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
    const peelDepth = [0, 1].map(() => this.texture(w, h, gl.DEPTH_COMPONENT32F, gl.DEPTH_COMPONENT, gl.FLOAT, gl.NEAREST));
    let accum: WebGLTexture;
    let accumFbo: WebGLFramebuffer;
    try {
      accum = this.texture(w, h, this.floatAccum ? gl.RGBA16F : gl.RGBA8, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR);
      accumFbo = this.fbo(accum, null);
    } catch {
      this.floatAccum = false;
      accum = this.texture(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
      accumFbo = this.fbo(accum, null);
    }
    this.targets = {
      w,
      h,
      opaqueFbo: this.fbo(opaqueColor, opaqueDepth),
      opaqueColor,
      opaqueDepth,
      peelFbo: peelDepth.map((d) => this.fbo(peelColor, d)),
      peelColor,
      peelDepth,
      accumFbo,
      accum,
    };
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private deleteTargets(): void {
    const t = this.targets;
    if (!t) return;
    const gl = this.gl;
    for (const f of [t.opaqueFbo, t.accumFbo, ...t.peelFbo]) gl.deleteFramebuffer(f);
    for (const x of [t.opaqueColor, t.opaqueDepth, t.peelColor, t.accum, ...t.peelDepth]) gl.deleteTexture(x);
    this.targets = null;
  }

  render(p: FrameParams): void {
    const gl = this.gl;
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    // allocate targets for the best quality; draw into a sub-rectangle for cheaper frames
    const fullScale = Math.max(1, p.maxSsaa, p.ssaa);
    const tw = Math.min(maxTex, Math.max(1, Math.round(p.width * fullScale)));
    const th = Math.min(maxTex, Math.max(1, Math.round(p.height * fullScale)));
    this.ensureTargets(tw, th);
    const t = this.targets!;
    const vw = Math.min(tw, Math.max(1, Math.round(p.width * p.ssaa)));
    const vh = Math.min(th, Math.max(1, Math.round(p.height * p.ssaa)));

    // ---- opaque pass --------------------------------------------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.opaqueFbo);
    gl.viewport(0, 0, vw, vh);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.clearDepth(1);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    // background
    gl.useProgram(this.bgProg.prog);
    gl.uniform4fv(this.bgProg.u.uTop, p.theme.background);
    gl.uniform4fv(this.bgProg.u.uBottom, p.theme.backgroundBottom ?? p.theme.background);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.useProgram(this.meshProg.prog);
    gl.uniformMatrix4fv(this.meshProg.u.uViewProj, false, p.viewProj);
    gl.uniformMatrix4fv(this.meshProg.u.uView, false, p.view);
    gl.uniform1i(this.meshProg.u.uOrtho, p.ortho ? 1 : 0);
    gl.uniform1i(this.meshProg.u.uPeel, 0);
    gl.uniform1i(this.meshProg.u.uOpaqueDepth, 0);
    gl.uniform1i(this.meshProg.u.uPrevDepth, 1);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1, 1);
    for (const m of this.meshes) {
      if (!m.opaque) continue;
      gl.bindVertexArray(m.vao);
      gl.drawArrays(gl.TRIANGLES, 0, m.opaque * 3);
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);

    // lines: edges, grid, axes (blended, no depth write)
    gl.useProgram(this.lineProg.prog);
    gl.uniformMatrix4fv(this.lineProg.u.uViewProj, false, p.viewProj);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.depthFunc(gl.LEQUAL);
    if (p.showEdges) {
      gl.uniform3f(this.lineProg.u.uOffset, 0, 0, 0);
      for (const m of this.meshes) {
        if (!m.edgeVao) continue;
        gl.bindVertexArray(m.edgeVao);
        gl.vertexAttrib4fv(1, p.theme.edges);
        gl.drawArrays(gl.LINES, 0, m.edgeCount);
      }
    }
    if (p.showGrid || p.showAxes) {
      this.ensureGrid(p.grid.step, p.grid.extent, p.theme, p.axesLength);
      gl.bindVertexArray(this.gridVao);
      gl.depthFunc(gl.LESS);
      if (p.showGrid) {
        // push the grid slightly below z=0 so 2D shapes are not hidden by it
        gl.uniform3f(this.lineProg.u.uOffset, 0, 0, -p.grid.extent * 2e-5);
        gl.drawArrays(gl.LINES, 0, this.gridCount);
      }
      if (p.showAxes) {
        gl.uniform3f(this.lineProg.u.uOffset, 0, 0, 0);
        gl.drawArrays(gl.LINES, this.gridCount, 12);
      }
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);

    // ---- transparent pass: depth peeling ---------------------------------------------
    const hasTransparent = this.meshes.some((m) => m.transparent > 0);
    if (hasTransparent) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.accumFbo);
      gl.viewport(0, 0, vw, vh);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, t.opaqueDepth);
      for (let layer = 0; layer < p.peelLayers; layer++) {
        const cur = layer % 2;
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.peelFbo[cur]);
        gl.viewport(0, 0, vw, vh);
        gl.clearColor(0, 0, 0, 0);
        gl.clearDepth(1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LESS);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
        gl.useProgram(this.meshProg.prog);
        gl.uniform1i(this.meshProg.u.uPeel, layer === 0 ? 1 : 2);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, t.opaqueDepth);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, t.peelDepth[1 - cur]);
        for (const m of this.meshes) {
          if (!m.transparent) continue;
          gl.bindVertexArray(m.vao);
          gl.drawArrays(gl.TRIANGLES, m.opaque * 3, m.transparent * 3);
        }
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.activeTexture(gl.TEXTURE0);

        // accumulate front to back (under operator)
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.accumFbo);
        gl.disable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(gl.ONE_MINUS_DST_ALPHA, gl.ONE, gl.ONE_MINUS_DST_ALPHA, gl.ONE);
        gl.useProgram(this.peelBlitProg.prog);
        gl.uniform1i(this.peelBlitProg.u.uTex, 0);
        gl.bindTexture(gl.TEXTURE_2D, t.peelColor);
        gl.bindVertexArray(this.emptyVao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.disable(gl.BLEND);
      }
    }

    // ---- composite to canvas -----------------------------------------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, p.width, p.height);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.finalProg.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t.opaqueColor);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, t.accum);
    gl.uniform1i(this.finalProg.u.uOpaque, 0);
    gl.uniform1i(this.finalProg.u.uAccum, 1);
    gl.uniform1i(this.finalProg.u.uHasAccum, hasTransparent ? 1 : 0);
    gl.uniform2f(this.finalProg.u.uUvScale, vw / t.w, vh / t.h);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    this.clearMeshes();
    this.deleteTargets();
    const gl = this.gl;
    if (this.gridVao) gl.deleteVertexArray(this.gridVao);
    if (this.gridBuf) gl.deleteBuffer(this.gridBuf);
    for (const p of [this.meshProg, this.lineProg, this.peelBlitProg, this.finalProg, this.bgProg]) gl.deleteProgram(p.prog);
  }
}
