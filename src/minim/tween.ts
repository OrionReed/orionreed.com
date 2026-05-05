// Augments `Signal.prototype` with `.to(target, sec, ease?)` —
// the canonical animation entry point. Chains via `.to(...).to(...)`,
// composes via `yield [a.to(...), b.to(...)]`. Times are seconds.

import { Signal } from "@preact/signals-core";
import type { Animator, Yieldable } from "./anim";
import { easeOut } from "./anims";
import type { Vec } from "./bounds";

type Easing = (t: number) => number;

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

/** A serial sequence of tween steps on a single Signal. Implements
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
  ease: Easing = easeOut,
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
