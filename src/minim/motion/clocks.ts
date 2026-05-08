// Clocks: any `Signal<number>` advancing over time. Two flavours of
// constructor (`pulse`, `clock`) and three modulators (`speed`, `ramp`,
// `reverse`) plus a small `every` side-effect helper. All three modulators
// are `Animator` generators that take a clock signal directly, so they
// compose with any signal-as-clock — `Timeline.clock`, a free-standing
// `signal(0)`, or a clock returned by `clock()` here.

import { signal, type Signal } from "../core";
import { toSig, type Arg } from "../core";
import type { Anim, Animator } from "../core";
import type { Easing } from "../core";

// ── Constructors ─────────────────────────────────────────────────────

/** Tick signal — increments every `sec` seconds while `anim` is active.
 *  The returned signal can be read in computeds, derived
 *  (`tick.derive(...)`), or used as a re-roll trigger. */
export function pulse(anim: Anim, sec: number): Signal<number> {
  const sig = signal(0);
  anim.loop(function* () {
    yield sec;
    sig.value = sig.peek() + 1;
  });
  return sig;
}

/** Continuous clock — a `Signal<number>` that grows by `dt` each frame
 *  while `anim` is active. Use as the source for `derive(t => ...)`
 *  bindings, or as a clock for `ramp` / `reverse`. */
export function clock(anim: Anim): Signal<number> {
  const sig = signal(0);
  anim.run(speed(sig, 1));
  return sig;
}

/** Periodic side-effect: run `fn` every `sec` seconds. Returns a
 *  disposer that cancels the loop. */
export function every(anim: Anim, sec: number, fn: () => void): () => void {
  return anim.loop(function* () {
    fn();
    yield sec;
  });
}

// ── Modulators ───────────────────────────────────────────────────────

/** Advance `clock` from its current value to `total`, modulating the
 *  rate by `ease(progress)` where `progress = clock / total`. With
 *  `easeInOut` you get slow-start/fast-middle/slow-end playback; with
 *  `easeIn` you get a slow start; etc. The rate at any instant is the
 *  easing's *value*, not a derivative — pass curves whose endpoints
 *  are 0 (e.g. `easeInOut`) for smooth ramping. */
export function ramp(
  clock: Signal<number>,
  total: Arg<number>,
  ease: Easing,
): Animator {
  const totalSig = toSig(total);
  return (function* () {
    while (clock.value < totalSig.value) {
      const dt: number = yield;
      const t = totalSig.value > 0 ? clock.value / totalSig.value : 1;
      clock.value += dt * ease(t);
    }
  })();
}

/** Drive `clock` backwards from its current value to 0. Useful for
 *  reverse-playback timelines. Symmetric with `ramp` — pass an easing
 *  for non-linear reverse rate. */
export function reverse(clock: Signal<number>, ease?: Easing): Animator {
  return (function* () {
    while (clock.value > 0) {
      const dt: number = yield;
      const rate = ease ? ease(1 - clock.value / Math.max(clock.value, 1)) : 1;
      clock.value = Math.max(0, clock.value - dt * rate);
    }
  })();
}

/** Advance `clock` forever, scaled by `rate`. Negative rate runs
 *  backwards. Reactive — `rate` may be a signal, so playback speed
 *  can be edited live (slider, crossfade, scrub-with-momentum). */
export function speed(clock: Signal<number>, rate: Arg<number>): Animator {
  const r = toSig(rate);
  return (function* () {
    while (true) {
      const dt: number = yield;
      clock.value += dt * r.value;
    }
  })();
}
