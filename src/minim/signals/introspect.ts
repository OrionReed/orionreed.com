// introspect.ts — read-only inspection of a signal's dependency graph.
//
// Used by `Propagators` to expand declared reads into their transitive
// parent set, so a propagator reading a lens chain reacts to writes that
// touch the chain's parents but not the chain's identity. Inspection is
// safe: it only reads engine state and peeks `.value` to populate deps
// for lazy Computeds (idempotent).

import type { Signal } from "./signal";

// One node in the engine's dep linked list; we only read `dep`/`nextDep`.
interface DepLink {
  dep: Signal<unknown>;
  nextDep: DepLink | undefined;
}

/** Every signal `s` transitively depends on, including itself. Raw cells
 *  return `{s}`; lens chains return the chain plus all parents. BFS,
 *  peeking each Computed to populate deps; the `seen` set breaks cycles. */
export function transitiveDeps(s: Signal<unknown>): Set<Signal<unknown>> {
  const seen = new Set<Signal<unknown>>();
  const queue: Signal<unknown>[] = [s];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    // Cast to reach engine fields the typed Signal<T> shape doesn't surface.
    const c = cur as unknown as {
      getter?: () => unknown;
      deps?: DepLink | undefined;
    };
    if (c.getter !== undefined) {
      void cur.value;
      let l: DepLink | undefined = c.deps;
      while (l !== undefined) {
        queue.push(l.dep);
        l = l.nextDep;
      }
    }
  }
  return seen;
}
