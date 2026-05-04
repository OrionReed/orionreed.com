// Reactive 2D point with chainable vector + layout operations. The only
// reactive type the lib exposes; numbers stay as preact `Signal<number>`
// (mutable) or plain numbers / thunks.
//
// Components are thunks `() => number`. Constants and reactive values
// look the same from outside — `pt(60, 170)` and `lerp(O, xEnd, lineT)`
// both return RPoint; the runtime difference is whether the thunks read
// any signals when called inside an effect.

import { computed, read, type Arg } from "./signal";
import type { Point } from "../elements/geom";

/**
 * Reactive 2D point. Read with `p.x()` / `p.y()` / `p.value`. Compose
 * via vector ops (`sub`, `add`, `scale`, `normalize`, `perp`, `dot`,
 * `length`) or layout ops (`offset`, `down`, `up`, `left`, `right`).
 */
export class RPoint {
  constructor(
    public readonly x: () => number,
    public readonly y: () => number,
  ) {}

  /** Snapshot — `{ x, y }` at this instant. */
  get value(): Point {
    return { x: this.x(), y: this.y() };
  }

  // ── Vector ops ──────────────────────────────────────────────────

  sub(p: RPoint): RPoint {
    return new RPoint(() => this.x() - p.x(), () => this.y() - p.y());
  }
  add(p: RPoint): RPoint {
    return new RPoint(() => this.x() + p.x(), () => this.y() + p.y());
  }
  scale(k: Arg<number>): RPoint {
    const kFn = read(k);
    return new RPoint(() => this.x() * kFn(), () => this.y() * kFn());
  }
  /** L2 length — returns a thunk for reactive composition. */
  length(): () => number {
    return () => Math.hypot(this.x(), this.y());
  }
  /** Unit-length vector in the same direction. Length is memoized. */
  normalize(): RPoint {
    // computed memoizes, so the hypot isn't recomputed twice when
    // both x and y are read in the same render cycle.
    const len = computed(() => Math.hypot(this.x(), this.y()) || 1);
    return new RPoint(
      () => this.x() / len.value,
      () => this.y() / len.value,
    );
  }
  /** Rotate 90° (in y-down screen coords: (x, y) → (-y, x)). */
  perp(): RPoint {
    return new RPoint(() => -this.y(), () => this.x());
  }
  dot(p: RPoint): () => number {
    return () => this.x() * p.x() + this.y() * p.y();
  }

  // ── Layout ops ──────────────────────────────────────────────────

  offset(dx: Arg<number>, dy: Arg<number>): RPoint {
    const dxFn = read(dx);
    const dyFn = read(dy);
    return new RPoint(() => this.x() + dxFn(), () => this.y() + dyFn());
  }
  down(n: Arg<number>): RPoint {
    return this.offset(0, n);
  }
  up(n: Arg<number>): RPoint {
    const nFn = read(n);
    return this.offset(0, () => -nFn());
  }
  right(n: Arg<number>): RPoint {
    return this.offset(n, 0);
  }
  left(n: Arg<number>): RPoint {
    const nFn = read(n);
    return this.offset(() => -nFn(), 0);
  }
}

/** Construct an RPoint from numbers, signals, or thunks. */
export function pt(x: Arg<number>, y: Arg<number>): RPoint {
  return new RPoint(read(x), read(y));
}

/**
 * Reactive linear interpolation between two points. The result is a
 * fresh RPoint that re-derives when any input changes.
 */
export function lerp(a: RPoint, b: RPoint, t: Arg<number>): RPoint {
  const tFn = read(t);
  return new RPoint(
    () => a.x() + (b.x() - a.x()) * tFn(),
    () => a.y() + (b.y() - a.y()) * tFn(),
  );
}
