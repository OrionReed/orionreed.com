// Composers for `Animator` generators.

import type { Animator, ReadonlySignal } from "../core";

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

/** Parallel with staggered starts: `lag(0.1, a, b, c)` → 0/0.1/0.2s. */
export function* lag(stagger: number, ...children: Animator[]): Animator {
  yield children.map((c, i) => delay(i * stagger, c));
}

/** Pause until `condition()` is true (polled per frame). */
export function* until(condition: () => boolean): Animator {
  while (!condition()) yield;
}

/** Run `gen()` `n` times in sequence. */
export function* repeat(n: number, gen: () => Animator): Animator {
  for (let i = 0; i < n; i++) yield* gen();
}

/** Run `fn(t, dt)` each frame for `source` seconds, with `t` going
 *  0→1. `source` may be a fixed number of seconds OR a reactive
 *  `Signal<number>` (e.g. a `timeline()` entry) — in the reactive
 *  case the duration is re-read each frame, so live edits propagate. */
export function* during(
  source: number | ReadonlySignal<number>,
  fn: (t: number, dt: number) => void,
): Animator {
  let elapsed = 0;
  fn(0, 0);
  while (true) {
    const total = typeof source === "number" ? source : source.value;
    if (elapsed >= total) break;
    const dt: number = yield;
    elapsed += dt;
    const t = total > 0 ? Math.min(elapsed / total, 1) : 1;
    fn(t, dt);
  }
  fn(1, 0);
}

/** Parallel; finishes when the first child does. Children must use
 *  bare `yield` only — wrap mixed-yield ones in a composer. */
export function* race(...children: Animator[]): Animator {
  for (const c of children) c.next();
  while (true) {
    const dt: number = yield;
    for (const c of children) {
      if (c.next(dt).done) return;
    }
  }
}
