// Reactivity delegated to @preact/signals-core; minim adds:
//  - `Arg<T>` / `ResolveSig` / `toSig` for "value or Signal" construction.
//  - `Signal.prototype.to(target, sec, ease?)` — the canonical animation
//    entry point, returning a `TweenChain` that's a Generator.

export {
  signal,
  computed,
  effect,
  batch,
  untracked,
  Signal,
  type ReadonlySignal,
} from "@preact/signals-core";

import { signal, computed, Signal } from "@preact/signals-core";
import type { ReadonlySignal } from "@preact/signals-core";
import type { Animator, Yieldable } from "./anim";
import type { Vec } from "./bounds";

/** A value, a Signal/ReadonlySignal, or a thunk `() => T` (sugar for
 *  `computed(() => ...)`). Accepted at every "drive this reactively"
 *  call site. */
export type Arg<T> = T | Signal<T> | ReadonlySignal<T> | (() => T);

/** Either side of the read/write split — common across many shape
 *  fields where the runtime kind depends on what the caller passed. */
export type NumSig = Signal<number> | ReadonlySignal<number>;

type ReadOrWrite<T> = Signal<T> | ReadonlySignal<T>;

/** Field type for an `Arg<T>` slot:
 *
 *   - `Signal<T>`         → `Signal<T>`         (writable)
 *   - `ReadonlySignal<T>` → `ReadonlySignal<T>`
 *   - `() => T`           → `ReadonlySignal<T>` (wrapped in computed)
 *   - `T` or `undefined`  → `Signal<T>`         (fresh writable, default-seeded)
 *   - `any`               → `Signal<T> | ReadonlySignal<T>`
 *
 *  The `IsAny` guard widens the erased-generic case so `Shape<any>` is
 *  a valid supertype of any specific `Shape<O>`. The `[A] extends [...]`
 *  brackets prevent union distribution. */
type IsAny<A> = 0 extends 1 & A ? true : false;
export type ResolveSig<A, T> = IsAny<A> extends true
  ? Signal<T> | ReadonlySignal<T>
  : [A] extends [Signal<T>]
    ? Signal<T>
    : [A] extends [ReadonlySignal<T> | (() => T)]
      ? ReadonlySignal<T>
      : Signal<T>;

function isSig<T>(v: Arg<T>): v is ReadOrWrite<T> {
  // ReadonlySignal is structurally an interface, but the runtime carrier
  // is always a Signal-class instance (Computed extends Signal).
  return v instanceof Signal;
}

/** Resolve an `Arg<T>` to a Signal-or-ReadonlySignal handle. With a
 *  `fallback`, an `undefined` arg becomes a fresh writable seeded with
 *  it. Thunks wrap in `computed`; existing signals pass through. */
export function toSig<T>(arg: Arg<T>): ReadOrWrite<T>;
export function toSig<T>(arg: Arg<T> | undefined, fallback: T): ReadOrWrite<T>;
export function toSig<T>(arg: Arg<T> | undefined, fallback?: T): ReadOrWrite<T> {
  if (arg === undefined) return signal(fallback as T);
  if (isSig(arg)) return arg;
  if (typeof arg === "function") return computed(arg as () => T);
  return signal(arg);
}

// ── Signal.prototype.to + TweenChain ────────────────────────────────

type Easing = (t: number) => number;
const defaultEase: Easing = (t) => 1 - (1 - t) * (1 - t); // easeOut

type Lerpable = number | Vec;

function lerp<T extends Lerpable>(a: T, b: T, t: number): T {
  if (typeof a === "number") {
    return (a + ((b as number) - a) * t) as T;
  }
  if (a !== null && typeof a === "object" && "x" in a && "y" in a) {
    const av = a as Vec;
    const bv = b as Vec;
    return {
      x: av.x + (bv.x - av.x) * t,
      y: av.y + (bv.y - av.y) * t,
    } as T;
  }
  throw new Error("tween: unsupported value type");
}

interface Step<T> {
  target: T;
  sec: number;
  ease?: Easing;
}

/** Serial sequence of tween steps on a single Signal. Implements
 *  `Generator` so it works under `yield*` and parallel-array yields. */
export class TweenChain<T extends Lerpable>
  implements Generator<Yieldable, void, number>
{
  private gen?: Generator<Yieldable, void, number>;

  constructor(
    private readonly sig: Signal<T>,
    private readonly steps: ReadonlyArray<Step<T>>,
  ) {}

  /** Append another tween step on the same signal. */
  to(target: T, sec: number, ease?: Easing): TweenChain<T> {
    return new TweenChain(this.sig, [...this.steps, { target, sec, ease }]);
  }

  /** Repeat the current sequence `n` times. */
  repeat(n: number): TweenChain<T> {
    const out: Step<T>[] = [];
    for (let i = 0; i < n; i++) out.push(...this.steps);
    return new TweenChain(this.sig, out);
  }

  private *run(): Generator<Yieldable, void, number> {
    for (const step of this.steps) {
      yield* tweenStep(this.sig, step.target, step.sec, step.ease);
    }
  }

  private active(): Generator<Yieldable, void, number> {
    return (this.gen ??= this.run());
  }

  next(...args: [] | [number]): IteratorResult<Yieldable, void> {
    return this.active().next(...args);
  }
  return(value: void): IteratorResult<Yieldable, void> {
    return this.active().return(value);
  }
  throw(e: unknown): IteratorResult<Yieldable, void> {
    return this.active().throw(e);
  }
  [Symbol.iterator](): Generator<Yieldable, void, number> {
    return this;
  }
}

function* tweenStep<T extends Lerpable>(
  sig: Signal<T>,
  target: T,
  sec: number,
  ease: Easing = defaultEase,
): Animator {
  const start = sig.peek();
  let elapsed = 0;
  while (elapsed < sec) {
    const dt: number = yield;
    elapsed += dt;
    const t = Math.min(elapsed / sec, 1);
    sig.value = lerp(start, target, ease(t));
  }
  sig.value = target;
}

declare module "@preact/signals-core" {
  interface Signal<T> {
    to(this: Signal<number>, target: number, sec: number, ease?: Easing): TweenChain<number>;
    to(this: Signal<Vec>, target: Vec, sec: number, ease?: Easing): TweenChain<Vec>;
  }
}

(Signal.prototype as unknown as {
  to: <T extends Lerpable>(target: T, sec: number, ease?: Easing) => TweenChain<T>;
}).to = function <T extends Lerpable>(
  this: Signal<T>,
  target: T,
  sec: number,
  ease?: Easing,
): TweenChain<T> {
  return new TweenChain(this, [{ target, sec, ease }]);
};
