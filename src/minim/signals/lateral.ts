// lateral.ts — symmetric / sibling-to-sibling lenses.
//
// `bind(target, source)` drives target from a Val<T> for the source's
// lifetime, returning a stop fn. `eq(a, b)` ties two writable signals
// so writes propagate both ways. `freeze(s)` strips the writable brand
// (type-only). `gated(s, when)` is dynamic freezing — a Read<T> that
// drops writes while a predicate is false.
//
// These complete the lens vocabulary on the "lateral" axis (between
// existing siblings) to complement the "vertical" axis (parent ↔
// derived) covered by the rest of the system.

import {
  Signal, effect, lens, value,
  type Read, type Val, type WritableBrand,
} from "./signal";

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
export function bind<T>(
  target: RW<T> & WritableBrand,
  source: Val<T>,
): () => void {
  if (source instanceof Signal || typeof source === "function") {
    return effect(() => { target.value = value(source) });
  }
  target.value = source as T;
  return () => {};
}

/** Bidirectional sync between two existing writable signals.
 *
 *  Initial state: writes flow from each into the other immediately.
 *  Stable: equality-skip in the engine prevents the round trip from
 *  oscillating once the values agree. Returns a disposer. */
export function eq<T>(a: RW<T>, b: RW<T>): () => void {
  const stop1 = effect(() => {
    const v = a.value;
    if (b.peek() !== v) b.value = v;
  });
  const stop2 = effect(() => {
    const v = b.value;
    if (a.peek() !== v) a.value = v;
  });
  return () => {
    stop1();
    stop2();
  };
}

/** Type-only no-op: strips the `WritableBrand`.
 *
 *  Pass a frozen signal into a lens factory and the factory's per-input
 *  policy will skip it on writes (because it's not writable). For
 *  runtime gating, see `gated()`. */
export function freeze<T>(s: Read<T>): Read<T> {
  return s;
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
