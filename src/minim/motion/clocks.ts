// Clock constructors — use `anim` to spawn loops that advance a
// signal (or call a fn) at a fixed interval. For per-frame integration
// (including continuous clock advancement at a rate), see
// `motion/integrators.ts:drift`.

import { signal, type Signal } from "../core";
import type { Anim } from "../core";

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
