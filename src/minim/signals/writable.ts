// writable.ts — `Writable<R>` as a generic modifier.
//
// Value classes are RO at the public type level (interface merge of
// `get value(): V`). Factories return `Writable<R>` to expose the
// writable surface AND brand the result so animator-style structural
// constraints reject bare RO values.
//
// Extensibility: `Writable<R>` works for ANY value class that
// declares `static invertibles = [...]` and field-lens getters typed
// as `Read<unknown>`. No per-class registry — `LiftField<X>`
// recursively applies `Writable<X>` to any Read-shaped field.

import { type Read, type WritableBrand } from "./signal";

// ─── Writers surface (internal) ───────────────────────────────────

interface Writers<T> {
  value: T;
  set(v: T | (() => T) | Read<T>): unknown;
  bind(s: T | (() => T) | Read<T>): () => void;
}

// ─── Type-level dispatch ──────────────────────────────────────────

/** Pick keys whose value is `Read<unknown>` (i.e. a field lens). */
type LensFields<R> = Exclude<
  { [K in keyof R]: R[K] extends Read<unknown> ? K : never }[keyof R],
  undefined
>;

/** Lift any Read<unknown>-shaped field to its writable form.
 *  Recursive: a Vec field gets fully lifted to Writable<Vec> (which
 *  has its own LensFields lifted in turn). No per-class registry —
 *  the same `Writable<X>` modifier handles any value class that
 *  declares its invertibles + field-lens getters.
 *
 *  Non-Read fields pass through unchanged. */
type LiftField<X> = X extends Read<unknown> ? Writable<X> : X;

/** Extract invertible method names from `static invertibles = [...] as const`. */
type InvOf<R> =
    R extends { readonly constructor: { readonly invertibles: infer I } }
      ? I extends readonly (keyof R)[] ? I[number] : never
      : never;

// ─── Public surface ───────────────────────────────────────────────

/** "R, but writable." Generic modifier — works on any value class
 *  that declares `static invertibles = [...] as const`.
 *
 *  Lifts invertible methods so chains stay writable, lifts field
 *  lenses to their own writable forms, and adds the writable surface
 *  (`.value`/`.set`/`.bind`) plus a nominal brand.
 *
 *  Note: we INTERSECT rather than Omit-then-add for invertibles and
 *  fields. The intersection of `(...) => Num` and `(...) => Writable<Num>`
 *  is `(...) => Writable<Num>` (the writable form is a subtype). This
 *  preserves R's full structural shape so `this: R & WritableBrand`
 *  constraints on inherited methods still match. */
export type Writable<R> =
  Omit<R, "value" | InvOf<R> | LensFields<R>>
  & Writers<R extends Read<infer T> ? T : never>
  & WritableBrand
  & { [K in InvOf<R>]: R[K] extends (...a: infer A) => R ? (...a: A) => Writable<R> : R[K] }
  & { [K in LensFields<R>]: LiftField<R[K]> };

/** T-anchored constraint for animator-style parameters:
 *
 *      function spring<T>(s: WritableOf<T> & Traits<T, "linear" | "metric">, target: T)
 *
 *  Satisfied by `Writable<Num>` / `Writable<Vec>` / any factory-
 *  returned writable signal. Bare RO value classes are rejected
 *  because they lack the brand. */
export interface WritableOf<T> extends WritableBrand {
  value: T;
  set(v: T | (() => T) | Read<T>): unknown;
  bind(s: T | (() => T) | Read<T>): () => void;
  peek(): T;
}

// ─── Author-side: declaring invertibles ──────────────────────────

/** Helper for declaring `static invertibles` with literal narrowing
 *  AND a compile-time check that each listed key is actually a method
 *  on R whose return type is R (the invertible-chain shape).
 *
 *      class Vec extends Signal<V> {
 *        static invertibles = invertibles<Vec>()("add", "sub", "scale", "offset");
 *      }
 *
 *  Forgetting `as const` is no longer possible; typos / non-invertible
 *  method names fail at the call site. The curried form lets us anchor
 *  R first so the second-arg key check has full inference. */
export function invertibles<R>(): <K extends ReadonlyArray<
  { [P in keyof R]: R[P] extends (...args: never[]) => R ? P : never }[keyof R]
>>(...keys: K) => K {
  return ((...keys: readonly unknown[]) => keys) as never;
}
