// canvas.ts — reactive raster image (handle-as-value).
//
// The reactive graph transports a tiny HEADER, never pixels: equality is a
// global monotonic `epoch`, so propagation never reads the buffer. Each cell
// owns its buffer; forward lenses render into a per-lens scratch buffer (no
// per-recompute copy), so a deep chain costs one buffer per node, not one
// per frame. The single ownership rule that keeps no-copy safe: a node
// writes only its own buffer, never one another live node still reads —
// holds under the engine's glitch-free flush (a parent renders before any
// child reads it). `fwd` and `bwd` of one lens keep SEPARATE scratch, since
// a backward settle runs `bwd` (→ parent value) then `fwd` (reads parent).
//
// Tiers mirror the rest of values/:
//   - pure isomorphisms (`invert`, `flipH`) — `.lens(fwd, bwd)`, exact.
//   - reactive-param invertibles (`brightness(k)`) — read `Val<number>`.
//   - complement projections (`grayscale`) — `Canvas.lens(parent, spec)`;
//     the lossy luma view writes back recoloured, chroma recovered from the
//     complement (the image analog of `str.ts`'s case-preserving lenses).

import type { Easing } from "../../core";
import { type Tween, tween } from "../anim";
import { Cell, reader, type Val, type Writable } from "../signal";
import type { Linear, TraitDict } from "../traits";
import { derived } from "../writable";
import { Bool } from "./bool";
import { Color } from "./color";
import { Vec } from "./vec";

/** Raster header. `data` is RGBA8, length `w*h*4`; `epoch` is the identity
 *  the graph compares on, bumped on every meaningful change. */
export interface Raster {
  readonly data: Uint8ClampedArray;
  readonly w: number;
  readonly h: number;
  readonly epoch: number;
}

type V = Raster;

let EPOCH = 0;
/** Stamp a buffer with a fresh epoch — the only way to mint a value. */
export const stamp = (data: Uint8ClampedArray, w: number, h: number): V => ({
  data,
  w,
  h,
  epoch: ++EPOCH,
});

export const equals = (a: V, b: V): boolean => a.epoch === b.epoch;

/** Van-Cittert iterations for `blur`'s backward (deconvolution) pass. */
const DECONV_ITERS = 24;

// ── luma / chroma ───────────────────────────────────────────────────
const LR = 0.299;
const LG = 0.587;
const LB = 0.114;
/** Rec.601 luma. */
export const luma = (r: number, g: number, b: number): number => LR * r + LG * g + LB * b;

// ── per-lens scratch (one owned buffer, reused across recomputes) ────
const scratch = (): ((n: number) => Uint8ClampedArray) => {
  let buf: Uint8ClampedArray | null = null;
  return (n: number) => {
    if (buf === null || buf.length !== n) buf = new Uint8ClampedArray(n);
    return buf;
  };
};

// ── linear trait (per-pixel; clamped, so approximate at the gamut edge) ─
const zip = (a: V, b: V, f: (x: number, y: number) => number): V => {
  const out = new Uint8ClampedArray(a.data.length);
  const da = a.data;
  const db = b.data;
  for (let i = 0; i < da.length; i++) out[i] = f(da[i]!, db[i]!);
  return stamp(out, a.w, a.h);
};
export const add = (a: V, b: V): V => zip(a, b, (x, y) => x + y);
export const sub = (a: V, b: V): V => zip(a, b, (x, y) => x - y);
export const scale = (a: V, k: number): V => {
  const out = new Uint8ClampedArray(a.data.length);
  const d = a.data;
  for (let i = 0; i < d.length; i++) out[i] = d[i]! * k;
  return stamp(out, a.w, a.h);
};
export const lerp = (a: V, b: V, t: number): V => {
  const out = new Uint8ClampedArray(a.data.length);
  const da = a.data;
  const db = b.data;
  for (let i = 0; i < da.length; i++) out[i] = da[i]! + (db[i]! - da[i]!) * t;
  return stamp(out, a.w, a.h);
};
/** RMS distance over all channels. */
export const metric = (a: V, b: V): number => {
  const da = a.data;
  const db = b.data;
  let s = 0;
  for (let i = 0; i < da.length; i++) {
    const d = da[i]! - db[i]!;
    s += d * d;
  }
  return Math.sqrt(s / da.length);
};

