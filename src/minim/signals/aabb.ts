// Box — the reactive rectangular-region primitive (axis-aligned).
// Mirrors the Vec/V split: `Box` is the registered struct value
// (`Box.signal({...})`, `instanceof Box`, etc.), `B` is the plain
// `{x, y, w, h}` value type.
//
// Cardinal anchors (`center`, `top`, `bottom`, `left`, `right`) are
// declared as **lazy property getters** via `.getters({...})`. Each
// is built on first access and cached as an own-property on the
// instance. Most consumers only touch one or two anchors per box —
// the rest never allocate.
//
// File still named `aabb.ts` for historical reasons; the public
// surface is `Box` / `B` / `Boxlike` (consumers import via
// `minim/index`, never this path directly).

import { struct } from "./struct";
import { Vec, type V, type Pointlike, type DerivedPoint } from "./vec";
import type { M } from "./matrix";
import { computed, type ReadonlySignal } from "../core/signal";

/** Plain Box value — `{x, y, w, h}`. The struct's value type. The
 *  identifier `Box` is BOTH this type AND the registered struct value
 *  below — same trick a `class` uses by default (a class declaration
 *  introduces both a value and a type under one name). `B` is an alias
 *  for the value type, kept for symmetry with `V` (Vec) and `C`
 *  (Color). */
export type Box = { x: number; y: number; w: number; h: number };
export type B = Box;

export const Box = struct<Box>("Box", { x: 0, y: 0, w: 0, h: 0 })
  .construct(
    (x: number, y: number, w: number, h: number): Box => ({ x, y, w, h }),
  )
  .equals((a, b) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h)
  .ops({
    expand: (b, n: number): Box => ({
      x: b.x - n,
      y: b.y - n,
      w: b.w + 2 * n,
      h: b.h + 2 * n,
    }),
    union: (a, b: Box): Box => {
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const w = Math.max(a.x + a.w, b.x + b.w) - x;
      const h = Math.max(a.y + a.h, b.y + b.h) - y;
      return { x, y, w, h };
    },
    /** Component-wise lerp; enables `.to(target, dur)` tween. */
    lerp: (a, b: Box, t: number): Box => ({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      w: a.w + (b.w - a.w) * t,
      h: a.h + (b.h - a.h) * t,
    }),
    /** This box in the frame `m`. Loose box around the four transformed
     *  corners. Replaces hand-rolled `transformAABB(matrix, box)`. */
    in: (b, m: M): Box => {
      const x0 = b.x;
      const y0 = b.y;
      const x1 = b.x + b.w;
      const y1 = b.y + b.h;
      const ax = m.a * x0 + m.c * y0 + m.e;
      const ay = m.b * x0 + m.d * y0 + m.f;
      const bx = m.a * x1 + m.c * y0 + m.e;
      const by = m.b * x1 + m.d * y0 + m.f;
      const cx = m.a * x1 + m.c * y1 + m.e;
      const cy = m.b * x1 + m.d * y1 + m.f;
      const dx = m.a * x0 + m.c * y1 + m.e;
      const dy = m.b * x0 + m.d * y1 + m.f;
      const minX = Math.min(ax, bx, cx, dx);
      const maxX = Math.max(ax, bx, cx, dx);
      const minY = Math.min(ay, by, cy, dy);
      const maxY = Math.max(ay, by, cy, dy);
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    },
  })
  .scalars({
    contains: (a, p: V): boolean =>
      p.x >= a.x && p.x <= a.x + a.w && p.y >= a.y && p.y <= a.y + a.h,
  })
  .getters({
    /** Area of this box, reactive. Lazy + cached as own-property. */
    area(this: { value: Box }): ReadonlySignal<number> {
      const self = this;
      return computed(() => self.value.w * self.value.h);
    },
    /** Self-reference so `Reactive<Box>` values satisfy the
     *  `Boxlike` interface (which has `aabb: ReadonlySignal<Box>` so
     *  Shape/Part — who hold the Box as a *field* — and bare
     *  Reactive<Box> are interchangeable to consumers). The Reactive
     *  *is* its own Box signal — `box.aabb === box`. */
    aabb(this: any) {
      return this;
    },
    /** `at(u, v)` returns a reactive Point at normalized fraction
     *  `(0, 0)` (top-left) to `(1, 1)` (bottom-right). Implemented as
     *  a getter that returns a method-shaped closure, so it's
     *  available on every Reactive flavor (signal, derived, lens) —
     *  cardinals (`.center`, etc.) are sugar built on top. */
    at(this: { value: Box }) {
      const self = this;
      return (u: number, v: number): DerivedPoint =>
        Vec.derived(() => {
          const b = self.value;
          return { x: b.x + u * b.w, y: b.y + v * b.h };
        });
    },
    /** Centre point — `at(0.5, 0.5)`. Lazy: built on first access. */
    center(this: { value: Box }): DerivedPoint {
      const self = this;
      return Vec.derived(() => {
        const b = self.value;
        return { x: b.x + 0.5 * b.w, y: b.y + 0.5 * b.h };
      });
    },
    top(this: { value: Box }): DerivedPoint {
      const self = this;
      return Vec.derived(() => {
        const b = self.value;
        return { x: b.x + 0.5 * b.w, y: b.y };
      });
    },
    bottom(this: { value: Box }): DerivedPoint {
      const self = this;
      return Vec.derived(() => {
        const b = self.value;
        return { x: b.x + 0.5 * b.w, y: b.y + b.h };
      });
    },
    left(this: { value: Box }): DerivedPoint {
      const self = this;
      return Vec.derived(() => {
        const b = self.value;
        return { x: b.x, y: b.y + 0.5 * b.h };
      });
    },
    right(this: { value: Box }): DerivedPoint {
      const self = this;
      return Vec.derived(() => {
        const b = self.value;
        return { x: b.x + b.w, y: b.y + 0.5 * b.h };
      });
    },
  })
  .build();

/** Reactive parametric anchor on a Box — sugar over `box.at(u, v)`. */
export const boxAt = (
  box: { at: (u: number, v: number) => Pointlike },
  u: number,
  v: number,
) => box.at(u, v);
