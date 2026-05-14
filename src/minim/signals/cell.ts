// `cell` — the unified user-facing reactive primitive.
//
// All reactive values flow through ONE name pair:
//
//   Cell<T>           — writable reactive cell carrying a `T`
//   ReadonlyCell<T>   — read-only flavor
//
// The same names cover the plain case (no struct surface, single
// `.value`) and the rich struct case (axes, lifted ops, lazy getters,
// per-struct `.to(target, dur)`). Parameterization narrows: `Cell<T>`
// with no extra generics is just a writable signal; `Cell<V, VecOps,
// VecScalars, VecGetters, VecMethods, {x: Num, y: Num}>` is a Vec cell
// with the full Vec surface. Value-type files (`values/num.ts`,
// `values/vec.ts`, …) export short aliases (`N`, `Point`, …) over
// specific generic args.
//
// Per-axis writability follows from construction. A struct cell built
// from a literal/Signal input gets writable axes; one built from a
// derived input gets read-only axes (see `Axes<T, W, N>` below).

import {
  signal,
  computed,
  lens,
  type Signal,
  type ReadonlySignal,
  type SignalOptions,
} from "./signal";
import type { Easing, Tween, Lerp } from "./tween";
import type { Val } from "./arg";

// ── Writability flavor flag (internal) ────────────────────────────

/** Internal: distinguishes writable from read-only flavor inside the
 *  rich Cell type. The two surface aliases `Cell` / `ReadonlyCell`
 *  hide this; users don't pass it directly. */
export type RW = "rw" | "ro";

// ── Helper types for the rich Cell surface ────────────────────────

/** Args for a lifted struct op: each positional arg accepts a literal,
 *  a reactive cell (writable or read-only — `Cell<T>` is structurally
 *  a `ReadonlyCell<T>`), or a thunk. */
type CellArgs<A extends readonly unknown[]> = {
  [K in keyof A]: A[K] | ReadonlyCell<A[K]> | (() => A[K]);
};

/** Lift a struct-returning op `(self, ...args) => T` into its method
 *  form `(...args) => ReadonlyCell<T, ...>`. Threads ops/scalars/getters
 *  and the nested map through so chained derivations preserve the
 *  full struct surface (e.g. `vec.add(b).x.to(...)` works). */
type LiftedStruct<F, T, O, X, G, N> = F extends (
  self: any,
  ...args: infer A
) => any
  ? (...args: CellArgs<A>) => ReadonlyCell<T, O, X, G, {}, N>
  : never;

/** Lift a scalar-returning op `(self, ...args) => R` into a method
 *  returning `ReadonlyCell<R>` (the plain readable case). */
type LiftedScalar<F> = F extends (self: any, ...args: infer A) => infer R
  ? (...args: CellArgs<A>) => ReadonlyCell<R>
  : never;

/** Methods bag — lifted ops + lifted scalars. Free-form methods (`M`)
 *  are NOT included here; they're added separately, only on writable
 *  flavors. */
type Methods<T, O, X, G, N> = {
  [K in keyof O]: LiftedStruct<O[K], T, O, X, G, N>;
} & {
  [K in keyof X]: LiftedScalar<X[K]>;
};

/** Lazy getter return types as readonly properties.
 *  `{ length: (this) => ReadonlyCell<number> }` becomes
 *  `{ readonly length: ReadonlyCell<number> }`. */
type GetterProps<G> = {
  readonly [K in keyof G]: G[K] extends (this: any) => infer R ? R : never;
};

/** Per-axis projections of a record-shaped `T`. Only emitted when the
 *  cell has struct surface (`keyof O extends never` ⇒ no axes, the
 *  plain `cell()` case). Writability follows the parent flavor `W`.
 *
 *  When `N` declares a nested struct type for a field, that axis
 *  exposes the nested struct's full surface (`tr.translate.x`,
 *  `tr.translate.length`, …) rather than a plain signal. */