const linearImpl: Linear<V> = { add, sub, scale };

// ── image-processing kernels (module-level, allocation-light) ───────

const clampIdx = (i: number, n: number): number => (i < 0 ? 0 : i >= n ? n - 1 : i);

/** Normalised 1-D Gaussian weights for the given radius (σ = radius/2). */
function gaussWeights(radius: number): Float32Array {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return new Float32Array([1]);
  const sigma = radius / 2;
  const w = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    w[i + r] = v;
    sum += v;
  }
  for (let i = 0; i < w.length; i++) w[i]! /= sum;
  return w;
}

/** Separable Gaussian blur of `src` into `out` (RGB; alpha copied). */
function gaussInto(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  radius: number,
  out: Uint8ClampedArray,
): void {
  const wt = gaussWeights(radius);
  const r = (wt.length - 1) / 2;
  const tmp = new Float32Array(w * h * 4);
  // horizontal
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let cr = 0;
      let cg = 0;
      let cb = 0;
      for (let k = -r; k <= r; k++) {
        const sx = clampIdx(x + k, w);
        const si = (y * w + sx) * 4;
        const wk = wt[k + r]!;
        cr += src[si]! * wk;
        cg += src[si + 1]! * wk;
        cb += src[si + 2]! * wk;
      }
      const ti = (y * w + x) * 4;
      tmp[ti] = cr;
      tmp[ti + 1] = cg;
      tmp[ti + 2] = cb;
      tmp[ti + 3] = src[ti + 3]!;
    }
  }
  // vertical
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let cr = 0;
      let cg = 0;
      let cb = 0;
      for (let k = -r; k <= r; k++) {
        const sy = clampIdx(y + k, h);
        const si = (sy * w + x) * 4;
        const wk = wt[k + r]!;
        cr += tmp[si]! * wk;
        cg += tmp[si + 1]! * wk;
        cb += tmp[si + 2]! * wk;
      }
      const ti = (y * w + x) * 4;
      out[ti] = cr;
      out[ti + 1] = cg;
      out[ti + 2] = cb;
      out[ti + 3] = tmp[ti + 3]!;
    }
  }
}

/** Box-average downsample by integer factor `f`. */
function boxDown(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  f: number,
): { data: Uint8ClampedArray; w: number; h: number } {
  const dw = Math.max(1, Math.floor(w / f));
  const dh = Math.max(1, Math.floor(h / f));
  const out = new Uint8ClampedArray(dw * dh * 4);
  const inv = 1 / (f * f);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      let cr = 0;
      let cg = 0;
      let cb = 0;
      let ca = 0;
      for (let dy = 0; dy < f; dy++) {
        for (let dx = 0; dx < f; dx++) {
          const si = (clampIdx(y * f + dy, h) * w + clampIdx(x * f + dx, w)) * 4;
          cr += src[si]!;
          cg += src[si + 1]!;
          cb += src[si + 2]!;
          ca += src[si + 3]!;
        }
      }
      const di = (y * dw + x) * 4;
      out[di] = cr * inv;
      out[di + 1] = cg * inv;
      out[di + 2] = cb * inv;
      out[di + 3] = ca * inv;
    }
  }
  return { data: out, w: dw, h: dh };
}

/** Nearest-neighbour upsample of a `sw×sh` image to `w×h` by factor `f`,
 *  written into `out` as floats. Box-down ∘ nearest-up = identity, which
 *  is what makes the Laplacian residual round-trip exactly. */
