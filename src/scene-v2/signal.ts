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

import { signal, effect } from "@preact/signals-core";
import type { Signal, ReadonlySignal } from "@preact/signals-core";

/**
 * A value that may be plain, a signal/computed, or a thunk. Anywhere a
 * shape accepts a reactive value it really takes one of these.
 */
export type Arg<T> = T | Signal<T> | ReadonlySignal<T> | (() => T);

export function isSignal<T>(v: unknown): v is Signal<T> | ReadonlySignal<T> {
  // preact-signals' `peek()` is the most distinctive marker.
  return (
    v !== null &&
    typeof v === "object" &&
    typeof (v as { peek?: unknown }).peek === "function"
  );
}

/** True if `arg` carries reactive content (signal or thunk). */
export function isReactive<T>(arg: Arg<T>): boolean {
  return typeof arg === "function" || isSignal(arg);
}

/**
 * Resolve an `Arg<T>` to a `Signal<T>` for use as a shape property.
 *   - Signal → returned as-is (caller's signal becomes the source of truth).
 *   - Thunk  → fresh signal driven by an effect; returns a disposer.
 *   - Value  → fresh signal seeded with that value.
 *   - undefined → fresh signal seeded with `defaultValue`.
 *
 * The disposer (if any) must be tracked by the caller (e.g. via
 * `shape.track`) so reactive bindings stop with the shape.
 */
export function bindArg<T>(
  arg: Arg<T> | undefined,
  defaultValue: T,
): { signal: Signal<T>; dispose?: () => void } {
  if (arg === undefined) return { signal: signal(defaultValue) };
  if (isSignal<T>(arg)) return { signal: arg as Signal<T> };
  if (typeof arg === "function") {
    const fn = arg as () => T;
    const s = signal(fn());
    const dispose = effect(() => {
      s.value = fn();
    });
    return { signal: s, dispose };
  }
  return { signal: signal(arg as T) };
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
