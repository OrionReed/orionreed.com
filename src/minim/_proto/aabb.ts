// AABB, declared via the struct framework. Compare to scene/box.ts
// (114 lines including the Box interface and helpers) — this is ~45.

import { struct } from "./struct";
import { Vec, type V } from "./vec";
import type { M } from "./matrix";

export type A = { x: number; y: number; w: number; h: number };

export const AABB = struct<A>("AABB", { x: 0, y: 0, w: 0, h: 0 })
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
    /** Anchor at normalized fraction. Returns a plain Vec literal —
     *  the caller wraps with `Vec.derived` if they want it reactive. */
    at: (a, u: number, v: number): V => ({
      x: a.x + u * a.w,
      y: a.y + v * a.h,
    }),
    area: (a): number => a.w * a.h,
  })
  .build();

/** Sugar matching today's `aabb(x, y, w, h)`. */
export const aabb = (x: number, y: number, w: number, h: number) =>
  AABB.signal({ x, y, w, h });

/** Reactive parametric anchor on a Box — replaces the eager `center`,
 *  `top`, etc. fields on the legacy `Box` interface. Lazy: only built
 *  when the caller asks. */
export const boxAt = (
  box: ReturnType<typeof AABB.signal>,
  u: number,
  v: number,
) =>
  Vec.derived(() => {
    const b = box.value;
    return { x: b.x + u * b.w, y: b.y + v * b.h };
  });
