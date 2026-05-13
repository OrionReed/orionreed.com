// "Value or signal" interop. `Val<T>` unifies literal, signal, and
// thunk; `toSig` normalizes to a Signal/ReadonlySignal.
//
// The name `Val<T>` reflects the values-layer naming convention (`Vec`,
// `Box`, `Num`, …): `Val<T>` is "any source of a value of type T",
// whether literal, reactive, or computed. `Arg<T>` is preserved as a
// deprecated alias for back-compat.

import { signal, computed, Signal, type ReadonlySignal } from "./signal";

/** Literal, signal, or `() => T` thunk (sugar for `computed`). */
export type Val<T> = T | Signal<T> | ReadonlySignal<T> | (() => T);

export type NumSig = Signal<number> | ReadonlySignal<number>;

type ReadOrWrite<T> = Signal<T> | ReadonlySignal<T>;

/** Resolve the field type for an `Arg<T>`:
 *
 *   - `Signal<T>`         → `Signal<T>`         (writable)
 *   - `ReadonlySignal<T>` → `ReadonlySignal<T>`
 *   - `() => T`           → `ReadonlySignal<T>`
 *   - `T` or `undefined`  → `Signal<T>`         (default-seeded)
 *   - `any`               → `Signal<T> | ReadonlySignal<T>`
 *
 *  Bracketed `[A] extends [...]` prevents union distribution; `IsAny`
 *  widens the erased-generic case for `Shape<any>` supertyping. */
type IsAny<A> = 0 extends 1 & A ? true : false;
export type ResolveSig<A, T> = IsAny<A> extends true
  ? Signal<T> | ReadonlySignal<T>
  : [A] extends [Signal<T>]
    ? Signal<T>
    : [A] extends [ReadonlySignal<T> | (() => T)]
      ? ReadonlySignal<T>
      : Signal<T>;

function isSig<T>(v: Val<T>): v is ReadOrWrite<T> {
  return v instanceof Signal;
}

/** Normalize a `Val<T>` to a signal. With `fallback`, `undefined` →
 *  fresh writable seeded with it. */
export function toSig<T>(arg: Val<T>): ReadOrWrite<T>;
export function toSig<T>(arg: Val<T> | undefined, fallback: T): ReadOrWrite<T>;
export function toSig<T>(arg: Val<T> | undefined, fallback?: T): ReadOrWrite<T> {
  if (arg === undefined) return signal(fallback as T);
  if (isSig(arg)) return arg;
  if (typeof arg === "function") return computed(arg as () => T);
  return signal(arg);
}

/** Coerce reactive truthiness to `0`/`1` — e.g. `opacity: when(hovered)`. */
export function when<T>(
  arg: Val<T>,
  predicate?: (v: T) => boolean,
): ReadonlySignal<number> {
  const sig = toSig(arg);
  return computed(() => {
    const v = sig.value;
    return (predicate ? predicate(v) : Boolean(v)) ? 1 : 0;
  });
}
