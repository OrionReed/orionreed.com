// Callable signal — uses alien-signals' engine directly, layers minim's
// type surface + method-attachment patterns on top.
//
// The public API is alien-signals' callable: `s()` reads, `s(v)` writes.
// Methods and trait slots are attached to the bound function via
// `Object.defineProperties` at construction time.

import {
  signal as aSignal,
  computed as aComputed,
  effect as aEffect,
  startBatch,
  endBatch,
} from "alien-signals";

// ─── Core types ──────────────────────────────────────────────────────

/** A signal is a callable function. `s()` reads, `s(v)` writes. */
export interface SignalFn<T> {
  (): T;
  (value: T): void;
}

/** A computed is read-only callable. */
export interface ComputedFn<T> {
  (): T;
}

/** Branded shape: a callable signal with attached methods + traits.
 *  T is the value type, M is the methods object. */
export type Reactive<T, M = {}> = SignalFn<T> & M;
export type ReadReactive<T, M = {}> = ComputedFn<T> & M;

// ─── Factories ───────────────────────────────────────────────────────

export const signal = aSignal;
export const computed = aComputed;
export const effect = aEffect;

export function batch<R>(fn: () => R): R {
  startBatch();
  try { return fn(); }
  finally { endBatch(); }
}

/** Untracked read — alien-signals doesn't export this. Use getActiveSub
 *  pattern from alien-signals/index.ts. */
import { setActiveSub } from "alien-signals";

export function untracked<R>(fn: () => R): R {
  const prev = setActiveSub(undefined);
  try { return fn(); }
  finally { setActiveSub(prev); }
}

// ─── attach: add methods + traits to a signal/computed callable ─────

/** Attach methods and trait slots to a callable. Mutates and returns
 *  the same function for ergonomics. Done at construction time — the
 *  resulting hidden class is stable per value-type. */
export function attach<F extends Function, M>(fn: F, methods: M): F & M {
  Object.defineProperties(fn, Object.getOwnPropertyDescriptors(methods));
  return fn as F & M;
}

// ─── isReactive type guard ──────────────────────────────────────────

const REACTIVE_BRAND = Symbol("minim.reactive");

/** Mark a callable as a Reactive. `isReactive(x)` then returns true. */
export function brand<F extends Function>(fn: F): F {
  Object.defineProperty(fn, REACTIVE_BRAND, { value: true });
  return fn;
}

export function isReactive(x: unknown): x is Reactive<unknown> {
  return typeof x === "function" && REACTIVE_BRAND in x;
}

/** Read a Val<T> (T, thunk, or signal). */
export type Val<T> = T | (() => T) | SignalFn<T> | ComputedFn<T>;

export function value<T>(v: Val<T>): T {
  if (typeof v === "function") return (v as () => T)();
  return v as T;
}
