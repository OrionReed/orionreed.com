import { computed, toSig, type Arg, type NumSig } from "../core";
import {
  Shape,
  DerivedPoint,
  Point,
  aabb,
  isPoint,
  type Box,
  type Pointlike,
  type Segment,
} from "../scene";
import { tokens } from "./tokens";
import { intrinsicType, wireStroke, type CommonOpts } from "./common";

export interface RectOpts extends CommonOpts {
  corner?: Arg<number>;
}

const HALF_PI = Math.PI / 2;

export class Rect<O extends RectOpts = RectOpts> extends Shape<O> {
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
    opts: O = {} as O,
  ) {
    const xs = toSig(x);
    const ys = toSig(y);
    const ws = toSig(w);
    const hs = toSig(h);
    super(
      intrinsicType(opts, "rect"),
      () => aabb(xs.value, ys.value, ws.value, hs.value),
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
    this.corner = toSig(opts.corner ?? tokens.corner);
    wireStroke(this, opts, true, () => {
      this.attr("x", xs);
      this.attr("y", ys);
      this.attr("width", ws);
      this.attr("height", hs);
      this.attr("rx", this.corner);
      this.attr("ry", this.corner);
    });
  }

  override boundary(toward: Pointlike): DerivedPoint {
    return new DerivedPoint(() => {
      const c = this.center.value;
      const b = this.aabb.value;
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
  outline(by: Arg<number>, opts?: RectOpts): Rect {
    const bys = toSig(by);
    return new Rect(
      computed(() => this.x.value - bys.value),
      computed(() => this.y.value - bys.value),
      computed(() => this.w.value + 2 * bys.value),
      computed(() => this.h.value + 2 * bys.value),
      { corner: computed(() => this.corner.value + bys.value), ...opts } as RectOpts,
    );
  }

  /** 4 sides + 4 corner quarter-arcs (or just sides when `corner === 0`). */
  override segments(): Segment[] {
    const b = this.aabb.value;
    const r = Math.min(this.corner.value, b.w / 2, b.h / 2);
    const x = b.x;
    const y = b.y;
    const w = b.w;
    const h = b.h;
    const p = (px: number, py: number) => new Point({ x: px, y: py });
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

/** Detect a `Box`-shaped value structurally (anything with `aabb` and
 *  `at`). Used by the `rect(box, opts?)` overload — Shape, view, and
 *  split/grid results all qualify. */
function isBox(v: unknown): v is Box {
  return (
    typeof v === "object" &&
    v !== null &&
    "aabb" in v &&
    typeof (v as { at?: unknown }).at === "function"
  );
}

/** Rect factory:
 *
 *   rect(x, y, w, h, opts?)             — corner-based (canonical)
 *   rect(box: Box, opts?)               — fill another Box (Shape, view, split…)
 *   rect(center: Point, w, h, opts?)    — centered on a Point
 *   rect(p1: Point, p2: Point, opts?)   — between two corner Points
 */
export function rect<const O extends RectOpts>(b: Box, opts?: O): Rect<O>;
export function rect<const O extends RectOpts>(
  p1: Pointlike,
  p2: Pointlike,
  opts?: O,
): Rect<O>;
export function rect<const O extends RectOpts>(
  center: Pointlike,
  w: Arg<number>,
  h: Arg<number>,
  opts?: O,
): Rect<O>;
export function rect<const O extends RectOpts>(
  x: Arg<number>,
  y: Arg<number>,
  w: Arg<number>,
  h: Arg<number>,
  opts?: O,
): Rect<O>;
export function rect(
  a: Arg<number> | Box | Pointlike,
  b?: Arg<number> | Pointlike | RectOpts,
  c?: Arg<number>,
  d?: Arg<number> | RectOpts,
  e?: RectOpts,
): Rect {
  if (isBox(a)) {
    return new Rect(a.x, a.y, a.w, a.h, b as RectOpts | undefined);
  }
  if (isPoint(a) && isPoint(b)) {
    // Bounding rect of two points (any orientation).
    return new Rect(
      computed(() => Math.min(a.x.value, b.x.value)),
      computed(() => Math.min(a.y.value, b.y.value)),
      computed(() => Math.abs(b.x.value - a.x.value)),
      computed(() => Math.abs(b.y.value - a.y.value)),
      c as RectOpts | undefined,
    );
  }
  if (isPoint(a)) {
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
