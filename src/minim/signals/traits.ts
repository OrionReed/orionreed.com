// Trait slots — module-local Symbols (not Symbol.for) so registry
// collisions across libraries are impossible. Value classes declare
// trait slots directly on their prototype (no `defineTrait` registration).

import type { Signal, Read } from "./signal";

export interface Linear<T> {
  add(a: T, b: T): T;
  sub(a: T, b: T): T;
  scale(a: T, k: number): T;
}
export type Lerp<T>   = (a: T, b: T, t: number) => T;
export type Metric<T> = (a: T, b: T) => number;
export type Equals<T> = (a: T, b: T) => boolean;

export const LINEAR = Symbol("linear");
export const LERP   = Symbol("lerp");
export const METRIC = Symbol("metric");
export const EQUALS = Symbol("equals");

declare module "./signal" {
  interface Signal<T> {
    [LINEAR]?: Linear<T>;
    // Trait slots may be implemented as methods (`[LERP](a,b,t) {...}`)
    // or property-of-function (`[LERP] = lerp`). Use method-shape so
    // subclasses can declare with class-method syntax without variance
    // errors.
    [LERP]?(a: T, b: T, t: number): T;
    [METRIC]?(a: T, b: T): number;
    [EQUALS]?(a: T, b: T): boolean;
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
