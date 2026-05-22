// Streams as a low-level primitive — push-based emission, distinct
// from signals (pull-based current value). Investigates whether a
// dedicated stream type buys us anything we can't already do with
// Signal<T> + effect.
//
// The interesting axis:
//   Signal<T>:  pulled, deduped, always has a value.
//   Stream<T>:  pushed, NOT deduped, may be silent for arbitrary spans.
//
// Both can be subscribed to. Both can be derived. The difference is
// the semantics of "no emission" (signal: keeps previous value;
// stream: subscribers don't fire).

import { effect, type Read, Signal } from "../signal";

// ── Variant 1: Stream<T> as its own primitive ────────────────────
//
// A subject-like push-based emitter. Subscribers receive every push.
// No replay (a late subscriber sees no history).

export class Stream<T> {
  #subs = new Set<(v: T) => void>();
  #closed = false;

  /** Last-pushed value, or undefined if never pushed. Not a Signal —
   *  reading is just inspection. */
  last: T | undefined = undefined;

  push(v: T): void {
    if (this.#closed) return;
    this.last = v;
    for (const fn of this.#subs) fn(v);
  }

  close(): void {
    this.#closed = true;
    this.#subs.clear();
  }

  subscribe(fn: (v: T) => void): () => void {
    if (this.#closed) return () => {};
    this.#subs.add(fn);
    return () => {
      this.#subs.delete(fn);
    };
  }

  // Composers — value-preserving transformations.
  map<U>(fn: (v: T) => U): Stream<U> {
    const out = new Stream<U>();
    this.subscribe(v => out.push(fn(v)));
    return out;
  }

  filter(pred: (v: T) => boolean): Stream<T> {
    const out = new Stream<T>();
    this.subscribe(v => {
      if (pred(v)) out.push(v);
    });
    return out;
  }

  /** Fold: each new emission produces a Signal<S> of the running state. */
  scan<S>(init: S, fn: (acc: S, v: T) => S): Signal<S> {
    const sig = new Signal<S>(init);
    this.subscribe(v => {
      sig.value = fn(sig.peek(), v);
    });
    return sig;
  }

  /** Latest as Signal: read the latest emission as a reactive value.
   *  Default before-first-push is `initial`. */
  latest(initial: T): Signal<T> {
    const sig = new Signal<T>(initial);
    this.subscribe(v => {
      sig.value = v;
    });
    return sig;
  }
}

export const stream = <T>(): Stream<T> => new Stream<T>();

// ── Variant 2: Stream as Signal<{value, version}> ────────────────
//
// Question: do we even need a separate type? A signal carrying a
// version-stamped value emits on every write (since {v, ver} is a
// fresh object each time, dedup doesn't kick in). Subscribers
// see each push.
//
// Pros: re-uses signal machinery, gets `.peek()`, `.subscribe()`, etc.
// Cons: subscribers fire with a wrapper object, .map/filter need new
// signals. Effectively isomorphic but more verbose at the call site.

export type VersionedEmission<T> = { value: T; version: number };

export function pushSignal<T>(): {
  push: (v: T) => void;
  signal: Signal<VersionedEmission<T> | undefined>;
} {
  const sig = new Signal<VersionedEmission<T> | undefined>(undefined);
  let version = 0;
  return {
    push: (v: T) => {
      version++;
      sig.value = { value: v, version };
    },
    signal: sig,
  };
}

// ── Variant 3: Stream-as-Signal-of-event-counter ─────────────────
//
// A 0-content variant where the *fact* of an emission is captured
// but the value isn't. Useful for "trigger" semantics. The signal
// is a counter that increments on each push; subscribers see the
// counter change.

export class Trigger {
  #count = new Signal<number>(0);
  fire(): void {
    this.#count.value = this.#count.peek() + 1;
  }
  get count(): Read<number> {
    return this.#count as Read<number>;
  }

  /** Run `fn` each time this fires. */
  on(fn: () => void): () => void {
    let prev = this.#count.peek();
    return effect(() => {
      const c = this.#count.value;
      if (c !== prev) {
        prev = c;
        fn();
      }
    });
  }
}

export const trigger = (): Trigger => new Trigger();
