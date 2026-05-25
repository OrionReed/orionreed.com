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
// Type-level constraint vs runtime lookup are separate axes:
//   - At the type level, `Traits<T, K>` requires the instance to
//     carry a phantom `_t` slot typed against the per-class
//     `static traits` dict. Each value class adds one line:
//       `declare readonly _t: typeof Vec.traits;`
//   - At runtime, `requireLinear` (and siblings) walks
//     `s.constructor.traits.linear` once per animator setup. Equality
//     is resolved to a per-instance `_equals` slot at construction
//     so the write hot path stays a single field read.

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

// ─── The one nominal constraint type ─────────────────────────────────

/** "A reactive whose class declares the listed traits."
 *
 *  Use inline at call sites:
 *
 *      function spring<T>(sig: Traits<T, "linear" | "metric">, target: Val<T>)
 *      function tween<T>(sig: Traits<T, "lerp">, target: T, dur: Val<number>)
 *      function attract<T>(sig: Traits<T, "linear">, target: Val<T>, k?: number)
 *
 *  Constraint shape: `_t` is a phantom slot per value class, typed
 *  against `typeof Cls.traits`. Listed keys must resolve to non-null
 *  trait values; unlisted keys may or may not be present.
 *
 *  Pure constraint — does not require `Signal<T>` directly; consumers
 *  intersect with `WritableOf<T>` / `Read<T>` / etc. for capability. */
export type Traits<T, K extends TraitKey = never> = {
  readonly _t: { [P in K]-?: NonNullable<TraitDict<T>[P]> } & TraitDict<T>;
};

// ─── Runtime lookup helpers ──────────────────────────────────────────

/** Class-level traits dictionary for any Signal subclass. */
const dictOf = <T>(s: object): TraitDict<T> =>
  ((s as { constructor?: { traits?: TraitDict<T> } }).constructor?.traits) ?? {};

const className = (s: object): string =>
  ((s as { constructor?: { name?: string } }).constructor?.name) ?? "?";

const missing = (s: object, slot: string): Error =>
  new Error(`require${slot}: ${className(s)} has no traits.${slot.toLowerCase()}`);

// require* helpers — generic over `T` only. The trait constraint lives
// in the parameter type (`Traits<T, "linear">`) so TS infers T from
// the argument and the trait presence is checked structurally.
export function requireLinear<T>(s: Traits<T, "linear">): Linear<T> {
  const v = dictOf<T>(s).linear;
  if (!v) throw missing(s, "Linear");
  return v;
}
export function requireLerp<T>(s: Traits<T, "lerp">): Lerp<T> {
  const v = dictOf<T>(s).lerp;
  if (!v) throw missing(s, "Lerp");
  return v;
}
export function requireMetric<T>(s: Traits<T, "metric">): Metric<T> {
  const v = dictOf<T>(s).metric;
  if (!v) throw missing(s, "Metric");
  return v;
}
export function requireEquals<T>(s: Traits<T, "equals">): Equals<T> {
  const v = dictOf<T>(s).equals;
  if (!v) throw missing(s, "Equals");
  return v;
}
export function requirePack<T>(s: Traits<T, "pack">): Pack<T> {
  const v = dictOf<T>(s).pack;
  if (!v) throw missing(s, "Pack");
  return v;
}
