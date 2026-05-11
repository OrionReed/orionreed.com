// Clocks — any `Signal<number>` advancing over time. For the runtime's
// own logical clock, read `anim.clock` directly. Constructors here
// build *custom* clock signals (tick counters, sec-interval callbacks);
// modulators (`speed`, `ramp`, `reverse`) drive any signal-as-clock —
// `Timeline.clock`, a plain signal, or `anim.clock`-derived computeds.

import { signal, type Signal } from "../core";
import { toSig, type Arg } from "../core";
import type { Anim, Animator } from "../core";
import type { Easing } from "../core";
import { drive } from "./drive";

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
  return drive((dt) => {
    if (clock.value >= totalSig.value) return false;
    const t = totalSig.value > 0 ? clock.value / totalSig.value : 1;
    clock.value += dt * ease(t);
  });
}

/** Drive `clock` backwards to 0. Symmetric with `ramp` — pass an
 *  easing for non-linear rate. */
export function reverse(clock: Signal<number>, ease?: Easing): Animator {
  return drive((dt) => {
    if (clock.value <= 0) return false;
    const rate = ease ? ease(1 - clock.value / Math.max(clock.value, 1)) : 1;
    clock.value = Math.max(0, clock.value - dt * rate);
  });
}

/** Advance `clock` forever, scaled by `rate` (reactive — negatives
 *  reverse, signal lets you scrub live). */
export function speed(clock: Signal<number>, rate: Arg<number>): Animator {
  const r = toSig(rate);
  return drive((dt) => {
    clock.value += dt * r.value;
  });
}
