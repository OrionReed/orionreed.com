// bool.ts — reactive boolean (symmetric-engine port).
//
// `not()` / `xor(b)` are writable invertibles riding the endo
// `.lens(fwd, bwd)`. `and`/`or`/`implies`/`eq`/`nand`/`nor` are lossy
// fan-ins → bare RO `Bool` (lift via `Bool.lens([a, b], …)` for a
// writable form with an explicit redistribution policy).

import type { Linear, TraitDict } from "../../../traits";
import { type Init, Signal, type Val, type Writable, reader } from "../signal";

type V = boolean;

export const not = (a: V): V => !a;
export const and = (a: V, b: V): V => a && b;
export const or = (a: V, b: V): V => a || b;
export const xor = (a: V, b: V): V => a !== b;
export const equals = (a: V, b: V) => a === b;

const linearImpl: Linear<V> = {
  add: xor,
  sub: xor,
  scale: (a, k) => (Math.round(k) % 2 !== 0 ? a : false),
};

export class Bool extends Signal<V> {
  static traits = { linear: linearImpl, equals } satisfies TraitDict<V>;
  declare readonly _t: typeof Bool.traits;

  constructor(v: V = false) {
    super(v, { equals });
  }

  /** Logical negation. Involution — its own inverse. */
  not(): this {
    return this.lens(not, not);
  }

  /** Symmetric difference / parity. `a ^ b = c ↔ a = c ^ b`. */
  xor(b: Val<V>): this {
    const bf = reader(b);
    return this.lens(
      (v) => v !== bf(),
      (n) => n !== bf(),
    );
  }

  and(b: Val<V>): Bool {
    const bf = reader(b);
    return Bool.derive(() => this.value && bf());
  }
  or(b: Val<V>): Bool {
    const bf = reader(b);
    return Bool.derive(() => this.value || bf());
  }
  implies(b: Val<V>): Bool {
    const bf = reader(b);
    return Bool.derive(() => !this.value || bf());
  }
  eq(b: Val<V>): Bool {
    const bf = reader(b);
    return Bool.derive(() => this.value === bf());
  }
  nand(b: Val<V>): Bool {
    const bf = reader(b);
    return Bool.derive(() => !(this.value && bf()));
  }
  nor(b: Val<V>): Bool {
    const bf = reader(b);
    return Bool.derive(() => !(this.value || bf()));
  }
}

/** Writable `Bool`. Literal seeds a fresh cell; `Writable<Bool>` passes
 *  through by identity. */
export function bool(v: Init<Bool> = false): Writable<Bool> {
  if (v instanceof Bool) return v as Writable<Bool>;
  return new Bool(v) as Writable<Bool>;
}
