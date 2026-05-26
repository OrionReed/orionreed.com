// Traits — polymorphic interfaces declared on the class via a single
// `static traits = { … }` dictionary. One nominal constraint type
// (`Traits<T, K>`) covers any combination of required traits via a
// string union of keys; no per-trait alias proliferation.
//
//   function spring<T>(sig: Traits<T, "linear" | "metric">, target: Val<T>) …
//   function tween<T>(sig: Traits<T, "lerp">, target: T, dur: Val<number>) …
//
// Naming note: the *dictionary shape* (what subclasses fill into
// their `static traits = {…}`) is `TraitDict<T>` to free up the
// public `Traits<T, K>` name for the constraint, which is what
// consumers see far more often.
//
// Constraint vs runtime lookup are separate axes:
//   - At the type level, `Traits<T, K>` requires the instance to
//     carry a phantom `_t` slot typed against the class's static
//     traits. Each value class declares it co-located with the
//     dictionary: `declare readonly _t: typeof Vec.traits`.
//   - At runtime, `requireLinear` (and siblings) walks
//     `s.constructor.traits.linear` once per animator setup.
//
// The engine itself (signal.ts) is trait-ignorant: it never reads
// `traits.equals`. Subclasses thread their equality through
// `super(v, { equals })` in their own constructor.

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

/** 2-D group-action structure: rotation + uniform scale about a pivot
 *  point. Required by closed-form aggregate lenses that need to
 *  "rotate the cluster about its centroid" / "scale the cluster about
 *  a handle" etc.
 *
 *  Implementation is per-value-class so geometric value types (Vec,
 *  Pose, …) define their own semantics — e.g., Pose rotates its
 *  position AND increments its orientation; Vec only rotates its
 *  position. The pivot is always a 2-D position (any `{x, y}` shape),
 *  regardless of T's full structure.
 *
 *  Caller threads dθ (signed angle delta) and k (signed scalar);
 *  k < 0 reflects, dθ ∈ ℝ wraps naturally. No constraints. */
export interface Pivotal<T> {
  rotateAbout(value: T, pivot: { x: number; y: number }, dθ: number): T;
  scaleAbout(value: T, pivot: { x: number; y: number }, k: number): T;
}

// ─── (Sketch) Differentiable trait — future work ────────────────────
//
// `Differentiable<I, O>` would declare an analytical Jacobian for a
// forward map `I → O`. Used by `factor()` to skip FD evaluations
// (faster + machine-precise).
//
// Open design questions:
//
//   1. Per-class trait, or per-method? A type-level trait says "Vec
//      knows how to differentiate operations on itself"; a method-
//      level one says "this specific `.add(k)` returns a Jacobian
//      row." The latter integrates better with the value-class
//      invertible-method pattern (`Num.add(k)` already has a known
//      analytical inverse — its analytical derivative is also known).
//
//   2. Composition: if every invertible returns its Jacobian,
//      `Num.add(1).scale(2)` composes via the chain rule. That's
//      effectively forward-mode autodiff over the closed-form
//      lens algebra. Likely a 50-line library on top of the existing
//      method-returns-`this` pattern.
//
//   3. Storage: where does the Jacobian live? On `_fusedOf` alongside
//      `fwd`/`bwd`? A separate companion field?
//
// Deferred until we have a use case that actively wants it — for now
// `factor()` accepts a user-supplied `jacobian` callback as opt-in.
//
// interface Differentiable<I, O> {
//   jacobian(input: I): readonly (readonly number[])[];
// }

// ─── Trait dictionary ────────────────────────────────────────────────

/** Shape of a value class's `static traits` dict. Subclasses fill the
 *  subset they implement; consumers constrain on `Traits<T, …keys>`. */
export interface TraitDict<T> {
  linear?: Linear<T>;
  lerp?: Lerp<T>;
  metric?: Metric<T>;
  equals?: Equals<T>;
  pack?: Pack<T>;
  pivotal?: Pivotal<T>;
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
 *
 *  Constraint shape: `_t` is a phantom slot on each value class,
 *  typed against `typeof Cls.traits` (declared via the class's
 *  interface augmentation). Listed keys must resolve to non-null
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
  (s as { constructor?: { traits?: TraitDict<T> } }).constructor?.traits ?? {};

const className = (s: object): string =>
  (s as { constructor?: { name?: string } }).constructor?.name ?? "?";

const missing = (s: object, slot: string): Error =>
  new Error(`require${slot}: ${className(s)} has no traits.${slot.toLowerCase()}`);

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
export function requirePivotal<T>(s: Traits<T, "pivotal">): Pivotal<T> {
  const v = dictOf<T>(s).pivotal;
  if (!v) throw missing(s, "Pivotal");
  return v;
}
