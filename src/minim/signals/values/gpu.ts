// gpu.ts — shared WebGL2 core for GPU-resident Canvas values.
//
// There is ONE compute context (a hidden canvas). That is a hard WebGL
// constraint, not a shared buffer: a lens pass samples its parent's texture
// and renders into its child's, and textures can't cross contexts (browsers
// also cap contexts at ~16). Every Canvas value still owns its own float
// texture(s); display blits each value into its own DOM canvas. The only
// CPU readbacks are 1×1 reductions (mean colour, settle energy).
//
// Coordinate convention: data row 0 lives at texture v=0, so every compute
// pass works in a single consistent data space (no flips); only `blit`
// flips Y so the image reads upright on screen.

let _gl: WebGL2RenderingContext | null = null;

/** Lazily create the shared WebGL2 context (browser-only). */
export function gl(): WebGL2RenderingContext {
  if (_gl) return _gl;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: false });
  if (!ctx) throw new Error("WebGL2 unavailable");
  if (!ctx.getExtension("EXT_color_buffer_float"))
    throw new Error("EXT_color_buffer_float unavailable");
  _gl = ctx;
  return ctx;
}

const QUAD = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

interface Prog {
  prog: WebGLProgram;
  locs: Map<string, WebGLUniformLocation | null>;
}
const progCache = new Map<string, Prog>();

function compile(g: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = g.createShader(type)!;
  g.shaderSource(sh, src);
  g.compileShader(sh);
  if (!g.getShaderParameter(sh, g.COMPILE_STATUS)) {
    const log = g.getShaderInfoLog(sh);
    g.deleteShader(sh);
    throw new Error(`shader compile: ${log}`);
  }
  return sh;
}

function program(frag: string): Prog {
  let p = progCache.get(frag);
  if (p) return p;
  const g = gl();
  const prog = g.createProgram()!;
  g.attachShader(prog, compile(g, g.VERTEX_SHADER, VERT));
  g.attachShader(prog, compile(g, g.FRAGMENT_SHADER, frag));
  g.bindAttribLocation(prog, 0, "a_pos");
  g.linkProgram(prog);
  if (!g.getProgramParameter(prog, g.LINK_STATUS))
    throw new Error(`link: ${g.getProgramInfoLog(prog)}`);
  p = { prog, locs: new Map() };
  progCache.set(frag, p);
  return p;
}

let _vao: WebGLVertexArrayObject | null = null;
function vao(): WebGLVertexArrayObject {
  if (_vao) return _vao;
  const g = gl();
  _vao = g.createVertexArray()!;
  g.bindVertexArray(_vao);
  const buf = g.createBuffer()!;
  g.bindBuffer(g.ARRAY_BUFFER, buf);
  g.bufferData(g.ARRAY_BUFFER, QUAD, g.STATIC_DRAW);
  g.enableVertexAttribArray(0);
  g.vertexAttribPointer(0, 2, g.FLOAT, false, 0, 0);
  g.bindVertexArray(null);
  return _vao;
}

let _fbo: WebGLFramebuffer | null = null;
function fbo(): WebGLFramebuffer {
  if (!_fbo) _fbo = gl().createFramebuffer()!;
  return _fbo;
}

/** A GPU-resident image: a texture plus its dimensions. */
export interface Tex {
  tex: WebGLTexture;
  w: number;
  h: number;
}

/** Allocate an RGBA32F texture (`data` in 0–1 floats, or null). */
export function newTex(w: number, h: number, data: Float32Array | null = null): WebGLTexture {
  const g = gl();
  const t = g.createTexture()!;
  g.bindTexture(g.TEXTURE_2D, t);
  g.texImage2D(g.TEXTURE_2D, 0, g.RGBA32F, w, h, 0, g.RGBA, g.FLOAT, data);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
  return t;
}

export function disposeTex(t: WebGLTexture): void {
  gl().deleteTexture(t);
}

/** A reusable owned texture, reallocated on size change — the GPU analog of
 *  the CPU scratch buffer. */
export function scratch(): (w: number, h: number) => Tex {
  let t: WebGLTexture | null = null;
  let cw = 0;
  let ch = 0;
  return (w, h) => {
    if (!t || cw !== w || ch !== h) {
      if (t) disposeTex(t);
      t = newTex(w, h);
      cw = w;
      ch = h;
    }
    return { tex: t, w, h };
  };
}

