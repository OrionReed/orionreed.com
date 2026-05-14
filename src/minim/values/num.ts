// Num — the reactive scalar number primitive.
//
// Pattern:
//   const Num            — registered struct
//   const num(v)         — factory shorthand
//   Num.Writable         — writable cell type    (was `N`)
//   Num.Readonly         — readonly cell type    (was `DerivedN`)
//   Num.Like             — either flavor
//   Num.Resolve<A>       — per-input narrowing   (was shape.ts `ResolveNum`)
//
// `cell(0)` (raw) returns a plain `Cell<number>` with no rich surface;
// reach for `num(0)` when you want `.to`, ops, behaviors, precision-stop.

import {
  defineStruct,
  type ReadonlyCell,
  type WriteOf,
  type ReadOf,
} from "@minim/signals";

export const Num = defineStruct({
  name: "Num",
  defaults: 0 as number,
  // No `.equals` — Signal's default `!==` reference check handles
  // numbers correctly without the function-call overhead.
  construct: (v: number): number => v,
  // ── Capabilities ────────────────────────────────────────────────
  algebra: {
    add:   (a, b) => a + b,
    sub:   (a, b) => a - b,
    scale: (a, k) => a * k,
  },
  lerp:   (a, b, t) => a + (b - a) * t,
  metric: (a, b) => Math.abs(a - b),
  // ── Extra ops + scalars ────────────────────────────────────────
  ops: {
    clamp: (a, lo: number, hi: number) =>
      a < lo ? lo : a > hi ? hi : a,
    wrap: (a, mod: number) => ((a % mod) + mod) % mod,
  },
  scalars: {
    abs:  (a) => Math.abs(a),
    sign: (a) => Math.sign(a),
  },
});

/** Writable reactive number — same function as `Num.signal`, shorter name. */
export const num = Num.signal;

type IsAny<A> = 0 extends 1 & A ? true : false;

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Num {
  /** Writable reactive number — `Num.signal(v)` return type. */
  export type Writable = WriteOf<typeof Num>;
  /** Read-only reactive number — `Num.derived(...)` return type. */
  export type Readonly = ReadOf<typeof Num>;
  /** Either flavor. */
  export type Like = Writable | Readonly;
  /** Resolve the right reactive Num flavor based on input arg type.
   *  Writable cells / numbers / `undefined` → `Writable`; thunks and
   *  read-only cells → `Readonly`. */
  export type Resolve<A> = IsAny<A> extends true
    ? Like
    : [A] extends [() => number]
      ? Readonly
      : [A] extends [ReadonlyCell<number>]
        ? [A] extends [Writable]
          ? Writable
          : Readonly
        : Writable;
}
