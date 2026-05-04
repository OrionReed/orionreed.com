// Geometry primitives for v2: bounds, vec, pivot. Kept lean — v1's
// `Bounds` (in `elements/geom.ts`) carries cached anchor points;
// v2 doesn't need them now that pivots are normalized coords.

/** Literal 2D vector — used for shape-internal transform values. */
export interface Vec {
  x: number;
  y: number;
}

export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Pivot — normalized coordinate within a shape's bounds. `{x:0, y:0}`
 * is top-left, `{x:1, y:1}` bottom-right. Off-axis values are valid
 * (no string-enum gating). `Pivot` namespace exposes named constants.
 */
export interface Pivot {
  x: number;
  y: number;
}

export const Pivot = Object.freeze({
  TL: { x: 0, y: 0 } as Pivot,
  TR: { x: 1, y: 0 } as Pivot,
  BL: { x: 0, y: 1 } as Pivot,
  BR: { x: 1, y: 1 } as Pivot,
  TOP: { x: 0.5, y: 0 } as Pivot,
  BOTTOM: { x: 0.5, y: 1 } as Pivot,
  LEFT: { x: 0, y: 0.5 } as Pivot,
  RIGHT: { x: 1, y: 0.5 } as Pivot,
  CENTER: { x: 0.5, y: 0.5 } as Pivot,
});

export function bounds(x: number, y: number, w: number, h: number): Bounds {
  return { x, y, w, h };
}

/** Inflate a bounds by `n` on each side. */
export function expandBounds(b: Bounds, n: number): Bounds {
  return bounds(b.x - n, b.y - n, b.w + 2 * n, b.h + 2 * n);
}

/** Smallest bounds enclosing all inputs. Empty input → zero bounds. */
export function unionBounds(...bs: Bounds[]): Bounds {
  if (bs.length === 0) return bounds(0, 0, 0, 0);
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
  return bounds(xMin, yMin, xMax - xMin, yMax - yMin);
}
