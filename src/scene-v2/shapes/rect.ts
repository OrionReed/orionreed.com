import { Shape } from "../shape";
import { aabb, Bounds } from "../bounds";
import { computed, unwrap, type Arg } from "../signal";
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

  /** Rounded-rect outline: 4 sides + 4 quarter-arcs at corners. */
  override segments(): Segment[] {
    const b = this.bounds.snap();
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
