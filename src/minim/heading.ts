// Position + tangent direction. Used at path tips and arrow heads,
// and anywhere geometry needs to "face" a direction.

import { Point, pt } from "./point";
import { read, type Arg } from "./signal";

export class Heading {
  constructor(
    readonly position: Point,
    readonly tangent: Point,  // unit direction
  ) {}

  /** Reactive thunk; angle in radians (atan2 of tangent, y-down). */
  angle: () => number = () => Math.atan2(this.tangent.y(), this.tangent.x());

  /** Tangent rotated 90° (y-down: `(x,y) → (-y, x)`). */
  get normal(): Point {
    return this.tangent.perp();
  }

  /** Heading at `p` facing `angle` (radians). */
  static fromAngle(p: Point, angle: Arg<number>): Heading {
    const aFn = read(angle);
    return new Heading(
      p,
      new Point(() => Math.cos(aFn()), () => Math.sin(aFn())),
    );
  }
}

export const heading = (position: Point, tangent: Point): Heading =>
  new Heading(position, tangent);

export { pt };
