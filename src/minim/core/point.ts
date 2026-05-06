// Reactive 2D point. `pt(x, y)` produces writable components; derived
// points (`a.sub(b)`, `a.lerp(b, t)`, etc.) are computed-backed and
// thus read-only.

import { computed, toSig, type Arg, type NumSig, type ReadonlySignal } from "./signal";
import type { Vec } from "./bounds";

export class Point {
  constructor(
    readonly x: NumSig,
    readonly y: NumSig,
  ) {}

  get value(): Vec {
    return { x: this.x.value, y: this.y.value };
  }

  sub(p: Point): Point {
    return new Point(
      computed(() => this.x.value - p.x.value),
      computed(() => this.y.value - p.y.value),
    );
  }
  add(p: Point): Point {
    return new Point(
      computed(() => this.x.value + p.x.value),
      computed(() => this.y.value + p.y.value),
    );
  }
  scale(k: Arg<number>): Point {
    const ks = toSig(k);
    return new Point(
      computed(() => this.x.value * ks.value),
      computed(() => this.y.value * ks.value),
    );
  }
  length(): ReadonlySignal<number> {
    return computed(() => Math.hypot(this.x.value, this.y.value));
  }
  normalize(): Point {
    const len = computed(() => Math.hypot(this.x.value, this.y.value) || 1);
    return new Point(
      computed(() => this.x.value / len.value),
      computed(() => this.y.value / len.value),
    );
  }
  /** 90° rotation in y-down screen coords: `(x, y) → (-y, x)`. */
  perp(): Point {
    return new Point(
      computed(() => -this.y.value),
      computed(() => this.x.value),
    );
  }
  dot(p: Point): ReadonlySignal<number> {
    return computed(() => this.x.value * p.x.value + this.y.value * p.y.value);
  }
  /** Linear interpolation; `t=0` → this, `t=1` → `b`. */
  lerp(b: Point, t: Arg<number>): Point {
    const ts = toSig(t);
    return new Point(
      computed(() => this.x.value + (b.x.value - this.x.value) * ts.value),
      computed(() => this.y.value + (b.y.value - this.y.value) * ts.value),
    );
  }
  /** Reactive midpoint between `this` and `b`. */
  midpoint(b: Point): Point {
    return new Point(
      computed(() => (this.x.value + b.x.value) / 2),
      computed(() => (this.y.value + b.y.value) / 2),
    );
  }
  /** Euclidean distance to `b` as a reactive scalar. */
  distance(b: Point): ReadonlySignal<number> {
    return computed(() =>
      Math.hypot(this.x.value - b.x.value, this.y.value - b.y.value),
    );
  }

  /** Point at radius `r` and angle `θ` (radians, y-down) from `c`. */
  static polar(c: Point, r: Arg<number>, angle: Arg<number>): Point {
    const rs = toSig(r);
    const as = toSig(angle);
    return new Point(
      computed(() => c.x.value + rs.value * Math.cos(as.value)),
      computed(() => c.y.value + rs.value * Math.sin(as.value)),
    );
  }

  offset(dx: Arg<number>, dy: Arg<number>): Point {
    const dxs = toSig(dx);
    const dys = toSig(dy);
    return new Point(
      computed(() => this.x.value + dxs.value),
      computed(() => this.y.value + dys.value),
    );
  }
  down(n: Arg<number>): Point {
    return this.offset(0, n);
  }
  up(n: Arg<number>): Point {
    const ns = toSig(n);
    return this.offset(0, computed(() => -ns.value));
  }
  right(n: Arg<number>): Point {
    return this.offset(n, 0);
  }
  left(n: Arg<number>): Point {
    const ns = toSig(n);
    return this.offset(computed(() => -ns.value), 0);
  }
}

export function pt(x: Arg<number>, y: Arg<number>): Point {
  return new Point(toSig(x), toSig(y));
}