function nearestUpInto(
  small: Uint8ClampedArray,
  sw: number,
  sh: number,
  f: number,
  out: Float32Array,
  w: number,
  h: number,
): void {
  for (let y = 0; y < h; y++) {
    const sy = clampIdx((y / f) | 0, sh);
    for (let x = 0; x < w; x++) {
      const sx = clampIdx((x / f) | 0, sw);
      const si = (sy * sw + sx) * 4;
      const di = (y * w + x) * 4;
      out[di] = small[si]!;
      out[di + 1] = small[si + 1]!;
      out[di + 2] = small[si + 2]!;
      out[di + 3] = small[si + 3]!;
    }
  }
}

/** RGB→HSV, channels 0–255 in, h in degrees, s/v in 0–1. */
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  let hh = 0;
  if (d !== 0) {
    if (mx === r) hh = ((g - b) / d) % 6;
    else if (mx === g) hh = (b - r) / d + 2;
    else hh = (r - g) / d + 4;
    hh *= 60;
    if (hh < 0) hh += 360;
  }
  return [hh, mx === 0 ? 0 : d / mx, mx];
}

/** HSV→RGB, h in degrees, s/v in 0–1, out 0–255. */
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = v - c;
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

export class Canvas extends Cell<V> {
  static traits = {
    linear: linearImpl,
    lerp,
    metric,
    equals,
  } satisfies TraitDict<V>;
  declare readonly _t: typeof Canvas.traits;

  constructor(v: V = stamp(new Uint8ClampedArray(4), 1, 1)) {
    super(v, { equals });
  }

  // ── pure isomorphisms ─────────────────────────────────────────────

  /** Per-channel invert (alpha preserved). Involution. */
  invert(): this {
    const sf = scratch();
    const sb = scratch();
    const run =
      (alloc: (n: number) => Uint8ClampedArray) =>
      (v: V): V => {
        const out = alloc(v.data.length);
        const s = v.data;
        for (let i = 0; i < s.length; i += 4) {
          out[i] = 255 - s[i]!;
          out[i + 1] = 255 - s[i + 1]!;
          out[i + 2] = 255 - s[i + 2]!;
          out[i + 3] = s[i + 3]!;
        }
        return stamp(out, v.w, v.h);
      };
    return this.lens(run(sf), run(sb));
  }

  /** Horizontal flip. Involution. */
  flipH(): this {
    const sf = scratch();
    const sb = scratch();
    const run =
      (alloc: (n: number) => Uint8ClampedArray) =>
      (v: V): V => {
        const out = alloc(v.data.length);
        const { w, h, data: s } = v;
        for (let y = 0; y < h; y++) {
          const row = y * w * 4;
          for (let x = 0; x < w; x++) {
            const di = row + x * 4;
            const si = row + (w - 1 - x) * 4;
            out[di] = s[si]!;
            out[di + 1] = s[si + 1]!;
            out[di + 2] = s[si + 2]!;
            out[di + 3] = s[si + 3]!;
          }
        }
        return stamp(out, w, h);
      };
    return this.lens(run(sf), run(sb));
  }

  // ── reactive-param invertible ─────────────────────────────────────

  /** Multiply RGB by reactive `k` (alpha preserved). Invertible while
   *  k ≠ 0; lossy at the clamp edge. */
  brightness(k: Val<number>): this {
    const kf = reader(k);
    const sf = scratch();
    const sb = scratch();
    const run =
      (alloc: (n: number) => Uint8ClampedArray, gain: () => number) =>
      (v: V): V => {
        const g = gain();
        const out = alloc(v.data.length);
        const s = v.data;
        for (let i = 0; i < s.length; i += 4) {
          out[i] = s[i]! * g;
          out[i + 1] = s[i + 1]! * g;
          out[i + 2] = s[i + 2]! * g;
          out[i + 3] = s[i + 3]!;
        }
        return stamp(out, v.w, v.h);
      };
    return this.lens(
      run(sf, () => kf()),
      run(sb, () => 1 / kf()),
    );
  }

