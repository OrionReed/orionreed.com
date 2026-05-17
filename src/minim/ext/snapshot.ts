// `snapshot(...sigs)` — capture current signal values; return a reset
// function. Args are cells or plain records whose signal-valued
// properties get flattened. Useful at the top of `loop(...)` bodies so
// each iteration starts from a known baseline.

import {Signal} from "@minim/signals";

/** Capture current values; return a reset function. Args are cells or
 *  plain records whose signal-valued properties get flattened.
 *
 *      const reset = snapshot(score, position);
 *      // … later, on cancel/reset …
 *      reset();
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function snapshot(
  ...args: ReadonlyArray<Signal<any> | Record<string, unknown>>
): () => void {
  const sigs: Signal<unknown>[] = [];
  for (const arg of args) {
    if (arg instanceof Signal) {
      sigs.push(arg);
      continue;
    }
    for (const v of Object.values(arg)) {
      if (v instanceof Signal) sigs.push(v);
    }
  }
  const initials = sigs.map((s) => s.peek());
  return () => {
    for (let i = 0; i < sigs.length; i++) sigs[i].value = initials[i];
  };
}
