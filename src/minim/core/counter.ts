import { signal, type ReadonlySignal } from "./signal";

/** Wrap a callback subscription `(cb) => disposer` as a `Signal<number>`
 *  that bumps on each fire. Sparse, event-paced — handy for adapting
 *  things like `Trace.onChange` into the signal graph. */
export function counter(
  subscribe: (cb: () => void) => () => void,
): ReadonlySignal<number> {
  const sig = signal(0);
  subscribe(() => {
    sig.value = sig.peek() + 1;
  });
  return sig;
}