  // ── complement projection: luma view, chroma-preserving write-back ─

  /** Grayscale (Rec.601 luma) view. The complement is the per-pixel
   *  chroma residual `(r−Y, g−Y, b−Y)`; editing the gray view writes the
   *  new luma back with colour intact — the raster analog of
   *  `str.lowercase()`. Round-trips exactly (the residual is luma-free,
   *  so `luma(Y'+dr, …) = Y'`). */
  grayscale(): Writable<Canvas> {
    const chromaOf = (s: V): Float32Array => {
      const n = (s.data.length / 4) | 0;
      const c = new Float32Array(n * 3);
      const d = s.data;
      for (let i = 0, p = 0; i < d.length; i += 4, p += 3) {
        const Y = luma(d[i]!, d[i + 1]!, d[i + 2]!);
        c[p] = d[i]! - Y;
        c[p + 1] = d[i + 1]! - Y;
        c[p + 2] = d[i + 2]! - Y;
      }
      return c;
    };
    const sf = scratch();
    const sb = scratch();
    const self: Canvas = this;
    return Canvas.lens([self], {
      init: ([s]) => chromaOf(s),
      step: ([s], c, external) => (external ? chromaOf(s) : c),
      fwd: ([s]) => {
        const out = sf(s.data.length);
        const d = s.data;
        for (let i = 0; i < d.length; i += 4) {
          const Y = luma(d[i]!, d[i + 1]!, d[i + 2]!);
          out[i] = Y;
          out[i + 1] = Y;
          out[i + 2] = Y;
          out[i + 3] = d[i + 3]!;
        }
        return stamp(out, s.w, s.h);
      },
      bwd: (target, [s], c) => {
        const out = sb(s.data.length);
        const t = target.data;
        const a = s.data;
        for (let i = 0, p = 0; i < t.length; i += 4, p += 3) {
          const Y = t[i]!; // gray view ⇒ r = g = b = Y
          out[i] = Y + c[p]!;
          out[i + 1] = Y + c[p + 1]!;
          out[i + 2] = Y + c[p + 2]!;
          out[i + 3] = a[i + 3]!;
        }
        return { updates: [stamp(out, s.w, s.h)], complement: c };
      },
    }) as Writable<Canvas>;
  }

  /** Single-channel ("r"|"g"|"b") view as gray; complement holds the other
   *  three channels (incl. alpha), so editing the isolated channel writes
   *  back with the rest intact. */
  channel(ch: "r" | "g" | "b"): Writable<Canvas> {
    const off = ch === "r" ? 0 : ch === "g" ? 1 : 2;
    const rest = (s: V): Uint8ClampedArray => new Uint8ClampedArray(s.data);
    const sf = scratch();
    const sb = scratch();
    const self: Canvas = this;
    return Canvas.lens([self], {
      init: ([s]) => rest(s),
      step: ([s], c, external) => (external ? rest(s) : c),
      fwd: ([s]) => {
        const out = sf(s.data.length);
        const d = s.data;
        for (let i = 0; i < d.length; i += 4) {
          const v = d[i + off]!;
          out[i] = v;
          out[i + 1] = v;
          out[i + 2] = v;
          out[i + 3] = 255;
        }
        return stamp(out, s.w, s.h);
      },
      bwd: (target, [s], c) => {
        const out = sb(s.data.length);
        out.set(c);
        const t = target.data;
        for (let i = 0; i < t.length; i += 4) out[i + off] = t[i]!;
        return { updates: [stamp(out, s.w, s.h)], complement: c };
      },
    }) as Writable<Canvas>;
  }

  // ── reactive-param invertibles ────────────────────────────────────

