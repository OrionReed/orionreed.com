// Reactive clock adapter — projects `anim.clock` into a
// `ReadonlyCell<number>` for callers that want to subscribe reactively
// (computed deps, `effect`, etc.). Anim itself has no Signal
// dependency; this lives in the values layer because that's where the
// Signal class lives.

import { type Anim } from "@minim/core";
import { cell, type ReadonlyCell } from "@minim/signals";

/** A `ReadonlyCell<number>` that mirrors `anim.clock`. Updates after
 *  every `step()`. Multiple callers can share — call once per anim. */
export function clockSignal(anim: Anim): ReadonlyCell<number> {
  const s = cell(anim.clock);
  anim.onFrame(() => { s.value = anim.clock; });
  return s;
}
