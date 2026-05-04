// Reactive 2D point with chainable vector + layout operations. The only
// reactive type the lib exposes; numbers stay as preact `Signal<number>`
// (mutable) or plain numbers / thunks.
//
// Components are thunks `() => number`. Constants and reactive values
// look the same from outside — `pt(60, 170)` and `O.lerp(xEnd, lineT)`
// both return Point; the runtime difference is whether the thunks read
// any signals when called inside an effect.
//
// Note: `Point` (this class) is distinct from `Vec` (literal `{x, y}`)
// in `bounds.ts`. Use `Point` for diagram geometry; `Vec` is only for
// shape-internal transform values.

import { computed, read, type Arg } from "./signal";
import type { Vec } from "./bounds";

/**
 * Reactive 2D point. Read with `p.x()` / `p.y()` / `p.value`. Compose
 * via vector ops (`sub`, `add`, `scale`, `normalize`, `perp`, `dot`,
 * `length`) or layout ops (`offset`, `down`, `up`, `left`, `right`).
 */
export class Point {
  constructor(
    public readonly x: () => number,
    public readonly y: () => number,
  ) {}

  /** Snapshot — `{ x, y }` at this instant. */
  get value(): Vec {
    return { x: this.x(), y: this.y() };
  }

  // ── Vector ops ──────────────────────────────────────────────────

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
  /** L2 length — returns a thunk for reactive composition. */
  length(): () => number {
    return () => Math.hypot(this.x(), this.y());
  }
  /** Unit-length vector in the same direction. Length is memoized. */
  normalize(): Point {
    // computed memoizes, so the hypot isn't recomputed twice when
    // both x and y are read in the same render cycle.
    const len = computed(() => Math.hypot(this.x(), this.y()) || 1);
    return new Point(
      () => this.x() / len.value,
      () => this.y() / len.value,
    );
  }
  /** Rotate 90° (in y-down screen coords: (x, y) → (-y, x)). */
  perp(): Point {
    return new Point(() => -this.y(), () => this.x());
  }
  dot(p: Point): () => number {
    return () => this.x() * p.x() + this.y() * p.y();
  }
  /** Linear interpolation toward `b`. Reactive: re-derives when any
   *  input changes. `t=0` returns this point, `t=1` returns `b`. */
  lerp(b: Point, t: Arg<number>): Point {
    const tFn = read(t);
    return new Point(
      () => this.x() + (b.x() - this.x()) * tFn(),
      () => this.y() + (b.y() - this.y()) * tFn(),
    );
  }

  // ── Layout ops ──────────────────────────────────────────────────

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

/** Construct an Point from numbers, signals, or thunks. */
export function pt(x: Arg<number>, y: Arg<number>): Point {
  return new Point(read(x), read(y));
}
