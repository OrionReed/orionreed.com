// writable.ts (spike) — three primitives:
//
//   Writable<R>      — registry lookup: "the writable form of R".
//                      Each class declares `_writable: Foo_W` phantom.
//                      Single hop, no recursion.
//
//   Inherits<R, T>   — `T` polymorphic over `R`'s writability. Returns
//                      `Writable<T>` when R carries the brand, else `T`.
//                      Used in field-lens getter return types
//                      (`get x(): Inherits<this, Num>`) so a field's
//                      writability inherits from its parent's.
//                      Replaces today's recursive `LiftField` AND fixes
//                      its type lie on derived fields like
//                      `box.center` (`deriveTo`-derived → RO at runtime,
//                      but `LiftField` over-eagerly types as writable).
//
//   WritableOf<T>    — animator constraint, same shape as today.
//
// What this enables:
//   - Writable interfaces shrink to `extends Foo, WritableBrand { value: V }`
//     — no per-field overrides; the getters' `Inherits<this, …>`
//     conditional switches uniformly.
//   - Derived RO fields (e.g. `magnitude`, `box.center`) stay RO on
//     writable receivers because the author types them as plain `Num` /
//     `Vec` (not `Inherits<this, …>`).

import { lazy as rawLazy, type WritableBrand } from "../signal";

/** Registry lookup: "the writable form of R". */
export type Writable<R> = R extends { readonly _writable: infer W } ? W : never;

/** Conditionally-typed `lazy`: identical runtime to `signal.lazy`, but
 *  the return type tracks the receiver. When `self` carries the brand,
 *  the field is `Writable<T>`; otherwise plain `T`. Used by value-class
 *  field-lens getters to drop the `as never` cast at the body return. */
export const lazy = rawLazy as <S, T>(
  self: S,
  key: string | symbol,
  make: () => T,
) => S extends WritableBrand ? Writable<T> : T;

/** "T polymorphic over R's writability." `Writable<T>` when R is
 *  branded, else `T`. Used in field-lens getter return types:
 *
 *      get x(): Inherits<this, Num> { … }
 *
 *  Receiver `Vec` → `.x: Num` (RO).
 *  Receiver `Writable<Vec>` → `.x: Writable<Num>` (RW). */
export type Inherits<R, T> = R extends WritableBrand ? Writable<T> : T;

/** T-anchored constraint for animator-style parameters. */
export interface WritableOf<T> extends WritableBrand {
  value: T;
  peek(): T;
}

export type { WritableBrand };
