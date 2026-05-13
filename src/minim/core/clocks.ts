// Clock constructors — spawn loops on `anim` that advance a signal
// at a fixed interval. For continuous per-frame advancement at a
// rate, see `drift` in `@minim/values`. For recurring side-effects
// inside a generator, see `every(...)` in `compose.ts`.

import { cell, type Cell } from "./cell";
import { loop } from "./compose";
import type { Anim } from "./anim";

/** Tick cell — increments every `sec` seconds while `anim` is active.
 *  Returns the signal directly; the underlying generator runs as a
 *  top-level child of `anim` and is cancelled when `anim.stop()` is
 *  called or the diagram disconnects. */
export function pulse(anim: Anim, sec: number): Cell<number> {
  const sig = cell(0);
  anim.run(
    loop(function* () {
      yield sec;
      sig.value = sig.peek() + 1;
    }),
  );
  return sig;
}
