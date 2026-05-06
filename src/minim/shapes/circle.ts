import {
  Shape,
  Point,
  aabb,
  computed,
  toSig,
  type Segment,
  type Arg,
  type NumSig,
} from "../core";
import { TWO_PI } from "./dashed";
import { applyOpts, setupDashed, type CommonOpts } from "./common";

export interface CircleOpts extends CommonOpts {}

export class Circle<O extends CircleOpts = CircleOpts> extends Shape<O> {
  readonly radius: NumSig;

  constructor(
    readonly center: Point,
    radius: Arg<number>,
    opts: O = {} as O,
  ) {
    const r = toSig(radius);
    const dashed = opts.dashed ?? false;
    super(
      dashed ? "path" : "circle",
      () =>
        aabb(center.x.value - r.value, center.y.value - r.value, 2 * r.value, 2 * r.value),
      opts,
      { origin: () => center.value },
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
      const sc = this.scale.value;
      // Visual radius respects the shape's own scale so the boundary
      // tracks pulses; for non-uniform scale we treat the result as a
      // circle of the larger axis (close enough for ports/connectors).
      const r = this.radius.value * Math.max(sc.x, sc.y);
      const len = Math.hypot(t.x - c.x, t.y - c.y) || 1;
      return { x: c.x + (t.x - c.x) / len * r, y: c.y + (t.y - c.y) / len * r };
    });
    return new Point(
      computed(() => proj.value.x),
      computed(() => proj.value.y),
    );
  }

  /** Two half-arcs — keeps each span ≤ π so SVG's `largeArc` flag
   *  stays unambiguous. */
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

export const circle = <const O extends CircleOpts>(
  at: Point,
  r: Arg<number>,
  opts?: O,
): Circle<O> => new Circle<O>(at, r, opts);
