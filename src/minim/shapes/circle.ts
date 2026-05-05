import { Shape } from "../shape";
import { Point } from "../point";
import { aabb } from "../bounds";
import { computed, toSig, type Arg, type Signal, type ReadonlySignal } from "../signal";
import { type Segment, TWO_PI } from "../dashed";
import { applyOpts, setupDashed, type CommonOpts } from "./common";

export interface CircleOpts extends CommonOpts {}

export class Circle extends Shape {
  readonly radius: Signal<number> | ReadonlySignal<number>;

  constructor(
    readonly center: Point,
    radius: Arg<number>,
    opts: CircleOpts = {},
  ) {
    const r = toSig(radius);
    const dashed = opts.dashed ?? false;
    super(
      dashed ? "path" : "circle",
      () =>
        aabb(center.x.value - r.value, center.y.value - r.value, 2 * r.value, 2 * r.value),
      opts,
    );
    this.radius = r;
    if (!dashed) {
      this.attr("cx", center.x);
      this.attr("cy", center.y);
      this.attr("r", r);
    }
    setupDashed(this, opts, true);
    applyOpts(this, opts);
  }

  /** Point on perimeter at angle θ (radians, y-down). */
  at(angle: Arg<number>): Point {
    const a = toSig(angle);
    return new Point(
      computed(() => this.center.x.value + this.radius.value * Math.cos(a.value)),
      computed(() => this.center.y.value + this.radius.value * Math.sin(a.value)),
    );
  }
  /** Unit tangent at angle θ. */
  tangentAt(angle: Arg<number>): Point {
    const a = toSig(angle);
    return new Point(
      computed(() => -Math.sin(a.value)),
      computed(() => Math.cos(a.value)),
    );
  }

  override boundary(toward: Point): Point {
    const proj = computed(() => {
      const t = toward.value;
      const c = this.center.value;
      const r = this.radius.value;
      const len = Math.hypot(t.x - c.x, t.y - c.y) || 1;
      return { x: c.x + (t.x - c.x) / len * r, y: c.y + (t.y - c.y) / len * r };
    });
    return new Point(
      computed(() => proj.value.x),
      computed(() => proj.value.y),
    );
  }

  /** Two half-circle arcs — keeps each arc span ≤ π so SVG `largeArc`
   *  flag stays unambiguous. */
  override segments(): Segment[] {
    const cx = () => this.center.x.value;
    const cy = () => this.center.y.value;
    const r = () => this.radius.value;
    return [
      { type: "arc", cx, cy, r, a0: () => 0, a1: () => Math.PI },
      { type: "arc", cx, cy, r, a0: () => Math.PI, a1: () => TWO_PI },
    ];
  }
}

export const circle = (at: Point, r: Arg<number>, opts?: CircleOpts) =>
  new Circle(at, r, opts);
