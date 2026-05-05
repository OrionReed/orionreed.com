// Easings + composers. Tweens themselves live on `Signal.prototype.to`
// (see `./tween`).

import type { Animator } from "./anim";

// ── Easings ─────────────────────────────────────────────────────────

/** Constant velocity. Opt out of the default `easeOut` for ongoing
 *  motion (vs settling transitions). */
export const linear = (t: number) => t;
export const easeOut = (t: number) => 1 - Math.pow(1 - t, 2);
export const easeIn = (t: number) => t * t;
export const easeInOut = (t: number) =>
  t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

// ── Composers ───────────────────────────────────────────────────────

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
