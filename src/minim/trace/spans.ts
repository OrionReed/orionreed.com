// Span recording, externalized from `Anim`. Subscribes via `anim.observe`
// and builds a flat span list with the same shape the previous in-core
// `Anim.trace()` returned. Pure consumer — the runtime knows nothing
// about spans, only about lifecycle events (spawn / complete / cancel).
//
// Tag association is via a WeakMap keyed on the spawned generator (see
// `./tag`); the runtime hands the gen reference to `observe`'s spawn
// listener, and we look it up here.

import type { Anim, Animator } from "../core/anim";
import { tagOf } from "./tag";

/** A single generator's lifecycle as flat data. `completedAt` is set
 *  on natural completion *and* on cancel — consumers reading still-open
 *  spans see `undefined`. Spawn order matches insertion order in
 *  `Trace.spans`; `parentId` walks the spawn tree. `tag` is set at
 *  spawn time from the generator's `tagOf` weak-map entry if present
 *  (see `./tag`). */
export type Span = {
  readonly id: number;
  readonly parentId?: number;
  readonly spawnedAt: number;
  readonly tag?: string;
  completedAt?: number;
};

/** Live recording of generator lifecycle, started by `spans(anim)`.
 *  `spans` mutates in place — new entries on spawn, `completedAt` set
 *  on completion/cancel. `onChange` lets consumers subscribe to
 *  structural changes; sparse, event-paced. Purely data; views (tree,
 *  gantt, equality) live outside this module. */
export type Trace = {
  readonly spans: readonly Span[];
  /** Wall-clock span of the trace: `max(completedAt ?? clock) − min(spawnedAt)`. */
  duration(): number;
  /** Subscribe to structural changes (spawn / complete / cancel).
   *  Returns a disposer. Wrap with `counter` from core for a
   *  signal-flavored adapter. */
  onChange(cb: () => void): () => void;
  /** Stop collecting; the existing `spans` array is yours to keep. */
  stop(): void;
};

/** Begin recording lifecycle of every generator spawned from now on
 *  (already-running generators are not retroactively included). The
 *  returned `spans` array fills live as actives spawn and complete;
 *  `completedAt` is set on natural completion and on cancel.
 *
 *  Single-recorder per Anim — calling `spans(anim)` again replaces the
 *  observation; the previous `Trace`'s array stays for inspection but
 *  receives no further updates. */
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
    /** In-flight bars use `anim.clock` directly so the duration grows
     *  per-frame, not just on lifecycle events. */
    duration() {
      if (list.length === 0) return 0;
      const now = anim.clock;
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
