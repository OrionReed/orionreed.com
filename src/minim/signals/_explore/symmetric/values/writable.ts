// writable.ts — value-class authoring helpers (symmetric-engine port).
//
// `field(this, "x", Num)`     — bidirectional field lens; conditional
//                               return (writable on writable parent,
//                               bare on RO parent).
// `derived(this, "k", Cls, fn)` — read-only derived view.
//
// The author's choice between `field()` and `derived()` IS the local
// declaration of writability at each getter site. `Writable<R>` lives
// in `../signal`.

import { type Inner, Signal, type Writable, type WritableBrand, lazy } from "../signal";

/** Bidirectional field lens onto `parent.value[key]`, cached per
 *  (instance, key). Writable parent → `Writable<Cls>`; RO parent →
 *  bare `Cls`. Runtime dispatch lives in `Signal.fieldOf`. */
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
  return lazy(parent, key as string | symbol, () =>
    Signal.fieldOf(parent as unknown as Signal<unknown>, key as string | symbol, Cls),
  ) as never;
}

/** Read-only derived view via `Cls.derive(parent, fn)`, cached per
 *  (instance, key). Always bare `Cls` (RO is the honest type). */
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
