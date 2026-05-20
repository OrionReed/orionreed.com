// Traits — Rust-ish polymorphic interfaces, declared on the class via a
// single `static traits = { … }` dictionary. No module-augmentation, no
// per-trait Symbol slots, no post-definition installer calls.
//
// Type story:
//   - Each consumer (spring, tween, mean, …) declares the traits it
//     needs as a constraint on its signal parameter:
//       function spring<R extends Reactive<unknown> & HasTraits<{linear, metric}, ValueOf<R>>>(sig: R, …)
//     so missing traits produce a compile error.
//   - At runtime, `requireLinear(sig)` reads `sig.constructor.traits.linear`
//     (one extra property load vs the old symbol lookup; cold-path).
//   - `traits.equals` interacts with the per-instance `opts.equals`
//     override: per-instance wins, then class, then `===` default.

import type { Reactive, Read, ValueOf } from "./reactive";
// `Reactive` is referenced in TSDoc only; needed for the import to stick.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _ = Reactive<unknown>;

// ─── Primitive shapes ────────────────────────────────────────────────

export interface Linear<T> {
  add(a: T, b: T): T;
  sub(a: T, b: T): T;
  scale(a: T, k: number): T;
}
export type Lerp<T>   = (a: T, b: T, t: number) => T;
export type Metric<T> = (a: T, b: T) => number;
export type Equals<T> = (a: T, b: T) => boolean;

// ─── Trait dictionary ────────────────────────────────────────────────

/** The shape of a class's `static traits` dictionary. All optional —
 *  consumers declare what they need at the call site via `HasTraits`. */
export interface Traits<T> {
  linear?: Linear<T>;
  lerp?: Lerp<T>;
  metric?: Metric<T>;
  equals?: Equals<T>;
}

// ─── Nominal type-level "implements" constraints ─────────────────────

/** Constrain a class to declare a specific set of traits. Use at
 *  call-site:
 *
 *      function spring<R extends Reactive<unknown> &
 *        HasTraits<{ linear: true; metric: true }, ValueOf<R>>>(sig: R) { … }
 *
 *  Keys you don't list stay optional. `true` means "must be present"
 *  for that trait. */
export type HasTraits<K extends { [k in keyof Traits<T>]?: true }, T> = {
  readonly constructor: {
    readonly traits: {
      [P in keyof K]: P extends keyof Traits<T>
        ? K[P] extends true ? NonNullable<Traits<T>[P]> : never
        : never;
    } & Traits<T>;
  };
};

/** Convenience aliases for the common single-trait constraints. */
export type HasLinear<T> = HasTraits<{ linear: true }, T>;
export type HasLerp<T>   = HasTraits<{ lerp: true }, T>;
export type HasMetric<T> = HasTraits<{ metric: true }, T>;
export type HasEquals<T> = HasTraits<{ equals: true }, T>;

// ─── Runtime lookup helpers ──────────────────────────────────────────

/** Class-level traits dictionary for any Reactive subclass. */
const traitsOf = <T>(s: Read<T>): Traits<T> =>
  (((s as object).constructor as { traits?: Traits<T> }).traits) ?? {};

export const linearOf = <R extends Read<unknown>>(s: R): Linear<ValueOf<R>> | undefined =>
  traitsOf<ValueOf<R>>(s as unknown as Read<ValueOf<R>>).linear;
export const lerpOf = <R extends Read<unknown>>(s: R): Lerp<ValueOf<R>> | undefined =>
  traitsOf<ValueOf<R>>(s as unknown as Read<ValueOf<R>>).lerp;
export const metricOf = <R extends Read<unknown>>(s: R): Metric<ValueOf<R>> | undefined =>
  traitsOf<ValueOf<R>>(s as unknown as Read<ValueOf<R>>).metric;
export const equalsOf = <R extends Read<unknown>>(s: R): Equals<ValueOf<R>> | undefined =>
  traitsOf<ValueOf<R>>(s as unknown as Read<ValueOf<R>>).equals;

const missing = <T>(s: Read<T>, slot: string): Error =>
  new Error(`require${slot}: ${classOf(s).name} has no traits.${slot.toLowerCase()}`);

export function requireLinear<R extends Read<unknown> & HasLinear<ValueOf<R>>>(s: R): Linear<ValueOf<R>> {
  const v = linearOf(s); if (!v) throw missing(s, "Linear"); return v;
}
export function requireLerp<R extends Read<unknown> & HasLerp<ValueOf<R>>>(s: R): Lerp<ValueOf<R>> {
  const v = lerpOf(s); if (!v) throw missing(s, "Lerp"); return v;
}
export function requireMetric<R extends Read<unknown> & HasMetric<ValueOf<R>>>(s: R): Metric<ValueOf<R>> {
  const v = metricOf(s); if (!v) throw missing(s, "Metric"); return v;
}
export function requireEquals<R extends Read<unknown> & HasEquals<ValueOf<R>>>(s: R): Equals<ValueOf<R>> {
  const v = equalsOf(s); if (!v) throw missing(s, "Equals"); return v;
}

export interface ValueClass<T = unknown> {
  new (...args: never[]): Reactive<T>;
  readonly name: string;
  readonly traits: Traits<T>;
}

export function classOf<T>(s: Read<T>): ValueClass<T> {
  return (s as object).constructor as ValueClass<T>;
}
