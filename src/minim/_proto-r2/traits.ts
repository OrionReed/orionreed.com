// Trait slots — module-local Symbols (not Symbol.for) so registry
// collisions across libraries are impossible. Value classes declare
// trait slots directly on their prototype.
//
// Unchanged shape from production minim, retargeted at Reactive<T>.

import type { Reactive, Read } from "./reactive";

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

declare module "./reactive" {
  interface Reactive<T> {
    [LINEAR]?: Linear<T>;
    [LERP]?(a: T, b: T, t: number): T;
    [METRIC]?(a: T, b: T): number;
    [EQUALS]?(a: T, b: T): boolean;
  }
}

export interface ValueClass<T = unknown> {
  new (...args: never[]): Reactive<T>;
  readonly name: string;
}

export function classOf<T>(s: Read<T>): ValueClass<T> {
  return (s as object).constructor as ValueClass<T>;
}

export const linearOf = <T>(s: Read<T>): Linear<T> | undefined => (s as Reactive<T>)[LINEAR];
export const lerpOf   = <T>(s: Read<T>): Lerp<T>   | undefined => (s as Reactive<T>)[LERP];
export const metricOf = <T>(s: Read<T>): Metric<T> | undefined => (s as Reactive<T>)[METRIC];
export const equalsOf = <T>(s: Read<T>): Equals<T> | undefined => (s as Reactive<T>)[EQUALS];

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
