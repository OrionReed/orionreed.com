// lateral.ts — `bind(target, source)` drives target from a `Val<T>`
// for the source's lifetime.

import { effect, Signal, type Val, value, type WritableOf } from "./signal";

/** Drive `target` from `source` for its lifetime. Returns a stop fn.
 *
 *  - `source` literal: writes once, returns a no-op stop.
 *  - `source` is a Signal or thunk: installs an effect that re-writes
 *    target whenever source changes. Stop fn disposes the effect.
 *
 *  Brand-gated on `target` — bare RO value classes are rejected at
 *  the call site. Multiple `bind(t, …)` calls on the same target
 *  install independent effects; the caller owns each stop fn. */
export function bind<T>(target: WritableOf<T>, source: Val<T>): () => void {
  if (source instanceof Signal || typeof source === "function") {
    return effect(() => {
      target.value = value(source);
    });
  }
  target.value = source as T;
  return () => {};
}
