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

// ── store() — record-of-signals with proxy-based auto-tracking ──────

/** Runtime marker on store proxies; used by `snapshot` to detect
 *  stores and harvest their underlying signals. */
const STORE_SIGNALS: unique symbol = Symbol("minim.store");

/** Phantom type-level brand for distinguishing `Store<T>` from plain `T`. */
declare const STORE_BRAND: unique symbol;

export type Store<T extends object> = T & {
  readonly [STORE_BRAND]: never;
};

/** A reactive record. Each property is backed by a `Signal`; reads
 *  inside reactive scopes (computed/effect) track changes, writes
 *  notify subscribers. Outside reactive scopes, reads are untracked
 *  (no `.peek()` ceremony needed).
 *
 *      const state = store({ pendingA: 0, pendingB: 0, holding: false });
 *      state.pendingA++;            // writes signal
 *      computed(() => state.pendingA > 0);  // tracked
 *      const reset = snapshot(state);       // works on whole store
 */
export function store<T extends object>(initial: T): Store<T> {
  const sigs = {} as { [K in keyof T]: Signal<T[K]> };
  for (const key of Object.keys(initial) as Array<keyof T>) {
    sigs[key] = signal(initial[key]) as Signal<T[keyof T]>;
  }
  const proxy = new Proxy({} as object, {
    get(_, key) {
      if (key === STORE_SIGNALS) return sigs;
      const k = key as keyof T;
      return k in sigs ? sigs[k].value : undefined;
    },
    set(_, key, value) {
      const k = key as keyof T;
      if (!(k in sigs)) return false;
      (sigs[k] as Signal<unknown>).value = value;
      return true;
    },
    has(_, key) {
      return key === STORE_SIGNALS || (key as keyof T) in sigs;
    },
    ownKeys() {
      return Object.keys(sigs);
    },
    getOwnPropertyDescriptor(_, key) {
      return (key as keyof T) in sigs
        ? { enumerable: true, configurable: true, writable: true, value: undefined }
        : undefined;
    },
  });
  return proxy as Store<T>;
}

/** Capture the current values of `args` and return a function that
 *  restores them. Each arg is either a single `Signal` or a `Store`
 *  (whose fields are flattened to their underlying signals). Useful
 *  at the top of `anim.loop` bodies that mutate state, so each
 *  iteration starts from a known baseline:
 *
 *      const reset = snapshot(state, taps);
 *      this.anim.loop(function* () {
 *        reset();
 *        // ...
 *      });
 */
export function snapshot(
  ...args: ReadonlyArray<Signal<unknown> | Store<object>>
): () => void {
  const sigs: Signal<unknown>[] = [];
  for (const arg of args) {
    if (arg instanceof Signal) {
      sigs.push(arg);
      continue;
    }
    const inner = (arg as { [STORE_SIGNALS]?: Record<string, Signal<unknown>> })[
      STORE_SIGNALS
    ];
    if (inner) {
      for (const sig of Object.values(inner)) sigs.push(sig);
    }
  }
  const initials = sigs.map((s) => s.peek());
  return () => {
    for (let i = 0; i < sigs.length; i++) sigs[i].value = initials[i];
  };
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

/** Duration source for a tween — a fixed `number` of seconds, or a
 *  reactive `Signal<number>` (read per frame, so live edits propagate). */
type Duration = number | ReadonlySignal<number>;

interface Step<T> {
  target: T;
  source: Duration;
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

  /** Append another tween step on the same signal. `source` may be a
   *  fixed number of seconds or a `Signal<number>` (e.g. a `timeline()`
   *  entry) — in the reactive case, edits propagate live. */
  to(target: T, source: Duration, ease?: Easing): TweenChain<T> {
    return new TweenChain(this.sig, [...this.steps, { target, source, ease }]);
  }

  /** Repeat the current sequence `n` times. */
  repeat(n: number): TweenChain<T> {
    const out: Step<T>[] = [];
    for (let i = 0; i < n; i++) out.push(...this.steps);
    return new TweenChain(this.sig, out);
  }

  private *run(): Generator<Yieldable, void, number> {
    for (const step of this.steps) {
      yield* tweenStep(this.sig, step.target, step.source, step.ease);
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
  source: Duration,
  ease: Easing = defaultEase,
): Animator {
  const start = sig.peek();
  let elapsed = 0;
  while (true) {
    const total = typeof source === "number" ? source : source.value;
    if (elapsed >= total) break;
    const dt: number = yield;
    elapsed += dt;
    const t = total > 0 ? Math.min(elapsed / total, 1) : 1;
    sig.value = lerp(start, target, ease(t));
  }
  sig.value = target;
}

declare module "@preact/signals-core" {
  interface ReadonlySignal<T> {
    /** Derive a new signal by applying `fn` to each value. */
    map<U>(fn: (v: T) => U): ReadonlySignal<U>;
  }
  interface Signal<T> {
    map<U>(fn: (v: T) => U): ReadonlySignal<U>;
    to(this: Signal<number>, target: number, source: Duration, ease?: Easing): TweenChain<number>;
    to(this: Signal<Vec>, target: Vec, source: Duration, ease?: Easing): TweenChain<Vec>;
  }
}

(Signal.prototype as unknown as {
  map: <T, U>(this: Signal<T>, fn: (v: T) => U) => ReadonlySignal<U>;
}).map = function <T, U>(this: Signal<T>, fn: (v: T) => U): ReadonlySignal<U> {
  return computed(() => fn(this.value));
};

(Signal.prototype as unknown as {
  to: <T extends Lerpable>(target: T, source: Duration, ease?: Easing) => TweenChain<T>;
}).to = function <T extends Lerpable>(
  this: Signal<T>,
  target: T,
  source: Duration,
  ease?: Easing,
): TweenChain<T> {
  return new TweenChain(this, [{ target, source, ease }]);
};

/** `0` if `arg` is falsy, `1` if truthy. With a `predicate`, `0` if
 *  the predicate is false, `1` if true. Common for binding shape
 *  opacity to a reactive boolean: `opacity: when(state.holding)`. */
export function when<T>(
  arg: Arg<T>,
  predicate?: (v: T) => boolean,
): ReadonlySignal<number> {
  const sig = toSig(arg);
  return computed(() => {
    const v = sig.value;
    return (predicate ? predicate(v) : Boolean(v)) ? 1 : 0;
  });
}
