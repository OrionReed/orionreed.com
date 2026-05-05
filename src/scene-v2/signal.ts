// Reactivity is delegated to @preact/signals-core. We re-export what we
// use and add helpers to normalize the value | signal | thunk pattern.

export {
  signal,
  computed,
  effect,
  batch,
  untracked,
  Signal,
  type ReadonlySignal,
} from "@preact/signals-core";

import { signal, effect, Signal } from "@preact/signals-core";
import type { ReadonlySignal } from "@preact/signals-core";

export type Arg<T> = T | Signal<T> | ReadonlySignal<T> | (() => T);

export const isSignal = <T>(v: unknown): v is Signal<T> | ReadonlySignal<T> =>
  v instanceof Signal;

export const isReactive = <T>(arg: Arg<T>): boolean =>
  typeof arg === "function" || isSignal(arg);

/** Resolve an `Arg<T>` to a `Signal<T>`. Signal → returned as-is (caller
 *  owns it); thunk → fresh signal driven by an effect; value → fresh
 *  signal seeded. The returned `dispose` (if any) must be tracked. */
export function bindArg<T>(
  arg: Arg<T> | undefined,
  defaultValue: T,
): { signal: Signal<T>; dispose?: () => void } {
  if (arg === undefined) return { signal: signal(defaultValue) };
  if (isSignal<T>(arg)) return { signal: arg as Signal<T> };
  if (typeof arg === "function") {
    const fn = arg as () => T;
    const s = signal(fn());
    return { signal: s, dispose: effect(() => { s.value = fn(); }) };
  }
  return { signal: signal(arg as T) };
}

/** Normalize an `Arg<T>` to a thunk that tracks signals it reads. */
export function read<T>(v: Arg<T>): () => T {
  if (isSignal<T>(v)) return () => v.value;
  if (typeof v === "function") return v as () => T;
  return () => v as T;
}

/** One-shot read — current value, no tracking. */
export function unwrap<T>(v: Arg<T>): T {
  if (isSignal<T>(v)) return v.value;
  if (typeof v === "function") return (v as () => T)();
  return v as T;
}
