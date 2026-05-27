import { Box, derive, Num, reader, type Val, Vec } from "@minim/signals";
import { type CommonOpts, type Segment, Shape } from "./shape";
import { tokens } from "./tokens";

export interface RectOpts extends CommonOpts {
  corner?: Val<number>;
}

const HALF_PI = Math.PI / 2;

export class Rect<O extends RectOpts = RectOpts> extends Shape<O> {
  readonly x: Num;
  readonly y: Num;
  readonly w: Num;
  readonly h: Num;
  readonly corner: Num;

  constructor(x: Val<number>, y: Val<number>, w: Val<number>, h: Val<number>, opts: O = {} as O) {
    const xs = Num.from(x);
    const ys = Num.from(y);
    const ws = Num.from(w);
    const hs = Num.from(h);
    super(
      opts.dashed ? "path" : "rect",
      () => ({ x: xs.value, y: ys.value, w: ws.value, h: hs.value }),
      opts,
      {
        origin: derive(() => ({
          x: xs.value + ws.value / 2,
          y: ys.value + hs.value / 2,
        })),
      },
    );
    this.x = xs;
    this.y = ys;
    this.w = ws;
    this.h = hs;
    this.corner = Num.from(opts.corner ?? tokens.corner);
    this.stroke(opts, true, {
      x: xs,
      y: ys,
      width: ws,
      height: hs,
      rx: this.corner,
      ry: this.corner,
    });
  }

  override boundary(toward: Vec): Vec {
    return Vec.derive(() => {
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
        dx === 0 ? Number.POSITIVE_INFINITY : halfW / Math.abs(dx),
        dy === 0 ? Number.POSITIVE_INFINITY : halfH / Math.abs(dy),
      );
      return { x: c.x + dx * k, y: c.y + dy * k };
    });
  }

  /** Concentric outline — a new unmounted Rect inflated by `by` per
   *  side; corner radius bumps to keep curves parallel. */
  outline(by: Val<number>, opts?: RectOpts): Rect {
    const b = reader(by);
    return new Rect(
      derive(() => this.x.value - b()),
      derive(() => this.y.value - b()),
      derive(() => this.w.value + 2 * b()),
      derive(() => this.h.value + 2 * b()),
      { corner: derive(() => this.corner.value + b()), ...opts } as RectOpts,
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
      {
        type: "arc",
        cx: () => x + w - r,
        cy: () => y + r,
        r: () => r,
        a0: () => -HALF_PI,
        a1: () => 0,
      },
      { type: "line", from: p(x + w, y + r), to: p(x + w, y + h - r) },
      {
        type: "arc",
        cx: () => x + w - r,
        cy: () => y + h - r,
        r: () => r,
        a0: () => 0,
        a1: () => HALF_PI,
      },
      { type: "line", from: p(x + w - r, y + h), to: p(x + r, y + h) },
      {
        type: "arc",
        cx: () => x + r,
        cy: () => y + h - r,
        r: () => r,
        a0: () => HALF_PI,
        a1: () => Math.PI,
      },
      { type: "line", from: p(x, y + h - r), to: p(x, y + r) },
      {
        type: "arc",
        cx: () => x + r,
        cy: () => y + r,
        r: () => r,
        a0: () => Math.PI,
        a1: () => 3 * HALF_PI,
      },
    ];
  }
}

/** Rect factory:
 *
 *   rect(x, y, w, h, opts?)             — corner-based (canonical)
 *   rect(box, opts?)                    — fill another Box (use `shape.box`)
 *   rect(center: Point, w, h, opts?)    — centered on a Point
 *   rect(p1: Point, p2: Point, opts?)   — between two corner Points
 */
export function rect<const O extends RectOpts>(b: Box, opts?: O): Rect<O>;
export function rect<const O extends RectOpts>(p1: Vec, p2: Vec, opts?: O): Rect<O>;
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
  a: Val<number> | Box | Vec,
  b?: Val<number> | Vec | RectOpts,
  c?: Val<number>,
  d?: Val<number> | RectOpts,
  e?: RectOpts,
): Rect {
  if (a instanceof Box) {
    return new Rect(
      derive(() => a.value.x),
      derive(() => a.value.y),
      derive(() => a.value.w),
      derive(() => a.value.h),
      b as RectOpts | undefined,
    );
  }
  if (a instanceof Vec && b instanceof Vec) {
    // Bounding rect of two points (any orientation).
    return new Rect(
      derive(() => Math.min(a.x.value, b.x.value)),
      derive(() => Math.min(a.y.value, b.y.value)),
      derive(() => Math.abs(b.x.value - a.x.value)),
      derive(() => Math.abs(b.y.value - a.y.value)),
      c as RectOpts | undefined,
    );
  }
  if (a instanceof Vec) {
    const w = b as Val<number>;
    const h = c as Val<number>;
    const ws = Num.from(w);
    const hs = Num.from(h);
    return new Rect(
      derive(() => a.x.value - ws.value / 2),
      derive(() => a.y.value - hs.value / 2),
      ws,
      hs,
      d as RectOpts | undefined,
    );
  }
  return new Rect(a as Val<number>, b as Val<number>, c as Val<number>, d as Val<number>, e);
}
