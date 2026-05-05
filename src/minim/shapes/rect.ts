import { Shape } from "../shape";
import { aabb, Bounds } from "../bounds";
import { computed, signal, toSig, type Arg, type Signal, type ReadonlySignal } from "../signal";
import { tokens } from "../tokens";
import { Point } from "../point";
import type { Segment } from "../dashed";
import { applyOpts, setupDashed, type CommonOpts } from "./common";

export interface RectOpts extends CommonOpts {
  corner?: Arg<number>;
}

const HALF_PI = Math.PI / 2;

type NumSig = Signal<number> | ReadonlySignal<number>;

export class Rect extends Shape {
  readonly x: NumSig;
  readonly y: NumSig;
  readonly w: NumSig;
  readonly h: NumSig;
  readonly corner: NumSig;

  constructor(
    x: Arg<number>,
    y: Arg<number>,
    w: Arg<number>,
    h: Arg<number>,
    opts: RectOpts = {},
  ) {
    const xs = toSig(x);
    const ys = toSig(y);
    const ws = toSig(w);
    const hs = toSig(h);
    const dashed = opts.dashed ?? false;
    super(
      dashed ? "path" : "rect",
      () => aabb(xs.value, ys.value, ws.value, hs.value),
      opts,
    );
    this.x = xs;
    this.y = ys;
    this.w = ws;
    this.h = hs;
    this.corner = toSig(opts.corner ?? tokens.corner);
    if (!dashed) {
      this.attr("x", xs);
      this.attr("y", ys);
      this.attr("width", ws);
      this.attr("height", hs);
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
    return new Point(
      computed(() => proj.value.x),
      computed(() => proj.value.y),
    );
  }

  /** Concentric outline: returns a new (unmounted) Rect inflated by
   *  `by` on each side, with the corner radius adjusted by the same
   *  amount so the outer curve stays parallel to the inner. */
  outline(by: Arg<number>, opts?: RectOpts): Rect {
    const bys = toSig(by);
    return new Rect(
      computed(() => this.x.value - bys.value),
      computed(() => this.y.value - bys.value),
      computed(() => this.w.value + 2 * bys.value),
      computed(() => this.h.value + 2 * bys.value),
      { corner: computed(() => this.corner.value + bys.value), ...opts },
    );
  }

  /** Rounded-rect outline: 4 sides + 4 quarter-arcs at corners. */
  override segments(): Segment[] {
    const b = this.bounds.value;
    const r = Math.min(this.corner.value, b.w / 2, b.h / 2);
    const x = b.x;
    const y = b.y;
    const w = b.w;
    const h = b.h;
    const p = (px: number, py: number) =>
      new Point(signal(px), signal(py));
    if (r <= 0) {
      return [
        { type: "line", from: p(x, y), to: p(x + w, y) },
        { type: "line", from: p(x + w, y), to: p(x + w, y + h) },
        { type: "line", from: p(x + w, y + h), to: p(x, y + h) },
        { type: "line", from: p(x, y + h), to: p(x, y) },
      ];
    }
    return [
      { type: "line", from: p(x + r, y), to: p(x + w - r, y) },
      { type: "arc", cx: () => x + w - r, cy: () => y + r, r: () => r, a0: () => -HALF_PI, a1: () => 0 },
      { type: "line", from: p(x + w, y + r), to: p(x + w, y + h - r) },
      { type: "arc", cx: () => x + w - r, cy: () => y + h - r, r: () => r, a0: () => 0, a1: () => HALF_PI },
      { type: "line", from: p(x + w - r, y + h), to: p(x + r, y + h) },
      { type: "arc", cx: () => x + r, cy: () => y + h - r, r: () => r, a0: () => HALF_PI, a1: () => Math.PI },
      { type: "line", from: p(x, y + h - r), to: p(x, y + r) },
      { type: "arc", cx: () => x + r, cy: () => y + r, r: () => r, a0: () => Math.PI, a1: () => 3 * HALF_PI },
    ];
  }
}

/** Rect factory with three forms:
 *
 *   rect(x, y, w, h, opts?)        — corner-based (canonical)
 *   rect(b: Bounds, opts?)         — derived from another shape's bounds
 *   rect(center: Point, w, h, opts?) — centered around a Point.
 */
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
    const ws = toSig(w);
    const hs = toSig(h);
    return new Rect(
      computed(() => a.x.value - ws.value / 2),
      computed(() => a.y.value - hs.value / 2),
      ws,
      hs,
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
