import {signal, computed, toSignal, derived, Vec, vec, Num, num, Box, box, isBoxLike, type BoxLike, type Val} from "@minim/signals";
import {Shape, type Segment} from "./shape";
import {tokens} from "./tokens";
import {intrinsicType, wireStroke, type CommonOpts} from "./common";

export interface RectOpts extends CommonOpts {
  corner?: Val<number>;
}

const HALF_PI = Math.PI / 2;

export class Rect<O extends RectOpts = RectOpts> extends Shape<O> {
  override readonly x: Num;
  override readonly y: Num;
  override readonly w: Num;
  override readonly h: Num;
  readonly corner: Num;

  constructor(
    x: Val<number>,
    y: Val<number>,
    w: Val<number>,
    h: Val<number>,
    opts: O = {} as O,
  ) {
    const xs = num(x);
    const ys = num(y);
    const ws = num(w);
    const hs = num(h);
    super(
      intrinsicType(opts, "rect"),
      () => ({ x: xs.value, y: ys.value, w: ws.value, h: hs.value }),
      opts,
      {
        origin: () => ({
          x: xs.value + ws.value / 2,
          y: ys.value + hs.value / 2,
        }),
      },
    );
    this.x = xs;
    this.y = ys;
    this.w = ws;
    this.h = hs;
    this.corner = num(opts.corner ?? tokens.corner);
    wireStroke(this, opts, true, () => {
      this.attr("x", xs);
      this.attr("y", ys);
      this.attr("width", ws);
      this.attr("height", hs);
      this.attr("rx", this.corner);
      this.attr("ry", this.corner);
    });
  }

  override boundary(toward: Vec): Vec {
    return derived(Vec, () => {
      const c = this.center.value;
      const b = this.box.value;
      const sc = this.scale.value;
      const t = toward.value;
      const halfW = (b.w / 2) * sc.x;
      const halfH = (b.h / 2) * sc.y;
      const dx = t.x - c.x;
      const dy = t.y - c.y;
      if (dx === 0 && dy === 0) return c;
      const k = Math.min(
        dx === 0 ? Infinity : halfW / Math.abs(dx),
        dy === 0 ? Infinity : halfH / Math.abs(dy),
      );
      return { x: c.x + dx * k, y: c.y + dy * k };
    });
  }

  /** Concentric outline — a new unmounted Rect inflated by `by` per
   *  side; corner radius bumps to keep curves parallel. */
  outline(by: Val<number>, opts?: RectOpts): Rect {
    const bys = toSignal(by);
    return new Rect(
      () => this.x.value - bys.value,
      () => this.y.value - bys.value,
      () => this.w.value + 2 * bys.value,
      () => this.h.value + 2 * bys.value,
      { corner: () => this.corner.value + bys.value, ...opts } as RectOpts,
    );
  }

  /** 4 sides + 4 corner quarter-arcs (or just sides when `corner === 0`). */
  override segments(): Segment[] {
    const b = this.box.value;
    const r = Math.min(this.corner.value, b.w / 2, b.h / 2);
    const x = b.x;
    const y = b.y;
    const w = b.w;
    const h = b.h;
    const p = (px: number, py: number) => ({ x: px, y: py });
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

/** Rect factory:
 *
 *   rect(x, y, w, h, opts?)             — corner-based (canonical)
 *   rect(box: BoxLike, opts?)           — fill another Box (Shape, view, split…)
 *   rect(center: Point, w, h, opts?)    — centered on a Point
 *   rect(p1: Point, p2: Point, opts?)   — between two corner Points
 */
export function rect<const O extends RectOpts>(b: BoxLike, opts?: O): Rect<O>;
export function rect<const O extends RectOpts>(
  p1: Vec,
  p2: Vec,
  opts?: O,
): Rect<O>;
export function rect<const O extends RectOpts>(
  center: Vec,
  w: Val<number>,
  h: Val<number>,
  opts?: O,
): Rect<O>;
export function rect<const O extends RectOpts>(
  x: Val<number>,
  y: Val<number>,
  w: Val<number>,
  h: Val<number>,
  opts?: O,
): Rect<O>;
export function rect(
  a: Val<number> | BoxLike | Vec,
  b?: Val<number> | Vec | RectOpts,
  c?: Val<number>,
  d?: Val<number> | RectOpts,
  e?: RectOpts,
): Rect {
  if (isBoxLike(a)) {
    return new Rect(a.x, a.y, a.w, a.h, b as RectOpts | undefined);
  }
  if (a instanceof Vec && b instanceof Vec) {
    // Bounding rect of two points (any orientation).
    return new Rect(
      computed(() => Math.min(a.x.value, b.x.value)),
      computed(() => Math.min(a.y.value, b.y.value)),
      computed(() => Math.abs(b.x.value - a.x.value)),
      computed(() => Math.abs(b.y.value - a.y.value)),
      c as RectOpts | undefined,
    );
  }
  if (a instanceof Vec) {
    const w = b as Val<number>;
    const h = c as Val<number>;
    const ws = toSignal(w);
    const hs = toSignal(h);
    return new Rect(
      computed(() => a.x.value - ws.value / 2),
      computed(() => a.y.value - hs.value / 2),
      ws,
      hs,
      d as RectOpts | undefined,
    );
  }
  return new Rect(
    a as Val<number>,
    b as Val<number>,
    c as Val<number>,
    d as Val<number>,
    e,
  );
}
