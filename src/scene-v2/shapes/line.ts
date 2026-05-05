import { Shape } from "../shape";
import { Point } from "../point";
import { aabb } from "../bounds";
import { computed, type Arg } from "../signal";
import type { Segment } from "../dashed";
import { applyOpts, setupDashed, type CommonOpts } from "./common";

export interface LineOpts extends CommonOpts {}

export class Line extends Shape {
  constructor(
    readonly from: Point,
    readonly to: Point,
    opts: LineOpts = {},
  ) {
    const dashed = opts.dashed ?? false;
    super(
      dashed ? "path" : "line",
      () => {
        const a = from.value;
        const b = to.value;
        return aabb(
          Math.min(a.x, b.x),
          Math.min(a.y, b.y),
          Math.abs(b.x - a.x),
          Math.abs(b.y - a.y),
        );
      },
      opts,
    );
    if (!dashed) {
      this.attr("x1", from.x);
      this.attr("y1", from.y);
      this.attr("x2", to.x);
      this.attr("y2", to.y);
    }
    this.attr("stroke-linecap", opts.cap ?? "round");
    setupDashed(this, opts, false);
    applyOpts(this, opts);
  }

  #tangent?: Point;
  #normal?: Point;
  #midpoint?: Point;

  get tangent(): Point {
    return (this.#tangent ??= this.to.sub(this.from).normalize());
  }
  get normal(): Point {
    return (this.#normal ??= this.tangent.perp());
  }
  get midpoint(): Point {
    return (this.#midpoint ??= this.from.lerp(this.to, 0.5));
  }
  at(t: Arg<number>): Point {
    return this.from.lerp(this.to, t);
  }
  length(): number {
    const a = this.from.value;
    const b = this.to.value;
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  /** Boundary on a line is the closer endpoint to `toward`. */
  override boundary(toward: Point): Point {
    const which = computed(() => {
      const t = toward.value;
      const a = this.from.value;
      const b = this.to.value;
      const da = (t.x - a.x) ** 2 + (t.y - a.y) ** 2;
      const db = (t.x - b.x) ** 2 + (t.y - b.y) ** 2;
      return da <= db ? a : b;
    });
    return new Point(() => which.value.x, () => which.value.y);
  }

  override segments(): Segment[] {
    return [{ type: "line", from: this.from, to: this.to }];
  }
}

export const line = (from: Point, to: Point, opts?: LineOpts) =>
  new Line(from, to, opts);
