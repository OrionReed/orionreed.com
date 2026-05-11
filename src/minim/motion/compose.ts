// Composers for `Animator` generators.
//
// For first-completion + cancel-losers semantics ("race") and the
// cancel-on-trigger pattern ("until"), see `core/awaitables.ts` —
// those are awaitable combinators that take advantage of the runtime's
// spawn capability to compose without anim plumbing.

import type { Animator } from "../core";

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
