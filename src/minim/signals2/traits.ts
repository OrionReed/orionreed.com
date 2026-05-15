// traits.ts — typed, extensible trait interfaces.
//
// `CommonTraits<T>` is the open registry of standard trait shapes
// every struct framework provides. Users extend it via declaration
// merging in their own modules:
//
//     // someUserModule.ts
//     declare module "minim/signals2/traits" {
//       interface CommonTraits<T> {
//         serialize?(v: T): string;
//         parse?(s: string): T;
//       }
//     }
//
// Then `Vec.traits.serialize` is typed without changing minim.
//
// Generic functions (in generics.ts or user code) write against these
// interfaces: `function mean<T>(...cells: { constructor: { traits: { linear: Linear<T> } } }[])`.

/** Additive group with a scalar action. The "vector space over ℝ"
 *  trait used by mean/spring/oscillate/drift. */
export interface Linear<T> {
  add(a: T, b: T): T;
  sub(a: T, b: T): T;
  scale(a: T, k: number): T;
}

/** Linear interpolation between two values. */
export type Lerp<T> = (a: T, b: T, t: number) => T;

/** Distance / norm between two values. Non-negative; metric axioms. */
export type Metric<T> = (a: T, b: T) => number;

/** Value-level equality, used for change detection on whole-value writes. */
export type Equals<T> = (a: T, b: T) => boolean;

/** Open registry of well-known trait names. Extend via declaration merging. */
export interface CommonTraits<T> {
  linear?: Linear<T>;
  lerp?: Lerp<T>;
  metric?: Metric<T>;
  equals?: Equals<T>;
}
