// writable.ts — public types + value-class authoring helpers.
//
// Public types:
//
//   Writable<R>      — registry lookup: "the writable form of R".
//                      Single hop, no recursion. Each value class
//                      declares `_writable: Wr<Foo>` (a phantom
//                      registry brand) so this lookup resolves.
//
//   Wr<R>            — default writable shape: `R & WritableBrand &
//                      { value: Of<R> }`. The standard `_writable`
//                      declaration target on every value class.
//
//   WritableOf<T>    — T-anchored animator constraint.
//
// Authoring helpers (call from inside class getters):
//
//   field(this, "x", Num)              — bidirectional field lens.
//                                        Conditional return: writable
//                                        on writable parent, bare on
//                                        RO parent. Combines `lazy` +
//                                        `Cls.lens` + spread-replace.
//
//   derived(this, "k", Cls, fn)        — read-only derived view via
//                                        `Cls.derive(parent, fn)`.
//                                        Always returns bare `Cls` (RO).
//
// Authors don't import the brand-conditional type directly — the
// helpers encapsulate it. The author's choice between `field()`
// (bidirectional) and `derived()` (RO) IS the local declaration of
// writability behaviour at each getter site, mirroring the locality
// of `: this` invertible method returns.
//
// For escape-hatch caching of arbitrary computed views (e.g.
// `Color.css` building a CSS string), use `lazy()` from "../signal"
// directly with whatever `make()` body you want.

import { lazy, type Of, Signal, type WritableBrand } from "./signal";

// ─── Public types ────────────────────────────────────────────────────

/** Default writable shape. Used as the `_writable` declaration target
 *  on every value class — `_writable` is the phantom registry hook. */
export type Wr<R> = R & WritableBrand & { value: Of<R> };

/** "The writable form of R." Resolves via the per-class `_writable`
 *  registry brand when present (so `Writable<Vec>` returns the
 *  Vec-specific writable shape); falls back to the default `Wr<R>`
 *  for plain `Signal<T>` and other classes that don't declare a
 *  custom writable form. Single hop, no recursion. */
export type Writable<R> = R extends { readonly _writable: infer W } ? W : Wr<R>;

/** T-anchored constraint for animator-style parameters:
 *
 *      function spring<T>(s: WritableOf<T> & Traits<T, "linear" | "metric">, target: T)
 *
 *  Satisfied by `Writable<Num>` / `Writable<Vec>` / any factory-
 *  returned writable signal. Bare RO value classes are rejected
 *  because they lack the brand. */
export interface WritableOf<T> extends WritableBrand {
  value: T;
  peek(): T;
}

export type { WritableBrand };

// ─── Authoring helpers ───────────────────────────────────────────────

/** Bidirectional field lens onto `parent.value[key]`. Read returns
 *  the field; write spread-replaces the composite. Cached per
 *  (instance, key) via `lazy()`. Return type is conditional on the
 *  receiver: `Writable<Cls>` when `parent` carries the brand,
 *  bare `Cls` otherwise.
 *
 *      get x() { return field(this, "x", Num); }
 *
 *  TS infers the getter's return type from `field()`'s conditional —
 *  no per-getter annotation needed.
 *
 *  Runtime smart-dispatch: when `parent` is a fused-RO chain (e.g.
 *  `box.center` is built from `deriveTo`), the bwd path has no place
 *  to land. Fall through to `deriveTo` to match the conditional
 *  return type at runtime. Without this, `field()` would try to
 *  install a writable lens onto a RO receiver and trip the
 *  construction-time check in `Signal._fuse`, breaking legitimate
 *  read-only patterns like `box.center.x.value`. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape, mirrors lensTo
export function field<
  S extends Signal<any>,
  K extends keyof Of<S>,
  C extends new (
    ...args: never[]
  ) => Signal<Of<S>[K]>,
>(
  parent: S,
  key: K,
  Cls: C,
): S extends WritableBrand ? Writable<InstanceType<C>> : InstanceType<C> {
  return lazy(parent, key as string | symbol, () => {
    const fused = (parent as unknown as { _fusedOf?: { bwd?: unknown } })._fusedOf;
    if (fused !== undefined && fused.bwd === undefined) {
      // biome-ignore lint/suspicious/noExplicitAny: variance escape on Cls.derive
      return (Cls as any).derive(parent, (s: Of<S>) => s[key] as Of<InstanceType<C>>);
    }
    return Signal.fieldOf(parent as unknown as Signal<unknown>, key as string | symbol, Cls);
  }) as never;
}

/** Read-only derived view via `Cls.derive(parent, fn)`. Cached per
 *  (instance, key). Always returns bare `Cls` (RO) regardless of
 *  parent writability — derived views are RO at runtime, so this is
 *  the honest type.
 *
 *      get magnitude() {
 *        return derived(this, "magnitude", Num, v => Math.hypot(v.x, v.y));
 *      } */
// biome-ignore lint/suspicious/noExplicitAny: variance escape, mirrors Cls.derive
export function derived<S extends Signal<any>, C extends new (...args: never[]) => Signal<any>>(
  parent: S,
  key: string | symbol,
  Cls: C,
  fn: (v: Of<S>) => Of<InstanceType<C>>,
): InstanceType<C> {
  // biome-ignore lint/suspicious/noExplicitAny: variance escape on Cls.derive
  return lazy(parent, key, () => (Cls as any).derive(parent, fn)) as InstanceType<C>;
}
