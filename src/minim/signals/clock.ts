// Reactive clock — projects `anim.clock` into a reactive signal so
// callers can subscribe through `computed`/`effect`. The runtime itself
// (`@minim/core`) has no signal dependency; this adapter lives in
// `signals/` because it bridges into the reactive layer.

import { type Anim } from "../core";
import { signal, type Signal } from "./signal";

/** Returns a `Signal<number>` that mirrors `anim.clock`. Updates after
 *  every `step()`. Share one per `Anim`. */
export function clockSignal(anim: Anim): Signal<number> {
  const s = signal(anim.clock);
  anim.onStep(() => { s.value = anim.clock; });
  return s;
}
