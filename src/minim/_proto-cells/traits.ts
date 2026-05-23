// Traits — polymorphic interfaces declared on the class via a single
// `static traits = { … }` dictionary. One nominal constraint type
// (`Traits<T, K>`) covers any combination of required traits via a
// string union of keys; no per-trait alias proliferation.
//
//   function spring<T>(sig: Traits<T, "linear" | "metric">, target: Val<T>) …
//   function tween<T>(sig: Traits<T, "lerp">, target: T, dur: Val<number>) …
//   function mean<R extends Read<unknown>>(
//     first: R & Traits<Of<R>, "linear">, …) …
//
// The inline form reads as a sentence and there's only one type to
// learn. Naming note: the *dictionary shape* (what subclasses fill
// into their `static traits = {…}`) is `TraitDict<T>` to free up the
// public `Traits<T, K>` name for the constraint, which is what
// consumers see far more often.
//
// Lookup helper `requireLinear` (and siblings) read class-level
// `s.constructor.traits.linear` once per animator setup; equality is
// resolved to a per-instance `_equals` slot at construction so the
// write hot path stays a single field read.

import type { Of, Read, Signal } from "./signal";

// ─── Primitive trait shapes ──────────────────────────────────────────

export interface Linear<T> {
  add(a: T, b: T): T;
  sub(a: T, b: T): T;
  scale(a: T, k: number): T;
}
export type Lerp<T> = (a: T, b: T, t: number) => T;
export type Metric<T> = (a: T, b: T) => number;
export type Equals<T> = (a: T, b: T) => boolean;

/** A flat-buffer codec for a value type. Used by numerical engines
 *  (constraint solvers, vectorised computations) that need to view
 *  a typed value as a `dim`-sized slice of a shared `Float64Array`.
 *
 *  Read/write by offset into the buffer to avoid object allocations
 *  in hot loops. */
export interface Pack<T> {
  readonly dim: number;
  read(value: T, into: Float64Array, offset: number): void;
  write(from: Float64Array, offset: number): T;
}

// ─── Trait dictionary ────────────────────────────────────────────────

/** Shape of a value class's `static traits` dict. Subclasses fill the
 *  subset they implement; consumers constrain on `Traits<T, …keys>`. */
export interface TraitDict<T> {
  linear?: Linear<T>;
  lerp?: Lerp<T>;
  metric?: Metric<T>;
  equals?: Equals<T>;
  pack?: Pack<T>;
}

/** Valid keys of `TraitDict`. The set of declarable traits. */
export type TraitKey = keyof TraitDict<unknown>;

/** Helper for declaring `static traits = …` with the literal trait
 *  subset preserved. `Traits<T, "linear">` then sees the listed slots
 *  as present (non-nullable). Subclasses pick whichever subset they
 *  implement — no `Required<TraitDict<V>>` vs intersection-form
 *  asymmetry needed at the declaration site.
 *
 *  Curried so `T` is explicit at the outer call (anchoring the trait
 *  function signatures to the right value type) while `D` is inferred
 *  from the dict literal at the inner call (preserving the literal
 *  subset). TS doesn't allow partial type-argument application, hence
 *  the two-step shape.
 *
 *      class Vec extends Signal<V> {
 *        static traits = traits<V>()({ linear, lerp, metric, equals });
 *      }
 *      class Matrix extends Signal<V> {
 *        static traits = traits<V>()({ equals });   // sparse — fine
 *      }
 */
export function traits<T>(): <D extends TraitDict<T>>(d: D) => D & TraitDict<T> {
  return d => d;
}

// ─── The one nominal constraint type ─────────────────────────────────

/** "A `Signal<T>` whose class declares the listed traits."
 *
 *  Use inline at call sites:
 *
 *      function spring<T>(sig: Traits<T, "linear" | "metric">, target: Val<T>)
 *      function tween<T>(sig: Traits<T, "lerp">, target: T, dur: Val<number>)
 *      function attract<T>(sig: Traits<T, "linear">, target: Val<T>, k?: number)
 *
 *  Bundles the instance shape (`Signal<T>`) with the class-level
 *  trait constraint (`constructor.traits` contains each listed key).
 *  Replaces per-trait aliases (`HasLinear`, …) AND per-consumer
 *  aliases (`SpringTarget`, …) with a single, composable type. */
/** "A reactive whose class declares the listed traits."
 *  Pure constraint — does not require `Signal<T>` directly; consumers
 *  intersect with `WritableOf<T>` / `Read<T>` / etc. for capability. */
export type Traits<T, K extends TraitKey = never> = {
  readonly constructor: {
    readonly traits: { [P in K]-?: NonNullable<TraitDict<T>[P]> } & TraitDict<T>;
  };
};

// ─── Runtime lookup helpers ──────────────────────────────────────────

/** Class-level traits dictionary for any Signal subclass. */
const dictOf = <T>(s: Read<T>): TraitDict<T> =>
  ((s as object).constructor as { traits?: TraitDict<T> }).traits ?? {};

const className = (s: object): string => (s.constructor as { name?: string }).name ?? "?";

const missing = (s: object, slot: string): Error =>
  new Error(`require${slot}: ${className(s)} has no traits.${slot.toLowerCase()}`);

// require* helpers — generic over `T` only. The trait constraint lives
// in the parameter type (`Traits<T, "linear">`) so TS infers T from
// the argument and the trait presence is checked structurally.
export function requireLinear<T>(s: Traits<T, "linear">): Linear<T> {
  const v = dictOf<T>(s as unknown as Read<T>).linear;
  if (!v) throw missing(s, "Linear");
  return v;
}
export function requireLerp<T>(s: Traits<T, "lerp">): Lerp<T> {
  const v = dictOf<T>(s as unknown as Read<T>).lerp;
  if (!v) throw missing(s, "Lerp");
  return v;
}
export function requireMetric<T>(s: Traits<T, "metric">): Metric<T> {
  const v = dictOf<T>(s as unknown as Read<T>).metric;
  if (!v) throw missing(s, "Metric");
  return v;
}
export function requireEquals<T>(s: Traits<T, "equals">): Equals<T> {
  const v = dictOf<T>(s as unknown as Read<T>).equals;
  if (!v) throw missing(s, "Equals");
  return v;
}
export function requirePack<T>(s: Traits<T, "pack">): Pack<T> {
  const v = dictOf<T>(s as unknown as Read<T>).pack;
  if (!v) throw missing(s, "Pack");
  return v;
}
