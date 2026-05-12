// Vec, declared via the struct framework. The whole declaration is
// roughly the size of a single hand-written method on the current
// `Point` class — and yet it produces an equivalent reactive type with
// axes, math methods, structural equality, and read-only derived
// chains.
//
// Compare to `scene/point.ts` (343 lines).

import { struct } from "./struct";
import type { M } from "./matrix";

/** The struct's value type. Declared up-front so ops can reference it
 *  in their signatures without circular type inference. */
export type V = { x: number; y: number };

export const Vec = struct<V>("Vec", { x: 0, y: 0 })
  .equals((a, b) => a.x === b.x && a.y === b.y)
  .ops({
    add: (a, b: V): V => ({ x: a.x + b.x, y: a.y + b.y }),
    sub: (a, b: V): V => ({ x: a.x - b.x, y: a.y - b.y }),
    scale: (a, k: number): V => ({ x: a.x * k, y: a.y * k }),
    perp: (a): V => ({ x: -a.y, y: a.x }),
    normalize: (a): V => {
      const len = Math.hypot(a.x, a.y) || 1;
      return { x: a.x / len, y: a.y / len };
    },
    lerp: (a, b: V, t: number): V => ({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
    }),
    /** This point in the frame `m`. Replaces hand-rolled
     *  `transformPoint(matrix.value, point.value)` calls. */
    in: (p, m: M): V => ({
      x: m.a * p.x + m.c * p.y + m.e,
      y: m.b * p.x + m.d * p.y + m.f,
    }),
  })
  .scalars({
    length: (a): number => Math.hypot(a.x, a.y),
    distance: (a, b: V): number => Math.hypot(a.x - b.x, a.y - b.y),
  })
  .build();

/** Authoring sugar matching today's `pt(x, y)`. */
export const pt = (x: number, y: number) => Vec.signal({ x, y });
