// Composers for `Animator` generators. For first-completion +
// cancel-losers (`race`) and cancel-on-trigger (`until`), see
// `core/suspensions.ts`.

import type { Animator, Signal } from "../core";
import { snapshot } from "../core";

/** Run in parallel; complete when all finish. */
export function* all(...children: Animator[]): Animator {
  yield children;
}

export function* sequence(...children: Animator[]): Animator {
  for (const c of children) yield* c;
}

/** Pause `sec` seconds, then run `c`. */
export function* delay(sec: number, c: Animator): Animator {
  if (sec > 0) yield sec;
  yield* c;
}

/** Run `work`; on cancel, synchronously restore the snapshot. Natural
 *  completion discards it. For an animated unwind, write the exit as
 *  a sequel after `until(trigger, work)` instead. */
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

/** Pick one of `children` uniformly at random and run it. Construction
 *  must be side-effect free — unselected generators are never advanced
 *  (the convention for every factory in this stdlib). Combine with
 *  `Anim.loop` for a fresh roll each iteration. */
export function* rand(...children: Animator[]): Animator {
  if (children.length === 0) return;
  const i = Math.floor(Math.random() * children.length);
  yield* children[i];
}
