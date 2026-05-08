// Generic adapter: any callback-style subscription `(cb) => disposer`
// becomes a `Signal<number>` that increments on each fire. Decoupled
// from any specific source — works with `Trace.onChange`, DOM event
// listeners, custom buses, etc.

import { signal, type ReadonlySignal } from "./signal";

/** Wrap a subscription source as a `Signal<number>`. The signal bumps
 *  once per callback fire, so dependents re-evaluate only on real
 *  events (not per-frame).
 *
 *  Lifetime: the subscription is held as long as the returned signal
 *  is reachable. For tighter control, manage the source's disposer
 *  yourself rather than going through this helper. */
export function counter(
  subscribe: (cb: () => void) => () => void,
): ReadonlySignal<number> {
  const sig = signal(0);
  subscribe(() => {
    sig.value = sig.peek() + 1;
  });
  return sig;
}
