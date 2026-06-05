// canvas.ts — GPU-resident reactive raster (handle-as-value).
//
// Every Canvas value is a float texture in the shared WebGL2 context (see
// gpu.ts); the reactive graph transports only a tiny HEADER {tex, w, h,
// epoch}, comparing the monotonic epoch, so propagation never reads a pixel
// and nothing is copied across the bus. Forward lenses render into a per-lens
// scratch texture (reused across recomputes); the single ownership rule that
// keeps no-copy safe is the same as on the CPU — a node writes only its own
// texture, never one another live node still reads, which holds under the
// engine's glitch-free flush.
//
// Tiers mirror the rest of values/:
//   - pure isomorphisms (`invert`, `flipH`) — one pointwise shader each way.
//   - reactive-param invertibles (`brightness(k)`) — read `Val<number>`.
//   - complement projections (`grayscale`, `downsample`) — the lossy view
//     plus a complement texture (chroma / Laplacian residual) recovered on
//     write-back, the raster analog of str.ts's case-preserving lenses.
//   - cross-type lenses (`meanColor` → Color, `brighterThan` → Bool).
//
// A backward pass that produces a ROOT cell's next value reads that root and
// writes a result that becomes its value, so it uses `scratch2` (a feedback-
// safe pair) to avoid reading and writing the same texture.

import { Cell, reader, type Val, type Writable } from "../signal";
import type { TraitDict } from "../traits";
import { derived } from "../writable";
import { Bool } from "./bool";
import { Color } from "./color";
import {
  copy,
  newTex,
  pass,
  reduceMean,
  Spring,
  type SpringOpts,
  scratch,
  scratch2,
  type Tex,
} from "./gpu";
import { Vec } from "./vec";

/** Raster header. The graph compares `epoch`; `tex` is an RGBA32F texture in
 *  the shared GL context (channels 0–1, may overshoot mid-deconvolution). */
export interface Raster {
  readonly tex: WebGLTexture;
  readonly w: number;
  readonly h: number;
  readonly epoch: number;
}

type V = Raster;

let EPOCH = 0;
/** Stamp a texture with a fresh epoch — the only way to mint a value. */
export const stamp = (tex: WebGLTexture, w: number, h: number): V => ({
  tex,
  w,
  h,
  epoch: ++EPOCH,
});

export const equals = (a: V, b: V): boolean => a.epoch === b.epoch;

const DECONV_ITERS = 24;
const MAXR = 8;
const LUMA_W = "vec3(0.299, 0.587, 0.114)";

