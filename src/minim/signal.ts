// Reactivity is delegated to @preact/signals-core. We re-export what we
// use and add `bindArg` / `toSig` for "value or Signal" construction.

export {
  signal,
  computed,
  effect,
  batch,
  untracked,
  Signal,
  type ReadonlySignal,
} from "@preact/signals-core";

import { signal, Signal } from "@preact/signals-core";
import type { ReadonlySignal } from "@preact/signals-core";

/** A value that may be plain or a Signal/ReadonlySignal. For derived
 *  inputs, wrap in `computed(() => ...)` — that's the one canonical
 *  way to declare reactive derivation. */
export type Arg<T> = T | Signal<T> | ReadonlySignal<T>;

type ReadOrWrite<T> = Signal<T> | ReadonlySignal<T>;

/** Type predicate: true if `v` is a Signal or ReadonlySignal. ReadonlySignal
 *  is an interface but its runtime carrier is always the Signal class
 *  (Computed extends Signal), so `instanceof Signal` covers both. */
function isSig<T>(v: Arg<T>): v is ReadOrWrite<T> {
  return v instanceof Signal;
}

/** Resolve an `Arg<T>` to a Signal. Signal/ReadonlySignal returned
 *  as-is (caller owns the source of truth). Plain value is wrapped
 *  in a fresh writable signal. */
export function toSig<T>(arg: Arg<T>): ReadOrWrite<T> {
  return isSig(arg) ? arg : signal(arg);
}

/** Like `toSig`, but with a default for `undefined` inputs. Used by
 *  Shape constructors where every animatable property is optional. */
export function bindArg<T>(arg: Arg<T> | undefined, defaultValue: T): Signal<T> {
  if (arg === undefined) return signal(defaultValue);
  if (isSig(arg)) return arg as Signal<T>;
  return signal(arg);
}