/** A feedback-safe scratch pair: returns an owned texture guaranteed not to
 *  equal `avoid` (the input being read), so a pass never reads and writes the
 *  same texture. Needed for backward passes that produce a root cell's next
 *  value (whose current value may be this same scratch). */
export function scratch2(): (w: number, h: number, avoid: WebGLTexture | null) => Tex {
  let a: WebGLTexture | null = null;
  let b: WebGLTexture | null = null;
  let cw = 0;
  let ch = 0;
  return (w, h, avoid) => {
    if (!a || !b || cw !== w || ch !== h) {
      if (a) disposeTex(a);
      if (b) disposeTex(b);
      a = newTex(w, h);
      b = newTex(w, h);
      cw = w;
      ch = h;
    }
    return avoid === a ? { tex: b, w, h } : { tex: a, w, h };
  };
}

const COPY = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_s;
out vec4 o;
void main() { o = texture(u_s, v_uv); }`;

/** Copy `srcTex` into `dst` (distinct textures). */
export function copy(srcTex: WebGLTexture, dst: Tex): void {
  pass(COPY, dst, s => s.tex("u_s", 0, srcTex));
}

function loc(p: Prog, name: string): WebGLUniformLocation | null {
  if (p.locs.has(name)) return p.locs.get(name)!;
  const l = gl().getUniformLocation(p.prog, name);
  p.locs.set(name, l);
  return l;
}

/** Uniform setters passed to a `pass` callback. */
export interface Setup {
  tex(name: string, unit: number, t: WebGLTexture): void;
  f(name: string, v: number): void;
  i(name: string, v: number): void;
  v2(name: string, a: number, b: number): void;
  v3(name: string, a: number, b: number, c: number): void;
  i2(name: string, a: number, b: number): void;
}

/** Run a fragment shader into `target`, configured by `setup`. */
export function pass(frag: string, target: Tex, setup: (s: Setup) => void): void {
  const g = gl();
  const p = program(frag);
  g.bindFramebuffer(g.FRAMEBUFFER, fbo());
  g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, target.tex, 0);
  g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT1, g.TEXTURE_2D, null, 0);
  g.drawBuffers([g.COLOR_ATTACHMENT0]);
  g.viewport(0, 0, target.w, target.h);
  g.useProgram(p.prog);
  const s: Setup = {
    tex: (name, unit, t) => {
      g.activeTexture(g.TEXTURE0 + unit);
      g.bindTexture(g.TEXTURE_2D, t);
      g.uniform1i(loc(p, name), unit);
    },
    f: (name, v) => g.uniform1f(loc(p, name), v),
    i: (name, v) => g.uniform1i(loc(p, name), v),
    v2: (name, a, b) => g.uniform2f(loc(p, name), a, b),
    v3: (name, a, b, c) => g.uniform3f(loc(p, name), a, b, c),
    i2: (name, a, b) => g.uniform2i(loc(p, name), a, b),
  };
  setup(s);
  g.bindVertexArray(vao());
  g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
  g.bindVertexArray(null);
}

// ── reduction (parallel sum via 2× pyramid) ─────────────────────────
const SUM4 = `#version 300 es
precision highp float;
uniform highp sampler2D u_src;
uniform ivec2 u_size;
out vec4 o;
void main() {
  ivec2 d = ivec2(gl_FragCoord.xy);
  ivec2 s = d * 2;
  vec4 sum = texelFetch(u_src, s, 0);
  bool rx = s.x + 1 < u_size.x;
  bool ry = s.y + 1 < u_size.y;
  if (rx) sum += texelFetch(u_src, ivec2(s.x + 1, s.y), 0);
  if (ry) sum += texelFetch(u_src, ivec2(s.x, s.y + 1), 0);
  if (rx && ry) sum += texelFetch(u_src, ivec2(s.x + 1, s.y + 1), 0);
  o = sum;
}`;

const SQUARE = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 o;
void main() { vec4 v = texture(u_src, v_uv); o = v * v; }`;

const reducePool = new Map<string, Tex>();
function poolTex(w: number, h: number): Tex {
  const key = `${w}x${h}`;
  let t = reducePool.get(key);
  if (!t) {
    t = { tex: newTex(w, h), w, h };
    reducePool.set(key, t);
  }
  return t;
}

/** Mean of all texels (RGBA, 0–1) via GPU pyramid reduction; one 1×1
 *  readback. */
