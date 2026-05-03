// Pure geometry — no rendering, no DOM.

export type Point = { x: number; y: number };
export type Bounds = { x: number; y: number; w: number; h: number };

export type EdgeDir =
  | "top"
  | "bottom"
  | "left"
  | "right"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right"
  | "center";

export const pt = (x: number, y: number): Point => ({ x, y });

export const lerp = (a: number, b: number, t: number): number =>
  a + (b - a) * t;

export const lerpPt = (a: Point, b: Point, t: number): Point => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
});

export const midpoint = (a: Point, b: Point): Point => lerpPt(a, b, 0.5);

export const dist = (a: Point, b: Point): number => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
};

/** Polar to cartesian. Angle in radians, 0 = right, π/2 = down. */
export function polar(cx: number, cy: number, r: number, angle: number): Point {
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
}

export function unionBounds(...bounds: Bounds[]): Bounds {
  if (bounds.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let { x, y } = bounds[0];
  let r = x + bounds[0].w;
  let b = y + bounds[0].h;
  for (let i = 1; i < bounds.length; i++) {
    const o = bounds[i];
    x = Math.min(x, o.x);
    y = Math.min(y, o.y);
    r = Math.max(r, o.x + o.w);
    b = Math.max(b, o.y + o.h);
  }
  return { x, y, w: r - x, h: b - y };
}

export function expandBounds(bounds: Bounds, n: number): Bounds {
  return {
    x: bounds.x - n,
    y: bounds.y - n,
    w: bounds.w + 2 * n,
    h: bounds.h + 2 * n,
  };
}

export function boundsEdge(b: Bounds, dir: EdgeDir): Point {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  switch (dir) {
    case "top":
      return { x: cx, y: b.y };
    case "bottom":
      return { x: cx, y: b.y + b.h };
    case "left":
      return { x: b.x, y: cy };
    case "right":
      return { x: b.x + b.w, y: cy };
    case "top-left":
      return { x: b.x, y: b.y };
    case "top-right":
      return { x: b.x + b.w, y: b.y };
    case "bottom-left":
      return { x: b.x, y: b.y + b.h };
    case "bottom-right":
      return { x: b.x + b.w, y: b.y + b.h };
    case "center":
      return { x: cx, y: cy };
  }
}

/** Point on a circle's edge in the direction of `from`. */
export function circleEdgeFrom(
  cx: number,
  cy: number,
  r: number,
  from: Point,
): Point {
  const dx = from.x - cx;
  const dy = from.y - cy;
  const d = Math.sqrt(dx * dx + dy * dy) || 1;
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
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  const t = Math.min(
    adx === 0 ? Infinity : halfW / adx,
    ady === 0 ? Infinity : halfH / ady,
  );
  return { x: cx + dx * t, y: cy + dy * t };
}
