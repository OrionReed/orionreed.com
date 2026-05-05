import { Shape } from "../shape";
import { aabb, Bounds } from "../bounds";
import { computed, unwrap, type Arg } from "../signal";
import { tokens } from "../tokens";
import { Point } from "../point";
import { applyOpts, type CommonOpts } from "./common";

export interface RectOpts extends CommonOpts {
  corner?: Arg<number>;
}

export class Rect extends Shape {
  constructor(
    readonly x: Arg<number>,
    readonly y: Arg<number>,
    readonly w: Arg<number>,
    readonly h: Arg<number>,
    opts: RectOpts = {},
  ) {
    super(
      "rect",
      () => aabb(unwrap(x), unwrap(y), unwrap(w), unwrap(h)),
      opts,
    );
    this.attr("x", () => unwrap(x));
    this.attr("y", () => unwrap(y));
    this.attr("width", () => unwrap(w));
    this.attr("height", () => unwrap(h));
    this.attr("rx", opts.corner ?? tokens.corner);
    this.attr("ry", opts.corner ?? tokens.corner);
    applyOpts(this, opts);
  }

  override boundary(toward: Point): Point {
    const proj = computed(() => {
      const b = this.bounds.snap();
      const t = toward.value;
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      const dx = t.x - cx;
      const dy = t.y - cy;
      if (dx === 0 && dy === 0) return { x: cx, y: cy };
      const k = Math.min(
        dx === 0 ? Infinity : (b.w / 2) / Math.abs(dx),
        dy === 0 ? Infinity : (b.h / 2) / Math.abs(dy),
      );
      return { x: cx + dx * k, y: cy + dy * k };
    });
    return new Point(() => proj.value.x, () => proj.value.y);
  }
}

/** Two forms: positional `rect(x, y, w, h, opts?)`, or derived from
 *  another shape's bounds — `rect(box.bounds.expand(4), opts?)`
 *  (reactive). */
export function rect(b: Bounds, opts?: RectOpts): Rect;
export function rect(
  x: Arg<number>,
  y: Arg<number>,
  w: Arg<number>,
  h: Arg<number>,
  opts?: RectOpts,
): Rect;
export function rect(
  a: Arg<number> | Bounds,
  b?: Arg<number> | RectOpts,
  c?: Arg<number>,
  d?: Arg<number>,
  e?: RectOpts,
): Rect {
  if (a instanceof Bounds) {
    return new Rect(a.x, a.y, a.w, a.h, b as RectOpts | undefined);
  }
  return new Rect(
    a as Arg<number>,
    b as Arg<number>,
    c as Arg<number>,
    d as Arg<number>,
    e,
  );
}
