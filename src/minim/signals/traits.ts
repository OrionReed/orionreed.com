// traits.ts — generic dispatch via prototype-stamped Symbol slots.
//
// A trait is a function (or bag) attached to a value-type's prototype:
//
//   Vec.prototype[LINEAR] = { add: vAdd, sub: vSub, scale: vScale };
//
// Reads walk the prototype chain (`v[LINEAR]`); per-instance writes
// shadow the class slot. Symbol.for makes the slot identity shared
// across realms so plugins can stamp third-party types without coupling.
//
// New traits: `export const X = Symbol.for("minim.x")` + module-augment
// `Signal<T>` to add `[X]?: ...`.

import type { Signal, Read } from "./signal";

// ════════════════════════════════════════════════════════════════════
// Trait shapes
// ════════════════════════════════════════════════════════════════════

export interface Linear<T> {
  add(a: T, b: T): T;
  sub(a: T, b: T): T;
  scale(a: T, k: number): T;
}
export type Lerp<T>   = (a: T, b: T, t: number) => T;
export type Metric<T> = (a: T, b: T) => number;
export type Equals<T> = (a: T, b: T) => boolean;

// ════════════════════════════════════════════════════════════════════
// Slot symbols + type-level slot declaration
// ════════════════════════════════════════════════════════════════════

export const LINEAR = Symbol.for("minim.linear");
export const LERP   = Symbol.for("minim.lerp");
export const METRIC = Symbol.for("minim.metric");
export const EQUALS = Symbol.for("minim.equals");

declare module "./signal" {
  interface Signal<T> {
    [LINEAR]?: Linear<T>;
    [LERP]?:   Lerp<T>;
    [METRIC]?: Metric<T>;
    [EQUALS]?: Equals<T>;
  }
}

// ════════════════════════════════════════════════════════════════════
// Inspection
// ════════════════════════════════════════════════════════════════════

export interface ValueClass<T = unknown> {
  new (...args: never[]): Signal<T>;
  readonly name: string;
}

export function classOf<T>(s: Read<T>): ValueClass<T> {
  return (s as object).constructor as ValueClass<T>;
}

// ════════════════════════════════════════════════════════════════════
// Per-trait accessors
//
//   xOf(s)      → Slot | undefined  (optional-trait code paths)
//   requireX(s) → Slot              (throws if missing)
//
// Parameters typed `Read<T>` (covariant) so subclass-T cells flow
// through; slots live on the `Signal` prototype, accessed structurally.
// ════════════════════════════════════════════════════════════════════

export const linearOf = <T>(s: Read<T>): Linear<T> | undefined => (s as Signal<T>)[LINEAR];
export const lerpOf   = <T>(s: Read<T>): Lerp<T>   | undefined => (s as Signal<T>)[LERP];
export const metricOf = <T>(s: Read<T>): Metric<T> | undefined => (s as Signal<T>)[METRIC];
export const equalsOf = <T>(s: Read<T>): Equals<T> | undefined => (s as Signal<T>)[EQUALS];

const missing = <T>(s: Read<T>, slot: string): Error =>
  new Error(`require${slot}: ${classOf(s).name} has no [${slot}] slot`);

export function requireLinear<T>(s: Read<T>): Linear<T> {
  const v = linearOf(s); if (!v) throw missing(s, "Linear"); return v;
}
export function requireLerp<T>(s: Read<T>): Lerp<T> {
  const v = lerpOf(s); if (!v) throw missing(s, "Lerp"); return v;
}
export function requireMetric<T>(s: Read<T>): Metric<T> {
  const v = metricOf(s); if (!v) throw missing(s, "Metric"); return v;
}
export function requireEquals<T>(s: Read<T>): Equals<T> {
  const v = equalsOf(s); if (!v) throw missing(s, "Equals"); return v;
}
