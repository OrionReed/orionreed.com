// Black-box over-execution counters.
//
// The key observation behind a framework-agnostic bireactive suite: the
// closures you hand a reactive engine are yours, so their invocation
// counts are observable without engine introspection. js-reactivity-
// benchmark counts forward computed calls this way; the backward duals
// (`bwd` calls, source commits) are observable by the same trick.
//
//   fwd / bwd  — closure invocations, counted by wrapping the closures.
//   changes    — observable source value changes, counted by an effect
//                per source (post-baseline).
//   fires      — downstream effect runs.
//
// All four are phrased purely in terms of what a consumer can see; none
// reads engine state. That is what makes them portable.

import type { ForwardReactive, Source } from "../adapters/types";

export interface Counters {
  fwd: number;
  bwd: number;
}

export const newCounters = (): Counters => ({ fwd: 0, bwd: 0 });

export const resetCounters = (c: Counters): void => {
  c.fwd = 0;
  c.bwd = 0;
};

/** Wrap a forward closure to count invocations. */
export function countFwd<A extends unknown[], R>(c: Counters, fn: (...a: A) => R): (...a: A) => R {
  return (...a: A) => {
    c.fwd++;
    return fn(...a);
  };
}

/** Wrap a backward closure to count invocations. */
export function countBwd<A extends unknown[], R>(c: Counters, fn: (...a: A) => R): (...a: A) => R {
  return (...a: A) => {
    c.bwd++;
    return fn(...a);
  };
}

export interface SourceObserver {
  /** Observable changes across all watched sources since the last reset. */
  changes(): number;
  /** Set the current state as the zero baseline (drops init fires). */
  reset(): void;
  dispose(): void;
}

/** Watch a set of sources via one effect each, counting how many fire
 *  after the baseline. A settled write that moves K sources registers K
 *  changes — the observable dual of "K source commits". */
export function observeSources(
  rx: ForwardReactive,
  sources: readonly Source<unknown>[],
): SourceObserver {
  let count = 0;
  const disposers = sources.map(s =>
    rx.effect(() => {
      void s.read();
      count++;
    }),
  );
  let baseline = count;
  return {
    changes: () => count - baseline,
    reset: () => {
      baseline = count;
    },
    dispose: () => {
      for (const d of disposers) d();
    },
  };
}

export interface EffectProbe {
  fires(): number;
  reset(): void;
  dispose(): void;
}

/** Install an effect that reads `body` and counts its runs (post-baseline). */
export function probeEffect(rx: ForwardReactive, body: () => void): EffectProbe {
  let count = 0;
  const dispose = rx.effect(() => {
    body();
    count++;
  });
  let baseline = count;
  return {
    fires: () => count - baseline,
    reset: () => {
      baseline = count;
    },
    dispose,
  };
}
