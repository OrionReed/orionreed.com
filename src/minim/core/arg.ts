// "Value or signal" interop. `Val<T>` unifies literal, reactive cell,
// and thunk; `toSig` normalizes to a signal cell that can always be
// read via `.value`. The signal layer lives in `@minim/signals` — this
// module is the one-way bridge from "any source of T" to "a cell of T".

import {
  signal,
  computed,
  Signal,
  type Cell,
  type ReadonlyCell,
} from "@minim/signals";

/** Literal, reactive cell, or `() => T` thunk (sugar for `computed`).
 *  Since `Cell<T>` is structurally a `ReadonlyCell<T>`, both writable
 *  and read-only cells satisfy the union — no `Signal<T> |
 *  ReadonlySignal<T>` pair needed. */
export type Val<T> = T | ReadonlyCell<T> | (() => T);

/** Normalize a `Val<T>` to a read-only cell. With `fallback`,
 *  `undefined` becomes a fresh writable cell seeded with it.
 *
 *  Returns the broader `ReadonlyCell<T>` because callers cannot
 *  generally write back through a `Val<T>` — the source may have been
 *  a thunk or a computed cell. Callers who need writability should
 *  type-narrow to `Cell<T>` at the call site or take a `Cell<T>`
 *  parameter explicitly. */
export function toSig<T>(arg: Val<T>): ReadonlyCell<T>;
export function toSig<T>(
  arg: Val<T> | undefined,
  fallback: T,
): ReadonlyCell<T>;
export function toSig<T>(
  arg: Val<T> | undefined,
  fallback?: T,
): ReadonlyCell<T> {
  if (arg === undefined) return signal(fallback as T) as ReadonlyCell<T>;
  if (arg instanceof Signal) return arg as ReadonlyCell<T>;
  if (typeof arg === "function") return computed(arg as () => T);
  return signal(arg as T) as ReadonlyCell<T>;
}

/** Coerce reactive truthiness to `0`/`1` — e.g. `opacity: when(hovered)`. */
export function when<T>(
  arg: Val<T>,
  predicate?: (v: T) => boolean,
): ReadonlyCell<number> {
  const sig = toSig(arg);
  return computed(() => {
    const v = sig.value;
    return (predicate ? predicate(v) : Boolean(v)) ? 1 : 0;
  });
}

// `Cell<T>` is re-exported here so `@minim/core` consumers that only
// pull this for type info don't have to dual-import from `@minim/signals`.
export type { Cell };
