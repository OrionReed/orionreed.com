// `snapshot(...sigs)` — capture current signal values; return a reset
// function. Args are signals or plain records whose signal-valued
// properties get flattened. Useful at the top of `loop(...)` bodies so
// each iteration starts from a known baseline.

import { type Read, Signal, type Writable } from "@minim/signals";

/** Capture current values; return a reset function. Args are signals
 *  (any concrete `T`) or plain records whose signal-valued properties
 *  get flattened. Restoration is type-safe per signal — each is restored
 *  to its own captured value.
 *
 *      const reset = snapshot(score, position);
 *      // … later, on cancel/reset …
 *      reset();
 */
export function snapshot(
  ...args: ReadonlyArray<Read<unknown> | Record<string, unknown>>
): () => void {
  const sigs: Writable<Signal<unknown>>[] = [];
  for (const arg of args) {
    if (arg instanceof Signal) {
      sigs.push(arg as Writable<Signal<unknown>>);
      continue;
    }
    for (const v of Object.values(arg)) {
      if (v instanceof Signal) sigs.push(v as Writable<Signal<unknown>>);
    }
  }
  const initials = sigs.map(s => s.peek());
  return () => {
    for (let i = 0; i < sigs.length; i++) sigs[i].value = initials[i];
  };
}
