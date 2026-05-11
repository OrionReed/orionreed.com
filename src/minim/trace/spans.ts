// Span recording via `anim.observe`. Pure consumer — the runtime
// knows nothing about spans, only lifecycle events. Tags are looked
// up from a WeakMap keyed on the spawned generator (see `./tag`).

import type { Anim, Animator } from "../core/anim";
import { tagOf } from "./tag";

/** One generator's lifecycle as flat data. `completedAt` is set on
 *  natural completion *and* on cancel; still-open spans read
 *  `undefined`. `tag` is set at spawn time if the generator has one. */
export type Span = {
  readonly id: number;
  readonly parentId?: number;
  readonly spawnedAt: number;
  readonly tag?: string;
  completedAt?: number;
};

/** Live recording of generator lifecycle. `spans` mutates in place;
 *  `onChange` notifies on structural changes (sparse, event-paced).
 *  Views (tree, gantt) live outside this module. */
export type Trace = {
  readonly spans: readonly Span[];
  /** Wall-clock duration: `max(completedAt ?? clock) − min(spawnedAt)`. */
  duration(): number;
  /** Subscribe to spawn/complete/cancel events. Wrap with `counter`
   *  for a signal adapter. */
  onChange(cb: () => void): () => void;
  /** Stop collecting; the existing `spans` array is yours to keep. */
  stop(): void;
};

/** Begin recording every generator spawned from now on (already-
 *  running ones aren't retroactively included). */
export function spans(anim: Anim): Trace {
  const list: Span[] = [];
  const byId = new Map<number, Span>();
  let listeners: Set<() => void> | undefined;
  const notify = (): void => {
    if (!listeners) return;
    for (const cb of listeners) cb();
  };

  const stopObserve = anim.observe({
    spawn: (id, parentId, clock, gen: Animator) => {
      const s: Span = { id, parentId, spawnedAt: clock, tag: tagOf(gen) };
      list.push(s);
      byId.set(id, s);
      notify();
    },
    complete: (id, clock) => {
      const s = byId.get(id);
      if (s && s.completedAt === undefined) {
        s.completedAt = clock;
        notify();
      }
    },
    cancel: (id, clock) => {
      const s = byId.get(id);
      if (s && s.completedAt === undefined) {
        s.completedAt = clock;
        notify();
      }
    },
  });

  return {
    spans: list,
    // Use `anim.clock` directly so in-flight bars grow per-frame, not
    // just on lifecycle events.
    duration() {
      if (list.length === 0) return 0;
      const now = anim.clock.peek();
      let min = Infinity;
      let max = 0;
      for (const s of list) {
        if (s.spawnedAt < min) min = s.spawnedAt;
        const end = s.completedAt ?? now;
        if (end > max) max = end;
      }
      return max - min;
    },
    onChange(cb) {
      if (!listeners) listeners = new Set();
      listeners.add(cb);
      return () => {
        listeners?.delete(cb);
      };
    },
    stop: stopObserve,
  };
}
