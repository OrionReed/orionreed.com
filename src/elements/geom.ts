// Pure geometry — no rendering, no DOM.

// ============= Types =============

export type Point = { x: number; y: number };
/** Semantic alias for direction vectors. */
export type Vec = { x: number; y: number };
/** Angle in radians. SVG y is down, so 0 = right, π/2 = down, -π/2 = up. */
export type Angle = number;
/** A point with a tangent direction (e.g. the tip of a Path). */
export type Heading = Point & { angle: Angle };

// ============= Constructors / converters =============

export const pt = (x: number, y: number): Point => ({ x, y });
export const vec = (x: number, y: number): Vec => ({ x, y });
export const heading = (x: number, y: number, angle: Angle): Heading => ({
  x,
  y,
  angle,
});

/** Degrees → radians. */
export const deg = (d: number): Angle => (d * Math.PI) / 180;
/** Identity, for symmetry / clarity at call sites. */
export const rad = (r: number): Angle => r;

export function isHeading(p: Point | Heading): p is Heading {
  return typeof (p as Heading).angle === "number";
}

// ============= Numeric / point utilities =============

export const lerp = (a: number, b: number, t: number): number =>
  a + (b - a) * t;
export const lerpPt = (a: Point, b: Point, t: number): Point => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
});
export const midpoint = (a: Point, b: Point): Point => lerpPt(a, b, 0.5);
export const dist = (a: Point, b: Point): number =>
  Math.hypot(b.x - a.x, b.y - a.y);

/** Polar to cartesian. Angle in radians; 0 = right, π/2 = down (SVG). */
export function polar(
  cx: number,
  cy: number,
  r: number,
  angle: number,
): Point {
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
}

// ============= Point operations (immutable) =============

export const offset = (p: Point, dx: number, dy: number): Point => ({
  x: p.x + dx,
  y: p.y + dy,
});
export const up = (p: Point, n: number): Point => ({ x: p.x, y: p.y - n });
export const down = (p: Point, n: number): Point => ({ x: p.x, y: p.y + n });
export const left = (p: Point, n: number): Point => ({ x: p.x - n, y: p.y });
export const right = (p: Point, n: number): Point => ({ x: p.x + n, y: p.y });

/** Step from `p` along `dir` (an angle in radians or a vector) by `dist` units. */
export function along(p: Point, dir: Angle | Vec, dist: number): Point {
  if (typeof dir === "number") {
    return { x: p.x + Math.cos(dir) * dist, y: p.y + Math.sin(dir) * dist };
  }
  const len = Math.hypot(dir.x, dir.y) || 1;
  return { x: p.x + (dir.x / len) * dist, y: p.y + (dir.y / len) * dist };
}

// ============= Bounds with named anchors =============

/**
 * Axis-aligned rectangle with cached anchor points. The 4 mid-edges and
 * 4 corners are accessible by name so call sites read like English
 * (`rect.bounds.top`, `row.bounds.center`).
 */
export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly center: Point;
  readonly top: Point;
  readonly bottom: Point;
  readonly left: Point;
  readonly right: Point;
  readonly tl: Point;
  readonly tr: Point;
  readonly bl: Point;
  readonly br: Point;
}

export function bounds(x: number, y: number, w: number, h: number): Bounds {
  const r = x + w;
  const b = y + h;
  const cx = x + w / 2;
  const cy = y + h / 2;
  return {
    x,
    y,
    w,
    h,
    center: { x: cx, y: cy },
    top: { x: cx, y },
    bottom: { x: cx, y: b },
    left: { x, y: cy },
    right: { x: r, y: cy },
    tl: { x, y },
    tr: { x: r, y },
    bl: { x, y: b },
    br: { x: r, y: b },
  };
}

export function expandBounds(b: Bounds, n: number): Bounds {
  return bounds(b.x - n, b.y - n, b.w + 2 * n, b.h + 2 * n);
}

export function unionBounds(...bs: Bounds[]): Bounds {
  if (bs.length === 0) return bounds(0, 0, 0, 0);
  let xMin = bs[0].x;
  let yMin = bs[0].y;
  let xMax = xMin + bs[0].w;
  let yMax = yMin + bs[0].h;
  for (let i = 1; i < bs.length; i++) {
    const o = bs[i];
    xMin = Math.min(xMin, o.x);
    yMin = Math.min(yMin, o.y);
    xMax = Math.max(xMax, o.x + o.w);
    yMax = Math.max(yMax, o.y + o.h);
  }
  return bounds(xMin, yMin, xMax - xMin, yMax - yMin);
}

// ============= Shape edge math =============

/** Point on a circle's edge in the direction of `from`. */
export function circleEdgeFrom(
  cx: number,
  cy: number,
  r: number,
  from: Point,
): Point {
  const dx = from.x - cx;
  const dy = from.y - cy;
  const d = Math.hypot(dx, dy) || 1;
  return { x: cx + (dx / d) * r, y: cy + (dy / d) * r };
}

/** Point on a rect's edge along the line from rect center to `from`. */
export function rectEdgeFrom(b: Bounds, from: Point): Point {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const dx = from.x - cx;
  const dy = from.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const halfW = b.w / 2;
  const halfH = b.h / 2;
  const t = Math.min(
    dx === 0 ? Infinity : halfW / Math.abs(dx),
    dy === 0 ? Infinity : halfH / Math.abs(dy),
  );
  return { x: cx + dx * t, y: cy + dy * t };
}

// ============= Path builder =============

/**
 * Fluent point-sequence builder. Each method extends the current end by
 * a relative or absolute step. `tip` returns the last point with the
 * tangent angle of the last segment — pass it to `s.label()` to get
 * label rotation aligned with the path direction "for free".
 */
export interface Path {
  readonly points: readonly Point[];
  readonly tip: Heading;
  up(n: number): Path;
  down(n: number): Path;
  left(n: number): Path;
  right(n: number): Path;
  offset(dx: number, dy: number): Path;
  along(dir: Angle | Vec, dist: number): Path;
  to(p: Point): Path;
}

class PathImpl implements Path {
  constructor(public readonly points: readonly Point[]) {}

  private get last(): Point {
    return this.points[this.points.length - 1];
  }

  get tip(): Heading {
    if (this.points.length < 2) {
      const p = this.last;
      return { x: p.x, y: p.y, angle: 0 };
    }
    const a = this.points[this.points.length - 2];
    const b = this.last;
    return { x: b.x, y: b.y, angle: Math.atan2(b.y - a.y, b.x - a.x) };
  }

  private extend(p: Point): Path {
    return new PathImpl([...this.points, p]);
  }

  up(n: number): Path {
    return this.extend(up(this.last, n));
  }
  down(n: number): Path {
    return this.extend(down(this.last, n));
  }
  left(n: number): Path {
    return this.extend(left(this.last, n));
  }
  right(n: number): Path {
    return this.extend(right(this.last, n));
  }
  offset(dx: number, dy: number): Path {
    return this.extend(offset(this.last, dx, dy));
  }
  along(dir: Angle | Vec, d: number): Path {
    return this.extend(along(this.last, dir, d));
  }
  to(p: Point): Path {
    return this.extend(p);
  }
}

export function path(start: Point): Path {
  return new PathImpl([start]);
}
