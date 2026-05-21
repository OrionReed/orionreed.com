// lateral.ts — symmetric / sibling-to-sibling lenses.
//
// `eq(a, b)` ties two writable signals so writes propagate both ways.
// `freeze(s)` strips the writable brand (type-only). `gated(s, when)`
// is dynamic freezing — a Read<T> that drops writes while a predicate
// is false.
//
// These complete the lens vocabulary on the "lateral" axis (between
// existing siblings) to complement the "vertical" axis (parent ↔
// derived) covered by the rest of the system.

import { effect, lens, type Read, type WritableBrand } from "./signal";

interface RW<T> {
  value: T;
  peek(): T;
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
export function gated<T>(
  s: RW<T> & WritableBrand,
  when: Read<boolean>,
): RW<T> & WritableBrand {
  return lens(
    () => s.value,
    (v) => {
      if (when.value) s.value = v;
    },
  ) as unknown as RW<T> & WritableBrand;
}
