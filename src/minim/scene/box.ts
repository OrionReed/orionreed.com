// `Box` is the structural type for any reactive rectangular region.
// Implemented by `Shape`, by `s.view()`, and by the layout helpers
// (`split` / `grid` / `expand`). The name is structural, not a class —
// authors never construct a "Box" directly; they receive one from a
// Shape, the scene, or layout sugar.
//
// `aabb` is the source-of-truth Signal; `x/y/w/h` are convenience
// signals; `center/top/bottom/left/right` are read-only anchor Points;
// `at(u, v)` is the parametric escape hatch. Named corners (tl/tr/...)
// are deliberately absent — use `at(0, 0)` etc. on the rare occasion
// you want one.
//
// For placement (writing through anchors to position a Shape), see the
// future writable-anchor plan; today, write `shape.translate` directly.

import { DerivedPoint } from "./point";
import { computed, type ReadonlySignal } from "../core/signal";

export interface AABB {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export const aabb = (x: number, y: number, w: number, h: number): AABB =>
  ({ x, y, w, h });

export const expandAABB = (b: AABB, n: number): AABB =>
  aabb(b.x - n, b.y - n, b.w + 2 * n, b.h + 2 * n);

export function unionAABB(...bs: AABB[]): AABB {
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

/** Perimeter point on an AABB facing `toward`. Used by default
 *  `Shape.boundary`. */
export function aabbEdgeFrom(
  b: AABB,
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

/** Reactive rectangular region. Read-only — for placement, write
 *  through the owning Shape. */
export interface Box {
  /** Source-of-truth AABB Signal; everything else derives from it. */
  readonly aabb: ReadonlySignal<AABB>;

  readonly x: ReadonlySignal<number>;
  readonly y: ReadonlySignal<number>;
  readonly w: ReadonlySignal<number>;
  readonly h: ReadonlySignal<number>;

  readonly center: DerivedPoint;
  readonly top: DerivedPoint;
  readonly bottom: DerivedPoint;
  readonly left: DerivedPoint;
  readonly right: DerivedPoint;

  /** Reactive Point at normalized fraction `(u, v)`: `(0, 0)` is
   *  top-left, `(1, 1)` is bottom-right. Cardinals are sugar. */
  at(u: number, v: number): DerivedPoint;
}

/** Build a Box from a reactive AABB Signal. The 5 cardinal anchors are
 *  created eagerly (each is a tiny DerivedPoint); `at(u, v)` constructs
 *  fresh DerivedPoints on demand. */
export function makeBox(sig: ReadonlySignal<AABB>): Box {
  const at = (u: number, v: number): DerivedPoint =>
    new DerivedPoint(() => {
      const b = sig.value;
      return { x: b.x + u * b.w, y: b.y + v * b.h };
    });

  return {
    aabb: sig,
    x: computed(() => sig.value.x),
    y: computed(() => sig.value.y),
    w: computed(() => sig.value.w),
    h: computed(() => sig.value.h),
    center: at(0.5, 0.5),
    top: at(0.5, 0),
    bottom: at(0.5, 1),
    left: at(0, 0.5),
    right: at(1, 0.5),
    at,
  };
}
