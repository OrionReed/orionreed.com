// Clocks — any `Signal<number>` advancing over time. Constructors
// (`pulse`, `clock`) plus modulators (`speed`, `ramp`, `reverse`)
// that work on any signal-as-clock (Timeline.clock, a plain signal,
// or one returned by `clock()`).

import { signal, type Signal } from "../core";
import { toSig, type Arg } from "../core";
import type { Anim, Animator } from "../core";
import type { Easing } from "../core";

// ── Constructors ─────────────────────────────────────────────────────

/** Tick signal — increments every `sec` seconds while `anim` is active. */
export function pulse(anim: Anim, sec: number): Signal<number> {
  const sig = signal(0);
  anim.loop(function* () {
    yield sec;
    sig.value = sig.peek() + 1;
  });
  return sig;
}

/** Continuous clock — grows by `dt` each frame while `anim` runs. */
export function clock(anim: Anim): Signal<number> {
  const sig = signal(0);
  anim.run(speed(sig, 1));
  return sig;
}

/** Run `fn` every `sec` seconds. Returns a disposer. */
export function every(anim: Anim, sec: number, fn: () => void): () => void {
  return anim.loop(function* () {
    fn();
    yield sec;
  });
}

// ── Modulators ───────────────────────────────────────────────────────

/** Advance `clock` to `total`, with rate modulated by `ease(progress)`
 *  (where progress = `clock / total`). The rate is the easing's
 *  *value*, not its derivative — pass curves with 0 endpoints (e.g.
 *  `easeInOut`) for smooth ramping. */
export function ramp(
  clock: Signal<number>,
  total: Arg<number>,
  ease: Easing,
): Animator {
  const totalSig = toSig(total);
  return (function* () {
    while (clock.value < totalSig.value) {
      const dt = yield;
      const t = totalSig.value > 0 ? clock.value / totalSig.value : 1;
      clock.value += dt * ease(t);
    }
  })();
}

/** Drive `clock` backwards to 0. Symmetric with `ramp` — pass an
 *  easing for non-linear rate. */
export function reverse(clock: Signal<number>, ease?: Easing): Animator {
  return (function* () {
    while (clock.value > 0) {
      const dt = yield;
      const rate = ease ? ease(1 - clock.value / Math.max(clock.value, 1)) : 1;
      clock.value = Math.max(0, clock.value - dt * rate);
    }
  })();
}

/** Advance `clock` forever, scaled by `rate` (reactive — negatives
 *  reverse, signal lets you scrub live). */
export function speed(clock: Signal<number>, rate: Arg<number>): Animator {
  const r = toSig(rate);
  return (function* () {
    while (true) {
      const dt = yield;
      clock.value += dt * r.value;
    }
  })();
}