  /** Rotate hue by reactive `deg`. Invertible (rotate −deg); saturation
   *  and value pass through. */
  hueRotate(deg: Val<number>): this {
    const df = reader(deg);
    const sf = scratch();
    const sb = scratch();
    const run =
      (alloc: (n: number) => Uint8ClampedArray, dir: number) =>
      (v: V): V => {
        const shift = df() * dir;
        const out = alloc(v.data.length);
        const d = v.data;
        for (let i = 0; i < d.length; i += 4) {
          const [h, s, val] = rgbToHsv(d[i]!, d[i + 1]!, d[i + 2]!);
          const [r, g, b] = hsvToRgb(h + shift, s, val);
          out[i] = r;
          out[i + 1] = g;
          out[i + 2] = b;
          out[i + 3] = d[i + 3]!;
        }
        return stamp(out, v.w, v.h);
      };
    return this.lens(run(sf, 1), run(sb, -1));
  }

  /** Gamma curve `v ↦ 255·(v/255)^γ` with reactive `γ`. Invertible
   *  (γ ↦ 1/γ); lossy only at the 0/255 endpoints. */
  gamma(g: Val<number>): this {
    const gf = reader(g);
    const sf = scratch();
    const sb = scratch();
    const run =
      (alloc: (n: number) => Uint8ClampedArray, exp: () => number) =>
      (v: V): V => {
        const e = exp();
        const out = alloc(v.data.length);
        const d = v.data;
        for (let i = 0; i < d.length; i += 4) {
          out[i] = 255 * (d[i]! / 255) ** e;
          out[i + 1] = 255 * (d[i + 1]! / 255) ** e;
          out[i + 2] = 255 * (d[i + 2]! / 255) ** e;
          out[i + 3] = d[i + 3]!;
        }
        return stamp(out, v.w, v.h);
      };
    return this.lens(
      run(sf, () => gf()),
      run(sb, () => 1 / gf()),
    );
  }

  // ── geometric & spatial lenses ────────────────────────────────────

  /** Sub-rectangle view (reactive `x,y,w,h`). Editing the crop composites
   *  back into the source; the surround is read straight from the parent
   *  (2-arg bwd), so no complement is needed. */
  crop(x: Val<number>, y: Val<number>, w: Val<number>, h: Val<number>): Writable<Canvas> {
    const xf = reader(x);
    const yf = reader(y);
    const wf = reader(w);
    const hf = reader(h);
    const self: Canvas = this;
    return Canvas.lens(
      self,
      v => {
        const cx = xf() | 0;
        const cy = yf() | 0;
        const cw = Math.max(1, wf() | 0);
        const cuh = Math.max(1, hf() | 0);
        const out = new Uint8ClampedArray(cw * cuh * 4);
        for (let j = 0; j < cuh; j++) {
          for (let i = 0; i < cw; i++) {
            const si = (clampIdx(cy + j, v.h) * v.w + clampIdx(cx + i, v.w)) * 4;
            const di = (j * cw + i) * 4;
            out[di] = v.data[si]!;
            out[di + 1] = v.data[si + 1]!;
            out[di + 2] = v.data[si + 2]!;
            out[di + 3] = v.data[si + 3]!;
          }
        }
        return stamp(out, cw, cuh);
      },
      (target, v) => {
        const cx = xf() | 0;
        const cy = yf() | 0;
        const out = new Uint8ClampedArray(v.data);
        for (let j = 0; j < target.h; j++) {
          const ty = cy + j;
          if (ty < 0 || ty >= v.h) continue;
          for (let i = 0; i < target.w; i++) {
            const tx = cx + i;
            if (tx < 0 || tx >= v.w) continue;
            const si = (j * target.w + i) * 4;
            const di = (ty * v.w + tx) * 4;
            out[di] = target.data[si]!;
            out[di + 1] = target.data[si + 1]!;
            out[di + 2] = target.data[si + 2]!;
            out[di + 3] = target.data[si + 3]!;
          }
        }
        return stamp(out, v.w, v.h);
      },
    ) as Writable<Canvas>;
  }

