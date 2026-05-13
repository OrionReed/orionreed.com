// Reactive list rendering. Diffs `parent`'s children as `source`
// changes; stable keys preserve per-shape state across updates.

import { effect, toSig, untracked, type Val } from "@minim/core";
import type { AnyShape } from "./shape";

export interface ForEachOptions<T> {
  /** Stable identity per item; defaults to index (fine for fixed
   *  positions, makes swaps look like replacement). */
  key?: (item: T, index: number) => unknown;
}

interface Entry {
  key: unknown;
  shapes: AnyShape[];
}

/** Reactive list result. `at(i)` returns the primary shape (the first
 *  if `render` returned an array). */
export interface ForEachResult {
  dispose: () => void;
  at: (i: number) => AnyShape | undefined;
  all: (i: number) => readonly AnyShape[] | undefined;
}

/** Render a shape (or shapes) per item in `source`, mounting under
 *  `parent`. Re-runs only on structural changes; per-item reactivity
 *  is the render fn's job. */
export function forEach<T>(
  parent: AnyShape,
  source: Val<readonly T[]>,
  render: (item: T, index: number) => AnyShape | AnyShape[],
  options: ForEachOptions<T> = {},
): ForEachResult {
  const sourceSig = toSig(source);
  const { key: keyOf } = options;

  let entries: Entry[] = [];

  const eff = effect(() => {
    const next = sourceSig.value;
    // Diff in `untracked` so internal reads/writes don't re-trigger.
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

      // Anything left in prevByKey is gone from the source.
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
