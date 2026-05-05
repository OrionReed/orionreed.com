import { Shape } from "../shape";
import { aabb, Bounds } from "../bounds";
import { computed, read, unwrap, type Arg } from "../signal";
import { tokens } from "../tokens";
import { Point } from "../point";
import type { Segment } from "../dashed";
import { applyOpts, setupDashed, type CommonOpts } from "./common";

export interface RectOpts extends CommonOpts {
  corner?: Arg<number>;
}

const HALF_PI = Math.PI / 2;

export class Rect extends Shape {
  readonly corner: Arg<number>;

  constructor(
    readonly x: Arg<number>,
    readonly y: Arg<number>,
    readonly w: Arg<number>,
    readonly h: Arg<number>,
    opts: RectOpts = {},
  ) {
    const dashed = opts.dashed ?? false;
    super(
      dashed ? "path" : "rect",
      () => aabb(unwrap(x), unwrap(y), unwrap(w), unwrap(h)),
      opts,
    );
    this.corner = opts.corner ?? tokens.corner;
    if (!dashed) {
      this.attr("x", () => unwrap(x));
      this.attr("y", () => unwrap(y));
      this.attr("width", () => unwrap(w));
      this.attr("height", () => unwrap(h));
      this.attr("rx", this.corner);
      this.attr("ry", this.corner);
    }
    setupDashed(this, opts, true);
    applyOpts(this, opts);
  }

  override boundary(toward: Point): Point {
    const proj = computed(() => {
      const b = this.bounds.value;
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

  /** Concentric outline: returns a new (unmounted) Rect inflated by
   *  `by` on each side, with the corner radius adjusted by the same
   *  amount so the outer curve stays parallel to the inner.
   *
   *    s(r.outline(4, { dashed: true }))   // dashed frame around r
   *
   *  Reactive in `this.x/y/w/h/corner` and `by`. Style opts override
   *  defaults. */
  outline(by: Arg<number>, opts?: RectOpts): Rect {
    const byFn = read(by);
    return new Rect(
      () => unwrap(this.x) - byFn(),
      () => unwrap(this.y) - byFn(),
      () => unwrap(this.w) + 2 * byFn(),
      () => unwrap(this.h) + 2 * byFn(),
      { corner: () => unwrap(this.corner) + byFn(), ...opts },
    );
  }

  /** Rounded-rect outline: 4 sides + 4 quarter-arcs at corners. */
  override segments(): Segment[] {
    const b = this.bounds.value;
    const r = Math.min(unwrap(this.corner), b.w / 2, b.h / 2);
    const x = b.x;
    const y = b.y;
    const w = b.w;
    const h = b.h;
    if (r <= 0) {
      const tl = new Point(() => x, () => y);
      const tr = new Point(() => x + w, () => y);
      const br = new Point(() => x + w, () => y + h);
      const bl = new Point(() => x, () => y + h);
      return [
        { type: "line", from: tl, to: tr },
        { type: "line", from: tr, to: br },
        { type: "line", from: br, to: bl },
        { type: "line", from: bl, to: tl },
      ];
    }
    return [
      { type: "line", from: new Point(() => x + r, () => y), to: new Point(() => x + w - r, () => y) },
      { type: "arc", cx: () => x + w - r, cy: () => y + r, r: () => r, a0: () => -HALF_PI, a1: () => 0 },
      { type: "line", from: new Point(() => x + w, () => y + r), to: new Point(() => x + w, () => y + h - r) },
      { type: "arc", cx: () => x + w - r, cy: () => y + h - r, r: () => r, a0: () => 0, a1: () => HALF_PI },
      { type: "line", from: new Point(() => x + w - r, () => y + h), to: new Point(() => x + r, () => y + h) },
      { type: "arc", cx: () => x + r, cy: () => y + h - r, r: () => r, a0: () => HALF_PI, a1: () => Math.PI },
      { type: "line", from: new Point(() => x, () => y + h - r), to: new Point(() => x, () => y + r) },
      { type: "arc", cx: () => x + r, cy: () => y + r, r: () => r, a0: () => Math.PI, a1: () => 3 * HALF_PI },
    ];
  }
}

/** Rect factory with three forms:
 *
 *   rect(x, y, w, h, opts?)        — corner-based (canonical)
 *   rect(b: Bounds, opts?)         — derived from another shape's bounds
 *                                     (e.g. `rect(box.bounds.expand(4), {...})`)
 *   rect(center: Point, w, h, opts?) — centered around a Point. Symmetric
 *                                       with `circle(center, radius)`.
 *
 * All forms are reactive in their inputs. */
export function rect(b: Bounds, opts?: RectOpts): Rect;
export function rect(
  center: Point,
  w: Arg<number>,
  h: Arg<number>,
  opts?: RectOpts,
): Rect;
export function rect(
  x: Arg<number>,
  y: Arg<number>,
  w: Arg<number>,
  h: Arg<number>,
  opts?: RectOpts,
): Rect;
export function rect(
  a: Arg<number> | Bounds | Point,
  b?: Arg<number> | RectOpts,
  c?: Arg<number>,
  d?: Arg<number> | RectOpts,
  e?: RectOpts,
): Rect {
  if (a instanceof Bounds) {
    return new Rect(a.x, a.y, a.w, a.h, b as RectOpts | undefined);
  }
  if (a instanceof Point) {
    const w = b as Arg<number>;
    const h = c as Arg<number>;
    return new Rect(
      () => a.x() - unwrap(w) / 2,
      () => a.y() - unwrap(h) / 2,
      w,
      h,
      d as RectOpts | undefined,
    );
  }
  return new Rect(
    a as Arg<number>,
    b as Arg<number>,
    c as Arg<number>,
    d as Arg<number>,
    e,
  );
}
