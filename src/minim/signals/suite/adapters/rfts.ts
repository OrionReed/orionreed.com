// Bridge an adapter to the reactive-framework-test-suite shape. RFTS
// already models a signal as `{ read, write }` and a computed as
// `{ read }`, which is exactly our `Source` / `Readable`, so the forward
// bridge is a rename. The lifted bridge is the interesting one: it backs
// every "signal" with an identity write-through view, so the entire
// forward suite runs with writes entering through a lens — the
// mechanical proof that forward invariants survive backward routing.

import type { ReactiveFramework } from "reactive-framework-test-suite";
import type { ForwardReactive, Reactive } from "./types";

export function forwardFramework(rx: ForwardReactive): ReactiveFramework {
  return {
    name: rx.name,
    signal: i => rx.signal(i),
    computed: fn => rx.computed(fn),
    effect: fn => rx.effect(fn),
    run: fn => fn(),
    batch: fn => rx.batch(fn),
    untracked: fn => rx.untracked(fn),
  };
}

export function liftedFramework(rx: Reactive): ReactiveFramework {
  return {
    name: `${rx.name}+lens`,
    signal: <T>(initial: T) => {
      const source = rx.signal(initial);
      return rx.lens<T, T>(
        source,
        x => x,
        nv => nv,
      );
    },
    computed: fn => rx.computed(fn),
    effect: fn => rx.effect(fn),
    run: fn => fn(),
    batch: fn => rx.batch(fn),
    untracked: fn => rx.untracked(fn),
  };
}
