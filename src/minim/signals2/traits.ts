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

import type { Signal } from "./signal";

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

export function classOf<T>(s: Signal<T>): ValueClass<T> {
  return s.constructor as ValueClass<T>;
}

// ════════════════════════════════════════════════════════════════════
// Per-trait accessors
//
//   xOf(s)      → Slot | undefined  (optional-trait code paths)
//   requireX(s) → Slot              (throws if missing)
// ════════════════════════════════════════════════════════════════════

export const linearOf = <T>(s: Signal<T>): Linear<T> | undefined => s[LINEAR];
export const lerpOf   = <T>(s: Signal<T>): Lerp<T>   | undefined => s[LERP];
export const metricOf = <T>(s: Signal<T>): Metric<T> | undefined => s[METRIC];
export const equalsOf = <T>(s: Signal<T>): Equals<T> | undefined => s[EQUALS];

const missing = <T>(s: Signal<T>, slot: string): Error =>
  new Error(`require${slot}: ${classOf(s).name} has no [${slot}] slot`);

export function requireLinear<T>(s: Signal<T>): Linear<T> {
  const v = s[LINEAR]; if (!v) throw missing(s, "Linear"); return v;
}
export function requireLerp<T>(s: Signal<T>): Lerp<T> {
  const v = s[LERP]; if (!v) throw missing(s, "Lerp"); return v;
}
export function requireMetric<T>(s: Signal<T>): Metric<T> {
  const v = s[METRIC]; if (!v) throw missing(s, "Metric"); return v;
}
export function requireEquals<T>(s: Signal<T>): Equals<T> {
  const v = s[EQUALS]; if (!v) throw missing(s, "Equals"); return v;
}
