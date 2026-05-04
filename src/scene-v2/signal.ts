// Reactivity is delegated to @preact/signals-core (~2KB, glitch-free
// updates, batched scheduling). We re-export the surface we use and add
// two tiny helpers — `read()` and `unwrap()` — to normalize the
// "value | signal | thunk" pattern across shape APIs.

export {
  signal,
  computed,
  effect,
  batch,
  untracked,
  type Signal,
  type ReadonlySignal,
} from "@preact/signals-core";

import type { Signal, ReadonlySignal } from "@preact/signals-core";

/**
 * A value that may be plain, a signal/computed, or a thunk. Anywhere a
 * shape accepts a reactive value it really takes one of these.
 */
export type Arg<T> = T | Signal<T> | ReadonlySignal<T> | (() => T);

function isSignal<T>(v: unknown): v is Signal<T> | ReadonlySignal<T> {
  // preact-signals' `peek()` is the most distinctive marker.
  return (
    v !== null &&
    typeof v === "object" &&
    typeof (v as { peek?: unknown }).peek === "function"
  );
}

/**
 * Normalize an `Arg<T>` to a plain getter. The returned function tracks
 * any signals it reads when called inside an effect.
 */
export function read<T>(v: Arg<T>): () => T {
  if (isSignal<T>(v)) return () => v.value;
  if (typeof v === "function") return v as () => T;
  return () => v as T;
}

/** One-shot read of an `Arg<T>` — current value, no tracking. */
export function unwrap<T>(v: Arg<T>): T {
  if (isSignal<T>(v)) return v.value;
  if (typeof v === "function") return (v as () => T)();
  return v as T;
}
