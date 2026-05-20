// `.value` class API wrapping alien-signals' callable engine.
//
// The question: can we keep the current `.value` getter API but use
// alien-signals under the hood for the algorithm? What does that buy?
//
// Hypothesis: the `.value` getter pattern caps us at ~4 ns reads
// regardless of what's underneath, because the property-access +
// getter-invocation costs ~3 ns by themselves. The "raw" perf gap
// between alien (0.4 ns) and class-based (4 ns) is the cost of the
// getter wrapper, not the algorithm.
//
// If that's right, wrapping alien gives us:
//   - Same perf as current minim (no win)
//   - Algorithm + bug fixes inherited from upstream (no porting burden)
//   - Cleaner separation of "reactive node" from "minim's class surface"
//   - viewClassFor STILL NEEDED for `derived(Cls, fn) instanceof Cls`
//     (the class hierarchy problem is independent of the engine).

import {
  signal as aSignal,
  computed as aComputed,
  effect as aEffect,
  startBatch,
  endBatch,
  setActiveSub,
} from "alien-signals";

// ─── Signal class wrapping alien's bound function ───────────────────

export class Signal<T = unknown> {
  /** @internal — the alien-signals bound function */
  protected _alien: (...args: [T] | []) => T | void;

  constructor(initial: T) {
    this._alien = aSignal(initial) as (...args: [T] | []) => T | void;
  }

  get value(): T {
    return this._alien() as T;
  }

  set value(next: T) {
    this._alien(next);
  }

  peek(): T {
    const prev = setActiveSub(undefined);
    try { return this._alien() as T; }
    finally { setActiveSub(prev); }
  }
}

export class Computed<T = unknown> extends Signal<T> {
  constructor(getter: () => T) {
    super(undefined as T);
    this._alien = aComputed(getter) as (...args: [T] | []) => T | void;
  }

  set value(_next: T) {
    throw new TypeError("Cannot write to a Computed");
  }
  get value(): T { return this._alien() as T; }
}

export function signal<T>(initial: T): Signal<T> {
  return new Signal(initial);
}

export function computed<T>(getter: () => T): Computed<T> {
  return new Computed(getter);
}

export function effect(fn: () => (() => void) | void): () => void {
  return aEffect(fn);
}

export function batch<R>(fn: () => R): R {
  startBatch();
  try { return fn(); }
  finally { endBatch(); }
}

export function untracked<R>(fn: () => R): R {
  const prev = setActiveSub(undefined);
  try { return fn(); }
  finally { setActiveSub(prev); }
}
