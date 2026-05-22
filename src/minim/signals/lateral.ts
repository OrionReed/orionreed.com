// lateral.ts — transitional home for `bind` and `gated`.
//
// `bind(target, source)` drives target from a `Val<T>` for the
// source's lifetime, returning a stop fn. `gated(s, when)` wraps a
// writable signal with runtime-conditional writability.
//
// Both are slated for absorption once the Signal-is-Lens engine
// collapse lands: `bind` becomes "construct a lens onto source"
// (subsumed by the unified construction story), and `gated` becomes a
// `.through()` method on Signal. Until then they live here.

import { effect, lens, type Read, Signal, type Val, value, type WritableBrand } from "./signal";

interface RW<T> {
  value: T;
  peek(): T;
}

/** Drive `target` from `source` for its lifetime. Returns a stop fn.
 *
 *  - `source` literal: writes once, returns a no-op stop.
 *  - `source` is a Signal or thunk: installs an effect that re-writes
 *    target whenever source changes. Stop fn disposes the effect.
 *
 *  Brand-gated on `target` — bare RO value classes are rejected at
 *  the call site. Multiple `bind(t, …)` calls on the same target
 *  install independent effects; the caller owns each stop fn. */
export function bind<T>(target: RW<T> & WritableBrand, source: Val<T>): () => void {
  if (source instanceof Signal || typeof source === "function") {
    return effect(() => {
      target.value = value(source);
    });
  }
  target.value = source as T;
  return () => {};
}

/** Runtime-conditional writability. Reads from `s`; accepts writes
 *  only while `when.value` is true. Useful for "lock this axis while
 *  shift is held" interactions. */
export function gated<T>(s: RW<T> & WritableBrand, when: Read<boolean>): RW<T> & WritableBrand {
  return lens(
    () => s.value,
    v => {
      if (when.value) s.value = v;
    },
  ) as unknown as RW<T> & WritableBrand;
}