// ── shaders ─────────────────────────────────────────────────────────
const HEAD = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;`;

const INVERT = `${HEAD}
uniform sampler2D u_s;
void main() { vec4 c = texture(u_s, v_uv); o = vec4(1.0 - c.rgb, c.a); }`;

const FLIPH = `${HEAD}
uniform sampler2D u_s;
void main() { o = texture(u_s, vec2(1.0 - v_uv.x, v_uv.y)); }`;

const SCALE3 = `${HEAD}
uniform sampler2D u_s; uniform float u_k;
void main() { vec4 c = texture(u_s, v_uv); o = vec4(c.rgb * u_k, c.a); }`;

const LUMA = `${HEAD}
uniform sampler2D u_s;
void main() { vec4 c = texture(u_s, v_uv); float y = dot(c.rgb, ${LUMA_W}); o = vec4(y, y, y, c.a); }`;

const CHROMA = `${HEAD}
uniform sampler2D u_s;
void main() { vec4 c = texture(u_s, v_uv); float y = dot(c.rgb, ${LUMA_W}); o = vec4(c.rgb - y, c.a); }`;

const RECOLOR = `${HEAD}
uniform sampler2D u_t; uniform sampler2D u_c;
void main() { float y = texture(u_t, v_uv).r; vec4 c = texture(u_c, v_uv); o = vec4(y + c.rgb, c.a); }`;

const CROP_FWD = `${HEAD}
uniform sampler2D u_s; uniform vec2 u_off; uniform vec2 u_csize; uniform vec2 u_ssize;
void main() { vec2 sp = (u_off + v_uv * u_csize) / u_ssize; o = texture(u_s, sp); }`;

const CROP_BWD = `${HEAD}
uniform sampler2D u_s; uniform sampler2D u_t; uniform vec2 u_off; uniform vec2 u_csize; uniform vec2 u_ssize;
void main() {
  vec2 sp = v_uv * u_ssize;
  vec2 rel = sp - u_off;
  if (rel.x >= 0.0 && rel.y >= 0.0 && rel.x < u_csize.x && rel.y < u_csize.y)
    o = texture(u_t, rel / u_csize);
  else o = texture(u_s, v_uv);
}`;

const BLUR1D = `${HEAD}
uniform sampler2D u_s; uniform vec2 u_dir; uniform float u_sigma; uniform int u_r;
void main() {
  vec3 acc = vec3(0.0); float wsum = 0.0; float a = texture(u_s, v_uv).a;
  for (int k = -${MAXR}; k <= ${MAXR}; k++) {
    if (k < -u_r || k > u_r) continue;
    float wk = exp(-float(k * k) / (2.0 * u_sigma * u_sigma));
    acc += texture(u_s, v_uv + u_dir * float(k)).rgb * wk;
    wsum += wk;
  }
  o = vec4(acc / wsum, a);
}`;

const VC_STEP = `${HEAD}
uniform sampler2D u_x; uniform sampler2D u_t; uniform sampler2D u_bl; uniform float u_lambda;
void main() {
  vec4 x = texture(u_x, v_uv); vec3 t = texture(u_t, v_uv).rgb; vec3 bl = texture(u_bl, v_uv).rgb;
  o = vec4(x.rgb + u_lambda * (t - bl), x.a);
}`;

const BOXDOWN = `${HEAD}
uniform highp sampler2D u_s; uniform int u_f; uniform ivec2 u_ssize;
void main() {
  ivec2 d = ivec2(gl_FragCoord.xy); vec4 sum = vec4(0.0); float n = 0.0;
  for (int dy = 0; dy < ${MAXR}; dy++) { if (dy >= u_f) break;
    for (int dx = 0; dx < ${MAXR}; dx++) { if (dx >= u_f) break;
      ivec2 sp = clamp(ivec2(d.x * u_f + dx, d.y * u_f + dy), ivec2(0), u_ssize - 1);
      sum += texelFetch(u_s, sp, 0); n += 1.0;
    } }
  o = sum / n;
}`;

const UP = `${HEAD}
uniform highp sampler2D u_small; uniform int u_f; uniform ivec2 u_smallsize;
void main() {
  ivec2 d = ivec2(gl_FragCoord.xy);
  ivec2 sp = clamp(d / u_f, ivec2(0), u_smallsize - 1);
  o = texelFetch(u_small, sp, 0);
}`;

const ADD = `${HEAD}
uniform sampler2D u_a; uniform sampler2D u_b;
void main() { o = texture(u_a, v_uv) + texture(u_b, v_uv); }`;

const SUB = `${HEAD}
uniform sampler2D u_a; uniform sampler2D u_b;
void main() { o = texture(u_a, v_uv) - texture(u_b, v_uv); }`;

const SHIFT = `${HEAD}
uniform sampler2D u_s; uniform vec3 u_d;
void main() { vec4 c = texture(u_s, v_uv); o = vec4(c.rgb + u_d, c.a); }`;

/** Separable Gaussian of `srcTex` → `out` via `tmp` (all distinct). */
function gauss(
  srcTex: WebGLTexture,
  w: number,
  h: number,
  radius: number,
  tmp: Tex,
  out: Tex,
): void {
  const r = Math.min(MAXR, Math.max(0, Math.round(radius)));
  const sigma = Math.max(0.5, radius / 2);
  pass(BLUR1D, tmp, s => {
    s.tex("u_s", 0, srcTex);
    s.v2("u_dir", 1 / w, 0);
    s.f("u_sigma", sigma);
    s.i("u_r", r);
  });
  pass(BLUR1D, out, s => {
    s.tex("u_s", 0, tmp.tex);
    s.v2("u_dir", 0, 1 / h);
    s.f("u_sigma", sigma);
    s.i("u_r", r);
  });
}

export class Canvas extends Cell<V> {
  static traits = { equals } satisfies TraitDict<V>;
  declare readonly _t: typeof Canvas.traits;

  constructor(v: V = { tex: null as unknown as WebGLTexture, w: 0, h: 0, epoch: 0 }) {
    super(v, { equals });
  }

  // ── pure isomorphisms ─────────────────────────────────────────────

  /** Per-channel invert (alpha preserved). Involution. */
  invert(): this {
    const sf = scratch();
    const sb = scratch();
    const run = (alloc: typeof sf) => (v: V) => {
      const out = alloc(v.w, v.h);
      pass(INVERT, out, s => s.tex("u_s", 0, v.tex));
      return stamp(out.tex, v.w, v.h);
    };
    return this.lens(run(sf), run(sb));
  }

  /** Horizontal flip. Involution. */
  flipH(): this {
    const sf = scratch();
    const sb = scratch();
    const run = (alloc: typeof sf) => (v: V) => {
      const out = alloc(v.w, v.h);
      pass(FLIPH, out, s => s.tex("u_s", 0, v.tex));
      return stamp(out.tex, v.w, v.h);
    };
    return this.lens(run(sf), run(sb));
  }

  // ── reactive-param invertible ─────────────────────────────────────

  /** Multiply RGB by reactive `k` (alpha preserved). Invertible while
   *  k ≠ 0. */
  brightness(k: Val<number>): this {
    const kf = reader(k);
    const sf = scratch();
    const sb = scratch();
    const run = (alloc: typeof sf, gain: () => number) => (v: V) => {
      const out = alloc(v.w, v.h);
      pass(SCALE3, out, s => {
        s.tex("u_s", 0, v.tex);
        s.f("u_k", gain());
      });
      return stamp(out.tex, v.w, v.h);
    };
    return this.lens(
      run(sf, () => kf()),
      run(sb, () => 1 / kf()),
    );
  }

  // ── complement projection: luma view, chroma-preserving write-back ─

  /** Grayscale (Rec.601 luma) view; complement is the per-pixel chroma
   *  residual `(r−Y, g−Y, b−Y)`, so editing the gray view recolours the
   *  source. The raster analog of `str.lowercase()`. */
  grayscale(): Writable<Canvas> {
    const sc = scratch();
    const sf = scratch();
    const sb = scratch();
    const chromaOf = (v: V): Tex => {
      const c = sc(v.w, v.h);
      pass(CHROMA, c, s => s.tex("u_s", 0, v.tex));
      return c;
    };
    const self: Canvas = this;
    return Canvas.lens([self], {
      init: ([s]) => chromaOf(s),
      step: ([s], c, external) => (external ? chromaOf(s) : c),
      fwd: ([s]) => {
        const out = sf(s.w, s.h);
        pass(LUMA, out, x => x.tex("u_s", 0, s.tex));
        return stamp(out.tex, s.w, s.h);
      },
      bwd: (target, [s], c) => {
        const out = sb(s.w, s.h);
        pass(RECOLOR, out, x => {
          x.tex("u_t", 0, target.tex);
          x.tex("u_c", 1, c.tex);
        });
        return { updates: [stamp(out.tex, s.w, s.h)], complement: c };
      },
    }) as Writable<Canvas>;
  }

  // ── geometric & spatial lenses ────────────────────────────────────

  /** Sub-rectangle view (reactive `x,y,w,h`). Editing the crop composites
   *  back into the source; the surround reads straight from the parent. */
  crop(x: Val<number>, y: Val<number>, w: Val<number>, h: Val<number>): Writable<Canvas> {
    const xf = reader(x);
    const yf = reader(y);
    const wf = reader(w);
    const hf = reader(h);
    const sf = scratch();
    const sb = scratch2();
    const self: Canvas = this;
    return Canvas.lens(
      self,
      v => {
        const cw = Math.max(1, wf() | 0);
        const ch = Math.max(1, hf() | 0);
        const out = sf(cw, ch);
        pass(CROP_FWD, out, s => {
          s.tex("u_s", 0, v.tex);
          s.v2("u_off", xf() | 0, yf() | 0);
          s.v2("u_csize", cw, ch);
          s.v2("u_ssize", v.w, v.h);
        });
        return stamp(out.tex, cw, ch);
      },
      (target, v) => {
        const out = sb(v.w, v.h, v.tex);
        pass(CROP_BWD, out, s => {
          s.tex("u_s", 0, v.tex);
          s.tex("u_t", 1, target.tex);
          s.v2("u_off", xf() | 0, yf() | 0);
          s.v2("u_csize", target.w, target.h);
          s.v2("u_ssize", v.w, v.h);
        });
        return stamp(out.tex, v.w, v.h);
      },
    ) as Writable<Canvas>;
  }

  /** Box-downsampled thumbnail (integer `factor`). Complement is the
   *  Laplacian residual `source − up(down(source))`; editing the thumbnail
   *  reconstructs full-res detail on top of the edit. */
  downsample(factor: number): Writable<Canvas> {
    const f = Math.max(1, Math.floor(factor));
    const dw = (n: number): number => Math.max(1, Math.floor(n / f));
    const sdF = scratch();
    const sdR = scratch();
    const suR = scratch();
    const sc = scratch();
    const suB = scratch();
    const sb = scratch();
    const down = (alloc: typeof sdF, srcTex: WebGLTexture, sw: number, sh: number): Tex => {
      const small = alloc(dw(sw), dw(sh));
      pass(BOXDOWN, small, x => {
        x.tex("u_s", 0, srcTex);
        x.i("u_f", f);
        x.i2("u_ssize", sw, sh);
      });
      return small;
    };
    const residualOf = (s: V): Tex => {
      const small = down(sdR, s.tex, s.w, s.h);
      const up = suR(s.w, s.h);
      pass(UP, up, x => {
        x.tex("u_small", 0, small.tex);
        x.i("u_f", f);
        x.i2("u_smallsize", small.w, small.h);
      });
      const res = sc(s.w, s.h);
      pass(SUB, res, x => {
        x.tex("u_a", 0, s.tex);
        x.tex("u_b", 1, up.tex);
      });
      return res;
    };
    const self: Canvas = this;
    return Canvas.lens([self], {
      init: ([s]) => residualOf(s),
      step: ([s], c, external) => (external ? residualOf(s) : c),
      fwd: ([s]) => {
        const small = down(sdF, s.tex, s.w, s.h);
        return stamp(small.tex, small.w, small.h);
      },
      bwd: (target, [s], c) => {
        const up = suB(s.w, s.h);
        pass(UP, up, x => {
          x.tex("u_small", 0, target.tex);
          x.i("u_f", f);
          x.i2("u_smallsize", target.w, target.h);
        });
        const out = sb(s.w, s.h);
        pass(ADD, out, x => {
          x.tex("u_a", 0, up.tex);
          x.tex("u_b", 1, c.tex);
        });
        return { updates: [stamp(out.tex, s.w, s.h)], complement: c };
      },
    }) as Writable<Canvas>;
  }

  /** Gaussian blur (reactive `radius`). Writable: the backward direction
   *  runs an iterated Van-Cittert deconvolution seeded from the source, so
   *  untouched regions stay fixed while a stroke back-solves to the sharp
   *  pre-image that explains it. PutGet, not exact GetPut — push `lambda`
   *  and it rings, the honest signature of the inverse problem. */
  blur(radius: Val<number>, lambda: Val<number> = 1): this {
    const rf = reader(radius);
    const lf = reader(lambda);
    const fTmp = scratch();
    const fOut = scratch();
    const xa = scratch();
    const xb = scratch();
    const bTmp = scratch();
    const bBl = scratch();
    return this.lens(
      v => {
        const tmp = fTmp(v.w, v.h);
        const out = fOut(v.w, v.h);
        gauss(v.tex, v.w, v.h, rf(), tmp, out);
        return stamp(out.tex, v.w, v.h);
      },
      (target, v) => {
        const A = xa(v.w, v.h);
        const B = xb(v.w, v.h);
        let cur = v.tex === A.tex ? B : A;
        let other = cur === A ? B : A;
        copy(v.tex, cur);
        const g = lf();
        const r = rf();
        for (let it = 0; it < DECONV_ITERS; it++) {
          const tmp = bTmp(v.w, v.h);
          const bl = bBl(v.w, v.h);
          gauss(cur.tex, v.w, v.h, r, tmp, bl);
          pass(VC_STEP, other, s => {
            s.tex("u_x", 0, cur.tex);
            s.tex("u_t", 1, target.tex);
            s.tex("u_bl", 2, bl.tex);
            s.f("u_lambda", g);
          });
          const t = cur;
          cur = other;
          other = t;
        }
        return stamp(cur.tex, v.w, v.h);
      },
    );
  }

  // ── cross-type lenses ─────────────────────────────────────────────

  /** Mean colour (0–1) as a writable `Color`; the GPU reduces, the write
   *  shifts every pixel by the delta (a rigid translate in RGB). */
  meanColor(): Writable<Color> {
    const self: Canvas = this;
    const sb = scratch2();
    return Color.lens(
      self,
      v => {
        const [r, g, b, a] = reduceMean({ tex: v.tex, w: v.w, h: v.h });
        return { r, g, b, a };
      },
      (target, v) => {
        const [mr, mg, mb] = reduceMean({ tex: v.tex, w: v.w, h: v.h });
        const out = sb(v.w, v.h, v.tex);
        pass(SHIFT, out, s => {
          s.tex("u_s", 0, v.tex);
          s.v3("u_d", target.r - mr, target.g - mg, target.b - mb);
        });
        return stamp(out.tex, v.w, v.h);
      },
    ) as Writable<Color>;
  }

  /** Mean luma ≥ reactive `threshold` (0–1) as a writable `Bool`; flipping
   *  the bit auto-exposes — iterate the gain (clipping caps a single step)
   *  until the mean crosses the line. */
  brighterThan(threshold: Val<number>): Writable<Bool> {
    const tf = reader(threshold);
    const self: Canvas = this;
    const xa = scratch();
    const xb = scratch();
    const meanLuma = (t: WebGLTexture, w: number, h: number): number => {
      const m = reduceMean({ tex: t, w, h });
      return 0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2];
    };
    return Bool.lens(
      self,
      v => meanLuma(v.tex, v.w, v.h) >= tf(),
      (target, v) => {
        const t = tf();
        const want = target ? t + 0.03 : t - 0.03;
        const A = xa(v.w, v.h);
        const B = xb(v.w, v.h);
        let cur = v.tex === A.tex ? B : A;
        let other = cur === A ? B : A;
        copy(v.tex, cur);
        for (let it = 0; it < 40; it++) {
          const Y = meanLuma(cur.tex, v.w, v.h);
          if (target ? Y >= t : Y < t) break;
          const k = Y > 0.002 ? want / Y : target ? 2 : 0;
          if (Math.abs(k - 1) < 1e-3) break;
          pass(SCALE3, other, s => {
            s.tex("u_s", 0, cur.tex);
            s.f("u_k", k);
          });
          const tmp = cur;
          cur = other;
          other = tmp;
        }
        return stamp(cur.tex, v.w, v.h);
      },
    ) as Writable<Bool>;
  }

  /** Dimensions `(w, h)` as a read-only `Vec`. */
  get dimensions(): Vec {
    return derived(this, "dimensions", Vec, v => ({ x: v.w, y: v.h }));
  }

  /** A GPU per-pixel spring driver seeded from this value's texture. The
   *  host steps it and writes `current()` back into a root cell each frame;
   *  settle is the GPU energy reduction. */
  spring(opts?: SpringOpts): Spring {
    const s = new Spring(this.value.w, this.value.h, opts);
    s.seed(this.value.tex);
    return s;
  }
}

/** Writable `Canvas` of size `w×h`. `painter` fills it pixel-by-pixel
 *  (RGBA, 0–255); omit for transparent black. Uploaded once to a texture. */
export function canvas(
  w: number,
  h: number,
  painter?: (x: number, y: number) => readonly [number, number, number, number],
): Writable<Canvas> {
  const f = new Float32Array(w * h * 4);
  if (painter !== undefined) {
    let o = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const [r, g, b, a] = painter(x, y);
        f[o++] = r / 255;
        f[o++] = g / 255;
        f[o++] = b / 255;
        f[o++] = a / 255;
      }
    }
  }
  return new Canvas(stamp(newTex(w, h, f), w, h)) as Writable<Canvas>;
}
