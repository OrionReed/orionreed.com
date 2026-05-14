// "Value or signal" interop. `Val<T>` unifies literal, reactive cell,
// and thunk. Two canonical normalisers — `toSig` (→ ReadonlyCell) and
// `asReader` (→ thunk) — cover every Val-consuming callsite in the
// library. No bespoke dispatch elsewhere.
//
// Lives in `signals/` rather than `core/` because we need the signal
// engine to wrap literals/thunks; the core generator runtime stays
// signal-free.

import { signal, computed, Signal } from "./signal";
import { type Cell, type ReadonlyCell } from "./cell";

/** Literal, reactive cell, or `() => T` thunk (sugar for `computed`).
 *  Since `Cell<T>` is structurally a `ReadonlyCell<T>`, both writable
 *  and read-only cells satisfy the union. */
export type Val<T> = T | ReadonlyCell<T> | (() => T);

/** Normalize a `Val<T>` to a read-only cell that's always safe to
 *  `.value` / `.peek()`. With `fallback`, `undefined` becomes a fresh
 *  writable cell seeded with it.
 *
 *  Returns the broader `ReadonlyCell<T>` because callers cannot
 *  generally write back through a `Val<T>` (the source may have been
 *  a thunk or computed). Callers who need writability take a `Cell<T>`
 *  parameter explicitly.
 *
 *  Allocates when `arg` is a literal (wraps in `signal`) or a thunk
 *  (wraps in `computed`). For per-frame readers that don't need a
 *  signal identity, prefer `asReader` — no allocation for literals. */
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

/** Normalize a `Val<T>` to a `() => T` thunk. Branches once at call
 *  time; the resulting closure is monomorphic and allocation-free for
 *  literals (no signal wrapper, no computed wrapper).
 *
 *  Used in lifted struct-ops to bind args once at construction, so the
 *  per-frame read is just one function call. The struct framework, the
 *  scaled-child bridge in `tween.ts`, and `adoptField`'s field-input
 *  branch all call through here — one canonical dispatch. */
export function asReader<T>(v: Val<T>): () => T {
  if (v instanceof Signal) {
    const s = v;
    return () => s.value as T;
  }
  if (typeof v === "function") {
    return v as () => T;
  }
  return () => v as T;
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

// `Cell<T>` is re-exported so `Val<T>` consumers can grab it from the
// same module.
export type { Cell };