export function reduceMean(src: Tex): [number, number, number, number] {
  let cur = src.tex;
  let cw = src.w;
  let ch = src.h;
  while (cw > 1 || ch > 1) {
    const nw = Math.ceil(cw / 2);
    const nh = Math.ceil(ch / 2);
    const dst = poolTex(nw, nh);
    pass(SUM4, dst, s => {
      s.tex("u_src", 0, cur);
      s.i2("u_size", cw, ch);
    });
    cur = dst.tex;
    cw = nw;
    ch = nh;
  }
  const g = gl();
  g.bindFramebuffer(g.FRAMEBUFFER, fbo());
  g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, cur, 0);
  const buf = new Float32Array(4);
  g.readPixels(0, 0, 1, 1, g.RGBA, g.FLOAT, buf);
  const n = src.w * src.h;
  return [buf[0]! / n, buf[1]! / n, buf[2]! / n, buf[3]! / n];
}

let _sq: Tex | null = null;
/** Mean of squared texels — the spring settle metric. */
export function reduceMeanSquare(src: Tex): number {
  if (!_sq || _sq.w !== src.w || _sq.h !== src.h) {
    if (_sq) disposeTex(_sq.tex);
    _sq = { tex: newTex(src.w, src.h), w: src.w, h: src.h };
  }
  pass(SQUARE, _sq, s => s.tex("u_src", 0, src.tex));
  const m = reduceMean(_sq);
  return (m[0] + m[1] + m[2] + m[3]) / 4;
}

