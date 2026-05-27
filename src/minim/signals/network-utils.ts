// network-utils.ts — small reactive-collection helpers that ride on
// top of the `network` model.
//
// These aren't framework primitives — they're the patterns that
// recur whenever you have collection-driven or boolean-driven
// resource lifecycles. Implemented in terms of `effect` (no special
// engine support); ship alongside `network` for convenience.
//
//   `each(source, body)` — body runs per element keyed by reference
//                          identity; cleanup on removal.
//   `when(source, body)` — body runs while truthy; cleanup on falsy.

import { effect, type Read } from "./signal";

/** Disposable handle. */
export interface Lifecycle {
  dispose(): void;
}

/** Reactively iterate `source`'s elements. For each element seen for
 *  the first time, runs `body(item)` and stores its returned cleanup.
 *  When an element disappears from `source`, runs its cleanup.
 *  Identity is element reference — keep stable refs across collection
 *  mutations (don't re-create `{a: 0, b: 1}` objects every frame; use
 *  longer-lived models instead).
 *
 *  Cleanup ordering on `dispose()`: runs every active cleanup, then
 *  unsubscribes the underlying effect. */
export function each<T>(source: Read<readonly T[]>, body: (item: T) => () => void): Lifecycle {
  const handles = new Map<T, () => void>();
  const eff = effect(() => {
    const items = source.value;
    const seen = new Set<T>(items);
    for (const item of items) {
      if (!handles.has(item)) handles.set(item, body(item));
    }
    for (const [item, cleanup] of handles) {
      if (!seen.has(item)) {
        cleanup();
        handles.delete(item);
      }
    }
  });
  return {
    dispose() {
      eff();
      for (const cleanup of handles.values()) cleanup();
      handles.clear();
    },
  };
}

/** Run `body(v)` while `source.value` is truthy; tear down with the
 *  returned cleanup when it goes falsy (and re-arm — body can run
 *  again next time it becomes truthy).
 *
 *  Note: there is also an `anim.ts` `when(sig)` returning an
 *  `Animator<void>` (one-shot wake). The two have different shapes
 *  and module homes; either is imported explicitly when needed. */
export function when<T>(source: Read<T>, body: (v: T) => () => void): Lifecycle {
  let cleanup: (() => void) | undefined;
  const eff = effect(() => {
    const v = source.value;
    if (v) {
      if (cleanup === undefined) cleanup = body(v);
    } else if (cleanup !== undefined) {
      cleanup();
      cleanup = undefined;
    }
  });
  return {
    dispose() {
      eff();
      if (cleanup !== undefined) {
        cleanup();
        cleanup = undefined;
      }
    },
  };
}
