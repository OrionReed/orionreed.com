// Generic dispatch via prototype-stamped `Symbol.for` slots; per-instance
// writes shadow the class slot. New traits: declare a symbol + augment
// the `Signal<T>` interface below.

import type { Signal, Read } from "./signal";

export interface Linear<T> {
  add(a: T, b: T): T;
  sub(a: T, b: T): T;
  scale(a: T, k: number): T;
}
export type Lerp<T>   = (a: T, b: T, t: number) => T;
export type Metric<T> = (a: T, b: T) => number;
export type Equals<T> = (a: T, b: T) => boolean;

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

export interface ValueClass<T = unknown> {
  new (...args: never[]): Signal<T>;
  readonly name: string;
}

export function classOf<T>(s: Read<T>): ValueClass<T> {
  return (s as object).constructor as ValueClass<T>;
}

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
