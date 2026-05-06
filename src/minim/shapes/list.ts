// Reactive list rendering. Mounts shapes per source item and diffs
// the parent's children as the source changes — stable keys preserve
// per-shape state (animations, signals, listeners) across structural
// updates. New items render, removed items dispose.

import { effect, toSig, untracked, type Arg, type AnyShape } from "../core";

export interface ForEachOptions<T> {
  /** Stable identity per item. Defaults to the array index — fine for
   *  fixed-position lists, but means swaps look like full replacement.
   *  Provide a real key for identity-based reuse. */
  key?: (item: T, index: number) => unknown;
}

interface Entry {
  key: unknown;
  shapes: AnyShape[];
}

/** Reactive list rendering result. `at(i)` returns the primary shape
 *  rendered for the i-th source item (the first if `render` returned
 *  an array), or `undefined` when out of range. */
export interface ForEachResult {
  dispose: () => void;
  at: (i: number) => AnyShape | undefined;
  all: (i: number) => readonly AnyShape[] | undefined;
}

/** Render a shape (or shapes) per item in `source`, mounting under
 *  `parent`. Re-runs only on list changes; per-item reactivity is
 *  the render function's job. Returns a disposer plus indexed access
 *  to the rendered shapes (for cross-layer references). */
export function forEach<T>(
  parent: AnyShape,
  source: Arg<readonly T[]>,
  render: (item: T, index: number) => AnyShape | AnyShape[],
  options: ForEachOptions<T> = {},
): ForEachResult {
  const sourceSig = toSig(source);
  const { key: keyOf } = options;

  let entries: Entry[] = [];

  const eff = effect(() => {
    const next = sourceSig.value;
    // Diff in `untracked` so reads of `entries` and add/remove writes
    // don't re-trigger this effect.
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

      // Whatever's left in prevByKey was removed from the source.
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
    at: (i: number) => entries[i]?.shapes[0],
    all: (i: number) => entries[i]?.shapes,
  };
}
