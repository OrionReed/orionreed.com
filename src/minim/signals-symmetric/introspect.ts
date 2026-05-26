// introspect.ts — read-only inspection of a signal's dependency graph.
//
// Used by `Propagators` to expand declared reads into their
// transitive parent set ("auto-expand"). Without this, a propagator
// reading a lens chain wouldn't react to writes that update the
// chain's parents but not the chain itself in identity.
//
// The walk is shallow: each step looks at one Computed's deps.
// Lens chains often FUSE — `a.add(b).scale(2)` is a single
// Computed with deps `{a, b}`, not three nested cells — so the
// walk is short for typical chains.
//
// Reading is safe: this only inspects engine state via the public
// `Signal` shape. It triggers a `.value` peek on each visited
// signal so deps get populated for lazy Computeds; the peek is
// cached (idempotent).

import type { Signal } from "./signal";

// Internal `Link` shape: a node in the engine's dep linked list.
// We only read `dep` and `nextDep`; the rest is engine bookkeeping.
interface DepLink {
  dep: Signal<unknown>;
  nextDep: DepLink | undefined;
}

/** Walk a signal's transitive dependency graph and return every
 *  signal it depends on (including itself). For raw cells (no
 *  getter), this returns just `{s}`. For lens chains, it returns
 *  the chain plus all transitive parents.
 *
 *  Walk semantics:
 *    - Visit `s`.
 *    - If `s` is Computed (has a getter), peek to populate deps,
 *      then enqueue each direct dep.
 *    - Recurse breadth-first.
 *
 *  Cycles are handled via the `seen` set; each signal is visited
 *  at most once. */
export function transitiveDeps(s: Signal<unknown>): Set<Signal<unknown>> {
  const seen = new Set<Signal<unknown>>();
  const queue: Signal<unknown>[] = [s];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    // Access engine fields via cast — `getter` and `deps` are
    // public on the Signal class but the typed Signal<T> shape
    // doesn't surface them.
    const c = cur as unknown as {
      getter?: () => unknown;
      deps?: DepLink | undefined;
    };
    if (c.getter !== undefined) {
      // Peek forces evaluation, populating deps for lazy Computeds.
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
