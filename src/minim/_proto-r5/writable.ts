// writable.ts — `Writable<R>` as a generic modifier.
//
// Value classes are RO at the public type level (interface merge of
// `get value(): V`). Factories return `Writable<R>` to expose the
// writable surface AND brand the result so animator-style structural
// constraints reject bare RO values.

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

/** Map a base value type to its writable form. Extend per value class.
 *  (The recursive imports here form a cycle with the value modules;
 *  TS resolves them lazily at type-check time, no runtime issue.) */
type LiftField<X> =
    X extends import("./values/num").Num       ? Writable<import("./values/num").Num>
  : X extends import("./values/vec").Vec       ? Writable<import("./values/vec").Vec>
  : X extends import("./values/box").Box       ? Writable<import("./values/box").Box>
  : X extends import("./values/transform").Transform ? Writable<import("./values/transform").Transform>
  : X extends Read<infer T>                    ? Read<T> & Writers<T>
  : X;

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
