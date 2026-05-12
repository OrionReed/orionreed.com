// Lens combinators — small generic vocabulary built on top of the
// `lens(read, write)` primitive in core/signal.ts.
//
// These are used internally by the struct framework (axis projections
// are `prop`; aggregates are `combine`) and exposed for users who want
// to build their own writable views.
//
// All combinators return `Signal<T>`. To get a richer Reactive<T>
// surface (with op methods), wrap the result via `Vec.lens(...)` or
// equivalent.

import { lens, type Signal } from "../core/signal";

/** Project a field of a struct signal as a writable signal.
 *  Reads return `parent.value[k]`; writes round-trip through the
 *  parent with the field replaced. */
export function prop<S, K extends keyof S>(
  parent: Signal<S>,
  k: K,
): Signal<S[K]> {
  return lens(
    () => parent.value[k],
    (v) => {
      parent.value = { ...parent.peek(), [k]: v } as S;
    },
  );
}

/** Index into an array signal. Writes replace the element at `i`. */
export function at<T>(parent: Signal<readonly T[]>, i: number): Signal<T> {
  return lens(
    () => parent.value[i],
    (v) => {
      const cur = parent.peek().slice();
      cur[i] = v;
      parent.value = cur;
    },
  );
}

/** Bijective view (e.g., polar ⇄ cartesian, °C ⇄ °F). */
export function iso<A, B>(
  parent: Signal<A>,
  forward: (a: A) => B,
  back: (b: B) => A,
): Signal<B> {
  return lens(
    () => forward(parent.value),
    (b) => {
      parent.value = back(b);
    },
  );
}

/** N-to-1 combinator. Reads merge inputs; writes distribute the change.
 *  This is the engine behind `meanVec`, `meanRotation`, `centroid` —
 *  all of which become 1-2 line factories over `combine`. */
export function combine<T>(
  parts: readonly Signal<T>[],
  merge: (vs: readonly T[]) => T,
  distribute: (next: T, prev: readonly T[]) => readonly T[],
): Signal<T> {
  return lens(
    () => merge(parts.map((p) => p.value)),
    (next) => {
      const prev = parts.map((p) => p.peek());
      const updated = distribute(next, prev);
      for (let i = 0; i < parts.length; i++) {
        parts[i].value = updated[i];
      }
    },
  );
}
