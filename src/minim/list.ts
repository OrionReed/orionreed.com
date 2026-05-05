// Reactive list rendering. `forEach(parent, source, render)` mounts a
// shape (or shapes) per source item and keeps the parent's children in
// sync as the source list changes. Stable items (matched by key) are
// reused — their per-shape state (animations, signals, listeners) is
// preserved across structural changes. New items render, removed items
// dispose. Designed so a viewport breakpoint changing the cell count
// no longer requires tearing down the entire diagram.

import { effect, toSig, untracked } from "./signal";
import type { Arg } from "./signal";
import type { Shape } from "./shape";

export interface ForEachOptions<T> {
  /** Stable identity per item. If two items in the same list resolve to
   *  the same key, behavior is undefined (caller's responsibility to
   *  pick unique keys). Defaults to the array index — fine for fixed
   *  position lists, but means "swapping two items" looks like
   *  "everything was replaced." Provide an explicit key for true
   *  identity-based reuse. */
  key?: (item: T, index: number) => unknown;
}

interface Entry {
  key: unknown;
  shapes: Shape[];
}

/** Render a shape (or shapes) per item in `source`, mounting under
 *  `parent`. Re-runs only when the *list* changes (new item added,
 *  removed, or replaced by key); per-item reactivity is the render
 *  function's responsibility (use signals from the closure).
 *
 *  Returns a disposer that detaches the effect and disposes every
 *  shape currently rendered. */
export function forEach<T>(
  parent: Shape,
  source: Arg<readonly T[]>,
  render: (item: T, index: number) => Shape | Shape[],
  options: ForEachOptions<T> = {},
): { dispose: () => void } {
  const sourceSig = toSig(source);
  const { key: keyOf } = options;

  let entries: Entry[] = [];

  const eff = effect(() => {
    const next = sourceSig.value;
    // Diff under `untracked` so reads of `entries` and writes via
    // `parent.add`/`remove` don't re-trigger this effect.
    untracked(() => {
      const prevByKey = new Map<unknown, Entry>();
      for (const e of entries) prevByKey.set(e.key, e);

      const nextEntries: Entry[] = [];
      for (let i = 0; i < next.length; i++) {
        const item = next[i];
        const k = keyOf ? keyOf(item, i) : i;
        const existing = prevByKey.get(k);
        if (existing) {
          nextEntries.push(existing);
          prevByKey.delete(k);
        } else {
          const result = render(item, i);
          const shapes = Array.isArray(result) ? result : [result];
          parent.add(...shapes);
          nextEntries.push({ key: k, shapes });
        }
      }

      // Anything left in prevByKey was removed from the source list.
      for (const removed of prevByKey.values()) {
        parent.remove(...removed.shapes);
      }

      entries = nextEntries;
    });
  });

  return {
    dispose: () => {
      eff();
      const toRemove = entries;
      entries = [];
      for (const e of toRemove) parent.remove(...e.shapes);
    },
  };
}
