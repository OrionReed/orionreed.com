// canvas-gpu.ts — GPU-resident pixel-space spring (WebGL2).
//
// Proves the handle-as-value thesis on the GPU: per-pixel spring state
// (position + velocity) lives in float textures and never leaves the card.
// Each pixel is an independent damped oscillator chasing a target image —
// embarrassingly parallel, so the integrator is one MRT fragment pass,
// ping-ponged each frame. The reactive layer drives knobs (stiffness,
// damping) and reads back only a tiny `settled` scalar, exactly as
// sketched: pixels stay resident, headers/handles cross the graph.
//
// This is renderer-only; a host element wires `step`/`render` into a RAF
// loop and surfaces `settled` + an epoch bump into the signal graph.

import type { Raster } from "./canvas";

const QUAD = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

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
  vec4 v = texture(u_vel, v_uv);
  vec4 t = texture(u_target, v_uv);
  vec4 acc = (t - p) * u_stiff - v * u_damp;
  vec4 nv = v + acc * u_dt;
  o_vel = nv;
  o_pos = p + nv * u_dt;
}`;

const DISPLAY = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_pos;
out vec4 o;
void main() {
  // Flip Y: textures are bottom-up, ImageData is top-down.
  vec3 c = texture(u_pos, vec2(v_uv.x, 1.0 - v_uv.y)).rgb;
  o = vec4(c, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader compile: ${log}`);
  }
  return sh;
}

function program(gl: WebGL2RenderingContext, fragSrc: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fragSrc));
  gl.bindAttribLocation(p, 0, "a_pos");
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`link: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
}

function floatTex(
  gl: WebGL2RenderingContext,
  w: number,
  h: number,
  data: Float32Array | null,
): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

const toFloat = (data: Uint8ClampedArray): Float32Array => {
  const f = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) f[i] = data[i]! / 255;
  return f;
};

export interface GpuSpringOpts {
  stiffness?: number;
  damping?: number;
}

/** Per-pixel spring field on the GPU. WebGL2 + float color-buffer
 *  required; the constructor throws if unavailable so the host can fall
 *  back. */
export class GpuSpring {
  private gl: WebGL2RenderingContext;
  private w: number;
  private h: number;
  private integrate: WebGLProgram;
  private display: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private fbo: WebGLFramebuffer;
  private pos: [WebGLTexture, WebGLTexture];
  private vel: [WebGLTexture, WebGLTexture];
  private target: WebGLTexture;
  private cur = 0;
  stiffness: number;
  damping: number;

  constructor(canvas: HTMLCanvasElement, w: number, h: number, opts: GpuSpringOpts = {}) {
    const gl = canvas.getContext("webgl2", { antialias: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error("WebGL2 unavailable");
    if (!gl.getExtension("EXT_color_buffer_float"))
      throw new Error("EXT_color_buffer_float unavailable");
    this.gl = gl;
    this.w = w;
    this.h = h;
    this.stiffness = opts.stiffness ?? 120;
    this.damping = opts.damping ?? 14;

    this.integrate = program(gl, INTEGRATE);
    this.display = program(gl, DISPLAY);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.pos = [floatTex(gl, w, h, null), floatTex(gl, w, h, null)];
    this.vel = [floatTex(gl, w, h, null), floatTex(gl, w, h, null)];
    this.target = floatTex(gl, w, h, null);
    this.fbo = gl.createFramebuffer()!;
  }

  /** Snap state to `r` (position = r, velocity = 0, target = r). */
  setImage(r: Raster): void {
    const gl = this.gl;
    const f = toFloat(r.data);
    const zero = new Float32Array(this.w * this.h * 4);
    for (const t of this.pos) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.w, this.h, gl.RGBA, gl.FLOAT, f);
    }
    for (const t of this.vel) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.w, this.h, gl.RGBA, gl.FLOAT, zero);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.target);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.w, this.h, gl.RGBA, gl.FLOAT, f);
  }

  /** Spring toward `r` (leaves current position/velocity intact). */
  setTarget(r: Raster): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.target);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.w, this.h, gl.RGBA, gl.FLOAT, toFloat(r.data));
  }

  /** Integrate one step (ping-pong). */
  step(dt: number): void {
    const gl = this.gl;
    const src = this.cur;
    const dst = 1 - this.cur;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.pos[dst]!, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.vel[dst]!, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.viewport(0, 0, this.w, this.h);

    gl.useProgram(this.integrate);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.pos[src]!);
    gl.uniform1i(gl.getUniformLocation(this.integrate, "u_pos"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.vel[src]!);
    gl.uniform1i(gl.getUniformLocation(this.integrate, "u_vel"), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.target);
    gl.uniform1i(gl.getUniformLocation(this.integrate, "u_target"), 2);
    gl.uniform1f(gl.getUniformLocation(this.integrate, "u_stiff"), this.stiffness);
    gl.uniform1f(gl.getUniformLocation(this.integrate, "u_damp"), this.damping);
    gl.uniform1f(gl.getUniformLocation(this.integrate, "u_dt"), Math.min(dt, 1 / 30));

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);

    this.cur = dst;
  }

  /** Draw current position to the canvas. */
  render(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.useProgram(this.display);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.pos[this.cur]!);
    gl.uniform1i(gl.getUniformLocation(this.display, "u_pos"), 0);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  /** Mean kinetic energy (velocity²) — the settle metric; one small
   *  readback, kept off the per-frame path by the host. */
  energy(): number {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.vel[this.cur]!,
      0,
    );
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, null, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    const buf = new Float32Array(this.w * this.h * 4);
    gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.FLOAT, buf);
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i]! * buf[i]!;
    return s / buf.length;
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.integrate);
    gl.deleteProgram(this.display);
    gl.deleteVertexArray(this.vao);
    gl.deleteFramebuffer(this.fbo);
    for (const t of [...this.pos, ...this.vel, this.target]) gl.deleteTexture(t);
  }
}
