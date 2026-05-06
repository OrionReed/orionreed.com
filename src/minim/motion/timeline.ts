// `timeline({ ... })` — typed object of named duration `Signal<number>`s.
// Pair with `during(tl.x, fn)` or `sig.to(target, tl.x)` to drive blocks
// from named, editable durations. Iterate with `Object.entries(tl)` for
// timeline-editor UIs.

import { signal, type Signal } from "../core";

/** Construct a typed record of duration signals from an initial map of
 *  numbers. Each property becomes a writable `Signal<number>` whose
 *  current value is the range's duration in seconds. */
export function timeline<const T extends Record<string, number>>(
  initial: T,
): { readonly [K in keyof T]: Signal<number> } {
  const out: Record<string, Signal<number>> = {};
  for (const key of Object.keys(initial)) {
    out[key] = signal(initial[key]);
  }
  return out as { [K in keyof T]: Signal<number> };
}
