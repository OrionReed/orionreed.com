// AABB literal, Bounds rich wrapper, Vec.

import { Point } from "./point";
import { computed, toSig, type Arg, type ReadonlySignal } from "./signal";

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

/** Reactive bounds wrapper: `x`/`y`/`w`/`h` Signals, lazy anchor Points,
 *  `value` getter for current AABB, derived ops (`expand`, `split`,
 *  `grid`). */
export class Bounds {
  readonly x: ReadonlySignal<number>;
  readonly y: ReadonlySignal<number>;
  readonly w: ReadonlySignal<number>;
  readonly h: ReadonlySignal<number>;

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
    this.x = computed(() => sig.value.x);
    this.y = computed(() => sig.value.y);
    this.w = computed(() => sig.value.w);
    this.h = computed(() => sig.value.h);
  }

  get tl()     { return (this.#tl     ??= this.at(0,   0)); }
  get tr()     { return (this.#tr     ??= this.at(1,   0)); }
  get bl()     { return (this.#bl     ??= this.at(0,   1)); }
  get br()     { return (this.#br     ??= this.at(1,   1)); }
  get top()    { return (this.#top    ??= this.at(0.5, 0)); }
  get bottom() { return (this.#bottom ??= this.at(0.5, 1)); }
  get left()   { return (this.#left   ??= this.at(0,   0.5)); }
  get right()  { return (this.#right  ??= this.at(1,   0.5)); }
  get center() { return (this.#center ??= this.at(0.5, 0.5)); }

  /** Reactive Point at normalized fraction (u, v) within these bounds.
   *  `(0, 0)` = top-left, `(1, 1)` = bottom-right. The named getters
   *  above (`tl`, `center`, etc.) cover the common cases. */
  at(u: number, v: number): Point {
    return new Point(
      computed(() => { const b = this.sig.value; return b.x + u * b.w; }),
      computed(() => { const b = this.sig.value; return b.y + v * b.h; }),
    );
  }

  /** Current AABB snapshot. Tracks inside an effect, like Signal/Point. */
  get value(): AABB {
    return this.sig.value;
  }

  /** Derived bounds inflated by `by`. Reactive in source bounds + `by`. */
  expand(by: Arg<number>): Bounds {
    const bys = toSig(by);
    return new Bounds(computed(() => expandAABB(this.sig.value, bys.value)));
  }

  /** 2D split into a `rows × cols` grid of reactive child Bounds.
   *  Sugar over two `split` calls. Returns `[row][col]`. */
  grid(
    rows: number,
    cols: number,
    opts: { gap?: Arg<number> } = {},
  ): Bounds[][] {
    return this.split("y", rows, opts).map((row) => row.split("x", cols, opts));
  }

  /** Split into N reactive child Bounds along an axis.
   *
   *   `b.split("x", 3)`           → 3 equal columns
   *   `b.split("x", [3, 2, 2])`   → 3 columns weighted 3:2:2
   *   `b.split("x", 3, { gap: 4 })` → with 4px between
   */
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
    const gapSig = toSig(opts.gap ?? 0);
    return ratios.map((r, i) =>
      new Bounds(
        computed(() => {
          const b = this.sig.value;
          const gap = gapSig.value;
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