type Axes<T, O, W extends RW, N> = keyof O extends never
  ? {}
  : T extends Record<string, any>
    ? {
        readonly [K in keyof T]: K extends keyof N
          ? N[K] extends StructType<
              infer NT,
              infer NO,
              infer NX,
              infer NG,
              infer _NM,
              infer NN
            >
            ? W extends "rw"
              ? Cell<NT, NO, NX, NG, {}, NN>
              : ReadonlyCell<NT, NO, NX, NG, {}, NN>
            : never
          : W extends "rw"
            ? Signal<T[K]>
            : ReadonlySignal<T[K]>;
      }
    : {};

/** `.to(target, dur, ease?)` exists only on writable struct cells with
 *  a registered `lerp` op (via the `[LERP]` prototype slot). */
type Tweenable<T, O, W extends RW> = W extends "rw"
  ? O extends { lerp: (a: any, b: any, t: number) => T }
    ? { to(target: T, dur: Val<number>, ease?: Easing): Tween<T> }
    : {}
  : {};

// ── Cell + ReadonlyCell ────────────────────────────────────────────

/** A writable reactive cell carrying a `T`.
 *
 *  Generics — all default to empty so `Cell<T>` is just a writable
 *  signal:
 *    O — struct-returning ops bag (`add`, `sub`, `lerp`, …)
 *    X — scalar-returning ops bag (`length`, `distance`, …)
 *    G — lazy-getter bag (`center`, `css`, …)
 *    M — free-form methods bag (writable-only)
 *    N — nested-struct map (for fields whose values are themselves
 *        registered struct types)
 *
 *  Only `T` appears in user-facing positions; the rest are filled by
 *  the struct framework via inference. */
export type Cell<T, O = {}, X = {}, G = {}, M = {}, N = {}> = Signal<T> &
  Axes<T, O, "rw", N> &
  Methods<T, O, X, G, N> &
  GetterProps<G> &
  Tweenable<T, O, "rw"> &
  M;

/** A read-only reactive cell carrying a `T`. Same surface as `Cell<T>`
 *  but without the writable setter and without writable axes / free-
 *  form methods (`_M` is accepted for parameter compatibility with
 *  `Cell<...>` / `WriteOf` / `ReadOf` but is not added to the type;
 *  free-form methods are writable-only by design). */
export type ReadonlyCell<
  T,
  O = {},
  X = {},
  G = {},
  _M = {},
  N = {},
> = ReadonlySignal<T> &
  Axes<T, O, "ro", N> &
  Methods<T, O, X, G, N> &
  GetterProps<G> &
  Tweenable<T, O, "ro">;

// ── Nested-struct types ────────────────────────────────────────────

/** Nested-struct field map. Each entry maps a field of `T` to a
 *  registered `StructType`, so that axis exposes the nested struct's
 *  surface rather than a plain signal. */
export type NestedMap<T> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [K in keyof T]?: StructType<T[K], any, any, any, any, any>;
};

/** Per-field input for a struct's `signal({...})` call. Literal,
 *  Signal, ReadonlySignal, or thunk for non-nested fields; nested
 *  fields additionally accept a matching nested `Cell` (which is
 *  adopted directly — same reference, two-way share). */
export type NestedInput<T, N = {}> = {
  [K in keyof T]: K extends keyof N
    ? N[K] extends StructType<
        infer NT,
        infer NO,
        infer NX,
        infer NG,
        infer NM,
        infer NN
      >
      ?
          | NT
          | ReadonlyCell<NT>
          | (() => NT)
          | Cell<NT, NO, NX, NG, NM, NN>
          | ReadonlyCell<NT, NO, NX, NG, NM, NN>
      : never
    : T[K] | ReadonlyCell<T[K]> | (() => T[K]);
};

// ── StructType: the runtime identity of a registered struct ────────

/** A registered struct: factory namespace + identity-as-instanceof.
 *  `v instanceof MyStruct` is O(1) via the `[STRUCT]` prototype slot.
 *  Implementation lives in `values/struct.ts`; type lives here so
 *  Cell can reference it for nested-axis resolution. */