  /** Box-downsampled thumbnail (integer `factor`). The complement is the
   *  Laplacian residual `source − up(down(source))`; editing the thumbnail
   *  reconstructs full-res detail on top of the edit. Round-trips exactly
   *  (box-down ∘ nearest-up = id, so the residual is band-limited away). */
  downsample(factor: number): Writable<Canvas> {
    const f = Math.max(1, Math.floor(factor));
    const residualOf = (s: V): Float32Array => {
      const small = boxDown(s.data, s.w, s.h, f);
      const up = new Float32Array(s.data.length);
      nearestUpInto(small.data, small.w, small.h, f, up, s.w, s.h);
      const res = new Float32Array(s.data.length);
      for (let i = 0; i < s.data.length; i++) res[i] = s.data[i]! - up[i]!;
      return res;
    };
    const self: Canvas = this;
    return Canvas.lens([self], {
      init: ([s]) => residualOf(s),
      step: ([s], c, external) => (external ? residualOf(s) : c),
      fwd: ([s]) => {
        const small = boxDown(s.data, s.w, s.h, f);
        return stamp(small.data, small.w, small.h);
      },
      bwd: (target, [s], c) => {
        const up = new Float32Array(s.data.length);
        nearestUpInto(target.data, target.w, target.h, f, up, s.w, s.h);
        const out = new Uint8ClampedArray(s.data.length);
        for (let i = 0; i < out.length; i++) out[i] = up[i]! + c[i]!;
        return { updates: [stamp(out, s.w, s.h)], complement: c };
      },
    }) as Writable<Canvas>;
  }

  /** Gaussian blur (reactive `radius`). Writable: the backward direction
   *  runs an iterated Van-Cittert deconvolution — find a source whose blur
   *  matches the edited target. Seeding from the current source means
   *  untouched regions stay fixed (their residual is zero) while a stroke
   *  back-solves to the sharp pre-image that explains it, gain `lambda` per
   *  step over `DECONV_ITERS` iterations. PutGet, not exact GetPut: the
   *  forward genuinely discards high frequencies, so push the gain and it
   *  rings — the honest signature of the inverse problem. */
  blur(radius: Val<number>, lambda: Val<number> = 1): this {
    const rf = reader(radius);
    const lf = reader(lambda);
    const sf = scratch();
    const sb = scratch();
    const stmp = scratch();
    return this.lens(
      v => {
        const out = sf(v.data.length);
        gaussInto(v.data, v.w, v.h, rf(), out);
        return stamp(out, v.w, v.h);
      },
      (target, v) => {
        const g = lf();
        const r = rf();
        const t = target.data;
        const x = sb(v.data.length); // running estimate (clamped each step)
        x.set(v.data);
        const bl = stmp(v.data.length);
        for (let it = 0; it < DECONV_ITERS; it++) {
          gaussInto(x, v.w, v.h, r, bl);
          for (let i = 0; i < x.length; i += 4) {
            x[i] = x[i]! + g * (t[i]! - bl[i]!);
            x[i + 1] = x[i + 1]! + g * (t[i + 1]! - bl[i + 1]!);
            x[i + 2] = x[i + 2]! + g * (t[i + 2]! - bl[i + 2]!);
          }
        }
        return stamp(x, v.w, v.h);
      },
    );
  }

