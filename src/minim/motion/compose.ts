// Composers for `Animator` generators.
//
// For first-completion + cancel-losers semantics ("race") and the
// cancel-on-trigger pattern ("until"), see `core/awaitables.ts` —
// those are awaitable combinators that take advantage of the runtime's
// spawn capability to compose without anim plumbing.

import type { Animator, Signal } from "../core";
import { snapshot } from "../core";

/** Run in parallel; complete when all finish. */
export function* all(...children: Animator[]): Animator {
  yield children;
}

/** Run sequentially. */
export function* sequence(...children: Animator[]): Animator {
  for (const c of children) yield* c;
}

/** Pause `sec` seconds, then run `c`. */
export function* delay(sec: number, c: Animator): Animator {
  if (sec > 0) yield sec;
  yield* c;
}

/** Snapshot the given signals, run `work`, and on cancel restore the
 *  snapshot synchronously. On natural completion the snapshot is
 *  discarded. Useful for atomic-effect patterns: drag-to-reorder,
 *  optimistic UI, exploration. The restore runs in `finally` so it
 *  fires whether the work returns, throws, or is cancelled.
 *
 *  Note: restore is synchronous — it sets the signals back to their
 *  start values in one step. For an animated restore, write the
 *  unwind as a sequel after `until(trigger, work)` instead. */
export function* transaction(
  work: Animator,
  ...sigs: Array<Signal<unknown> | Record<string, unknown>>
): Animator {
  const restore = snapshot(...sigs);
  let completed = false;
  try {
    yield* work;
    completed = true;
  } finally {
    if (!completed) restore();
  }
}

/** Pick one of `children` uniformly at random and run it. Pair with
 *  `Anim.loop(...)` to take a different branch each iteration — the
 *  factory runs every cycle, building a fresh set of generators for
 *  `rand` to choose from:
 *
 *  ```ts
 *  anim.loop(function* () {
 *    yield* rand(fadeUp(s, 0.4), spinIn(s, 0.4), bounceIn(s, 0.4));
 *  });
 *  ```
 *
 *  Unselected generators are never advanced — construction must be
 *  side-effect free (the convention for every motion factory in this
 *  stdlib). For deterministic simulation, drive `Math.random` from a
 *  seeded source upstream. */
export function* rand(...children: Animator[]): Animator {
  if (children.length === 0) return;
  const i = Math.floor(Math.random() * children.length);
  yield* children[i];
}
