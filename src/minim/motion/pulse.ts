// Tick signal — a `Signal<number>` that increments every `sec` seconds
// while the parent Anim runs. Useful for re-rolling random patterns,
// triggering periodic events, driving cell-grid recomputation, etc.

import { signal, type Signal } from "../core";
import type { Anim } from "../core";

/** Tick signal — increments every `sec` seconds while `anim` is active.
 *  The returned signal can be read in computeds, derived (`tick.derive(...)`),
 *  or used as a re-roll trigger. */
export function pulse(anim: Anim, sec: number): Signal<number> {
  const sig = signal(0);
  anim.loop(function* () {
    yield sec;
    sig.value = sig.peek() + 1;
  });
  return sig;
}
