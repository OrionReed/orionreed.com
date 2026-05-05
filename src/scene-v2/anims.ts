// Animation primitives. Generators iterate lazily so `sig.peek()` runs
// when the runner picks them up, not at construction — composition
// works under any nesting.

import type { Animator } from "./anim";
import type { Signal } from "./signal";
import type { Shape } from "./shape";

// ── Easings ─────────────────────────────────────────────────────────

export const easeOut = (t: number) => 1 - Math.pow(1 - t, 2);
export const easeIn = (t: number) => t * t;
export const easeInOut = (t: number) =>
  t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

// ── Tweens ──────────────────────────────────────────────────────────

export function* tween(
  sig: Signal<number>,
  target: number,
  ms: number,
  ease: (t: number) => number = easeOut,
): Animator {
  const start = sig.peek();
  let elapsed = 0;
  while (elapsed < ms) {
    const dt: number = yield;
    elapsed += dt;
    const t = Math.min(elapsed / ms, 1);
    sig.value = start + (target - start) * ease(t);
  }
  sig.value = target;
}

export const fadeIn = (s: Shape, ms: number, ease?: (t: number) => number) =>
  tween(s.opacity, 1, ms, ease);

export const fadeOut = (s: Shape, ms: number, ease?: (t: number) => number) =>
  tween(s.opacity, 0, ms, ease);

// ── Composers ───────────────────────────────────────────────────────

/** Run children in parallel; complete when all finish. */
export function* parallel(...children: Animator[]): Animator {
  yield children;
}

/** Run children sequentially. */
export function* sequence(...children: Animator[]): Animator {
  for (const c of children) yield* c;
}

/** Pause `ms` then run `c`. */
export function* withDelay(ms: number, c: Animator): Animator {
  if (ms > 0) yield ms;
  yield* c;
}

/** Parallel with staggered starts: `lag(100, a, b, c)` → 0, 100, 200ms. */
export function* lag(stagger: number, ...children: Animator[]): Animator {
  yield children.map((c, i) => withDelay(i * stagger, c));
}

/** Pause until `condition()` is true (polled per frame). */
export function* untilSig(condition: () => boolean): Animator {
  while (!condition()) yield;
}

/** Sequence `gen()` `n` times. Each call produces a fresh generator. */
export function* repeat(n: number, gen: () => Animator): Animator {
  for (let i = 0; i < n; i++) yield* gen();
}

/** Parallel; complete as soon as the FIRST child finishes. Frame-only
 *  children (only bare `yield`) — wrap mixed-yield ones in a composer. */
export function* race(...children: Animator[]): Animator {
  for (const c of children) c.next();
  while (true) {
    const dt: number = yield;
    for (const c of children) {
      if (c.next(dt).done) return;
    }
  }
}
