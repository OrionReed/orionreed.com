// Traits — polymorphic interfaces declared on the class via a single
// `static traits = { … }` dictionary, with one nominal constraint
// type (`Traits<T, K>`) gating animator/combinator inputs.
//
// Identical in spirit to the r2 design; only the `Read<T>` import
// moves over to the new engine module.

import { type Node, type Read, type Of } from "./node";

// ─── Primitive trait shapes ──────────────────────────────────────────

export interface Linear<T> {
  add(a: T, b: T): T;
  sub(a: T, b: T): T;
  scale(a: T, k: number): T;
}
export type Lerp<T>   = (a: T, b: T, t: number) => T;
export type Metric<T> = (a: T, b: T) => number;
export type Equals<T> = (a: T, b: T) => boolean;

// ─── Dictionary shape ────────────────────────────────────────────────

export interface TraitDict<T> {
  linear?: Linear<T>;
  lerp?: Lerp<T>;
  metric?: Metric<T>;
  equals?: Equals<T>;
}
export type TraitKey = keyof TraitDict<unknown>;

// ─── The one nominal constraint ──────────────────────────────────────

/** "A `Node<T>` whose class declares the listed traits." */
export type Traits<T, K extends TraitKey = never> = Node<T> & {
  readonly constructor: {
    readonly traits: { [P in K]-?: NonNullable<TraitDict<T>[P]> } & TraitDict<T>;
  };
};

// ─── Lookup helpers ──────────────────────────────────────────────────

const dictOf = <T>(s: Read<T>): TraitDict<T> =>
  (((s as object).constructor as { traits?: TraitDict<T> }).traits) ?? {};

export const linearOf = <R extends Read<unknown>>(s: R): Linear<Of<R>> | undefined =>
  dictOf<Of<R>>(s as unknown as Read<Of<R>>).linear;
export const lerpOf = <R extends Read<unknown>>(s: R): Lerp<Of<R>> | undefined =>
  dictOf<Of<R>>(s as unknown as Read<Of<R>>).lerp;
export const metricOf = <R extends Read<unknown>>(s: R): Metric<Of<R>> | undefined =>
  dictOf<Of<R>>(s as unknown as Read<Of<R>>).metric;
export const equalsOf = <R extends Read<unknown>>(s: R): Equals<Of<R>> | undefined =>
  dictOf<Of<R>>(s as unknown as Read<Of<R>>).equals;

const className = (s: object): string =>
  (s.constructor as { name?: string }).name ?? "?";
const missing = (s: object, slot: string): Error =>
  new Error(`require${slot}: ${className(s)} has no traits.${slot.toLowerCase()}`);

export function requireLinear<T>(s: Traits<T, "linear">): Linear<T> {
  const v = dictOf<T>(s).linear; if (!v) throw missing(s, "Linear"); return v;
}
export function requireLerp<T>(s: Traits<T, "lerp">): Lerp<T> {
  const v = dictOf<T>(s).lerp; if (!v) throw missing(s, "Lerp"); return v;
}
export function requireMetric<T>(s: Traits<T, "metric">): Metric<T> {
  const v = dictOf<T>(s).metric; if (!v) throw missing(s, "Metric"); return v;
}
export function requireEquals<T>(s: Traits<T, "equals">): Equals<T> {
  const v = dictOf<T>(s).equals; if (!v) throw missing(s, "Equals"); return v;
}