export interface StructType<T, O = {}, X = {}, G = {}, M = {}, N = {}> {
  readonly name: string;
  readonly defaults: T;
  /** Build a writable struct cell. Each field accepts a literal OR a
   *  matching reactive value; per-axis writability narrows by input
   *  flavor (literal/Signal → writable, computed/thunk → readonly).
   *  Pass a nested cell directly and the result's axis IS that cell —
   *  same reference, two-way share. */
  signal(v: NestedInput<T, N>): Cell<T, O, X, G, M, N>;
  derived(fn: () => T): ReadonlyCell<T, O, X, G, M, N>;
  lens(read: () => T, write: (v: T) => void): Cell<T, O, X, G, M, N>;
  /** Type-guard for "any flavor of this struct's cell" — `Cell<T>` is
   *  a `ReadonlyCell<T>` structurally, so a single `ReadonlyCell` is
   *  the safe lower bound. Use `isWritable` if you need the narrower
   *  type. */
  is(v: unknown): v is ReadonlyCell<T, O, X, G, M, N>;
  isWritable(v: unknown): v is Cell<T, O, X, G, M, N>;
  [Symbol.hasInstance](v: unknown): boolean;
}

/** Project a `StructType` to its writable cell type. Used to spell
 *  short aliases (`Point = WriteOf<typeof Vec>`) without depending on
 *  `signal()`'s ReturnType (which can widen under generic inference). */
export type WriteOf<S> =
  S extends StructType<infer T, infer O, infer X, infer G, infer M, infer N>
    ? Cell<T, O, X, G, M, N>
    : never;

/** Project a `StructType` to its read-only cell type. */
export type ReadOf<S> =
  S extends StructType<infer T, infer O, infer X, infer G, any, infer N>
    ? ReadonlyCell<T, O, X, G, {}, N>
    : never;

// ── Plain cell factory ────────────────────────────────────────────

/** Options accepted by `cell(value, opts)`. `equals` suppresses no-op writes. */
export type CellOptions<T> = SignalOptions<T>;

interface CellFactory {
  <T>(value: T, opts?: CellOptions<T>): Cell<T>;
  <T = undefined>(): Cell<T | undefined>;
  /** Read-only cell from a function of dependencies. */
  derived<T>(fn: () => T): ReadonlyCell<T>;
  /** Writable lens — reads via `read`, writes via `write`. */
  lens<T>(read: () => T, write: (v: T) => void): Cell<T>;
}

/** The unified user-facing reactive primitive.
 *
 *      cell(v)                — writable cell
 *      cell.derived(fn)       — read-only cell
 *      cell.lens(read, write) — writable lens cell
 *
 *  For struct cells (with ops, lerp, axes, …), use the value-type
 *  factories: `num(0)`, `vec(x, y)`, `rgb(r, g, b)`, etc. */
export const cell: CellFactory = Object.assign(signal, {
  derived: computed,
  lens,
}) as CellFactory;

/** Derive a read-only cell by mapping a single source cell's value.
 *
 *      derive(hovered, (h) => h ? 0.08 : 0)
 *      // ≡ cell.derived(() => (hovered.value ? 0.08 : 0))
 */

export function derive<T, U>(
  sig: ReadonlyCell<T>,
  fn: (v: T) => U,
): ReadonlyCell<U> {
  return computed(() => fn(sig.value));
}

/** Logical inverse — `true` when `sig` is falsy, `false` otherwise.
 *  Useful with `play(work).until(not(ready))` and similar patterns
 *  where you want to wait for a falsy transition.
 *
 *      play(idle).until(not(typing))   // run idle until typing starts
 */
export function not(sig: ReadonlyCell<unknown>): ReadonlyCell<boolean> {
  return computed(() => !sig.value);
}

// ── Re-export Lerp for value-type files that build StructTypes ────

export type { Lerp };
