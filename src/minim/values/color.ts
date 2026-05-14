// Color — RGBA cell. Demonstrates that adding a non-geometric value
// type is the same shape as a geometric one: just declare capabilities
// and ops. ~50 lines and you get:
//
//   - Reactive Color cells with structural equality
//   - Per-channel axis access (r/g/b/a)
//   - Color ops: blend, withAlpha, lighten — chainable, derived
//   - Scalar projections: luminance, css string
//   - Generic `.to(target, dur)` tween from the `lerp` capability
//   - Spring/oscillate/mean from the `algebra` capability
//
// Compare to writing this from scratch (~150-200 lines bespoke).

import {
  computed,
  defineStruct,
  type ReadonlyCell,
  type WriteOf,
  type ReadOf,
} from "@minim/signals";

/** Plain RGBA shape. The `Color` const wraps this in a reactive cell;
 *  `Color.Writable` / `Color.Readonly` name the cell flavors. */
export interface Color {
  r: number;
  g: number;
  b: number;
  a: number;
}

export const Color = defineStruct({
  name: "Color",
  defaults: { r: 0, g: 0, b: 0, a: 1 } as Color,
  construct: (r: number, g: number, b: number, a: number): Color => ({ r, g, b, a }),
  equals: (x, y) => x.r === y.r && x.g === y.g && x.b === y.b && x.a === y.a,
  // ── Capabilities ────────────────────────────────────────────────
  algebra: {
    add:   (a, b) => ({ r: a.r + b.r, g: a.g + b.g, b: a.b + b.b, a: a.a + b.a }),
    sub:   (a, b) => ({ r: a.r - b.r, g: a.g - b.g, b: a.b - b.b, a: a.a - b.a }),
    scale: (a, k) => ({ r: a.r * k, g: a.g * k, b: a.b * k, a: a.a * k }),
  },
  /** Component-wise lerp in linear RGBA. */
  lerp: (a, b, t) => ({
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
    a: a.a + (b.a - a.a) * t,
  }),
  // ── Custom ops + getters ──────────────────────────────────────
  ops: {
    blend: (a, b: Color, t: number): Color => ({
      r: a.r * (1 - t) + b.r * t,
      g: a.g * (1 - t) + b.g * t,
      b: a.b * (1 - t) + b.b * t,
      a: Math.max(a.a, b.a),
    }),
    withAlpha: (c, alpha: number): Color => ({ r: c.r, g: c.g, b: c.b, a: alpha }),
    lighten: (c, amount: number): Color => ({
      r: Math.min(1, c.r + amount),
      g: Math.min(1, c.g + amount),
      b: Math.min(1, c.b + amount),
      a: c.a,
    }),
  },
  getters: {
    /** Perceptual luminance ≈ 0..1. Lazy + cached as own-property. */
    luminance(this: { value: Color }): ReadonlyCell<number> {
      const self = this;
      return computed(() => {
        const c = self.value;
        return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
      });
    },
    /** CSS `rgba(...)` string, reactive. Lazy + cached as own-property. */
    css(this: { value: Color }): ReadonlyCell<string> {
      const self = this;
      return computed(() => {
        const c = self.value;
        return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a})`;
      });
    },
  },
});

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Color {
  /** Writable reactive Color. */
  export type Writable = WriteOf<typeof Color>;
  /** Read-only reactive Color. */
  export type Readonly = ReadOf<typeof Color>;
  /** Either flavor. */
  export type Like = Writable | Readonly;
}

export const rgb = (r: number, g: number, b: number) =>
  Color.signal({ r, g, b, a: 1 });

export const rgba = (r: number, g: number, b: number, a: number) =>
  Color.signal({ r, g, b, a });
