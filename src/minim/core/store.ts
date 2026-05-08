// `snapshot(...)` captures the current values of any mix of signals
// and signal-records and returns a reset function.

import { Signal } from "./signal";

/** Capture the current values of `args` and return a function that
 *  restores them. Each arg is either a single `Signal` or a plain
 *  object whose Signal-valued properties are flattened. Useful at the
 *  top of `anim.loop` bodies that mutate state, so each iteration
 *  starts from a known baseline:
 *
 *      const state = {
 *        broadcast: signal(0),
 *        cells: signal(new Map<number, CellState>()),
 *      };
 *      const reset = snapshot(state);
 *      this.anim.loop(function* () {
 *        reset();
 *        // ...
 *      });
 */
export function snapshot(
  ...args: ReadonlyArray<Signal<unknown> | Record<string, unknown>>
): () => void {
  const sigs: Signal<unknown>[] = [];
  for (const arg of args) {
    if (arg instanceof Signal) {
      sigs.push(arg);
      continue;
    }
    // Plain object — pick out Signal-valued properties.
    for (const v of Object.values(arg)) {
      if (v instanceof Signal) sigs.push(v);
    }
  }
  const initials = sigs.map((s) => s.peek());
  return () => {
    for (let i = 0; i < sigs.length; i++) sigs[i].value = initials[i];
  };
}
