// AABB literal, Bounds rich wrapper, Vec, Pivot.

import { Point } from "./point";
import { computed, unwrap, type Arg, type ReadonlySignal } from "./signal";

/** Axis-aligned bounding box snapshot. */
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

/** Rect-edge math — perimeter point on an AABB facing `toward`. The
 *  default Shape.boundary uses this; subclasses with tighter analytic
 *  boundaries (Circle, Rect) override. */
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

export interface Vec {
  x: number;
  y: number;
}

/** Normalized 0..1 coord within a shape's bounds. `{0,0}` is top-left. */
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

/** Reactive bounds wrapper: thunks `x()`/`y()`/`w()`/`h()`, lazy anchor
 *  Points, `snap()` for one-shot AABB read, `expand(by)` for derived. */
export class Bounds {
  readonly x: () => number;
  readonly y: () => number;
  readonly w: () => number;
  readonly h: () => number;

  #tl?: Point;
  #tr?: Point;
  #bl?: Point;
  #br?: Point;
  #top?: Point;
  #bottom?: Point;
  #left?: Point;
  #right?: Point;
  #center?: Point;

  constructor(private readonly sig: ReadonlySignal<AABB>) {
    this.x = () => sig.value.x;
    this.y = () => sig.value.y;
    this.w = () => sig.value.w;
    this.h = () => sig.value.h;
  }

  get tl()     { return (this.#tl     ??= this.anchor(Pivot.TL)); }
  get tr()     { return (this.#tr     ??= this.anchor(Pivot.TR)); }
  get bl()     { return (this.#bl     ??= this.anchor(Pivot.BL)); }
  get br()     { return (this.#br     ??= this.anchor(Pivot.BR)); }
  get top()    { return (this.#top    ??= this.anchor(Pivot.TOP)); }
  get bottom() { return (this.#bottom ??= this.anchor(Pivot.BOTTOM)); }
  get left()   { return (this.#left   ??= this.anchor(Pivot.LEFT)); }
  get right()  { return (this.#right  ??= this.anchor(Pivot.RIGHT)); }
  get center() { return (this.#center ??= this.anchor(Pivot.CENTER)); }

  /** Anchor at arbitrary normalized coords. Allocates a fresh Point. */
  anchor(at: Pivot): Point {
    return new Point(
      () => { const b = this.sig.value; return b.x + at.x * b.w; },
      () => { const b = this.sig.value; return b.y + at.y * b.h; },
    );
  }

  /** Current AABB snapshot — non-tracking equivalent of an inner `.value`. */
  snap(): AABB {
    return this.sig.value;
  }

  /** Derived bounds inflated by `by`. Reactive in source bounds + `by`. */
  expand(by: Arg<number>): Bounds {
    return new Bounds(computed(() => expandAABB(this.sig.value, unwrap(by))));
  }

  /** Split into N reactive child Bounds along an axis.
   *
   *   `b.split("x", 3)`           → 3 equal columns
   *   `b.split("x", [3, 2, 2])`   → 3 columns weighted 3:2:2
   *   `b.split("x", 3, { gap: 4 })` → with 4px between
   *
   * Each result tracks the parent bounds and the gap reactively. */
  split(
    axis: "x" | "y",
    parts: number | number[],
    opts: { gap?: Arg<number> } = {},
  ): Bounds[] {
    const ratios = typeof parts === "number" ? new Array(parts).fill(1) : parts;
    const total = ratios.reduce((a, b) => a + b, 0);
    const cumBefore = ratios.map((_, i) =>
      ratios.slice(0, i).reduce((a, b) => a + b, 0),
    );
    return ratios.map((r, i) =>
      new Bounds(
        computed(() => {
          const b = this.sig.value;
          const gap = unwrap(opts.gap ?? 0);
          const gapTotal = gap * (ratios.length - 1);
          if (axis === "x") {
            const free = b.w - gapTotal;
            const offset = (cumBefore[i] / total) * free + gap * i;
            return aabb(b.x + offset, b.y, (r / total) * free, b.h);
          }
          const free = b.h - gapTotal;
          const offset = (cumBefore[i] / total) * free + gap * i;
          return aabb(b.x, b.y + offset, b.w, (r / total) * free);
        }),
      ),
    );
  }
}
