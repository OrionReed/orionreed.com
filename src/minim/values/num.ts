// Num — the reactive number primitive, declared via the struct
// framework. `num(0)` is the canonical writable scalar cell with
// `.to(target, dur)` (via [LERP]) and behaviors (via [ALGEBRA]).
//
// `cell(0)` (raw) returns a plain `Cell<number>` with no rich surface;
// reach for `num(0)` when you want `.to`, `.derive`, ops, behaviors.

import { struct, type WriteOf, type ReadOf } from "./struct";

export const Num = struct<number>("Num", 0)
  .construct((v: number): number => v)
  // No `.equals()` — Signal's default `!==` reference check handles
  // numbers correctly without the function-call overhead.
  .ops({
    add: (a, b: number): number => a + b,
    sub: (a, b: number): number => a - b,
    scale: (a, k: number): number => a * k,
    lerp: (a, b: number, t: number): number => a + (b - a) * t,
    clamp: (a, lo: number, hi: number): number =>
      a < lo ? lo : a > hi ? hi : a,
    wrap: (a, mod: number): number => ((a % mod) + mod) % mod,
  })
  .scalars({
    abs: (a): number => Math.abs(a),
    sign: (a): number => Math.sign(a),
  })
  .build();

/** Writable reactive number — same function as `Num.signal`, shorter name. */
export const num = Num.signal;

/** Writable reactive number — broad rw type. */
export type N = WriteOf<typeof Num>;

/** Read-only reactive number. */
export type DerivedN = ReadOf<typeof Num>;
