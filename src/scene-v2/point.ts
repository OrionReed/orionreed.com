// Reactive 2D point. Components are thunks `() => number` — constants
// and reactive expressions look the same from outside; the difference
// is whether the thunks read signals when called inside an effect.

import { computed, read, type Arg } from "./signal";
import type { Vec } from "./bounds";

export class Point {
  constructor(
    public readonly x: () => number,
    public readonly y: () => number,
  ) {}

  /** `{x, y}` snapshot at this instant. */
  get value(): Vec {
    return { x: this.x(), y: this.y() };
  }

  sub(p: Point): Point {
    return new Point(() => this.x() - p.x(), () => this.y() - p.y());
  }
  add(p: Point): Point {
    return new Point(() => this.x() + p.x(), () => this.y() + p.y());
  }
  scale(k: Arg<number>): Point {
    const kFn = read(k);
    return new Point(() => this.x() * kFn(), () => this.y() * kFn());
  }
  length(): () => number {
    return () => Math.hypot(this.x(), this.y());
  }
  /** Unit vector. Length memoized so x/y reads in the same cycle share it. */
  normalize(): Point {
    const len = computed(() => Math.hypot(this.x(), this.y()) || 1);
    return new Point(() => this.x() / len.value, () => this.y() / len.value);
  }
  /** 90° rotation in y-down screen coords: `(x, y) → (-y, x)`. */
  perp(): Point {
    return new Point(() => -this.y(), () => this.x());
  }
  dot(p: Point): () => number {
    return () => this.x() * p.x() + this.y() * p.y();
  }
  /** Linear interpolation; `t=0` is this, `t=1` is `b`. */
  lerp(b: Point, t: Arg<number>): Point {
    const tFn = read(t);
    return new Point(
      () => this.x() + (b.x() - this.x()) * tFn(),
      () => this.y() + (b.y() - this.y()) * tFn(),
    );
  }

  offset(dx: Arg<number>, dy: Arg<number>): Point {
    const dxFn = read(dx);
    const dyFn = read(dy);
    return new Point(() => this.x() + dxFn(), () => this.y() + dyFn());
  }
  down(n: Arg<number>): Point {
    return this.offset(0, n);
  }
  up(n: Arg<number>): Point {
    const nFn = read(n);
    return this.offset(0, () => -nFn());
  }
  right(n: Arg<number>): Point {
    return this.offset(n, 0);
  }
  left(n: Arg<number>): Point {
    const nFn = read(n);
    return this.offset(() => -nFn(), 0);
  }
}

export function pt(x: Arg<number>, y: Arg<number>): Point {
  return new Point(read(x), read(y));
}
