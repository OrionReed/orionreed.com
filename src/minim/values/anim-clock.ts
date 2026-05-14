// Reactive clock adapter — projects Anim's plain-number `clockMs`
// into a `ReadonlyCell<number>` for callers that want to subscribe
// reactively (computed deps, `effect`, etc.).
//
// Anim itself has no Signal dependency (see `core/anim.ts`); the
// adapter lives here in the signals layer because that's where the
// Signal class lives. The signal is allocated once per `clockSignal`
// call and writes through `anim.onClock`.

import { type Anim } from "@minim/core";
import { cell, type ReadonlyCell } from "@minim/signals";

/** A `ReadonlyCell<number>` that mirrors `anim.clockMs`. Updates
 *  after every step. Multiple callers can share — call once per anim
 *  and pass the result around. */
export function clockSignal(anim: Anim): ReadonlyCell<number> {
  const s = cell(anim.clockMs);
  anim.onClock((t) => {
    s.value = t;
  });
  return s;
}
