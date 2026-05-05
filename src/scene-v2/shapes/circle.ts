import { Shape } from "../shape";
import { Point } from "../point";
import { aabb } from "../bounds";
import { computed, read, unwrap, type Arg } from "../signal";
import { applyOpts, type CommonOpts } from "./common";

export interface CircleOpts extends CommonOpts {}

export class Circle extends Shape {
  constructor(
    readonly center: Point,
    readonly radius: Arg<number>,
    opts: CircleOpts = {},
  ) {
    super(
      "circle",
      () => {
        const r = unwrap(radius);
        return aabb(center.x() - r, center.y() - r, 2 * r, 2 * r);
      },
      opts,
    );
    this.attr("cx", center.x);
    this.attr("cy", center.y);
    this.attr("r", () => unwrap(radius));
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
}

export const circle = (at: Point, r: Arg<number>, opts?: CircleOpts) =>
  new Circle(at, r, opts);
