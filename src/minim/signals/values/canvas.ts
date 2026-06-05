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

import { Cell, reader, type Val, type Writable } from "../signal";
import type { Linear, TraitDict } from "../traits";

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
