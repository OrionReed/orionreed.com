// AABB — the reactive axis-aligned bounding box primitive. Subsumes
// the old `Box` interface + `makeBox` factory (~114 lines) into one
// declaration via the struct framework.
//
// Cardinal anchors (`center`, `top`, `bottom`, `left`, `right`) are
// declared as **lazy property getters** via `.getters({...})`. Each
// is built on first access and cached as an own-property on the
// instance. Most consumers only touch one or two anchors per box —
// the rest never allocate.

import { struct } from "./struct";
import { Vec, type V, type Pointlike, type DerivedPoint } from "./vec";
import type { M } from "./matrix";

export type A = { x: number; y: number; w: number; h: number };

export const AABB = struct<A>("AABB", { x: 0, y: 0, w: 0, h: 0 })
  .construct((x: number, y: number, w: number, h: number): A => ({ x, y, w, h }))
  .equals((a, b) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h)
  .ops({
    expand: (b, n: number): A => ({
      x: b.x - n,
      y: b.y - n,
      w: b.w + 2 * n,
      h: b.h + 2 * n,
    }),
    union: (a, b: A): A => {
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const w = Math.max(a.x + a.w, b.x + b.w) - x;
      const h = Math.max(a.y + a.h, b.y + b.h) - y;
      return { x, y, w, h };
    },
    /** Component-wise lerp; enables `.to(target, dur)` tween. */
    lerp: (a, b: A, t: number): A => ({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      w: a.w + (b.w - a.w) * t,
      h: a.h + (b.h - a.h) * t,
    }),
    /** AABB in the frame `m`. Loose box around the four transformed
     *  corners. Replaces hand-rolled `transformAABB(matrix, aabb)`. */
    in: (b, m: M): A => {
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
    area: (a): number => a.w * a.h,
  })
  .getters({
    /** Self-reference so `Reactive<AABB>` values satisfy the
     *  `Box` interface (which has `aabb: ReadonlySignal<AABB>` to
     *  unify with Shape/Part who hold the AABB as a field). The
     *  Reactive *is* its own AABB signal — `box.aabb === box`. */
    aabb(this: any) {
      return this;
    },
    /** `at(u, v)` returns a reactive Point at normalized fraction
     *  `(0, 0)` (top-left) to `(1, 1)` (bottom-right). Implemented as
     *  a getter that returns a method-shaped closure, so it's
     *  available on every Reactive flavor (signal, derived, lens) —
     *  cardinals (`.center`, etc.) are sugar built on top. */
    at(this: { value: A }) {
      const self = this;
      return (u: number, v: number): DerivedPoint =>
        Vec.derived(() => {
          const b = self.value;
          return { x: b.x + u * b.w, y: b.y + v * b.h };
        });
    },
    /** Centre point — `at(0.5, 0.5)`. Lazy: built on first access. */
    center(this: { value: A }): DerivedPoint {
      const self = this;
      return Vec.derived(() => {
        const b = self.value;
        return { x: b.x + 0.5 * b.w, y: b.y + 0.5 * b.h };
      });
    },
    top(this: { value: A }): DerivedPoint {
      const self = this;
      return Vec.derived(() => {
        const b = self.value;
        return { x: b.x + 0.5 * b.w, y: b.y };
      });
    },
    bottom(this: { value: A }): DerivedPoint {
      const self = this;
      return Vec.derived(() => {
        const b = self.value;
        return { x: b.x + 0.5 * b.w, y: b.y + b.h };
      });
    },
    left(this: { value: A }): DerivedPoint {
      const self = this;
      return Vec.derived(() => {
        const b = self.value;
        return { x: b.x, y: b.y + 0.5 * b.h };
      });
    },
    right(this: { value: A }): DerivedPoint {
      const self = this;
      return Vec.derived(() => {
        const b = self.value;
        return { x: b.x + b.w, y: b.y + 0.5 * b.h };
      });
    },
  })
  .build();

/** Sugar matching today's `aabb(x, y, w, h)`. */
export const aabb = (x: number, y: number, w: number, h: number) =>
  AABB.signal({ x, y, w, h });

/** Reactive parametric anchor on a Box — sugar over `box.at(u, v)`. */
export const boxAt = (
  box: { at: (u: number, v: number) => Pointlike },
  u: number,
  v: number,
) => box.at(u, v);
