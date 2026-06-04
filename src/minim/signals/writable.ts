// writable.ts — value-class authoring helpers.
//
// `field(this, "x", Num)` — bidirectional field lens; conditional
// return (writable on writable parent, bare on RO). `derived(this,
// "k", Cls, fn)` — read-only derived view via `Cls.derive`. The choice
// between them IS the local declaration of writability at each getter,
// mirroring `: this` invertible method returns. For arbitrary cached
// views, use `lazy()` from "../signal" directly.

import { Cell, type Inner, lazy, type Writable, type WritableBrand } from "./signal";

/** Bidirectional field lens onto `parent.value[key]`; write spread-
 *  replaces the composite. Cached per (instance, key). Return type is
 *  conditional: `Writable<Cls>` on a writable parent, bare `Cls` on RO
 *  (runtime dispatch in `Cell.fieldOf` mirrors this).
 *
 *      get x() { return field(this, "x", Num); } */
export function field<
  // biome-ignore lint/suspicious/noExplicitAny: variance escape on Cls.lens
  S extends Cell<any>,
  K extends keyof Inner<S>,
  C extends new (
    ...args: never[]
  ) => Cell<Inner<S>[K]>,
>(
  parent: S,
  key: K,
  Cls: C,
): S extends WritableBrand ? Writable<InstanceType<C>> : InstanceType<C> {
  return lazy(parent, key as string | symbol, () =>
    Cell.fieldOf(parent as unknown as Cell<unknown>, key as string | symbol, Cls),
  ) as never;
}

/** Read-only derived view via `Cls.derive(parent, fn)`. Cached per
 *  (instance, key); always bare `Cls` (RO).
 *
 *      get magnitude() {
 *        return derived(this, "magnitude", Num, v => Math.hypot(v.x, v.y));
 *      } */
// biome-ignore lint/suspicious/noExplicitAny: variance escape, mirrors Cls.derive
export function derived<S extends Cell<any>, C extends new (...args: never[]) => Cell<any>>(
  parent: S,
  key: string | symbol,
  Cls: C,
  fn: (v: Inner<S>) => Inner<InstanceType<C>>,
): InstanceType<C> {
  // biome-ignore lint/suspicious/noExplicitAny: variance escape on Cls.derive
  return lazy(parent, key, () => (Cls as any).derive(parent, fn)) as InstanceType<C>;
}
