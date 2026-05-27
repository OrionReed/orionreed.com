// wrap.ts — `w()` brand: opts in a writable parameter to participate
// in a lens's bwd cascade.
//
// Usage:
//
//     a.right(n)         // n is read-only context (today's behavior).
//     a.right(w(n))      // n absorbs writes to the result.
//     a.right(w(n, {weight: 0.5}))   // n and a split delta 50/50.
//     a.right(w(n, {weight: stiffness}))  // reactive split policy.
//
// The marker is a thin wrapper object holding the writable signal plus
// per-parameter options. The receiving lens method detects the brand and
// routes to a multi-parent `Cls.lens([receiver, n], fwd, bwd)` form whose
// bwd produces intentions for both parents according to `weight`. When
// no `w()` is present, the existing single-source lens path runs
// unchanged.
//
// Default weight is 1: the wrapped param fully absorbs and the receiver
// is anchored. Weight 0 is equivalent to not wrapping (no-op). Weight
// 0.5 splits evenly. Reactive weights (Val<number>) are supported.
//
// The brand is type-level only at runtime — `w(sig)` returns a small
// object you should not unwrap by hand; methods use `isW()`/`unwrapW()`.

import { isSignal, type Read, type Signal, type Val, type Writable } from "./signal";

const WP_BRAND: unique symbol = Symbol("wp.brand");

/** Per-parameter options on a wrapped signal. */
export interface WOpts {
  /** Relative absorption weight in the bwd's distribution. Default 1.
   *  Reactive: pass a `Val<number>`. */
  weight?: Val<number>;
}

/** Wrapped-writable-parameter marker. Carries the signal + per-param
 *  opts. The lens method that receives this branches on its presence. */
export interface W<T> {
  readonly [WP_BRAND]: true;
  readonly sig: Writable<Signal<T>>;
  readonly weight: Val<number>;
}

/** Wrap a writable signal as a writable parameter to a lens method.
 *  See module header for semantics. */
export function w<T>(sig: Writable<Signal<T>>, opts?: WOpts): W<T> {
  if (!isSignal(sig) || (sig as Signal<unknown>).getter !== undefined && (sig as Signal<unknown>).setter === undefined) {
    throw new TypeError("w(): expected a Writable<Signal<T>> (signal or writable lens)");
  }
  return {
    [WP_BRAND]: true as const,
    sig,
    weight: opts?.weight ?? 1,
  };
}

/** Permissive shape for a parameter that MAY be wrapped. The lens
 *  method takes `Val<T> | W<T>` and dispatches on `isW()`. */
export type Param<T> = Val<T> | W<T>;

/** Runtime check for the `w()` brand. Designed for use inside method
 *  bodies as a discriminant; the inferred `W<T>` type carries `T`
 *  from the call-site parameter via the conditional type. */
export function isW<T>(v: Param<T>): v is Extract<Param<T>, W<T>> {
  return typeof v === "object" && v !== null && (v as { [WP_BRAND]?: true })[WP_BRAND] === true;
}

/** Resolve a `Param<T>` to a closure that reads its current value on
 *  each call. For wrapped params, reads through the signal. */
export function paramReader<T>(p: Param<T>): () => T {
  if (isW(p)) {
    const s = p.sig as Read<T>;
    return () => s.value;
  }
  if (isSignal(p)) return () => (p as Read<T>).value;
  return () => p as T;
}
