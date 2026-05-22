// writable.ts (spike) — public types and value-class authoring helpers.
//
// Public types:
//
//   Writable<R>      — registry lookup: "the writable form of R".
//                      Single hop, no recursion. Each class declares
//                      `_writable: Foo_W` phantom.
//
//   WritableOf<T>    — animator constraint, same shape as today.
//
// Authoring helpers (call from inside class getters):
//
//   field(this, "x", Num)          — bidirectional field lens. Returns
//                                    Writable<Num> on writable parent,
//                                    Num on bare. Combines lazy +
//                                    lensTo + spread-replace.
//
//   derived(this, "magnitude",     — read-only derived view via
//           Num, v => fn(v))         deriveTo. Returns Cls instance,
//                                    NEVER lifted to writable (today's
//                                    LiftField type lie is gone).
//
// Authors don't import `Inherits` or `lazy` directly — the helpers
// encapsulate the conditional resolution. For escape hatches (e.g.
// caching arbitrary computed views), import `lazy` from "../signal".

import { lazy, Signal, type WritableBrand } from "../signal";
import type { Of } from "../signal";

// ─── Public types ────────────────────────────────────────────────────

/** Registry lookup: "the writable form of R". Single hop. */
export type Writable<R> = R extends { readonly _writable: infer W } ? W : never;

/** Generic writable shape: original class + brand + RW value. Used as
 *  the default `_writable` declaration target — saves a per-class
 *  named writable interface in the common case:
 *
 *      class Vec extends Signal<V> {
 *        declare readonly _writable: Wr<Vec>;
 *      }
 *
 *  Authors who want a named writable type for some external use can
 *  declare `interface Vec_W extends Wr<Vec> {}` separately. */
export type Wr<R> = R & WritableBrand & { value: Of<R> };

/** T-anchored constraint for animator-style parameters. */
export interface WritableOf<T> extends WritableBrand {
  value: T;
  peek(): T;
}

export type { WritableBrand };

// ─── Internal: receiver-conditional ──────────────────────────────────

/** Internal helper: `T` polymorphic over `R`'s writability. Used by
 *  `field()`'s return type. Authors should NOT need to type this
 *  directly — the helpers handle the conditional. */
type Inherits<R, T> = R extends WritableBrand ? Writable<T> : T;

// ─── Authoring helpers ───────────────────────────────────────────────

/** Bidirectional field lens onto `parent.value[key]`. Read returns
 *  the field; write spread-replaces the composite. Cached per
 *  (instance, key) via `lazy()`. Return type is conditional: writable
 *  iff `parent` is writable.
 *
 *  Use inside a getter named `key`:
 *
 *      get x() { return field(this, "x", Num); }
 *
 *  TS infers the getter's return type from `field()`'s conditional.
 *
 *  Variance note: uses `Signal<any>` for the parent constraint
 *  (mirrors `lensTo` / `deriveTo`) — `Signal<unknown>` is invariant
 *  and rejects concrete `Signal<V>` subclasses. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape
export function field<S extends Signal<any>, K extends keyof Of<S>, C extends new (...args: never[]) => Signal<Of<S>[K]>>(
  parent: S,
  key: K,
  Cls: C,
): S extends WritableBrand ? Writable<InstanceType<C>> : InstanceType<C> {
  return lazy(parent, key as string | symbol, () =>
    (parent as Signal<Of<S>>).lensTo(
      Cls,
      (s) => s[key] as Of<InstanceType<C>>,
      (v, s) => ({ ...(s as object), [key]: v }) as Of<S>,
    ),
  ) as never;
}

/** Read-only derived view via `deriveTo`. Cached per (instance, key).
 *  Always returns a bare `Cls` instance, regardless of parent
 *  writability — derived views are RO at runtime, so there's no type
 *  lie even on writable receivers (this is the LiftField bug fix).
 *
 *  Use inside a getter named `key`:
 *
 *      get magnitude() {
 *        return derived(this, "magnitude", Num, v => Math.hypot(v.x, v.y));
 *      } */
// biome-ignore lint/suspicious/noExplicitAny: variance escape
export function derived<S extends Signal<any>, C extends new (...args: never[]) => Signal<any>>(
  parent: S,
  key: string | symbol,
  Cls: C,
  fn: (v: Of<S>) => Of<InstanceType<C>>,
): InstanceType<C> {
  return lazy(parent, key, () => (parent as Signal<Of<S>>).deriveTo(Cls, fn)) as InstanceType<C>;
}

/** `Inherits<R, T>` is exposed for advanced authors writing custom
 *  helpers. Most authors should reach for `field()` / `derived()`
 *  instead. */
export type { Inherits };
