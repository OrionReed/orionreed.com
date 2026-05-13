import { toSig, type Arg, type NumSig } from "@minim/core";
import { Shape, type Segment } from "./shape";
import {
  Vec,
  box,
  type DerivedPoint,
  type Pointlike,
} from "@minim/values";
import { TWO_PI } from "./dashed";
import { intrinsicType, wireStroke, type CommonOpts } from "./common";

export interface CircleOpts extends CommonOpts {}

export class Circle<O extends CircleOpts = CircleOpts> extends Shape<O> {
  readonly radius: NumSig;

  constructor(
    center: Pointlike,
    radius: Arg<number>,
    opts: O = {} as O,
  ) {
    const r = toSig(radius);
    super(
      intrinsicType(opts, "circle"),
      () =>
        box(center.x.value - r.value, center.y.value - r.value, 2 * r.value, 2 * r.value),
      opts,
      { origin: () => center.value },
    );
    this.radius = r;
    // Note: the inherited Box `this.center` (a DerivedPoint computed
    // from the Box) resolves to the same point as `center` reactively;
    // internal methods read it via `this.center` rather than capturing
    // the constructor parameter.
    wireStroke(this, opts, true, () => {
      this.attr("cx", center.x);
      this.attr("cy", center.y);
      this.attr("r", r);
    });
  }

  /** Point on perimeter at angle θ (radians, y-down). */
  atAngle(angle: Arg<number>): DerivedPoint {
    const a = toSig(angle);
    return Vec.derived(() => ({
      x: this.center.x.value + this.radius.value * Math.cos(a.value),
      y: this.center.y.value + this.radius.value * Math.sin(a.value),
    }));
  }
  /** Unit tangent at angle θ. */
  tangentAt(angle: Arg<number>): DerivedPoint {
    const a = toSig(angle);
    return Vec.derived(() => ({
      x: -Math.sin(a.value),
      y: Math.cos(a.value),
    }));
  }

  override boundary(toward: Pointlike): DerivedPoint {
    return Vec.derived(() => {
      const t = toward.value;
      const c = this.center.value;
      const sc = this.scale.value;
      // Boundary tracks the visual radius so pulses scale it; for
      // non-uniform scale, approximate as a circle of the larger axis.
      const r = this.radius.value * Math.max(sc.x, sc.y);
      const len = Math.hypot(t.x - c.x, t.y - c.y) || 1;
      return {
        x: c.x + ((t.x - c.x) / len) * r,
        y: c.y + ((t.y - c.y) / len) * r,
      };
    });
  }

  /** Two half-arcs so each span stays ≤ π (keeps `largeArc` unambiguous).
   *  Rendered inside the shape's own `<g transform>` so coords are in
   *  local frame — derived from the Box rather than `this.center`
   *  (which is now parent-frame). */
  override segments(): Segment[] {
    const cx = () => this.box.value.x + this.box.value.w / 2;
    const cy = () => this.box.value.y + this.box.value.h / 2;
    const r = () => this.radius.value;
    return [
      { type: "arc", cx, cy, r, a0: () => 0, a1: () => Math.PI },
      { type: "arc", cx, cy, r, a0: () => Math.PI, a1: () => TWO_PI },
    ];
  }
}

export const circle = <const O extends CircleOpts>(
  at: Pointlike,
  r: Arg<number>,
  opts?: O,
): Circle<O> => new Circle<O>(at, r, opts);
