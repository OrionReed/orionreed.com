// Animation primitives as generator functions. Each yields per frame
// (`yield`) and receives the dt back. Lazy state capture is automatic
// because generator bodies don't execute until iterated — so
// `sig.peek()` runs at the moment the runner picks up this animation,
// not at construction time.

import { easeOut, type Animator } from "./anim";
import type { Signal } from "./signal";
import type { Shape } from "./shape";

/**
 * Tween a numeric signal from its current value to `target` over `ms`.
 * Start value is captured the first time the runner advances this
 * generator (lazy — composes correctly under any nesting).
 */
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
  // Snap to exact target in case the last frame overshot.
  sig.value = target;
}

/** Fade `shape.opacity` from current value to 1 over `ms`. */
export function* fadeIn(
  shape: Shape,
  ms: number,
  ease: (t: number) => number = easeOut,
): Animator {
  const start = shape.opacity.peek();
  let elapsed = 0;
  while (elapsed < ms) {
    const dt: number = yield;
    elapsed += dt;
    const t = Math.min(elapsed / ms, 1);
    shape.opacity.value = start + (1 - start) * ease(t);
  }
  shape.opacity.value = 1;
}

/** Fade `shape.opacity` from current value to 0 over `ms`. */
export function* fadeOut(
  shape: Shape,
  ms: number,
  ease: (t: number) => number = easeOut,
): Animator {
  const start = shape.opacity.peek();
  let elapsed = 0;
  while (elapsed < ms) {
    const dt: number = yield;
    elapsed += dt;
    const t = Math.min(elapsed / ms, 1);
    shape.opacity.value = start * (1 - ease(t));
  }
  shape.opacity.value = 0;
}

// ── Composers ────────────────────────────────────────────────────────
// Built directly on JS generator semantics — no special runner
// support needed. `yield <array>` is the runner's parallel sugar;
// `yield* gen` delegates serially via the language.

/**
 * Run children in parallel; return when all complete. Equivalent to
 * `yield <array>` but as a named verb that composes via `yield*`.
 */
export function* parallel(...children: Animator[]): Animator {
  yield children;
}

/** Run children one after another. */
export function* sequence(...children: Animator[]): Animator {
  for (const c of children) yield* c;
}

/** Pause `ms` then run `c`. */
export function* withDelay(ms: number, c: Animator): Animator {
  if (ms > 0) yield ms;
  yield* c;
}

/**
 * Run children in parallel, but stagger their starts by `stagger` ms each.
 * `lag(100, a, b, c)` → a starts immediately, b at 100ms, c at 200ms.
 */
export function* lag(stagger: number, ...children: Animator[]): Animator {
  yield children.map((c, i) => withDelay(i * stagger, c));
}
