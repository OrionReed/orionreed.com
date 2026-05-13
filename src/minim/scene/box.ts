// `Boxlike` is the structural reactive-rectangular-region surface
// used across minim. It's implemented by:
//
//   - Shape (class with an `.aabb` Signal field + cardinal anchors)
//   - Part  (class with an `.aabb` Signal field + cardinal anchors)
//   - any `Reactive<Box>` from `signals/aabb` (the framework's
//     prototype provides `.aabb` as a self-reference, plus the
//     cardinals and `.at(u, v)` via `.getters({...})`)
//
// All three types satisfy this interface structurally — consumers
// take `Boxlike` and don't care which one they got. (Mirrors how
// `Pointlike` unifies Vec.signal / Vec.derived / Vec.lens results.)
//
// `aabb` (the value-level helpers below) and `Boxlike` (the
// interface) live here together because they're conceptually paired.
// The reactive `Box` struct itself lives in `signals/aabb`.

import type { ReadonlySignal } from "../core/signal";
import type { Pointlike } from "../signals/vec";
// `Box` here is the *type alias* for the plain `{x, y, w, h}` shape.
// The struct *value* of the same name lives in `../signals/aabb` —
// type and value share the name, same trick `class` uses.
export type { Box } from "../signals/aabb";
import type { Box } from "../signals/aabb";

export const aabb = (x: number, y: number, w: number, h: number): Box =>
  ({ x, y, w, h });

export const expandAABB = (b: Box, n: number): Box =>
  aabb(b.x - n, b.y - n, b.w + 2 * n, b.h + 2 * n);

export function unionAABB(...bs: Box[]): Box {
  if (bs.length === 0) return aabb(0, 0, 0, 0);
  let xMin = bs[0].x;
  let yMin = bs[0].y;
  let xMax = xMin + bs[0].w;
  let yMax = yMin + bs[0].h;
  for (let i = 1; i < bs.length; i++) {
    const o = bs[i];
    if (o.x < xMin) xMin = o.x;
    if (o.y < yMin) yMin = o.y;
    if (o.x + o.w > xMax) xMax = o.x + o.w;
    if (o.y + o.h > yMax) yMax = o.y + o.h;
  }
  return aabb(xMin, yMin, xMax - xMin, yMax - yMin);
}

/** Perimeter point on a Box facing `toward`. Used by default
 *  `Shape.boundary`. */
export function aabbEdgeFrom(
  b: Box,
  toward: { x: number; y: number },
): { x: number; y: number } {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const k = Math.min(
    dx === 0 ? Infinity : (b.w / 2) / Math.abs(dx),
    dy === 0 ? Infinity : (b.h / 2) / Math.abs(dy),
  );
  return { x: cx + dx * k, y: cy + dy * k };
}

/** Reactive rectangular region. Anchor types are `Pointlike` so
 *  implementations can narrow: views, splits, parts return read-only
 *  `DerivedPoint`s; `Shape` returns writable `Point`s (lens-backed
 *  through `translate`). */
export interface Boxlike {
  /** Source-of-truth Box signal; everything else derives from it.
   *  For `Reactive<Box>` values from the framework, this is a
   *  self-reference (`box.aabb === box`); for `Shape`/`Part`, it's
   *  a real field. */
  readonly aabb: ReadonlySignal<Box>;

  readonly x: ReadonlySignal<number>;
  readonly y: ReadonlySignal<number>;
  readonly w: ReadonlySignal<number>;
  readonly h: ReadonlySignal<number>;

  readonly center: Pointlike;
  readonly top: Pointlike;
  readonly bottom: Pointlike;
  readonly left: Pointlike;
  readonly right: Pointlike;

  /** Reactive Point at normalized fraction `(u, v)`: `(0, 0)` is
   *  top-left, `(1, 1)` is bottom-right. Cardinals are sugar. */
  at(u: number, v: number): Pointlike;
}
