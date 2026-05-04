// Bounds — minimal axis-aligned rectangle for v2. v1's `Bounds` (in
// `elements/geom.ts`) carries cached anchor points (center/tl/tr/etc.);
// v2 doesn't need them now that pivots are normalized coords, so we
// keep this lean.

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