  /** Per-channel quantize to `levels` steps (reactive). The complement is
   *  the sub-step residual, so editing the quantized view round-trips like
   *  `Num.quantize`. */
  quantize(levels: Val<number>): Writable<Canvas> {
    const lf = reader(levels);
    const q = (v: number, step: number): number => Math.round(v / step) * step;
    const residualOf = (s: V): Float32Array => {
      const step = 255 / Math.max(1, lf() - 1);
      const res = new Float32Array(s.data.length);
      for (let i = 0; i < s.data.length; i++) res[i] = s.data[i]! - q(s.data[i]!, step);
      return res;
    };
    const sf = scratch();
    const sb = scratch();
    const self: Canvas = this;
    return Canvas.lens([self], {
      init: ([s]) => residualOf(s),
      step: ([s], c, external) => (external ? residualOf(s) : c),
      fwd: ([s]) => {
        const step = 255 / Math.max(1, lf() - 1);
        const out = sf(s.data.length);
        const d = s.data;
        for (let i = 0; i < d.length; i += 4) {
          out[i] = q(d[i]!, step);
          out[i + 1] = q(d[i + 1]!, step);
          out[i + 2] = q(d[i + 2]!, step);
          out[i + 3] = d[i + 3]!;
        }
        return stamp(out, s.w, s.h);
      },
      bwd: (target, [s], c) => {
        const out = sb(s.data.length);
        const t = target.data;
        for (let i = 0; i < t.length; i += 4) {
          out[i] = t[i]! + c[i]!;
          out[i + 1] = t[i + 1]! + c[i + 1]!;
          out[i + 2] = t[i + 2]! + c[i + 2]!;
          out[i + 3] = t[i + 3]!;
        }
        return { updates: [stamp(out, s.w, s.h)], complement: c };
      },
    }) as Writable<Canvas>;
  }

  // ── read-only derivations ─────────────────────────────────────────

