// writable.ts — value-class authoring helpers.
//
// `field(this, "x", Num)`  — bidirectional field lens. Conditional
//                            return: writable on writable parent,
//                            bare on RO parent. Combines `lazy` +
//                            `Cls.lens` + spread-replace.
//
// `derived(this, "k", Cls, fn)` — read-only derived view via
//                                 `Cls.derive(parent, fn)`. Always
//                                 returns bare `Cls` (RO).
//
// The author's choice between `field()` (bidirectional) and
// `derived()` (RO) IS the local declaration of writability behaviour
// at each getter site, mirroring the locality of `: this` invertible
// method returns.
//
// For escape-hatch caching of arbitrary computed views (e.g.
// `Color.css` building a CSS string), use `lazy()` from "../signal"
// directly with whatever `make()` body you want.
//
// Public type `Writable<R>` lives in `./signal`
// alongside the brand they ride on.

import { type Inner, lazy, Signal, type Writable, type WritableBrand } from "./signal";

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
 *  `box.center` is built from `Cls.derive`), the bwd path has no
 *  place to land. Fall through to `Cls.derive` to match the
 *  conditional return type at runtime. Without this, `field()` would
 *  try to install a writable lens onto a RO receiver and trip the
 *  construction-time check in `Signal._fuse`, breaking legitimate
 *  read-only patterns like `box.center.x.value`. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape on Cls.lens
export function field<
  S extends Signal<any>,
  K extends keyof Inner<S>,
  C extends new (
    ...args: never[]
  ) => Signal<Inner<S>[K]>,
>(
  parent: S,
  key: K,
  Cls: C,
): S extends WritableBrand ? Writable<InstanceType<C>> : InstanceType<C> {
  return lazy(parent, key as string | symbol, () => {
    const fused = (parent as unknown as { _fusedOf?: { bwd?: unknown } })._fusedOf;
    if (fused !== undefined && fused.bwd === undefined) {
      // biome-ignore lint/suspicious/noExplicitAny: variance escape on Cls.derive
      return (Cls as any).derive(parent, (s: Inner<S>) => s[key] as Inner<InstanceType<C>>);
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
  fn: (v: Inner<S>) => Inner<InstanceType<C>>,
): InstanceType<C> {
  // biome-ignore lint/suspicious/noExplicitAny: variance escape on Cls.derive
  return lazy(parent, key, () => (Cls as any).derive(parent, fn)) as InstanceType<C>;
}
