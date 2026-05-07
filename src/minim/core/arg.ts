// "Value or signal" interop. Most reactive APIs accept any of: a literal
// value, an existing Signal/ReadonlySignal, or a thunk that derives a
// computed signal. `Arg<T>` names that union; `toSig` normalizes it.

import { signal, computed, Signal, type ReadonlySignal } from "./signal";

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
