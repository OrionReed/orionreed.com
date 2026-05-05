// Reactivity is delegated to @preact/signals-core. We re-export what we
// use and add `toSig` for "value or Signal" construction.

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

/** A value that may be plain, a Signal/ReadonlySignal, or a thunk
 *  `() => T` (treated as `computed(() => ...)` — exact parity at the
 *  reactivity level, just shorter at the call site). */
export type Arg<T> = T | Signal<T> | ReadonlySignal<T> | (() => T);

type ReadOrWrite<T> = Signal<T> | ReadonlySignal<T>;

/** Resolve the runtime field type for an `Arg<T>` slot:
 *
 *   - `Signal<T>`         → `Signal<T>`         (caller owns it; writable)
 *   - `ReadonlySignal<T>` → `ReadonlySignal<T>` (e.g. `computed(...)`)
 *   - `() => T`           → `ReadonlySignal<T>` (we wrap in computed)
 *   - `T` or `undefined`  → `Signal<T>`         (fresh writable, possibly default-seeded)
 *   - `any`               → `Signal<T> | ReadonlySignal<T>` (the union — so
 *                                                            `Shape<any>` is a valid
 *                                                            supertype of any specific
 *                                                            `Shape<O>`)
 *
 *  The `[A] extends [...]` brackets prevent distribution over unions
 *  so a mixed union like `T | Signal<T>` (the constraint shape from
 *  `Arg<T>`) falls through to the `Signal<T>` default rather than
 *  splitting and rejoining. Order matters: `Signal<T>` is tested
 *  first because `ReadonlySignal<T>` is structurally a supertype.
 *  Combining the two readonly producers (ReadonlySignal | thunk) keeps
 *  the table compact. The `IsAny` guard up front widens the result for
 *  the erased-generic case. */
type IsAny<A> = 0 extends 1 & A ? true : false;
export type ResolveSig<A, T> = IsAny<A> extends true
  ? Signal<T> | ReadonlySignal<T>
  : [A] extends [Signal<T>]
    ? Signal<T>
    : [A] extends [ReadonlySignal<T> | (() => T)]
      ? ReadonlySignal<T>
      : Signal<T>;

/** Type predicate: true if `v` is a Signal or ReadonlySignal. ReadonlySignal
 *  is an interface but its runtime carrier is always the Signal class
 *  (Computed extends Signal), so `instanceof Signal` covers both. */
function isSig<T>(v: Arg<T>): v is ReadOrWrite<T> {
  return v instanceof Signal;
}

/** Resolve an `Arg<T>` to a Signal. Two call shapes:
 *
 *   - `toSig(arg)`              — required arg.
 *   - `toSig(arg, fallback)`    — `arg` may be `undefined`, falls back
 *                                  to a fresh writable seeded with `fallback`.
 *
 *  Existing Signal/ReadonlySignal returned as-is (caller owns the source
 *  of truth). Thunks become `computed(...)`. Plain values become a fresh
 *  writable signal. */
export function toSig<T>(arg: Arg<T>): ReadOrWrite<T>;
export function toSig<T>(arg: Arg<T> | undefined, fallback: T): ReadOrWrite<T>;
export function toSig<T>(arg: Arg<T> | undefined, fallback?: T): ReadOrWrite<T> {
  if (arg === undefined) return signal(fallback as T);
  if (isSig(arg)) return arg;
  if (typeof arg === "function") return computed(arg as () => T);
  return signal(arg);
}
