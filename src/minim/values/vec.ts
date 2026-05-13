// Vec — the reactive 2D point primitive, declared via the struct
// framework. `Point`/`DerivedPoint`/`Pointlike` are flavor aliases over
// the underlying `Reactive<V>`.

import { struct, type WriteOf, type ReadOf } from "./struct";
import type { Matrix2D } from "./matrix";
import { computed, effect, Signal, type ReadonlySignal } from "../core/signal";
import { toSig, type Arg } from "../core/arg";

/** The struct's value type — declared up-front so ops can reference
 *  it in their signatures without circular type inference. */
export type V = { x: number; y: number };

export const Vec = struct<V>("Vec", { x: 0, y: 0 })
  .construct((x: number, y: number): V => ({ x, y }))
  .equals((a, b) => a.x === b.x && a.y === b.y)
  .ops({
    add: (a, b: V): V => ({ x: a.x + b.x, y: a.y + b.y }),
    sub: (a, b: V): V => ({ x: a.x - b.x, y: a.y - b.y }),
    scale: (a, k: number): V => ({ x: a.x * k, y: a.y * k }),
    perp: (a): V => ({ x: -a.y, y: a.x }),
    normalize: (a): V => {
      const len = Math.hypot(a.x, a.y) || 1;
      return { x: a.x / len, y: a.y / len };
    },
    lerp: (a, b: V, t: number): V => ({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
    }),
    offset: (a, dx: number, dy: number): V => ({ x: a.x + dx, y: a.y + dy }),
    up: (a, n: number): V => ({ x: a.x, y: a.y - n }),
    down: (a, n: number): V => ({ x: a.x, y: a.y + n }),
    left: (a, n: number): V => ({ x: a.x - n, y: a.y }),
    right: (a, n: number): V => ({ x: a.x + n, y: a.y }),
    /** This point in the frame `m`. Replaces hand-rolled
     *  `transformPoint(matrix.value, point.value)` calls. */
    in: (p, m: Matrix2D): V => ({
      x: m.a * p.x + m.c * p.y + m.e,
      y: m.b * p.x + m.d * p.y + m.f,
    }),
  })
  .scalars({
    /** Distance to `b`. Method (takes an arg) — call as `v.distance(b)`. */
    distance: (a, b: V): number => Math.hypot(a.x - b.x, a.y - b.y),
  })
  .getters({
    /** Magnitude of this Vec. Lazy + cached as own-property; reads as
     *  a signal property (`v.length`), not a method call. */
    length(this: { value: V }): ReadonlySignal<number> {
      const self = this;
      return computed(() => Math.hypot(self.value.x, self.value.y));
    },
  })
  .methods({
    /** Copy `target.value` into this point — convenience over
     *  `this.value = target.value`. Returns `this` for chaining.
     *
     *  Typed with the underlying `Signal<V>` shape rather than the
     *  `Pointlike` alias to break a type-level cycle (`Point` is
     *  defined in terms of `Vec.signal`'s return). At runtime, any
     *  reactive Vec works. */
    set(this: Signal<V>, target: Signal<V> | ReadonlySignal<V>) {
      this.value = target.value;
      return this;
    },
    /** Continuously mirror `target` into this point. Returns a
     *  disposer that stops the binding. */
    bind(this: Signal<V>, target: Signal<V> | ReadonlySignal<V>) {
      const self = this;
      return effect(() => {
        self.value = target.value;
      });
    },
  })
  .build();

/** Writable reactive Vec. The broad rw-flavor type — `Vec.signal({...})`
 *  may return a narrower type with per-axis flavors derived from input. */
export type Point = WriteOf<typeof Vec>;

/** Read-only reactive Vec. */
export type DerivedPoint = ReadOf<typeof Vec>;

/** Either flavor — writable or derived. */
export type Pointlike = Point | DerivedPoint;

/** Resolves to the right reactive Vec flavor based on input arg type. */
type IsAny<A> = 0 extends 1 & A ? true : false;
export type ResolveVec<A> = IsAny<A> extends true
  ? Pointlike
  : [A] extends [Point]
    ? Point
    : [A] extends [DerivedPoint | Signal<V> | ReadonlySignal<V> | (() => V)]
      ? DerivedPoint
      : Point;

/** Detect a Vec-shaped reactive at runtime. Sugar for `v instanceof Vec`. */
export const isPoint = (v: unknown): v is Pointlike => Vec.is(v);

/** Structural equality for plain Vec values (not reactives). */
export const vecEquals = (a: V, b: V): boolean =>
  a === b || (a.x === b.x && a.y === b.y);

/** Construct a Point. Two numbers → writable; any reactive input → derived. */
export function vec(x: number, y: number): Point;
export function vec(x: Arg<number>, y: Arg<number>): Pointlike;
export function vec(x: Arg<number>, y: Arg<number>): Pointlike {
  if (typeof x === "number" && typeof y === "number") {
    return Vec.signal({ x, y });
  }
  const xs = toSig(x);
  const ys = toSig(y);
  return Vec.derived(() => ({ x: xs.value, y: ys.value }));
}

/** Derived Point at radius `r` and angle `θ` (radians, y-down) from `c`. */
export const polar = (
  c: Pointlike,
  r: Arg<number>,
  angle: Arg<number>,
): DerivedPoint => {
  const rs = toSig(r);
  const as = toSig(angle);
  return Vec.derived(() => {
    const cv = c.value;
    return {
      x: cv.x + rs.value * Math.cos(as.value),
      y: cv.y + rs.value * Math.sin(as.value),
    };
  });
};

