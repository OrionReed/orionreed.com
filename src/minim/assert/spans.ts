// Span recording via `anim.observer`. Pure consumer — the runtime
// has a single optional `observer` slot; this module sets it. Tags
// are looked up from a WeakMap keyed on the spawned generator
// (see `./tag`).
//
// Multiple subscribers: today there's only one (this module). If a
// future caller needs fan-out, compose observers in user code and
// assign the composition to `anim.observer`.

import { Anim, AnimObserver, Animator } from "@minim/core";
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
  /** Subscribe to spawn/complete/cancel events. To plug into the
   *  reactive graph, bump a cell from the callback:
   *  `const v = cell(0); trace.onChange(() => v.value++);` */
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

  const prior = anim.observer;
  const observer: AnimObserver = {
    spawn: (id, parentId, clock, gen: Animator) => {
      prior?.spawn?.(id, parentId, clock, gen);
      const s: Span = { id, parentId, spawnedAt: clock, tag: tagOf(gen) };
      list.push(s);
      byId.set(id, s);
      notify();
    },
    complete: (id, clock) => {
      prior?.complete?.(id, clock);
      const s = byId.get(id);
      if (s && s.completedAt === undefined) {
        s.completedAt = clock;
        notify();
      }
    },
    cancel: (id, clock) => {
      prior?.cancel?.(id, clock);
      const s = byId.get(id);
      if (s && s.completedAt === undefined) {
        s.completedAt = clock;
        notify();
      }
    },
  };
  anim.observer = observer;
  const stopObserve = (): void => {
    // Restore the previous observer if our slot is still ours.
    if (anim.observer === observer) anim.observer = prior;
  };

  return {
    spans: list,
    // Use `anim.clock` directly so in-flight bars grow per-frame,
    // not just on lifecycle events. Plain number — no Signal lookup
    // overhead.
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