  /** Sobel edge magnitude as gray (read-only; non-invertible). */
  edges(): Canvas {
    return Canvas.derive(this, v => {
      const { w, h, data: d } = v;
      const lum = new Float32Array(w * h);
      for (let i = 0, p = 0; i < d.length; i += 4, p++) lum[p] = luma(d[i]!, d[i + 1]!, d[i + 2]!);
      const out = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const l = (xx: number, yy: number): number => lum[clampIdx(yy, h) * w + clampIdx(xx, w)]!;
          const gx =
            -l(x - 1, y - 1) -
            2 * l(x - 1, y) -
            l(x - 1, y + 1) +
            l(x + 1, y - 1) +
            2 * l(x + 1, y) +
            l(x + 1, y + 1);
          const gy =
            -l(x - 1, y - 1) -
            2 * l(x, y - 1) -
            l(x + 1, y - 1) +
            l(x - 1, y + 1) +
            2 * l(x, y + 1) +
            l(x + 1, y + 1);
          const m = Math.hypot(gx, gy);
          const di = (y * w + x) * 4;
          out[di] = m;
          out[di + 1] = m;
          out[di + 2] = m;
          out[di + 3] = 255;
        }
      }
      return stamp(out, w, h);
    });
  }

  // ── cross-type lenses ─────────────────────────────────────────────

  /** Single-pixel colour at reactive `(x, y)` as a writable `Color`
   *  (channels 0–1). Writing sets just that pixel (2-arg bwd copies the
   *  source). The raster analog of `Vec.x`. */
  pixel(x: Val<number>, y: Val<number>): Writable<Color> {
    const xf = reader(x);
    const yf = reader(y);
    const self: Canvas = this;
    return Color.lens(
      self,
      v => {
        const i = (clampIdx(Math.round(yf()), v.h) * v.w + clampIdx(Math.round(xf()), v.w)) * 4;
        const d = v.data;
        return { r: d[i]! / 255, g: d[i + 1]! / 255, b: d[i + 2]! / 255, a: d[i + 3]! / 255 };
      },
      (target, v) => {
        const out = new Uint8ClampedArray(v.data);
        const i = (clampIdx(Math.round(yf()), v.h) * v.w + clampIdx(Math.round(xf()), v.w)) * 4;
        out[i] = target.r * 255;
        out[i + 1] = target.g * 255;
        out[i + 2] = target.b * 255;
        out[i + 3] = target.a * 255;
        return stamp(out, v.w, v.h);
      },
    ) as Writable<Color>;
  }

  /** Mean colour (channels 0–1) as a writable `Color`. Writing shifts
   *  every pixel by the delta — a rigid translate in RGBA, like
   *  `meanColor` over a palette. */
  meanColor(): Writable<Color> {
    const self: Canvas = this;
    const mean = (v: V): [number, number, number, number] => {
      const d = v.data;
      const n = d.length / 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let i = 0; i < d.length; i += 4) {
        r += d[i]!;
        g += d[i + 1]!;
        b += d[i + 2]!;
        a += d[i + 3]!;
      }
      return [r / n, g / n, b / n, a / n];
    };
    return Color.lens(
      self,
      v => {
        const [r, g, b, a] = mean(v);
        return { r: r / 255, g: g / 255, b: b / 255, a: a / 255 };
      },
      (target, v) => {
        const [mr, mg, mb] = mean(v);
        const dr = target.r * 255 - mr;
        const dg = target.g * 255 - mg;
        const db = target.b * 255 - mb;
        const out = new Uint8ClampedArray(v.data.length);
        const d = v.data;
        for (let i = 0; i < d.length; i += 4) {
          out[i] = d[i]! + dr;
          out[i + 1] = d[i + 1]! + dg;
          out[i + 2] = d[i + 2]! + db;
          out[i + 3] = d[i + 3]!;
        }
        return stamp(out, v.w, v.h);
      },
    ) as Writable<Color>;
  }

  /** Dimensions `(w, h)` as a read-only `Vec`. */
  get dimensions(): Vec {
    return derived(this, "dimensions", Vec, v => ({ x: v.w, y: v.h }));
  }

  /** A 1-bit projection: is the mean luma ≥ reactive `threshold` (0–255)?
   *  Writable — flipping the bit auto-exposes, scaling RGB so the mean
   *  lands just across the threshold (a rigid gain, like `meanColor` but
   *  collapsed to a predicate). The raster→`Bool` analog of a comparator. */
  brighterThan(threshold: Val<number>): Writable<Bool> {
    const tf = reader(threshold);
    const self: Canvas = this;
    const meanLumaBuf = (d: Uint8ClampedArray): number => {
      let s = 0;
      for (let i = 0; i < d.length; i += 4) s += luma(d[i]!, d[i + 1]!, d[i + 2]!);
      return s / (d.length / 4);
    };
    return Bool.lens(
      self,
      v => meanLumaBuf(v.data) >= tf(),
      (target, v) => {
        // iterate the gain because clipping caps a single step short of the
        // line; converges to all-255 / all-0 if the bound is unreachable.
        const t = tf();
        const want = target ? t + 8 : t - 8;
        const out = new Uint8ClampedArray(v.data);
        for (let it = 0; it < 40; it++) {
          const Y = meanLumaBuf(out);
          if (target ? Y >= t : Y < t) break;
          const k = Y > 0.5 ? want / Y : target ? 2 : 0;
          if (Math.abs(k - 1) < 1e-3) break;
          for (let i = 0; i < out.length; i += 4) {
            out[i] = out[i]! * k;
            out[i + 1] = out[i + 1]! * k;
            out[i + 2] = out[i + 2]! * k;
          }
        }
        return stamp(out, v.w, v.h);
      },
    ) as Writable<Bool>;
  }

  // ── animation ─────────────────────────────────────────────────────

  /** Tween-builder (morph via the `lerp` trait). */
  to(this: Writable<Canvas>, target: Raster, dur: Val<number>, ease?: Easing): Tween<Raster> {
    return tween(this, target, dur, ease);
  }
}

/** Writable `Canvas` of size `w×h`. `painter` fills it pixel-by-pixel
 *  (RGBA, 0–255); omit for transparent black. */
export function canvas(
  w: number,
  h: number,
  painter?: (x: number, y: number) => readonly [number, number, number, number],
): Writable<Canvas> {
  const data = new Uint8ClampedArray(w * h * 4);
  if (painter !== undefined) {
    let o = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const [r, g, b, a] = painter(x, y);
        data[o++] = r;
        data[o++] = g;
        data[o++] = b;
        data[o++] = a;
      }
    }
  }
  return new Canvas(stamp(data, w, h)) as Writable<Canvas>;
}
