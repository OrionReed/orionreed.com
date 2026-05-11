import { Signal } from "./signal";

/** Capture current values; return a reset function. Args are signals
 *  or plain objects whose Signal-valued props get flattened. Useful at
 *  the top of `anim.loop` bodies so each iteration starts from a known
 *  baseline. */
export function snapshot(
  ...args: ReadonlyArray<Signal<unknown> | Record<string, unknown>>
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