// ── display ─────────────────────────────────────────────────────────
const DISPLAY = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 o;
void main() {
  vec3 c = texture(u_src, vec2(v_uv.x, 1.0 - v_uv.y)).rgb;
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

/** Render `src` to a 2D canvas (GPU draw + drawImage; no CPU readback). */
export function blit(src: Tex, ctx: CanvasRenderingContext2D): void {
  const g = gl();
  const glc = g.canvas as HTMLCanvasElement;
  if (glc.width !== src.w || glc.height !== src.h) {
    glc.width = src.w;
    glc.height = src.h;
  }
  g.bindFramebuffer(g.FRAMEBUFFER, null);
  g.viewport(0, 0, src.w, src.h);
  const p = program(DISPLAY);
  g.useProgram(p.prog);
  g.activeTexture(g.TEXTURE0);
  g.bindTexture(g.TEXTURE_2D, src.tex);
  g.uniform1i(loc(p, "u_src"), 0);
  g.bindVertexArray(vao());
  g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
  g.bindVertexArray(null);
  const cv = ctx.canvas;
  if (cv.width !== src.w || cv.height !== src.h) {
    cv.width = src.w;
    cv.height = src.h;
  }
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.drawImage(glc, 0, 0);
}

// ── brush (soft disc, GPU copy-on-write) ────────────────────────────
const BRUSH = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_res;
uniform vec2 u_center;
uniform float u_radius;
uniform vec3 u_color;
out vec4 o;
void main() {
  vec4 s = texture(u_src, v_uv);
  vec2 px = v_uv * u_res;
  float d = distance(px, u_center);
  float f = clamp(1.0 - d / u_radius, 0.0, 1.0);
  float a = f * f * 0.9;
  o = vec4(mix(s.rgb, u_color, a), 1.0);
}`;

/** Stamp a soft disc of `color` (0–1) at data pixel `(cx,cy)` into `dst`,
 *  reading from `srcTex`. Caller supplies a `dst` distinct from `srcTex`. */
export function brush(
  srcTex: WebGLTexture,
  dst: Tex,
  cx: number,
  cy: number,
  radius: number,
  color: [number, number, number],
): void {
  pass(BRUSH, dst, s => {
    s.tex("u_src", 0, srcTex);
    s.v2("u_res", dst.w, dst.h);
    s.v2("u_center", cx, cy);
    s.f("u_radius", radius);
    s.v3("u_color", color[0], color[1], color[2]);
  });
}

// ── per-pixel spring (MRT position + velocity, ping-ponged) ──────────
const INTEGRATE = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_pos;
uniform sampler2D u_vel;
uniform sampler2D u_target;
uniform float u_stiff;
uniform float u_damp;
uniform float u_dt;
layout(location = 0) out vec4 o_pos;
layout(location = 1) out vec4 o_vel;
void main() {
  vec4 p = texture(u_pos, v_uv);
  vec4 t = texture(u_target, v_uv);
  vec4 v = texture(u_vel, v_uv);
  vec4 acc = (t - p) * u_stiff - v * u_damp;
  vec4 nv = v + acc * u_dt;
  o_vel = nv;
  o_pos = p + nv * u_dt;
}`;

export interface SpringOpts {
  stiffness?: number;
  damping?: number;
}

/** Per-pixel damped oscillator field on the GPU. Position and velocity live
 *  in float textures and never leave the card; `current()` exposes position
 *  as a `Tex` so it can back a reactive Canvas value frame by frame. */
export class Spring {
  readonly w: number;
  readonly h: number;
  stiffness: number;
  damping: number;
  private pos: [WebGLTexture, WebGLTexture];
  private vel: [WebGLTexture, WebGLTexture];
  private targetTex: WebGLTexture;
  private cur = 0;
  private springFbo: WebGLFramebuffer;

  constructor(w: number, h: number, opts: SpringOpts = {}) {
    this.w = w;
    this.h = h;
    this.stiffness = opts.stiffness ?? 100;
    this.damping = opts.damping ?? 2;
    this.pos = [newTex(w, h), newTex(w, h)];
    this.vel = [newTex(w, h), newTex(w, h)];
    this.targetTex = newTex(w, h);
    this.springFbo = gl().createFramebuffer()!;
  }

  private clearTex(t: WebGLTexture): void {
    const g = gl();
    g.bindFramebuffer(g.FRAMEBUFFER, this.springFbo);
    g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT1, g.TEXTURE_2D, null, 0);
    g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, t, 0);
    g.drawBuffers([g.COLOR_ATTACHMENT0]);
    g.viewport(0, 0, this.w, this.h);
    g.clearColor(0, 0, 0, 0);
    g.clear(g.COLOR_BUFFER_BIT);
  }

  /** Snap position + target to `srcTex`, zero the velocity. `srcTex` may
   *  alias one of our own position textures (the host feeds `current()` back
   *  as the root value), so skip any copy that would read and write the same
   *  texture — illegal GL feedback, and a no-op anyway. */
  seed(srcTex: WebGLTexture): void {
    for (const tex of [this.pos[0], this.pos[1], this.targetTex])
      if (srcTex !== tex) copy(srcTex, { tex, w: this.w, h: this.h });
    this.clearTex(this.vel[0]);
    this.clearTex(this.vel[1]);
    this.cur = 0;
  }

  /** Retarget (keeps current position + velocity). */
  setTarget(srcTex: WebGLTexture): void {
    copy(srcTex, { tex: this.targetTex, w: this.w, h: this.h });
  }

  step(dt: number): void {
    const g = gl();
    const src = this.cur;
    const dst = 1 - this.cur;
    const p = program(INTEGRATE);
    g.bindFramebuffer(g.FRAMEBUFFER, this.springFbo);
    g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, this.pos[dst]!, 0);
    g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT1, g.TEXTURE_2D, this.vel[dst]!, 0);
    g.drawBuffers([g.COLOR_ATTACHMENT0, g.COLOR_ATTACHMENT1]);
    g.viewport(0, 0, this.w, this.h);
    g.useProgram(p.prog);
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, this.pos[src]!);
    g.uniform1i(loc(p, "u_pos"), 0);
    g.activeTexture(g.TEXTURE1);
    g.bindTexture(g.TEXTURE_2D, this.vel[src]!);
    g.uniform1i(loc(p, "u_vel"), 1);
    g.activeTexture(g.TEXTURE2);
    g.bindTexture(g.TEXTURE_2D, this.targetTex);
    g.uniform1i(loc(p, "u_target"), 2);
    g.uniform1f(loc(p, "u_stiff"), this.stiffness);
    g.uniform1f(loc(p, "u_damp"), this.damping);
    g.uniform1f(loc(p, "u_dt"), Math.min(dt, 1 / 30));
    g.bindVertexArray(vao());
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
    g.bindVertexArray(null);
    this.cur = dst;
  }

  current(): Tex {
    return { tex: this.pos[this.cur]!, w: this.w, h: this.h };
  }

  /** Mean kinetic energy (velocity²) — the settle metric. */
  energy(): number {
    return reduceMeanSquare({ tex: this.vel[this.cur]!, w: this.w, h: this.h });
  }

  dispose(): void {
    const g = gl();
    g.deleteFramebuffer(this.springFbo);
    for (const t of [...this.pos, ...this.vel, this.targetTex]) g.deleteTexture(t);
  }
}
