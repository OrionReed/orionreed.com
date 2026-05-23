// writable.ts (spike) — three primitives.
//
//   Writable<R>     — registry lookup: "the writable form of R".
//                     Single hop, no recursion. Each class declares
//                     `_writable: Foo_W` (or `Wr<Foo>` for shapes
//                     without field-lens overrides).
//
//   Wr<R>           — default writable shape: `R & WritableBrand &
//                     { value: Of<R> }`. Used directly for scalar-ish
//                     classes (no field-lens overrides) and as the
//                     base for richer per-class writable interfaces.
//
//   WritableOf<T>   — animator constraint, same shape as today.
//
// Authors write field-lens getters with the explicit `lazy + lensTo`
// pattern (return type bare `Foo`, RO at type level), then redeclare
// the writable counterparts on `Foo_W`. This keeps every closure
// visible at the getter site (fast V8 paths for `s.x` / `{...s, x: v}`)
// and makes "which fields propagate writability" explicit on the
// writable interface.

import type { Of, WritableBrand } from "../signal";

/** Registry lookup: "the writable form of R". Single hop. */
export type Writable<R> = R extends { readonly _writable: infer W } ? W : never;

/** Default writable shape: original class + brand + RW value. Use
 *  directly for scalar classes whose fields don't need overrides:
 *
 *      class Num extends Signal<V> {
 *        declare readonly _writable: Wr<Num>;
 *      }
 *
 *  For classes with field lenses, declare a richer `Foo_W` interface
 *  extending `Wr<Foo>` and add per-field overrides:
 *
 *      interface Vec_W extends Wr<Vec> {
 *        get x(): Writable<Num>;
 *        get y(): Writable<Num>;
 *      } */
export type Wr<R> = R & WritableBrand & { value: Of<R> };

/** T-anchored constraint for animator-style parameters. */
export interface WritableOf<T> extends WritableBrand {
  value: T;
  peek(): T;
}

export type { WritableBrand };
