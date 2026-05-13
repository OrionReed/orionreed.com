// Clock constructors — spawn loops on `anim` that advance a signal
// (or call a fn) at a fixed interval. For continuous per-frame
// advancement at a rate, see `drift` in `@minim/values`.

import { cell, type Cell } from "./cell";
import type { Anim } from "./anim";

/** Tick cell — increments every `sec` seconds while `anim` is active. */
export function pulse(anim: Anim, sec: number): Cell<number> {
  const sig = cell(0);
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
