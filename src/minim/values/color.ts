// Color, declared via the struct framework. Demonstrates that adding
// a non-geometric value type is exactly the same shape as adding a
// geometric one. ~50 lines and you get:
//
//   - Reactive Color signals with structural equality
//   - Per-channel axis access (r/g/b/a, all writable)
//   - Color ops: blend, withAlpha, lighten — chainable, derived
//   - Scalar projections: luminance, css string
//   - Generic `.to(target, dur)` tween, automatically derived from
//     the registered `lerp` op — same engine that tweens Vec/Box
//
// Compare to writing this from scratch (~150-200 lines bespoke).

import { struct } from "@minim/signals";
import { computed, type ReadonlyCell } from "@minim/signals";

export type C = { r: number; g: number; b: number; a: number };

export const Color = struct<C>("Color", { r: 0, g: 0, b: 0, a: 1 })
  .construct(
    (r: number, g: number, b: number, a: number): C => ({ r, g, b, a }),
  )
  .equals((x, y) => x.r === y.r && x.g === y.g && x.b === y.b && x.a === y.a)
  .ops({
    /** Component-wise add. With `sub`+`scale` stamps `[ALGEBRA]` so
     *  behaviors and aggregates work on `Reactive<C>`. */
    add: (a, b: C): C => ({
      r: a.r + b.r,
      g: a.g + b.g,
      b: a.b + b.b,
      a: a.a + b.a,
    }),
    sub: (a, b: C): C => ({
      r: a.r - b.r,
      g: a.g - b.g,
      b: a.b - b.b,
      a: a.a - b.a,
    }),
    scale: (a, k: number): C => ({
      r: a.r * k,
      g: a.g * k,
      b: a.b * k,
      a: a.a * k,
    }),
    /** Component-wise lerp in linear RGBA. Registering this enables
     *  the framework to derive `.to(target, dur)` automatically. */
    lerp: (a, b: C, t: number): C => ({
      r: a.r + (b.r - a.r) * t,
      g: a.g + (b.g - a.g) * t,
      b: a.b + (b.b - a.b) * t,
      a: a.a + (b.a - a.a) * t,
    }),
    blend: (a, b: C, t: number): C => ({
      r: a.r * (1 - t) + b.r * t,
      g: a.g * (1 - t) + b.g * t,
      b: a.b * (1 - t) + b.b * t,
      a: Math.max(a.a, b.a),
    }),
    withAlpha: (c, alpha: number): C => ({ r: c.r, g: c.g, b: c.b, a: alpha }),
    lighten: (c, amount: number): C => ({
      r: Math.min(1, c.r + amount),
      g: Math.min(1, c.g + amount),
      b: Math.min(1, c.b + amount),
      a: c.a,
    }),
  })
  .getters({
    /** Perceptual luminance ≈ 0..1. Lazy + cached as own-property. */
    luminance(this: { value: C }): ReadonlyCell<number> {
      const self = this;
      return computed(() => {
        const c = self.value;
        return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
      });
    },
    /** CSS `rgba(...)` string, reactive. Lazy + cached as own-property. */
    css(this: { value: C }): ReadonlyCell<string> {
      const self = this;
      return computed(() => {
        const c = self.value;
        return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a})`;
      });
    },
  })
  .build();

export const rgb = (r: number, g: number, b: number) =>
  Color.signal({ r, g, b, a: 1 });

export const rgba = (r: number, g: number, b: number, a: number) =>
  Color.signal({ r, g, b, a });
