import { Shape } from "../shape";
import { Point } from "../point";
import { aabb } from "../bounds";
import { computed, read, unwrap, type Arg } from "../signal";
import { type Segment, TWO_PI } from "../dashed";
import { applyOpts, setupDashed, type CommonOpts } from "./common";

export interface CircleOpts extends CommonOpts {}

export class Circle extends Shape {
  constructor(
    readonly center: Point,
    readonly radius: Arg<number>,
    opts: CircleOpts = {},
  ) {
    const dashed = opts.dashed ?? false;
    super(
      dashed ? "path" : "circle",
      () => {
        const r = unwrap(radius);
        return aabb(center.x() - r, center.y() - r, 2 * r, 2 * r);
      },
      opts,
    );
    if (!dashed) {
      this.attr("cx", center.x);
      this.attr("cy", center.y);
      this.attr("r", () => unwrap(radius));
    }
    setupDashed(this, opts, true);
    applyOpts(this, opts);
  }

  /** Point on perimeter at angle θ (radians, y-down). */
  at(angle: Arg<number>): Point {
    const a = read(angle);
    return new Point(
      () => this.center.x() + unwrap(this.radius) * Math.cos(a()),
      () => this.center.y() + unwrap(this.radius) * Math.sin(a()),
    );
  }
  /** Unit tangent at angle θ. */
  tangentAt(angle: Arg<number>): Point {
    const a = read(angle);
    return new Point(() => -Math.sin(a()), () => Math.cos(a()));
  }

  override boundary(toward: Point): Point {
    const proj = computed(() => {
      const t = toward.value;
      const c = this.center.value;
      const r = unwrap(this.radius);
      const len = Math.hypot(t.x - c.x, t.y - c.y) || 1;
      return { x: c.x + (t.x - c.x) / len * r, y: c.y + (t.y - c.y) / len * r };
    });
    return new Point(() => proj.value.x, () => proj.value.y);
  }

  /** Two half-circle arcs — keeps each arc span ≤ π so SVG `largeArc`
   *  flag stays unambiguous. */
  override segments(): Segment[] {
    const cx = this.center.x;
    const cy = this.center.y;
    const r = () => unwrap(this.radius);
    return [
      { type: "arc", cx, cy, r, a0: () => 0, a1: () => Math.PI },
      { type: "arc", cx, cy, r, a0: () => Math.PI, a1: () => TWO_PI },
    ];
  }
}

export const circle = (at: Point, r: Arg<number>, opts?: CircleOpts) =>
  new Circle(at, r, opts);
