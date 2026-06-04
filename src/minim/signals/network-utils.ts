// network-utils.ts — reactive-collection lifecycle helpers over the
// `network` model. Implemented purely via `effect`:
//
//   `each(source, body)` — body runs per element (keyed by reference
//                          identity); cleanup on removal.
//   `when(source, body)` — body runs while truthy; cleanup on falsy.

import { effect, type Read } from "./signal";

/** Disposable handle. */
export interface Lifecycle {
  dispose(): void;
}

/** Run `body(item)` per element on first sight (storing its cleanup) and
 *  run that cleanup when the element leaves. Identity is element
 *  reference — keep stable refs across mutations, don't re-create
 *  objects every frame. */
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

/** Run `body(v)` while `source.value` is truthy; run the returned
 *  cleanup on falsy and re-arm. (Distinct from `anim.ts`'s one-shot
 *  `when(sig)` Animator.) */
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
