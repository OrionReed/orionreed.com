// bool.ts — reactive boolean.
//
// Invertibles ride the plain endo `.lens(fwd, bwd)`: `not()` (involution,
// `.not().not()` round-trips to identity) and `xor(b)` (its own inverse;
// `a ^ b = c ↔ a = c ^ b`). xor carries Bool's `linear` trait.
//
// `and` / `or` / `implies` / `eq` / `nand` / `nor` return bare RO `Bool`
// — lossy fan-ins whose write-back is ambiguous. Lift to writable via
// `Bool.lens([a, b], fwd, bwd)` with an explicit policy.

import { Cell, type Init, reader, type Val, type Writable } from "../signal";
import type { Linear, TraitDict } from "../traits";

type V = boolean;

export const not = (a: V): V => !a;
export const and = (a: V, b: V): V => a && b;
export const or = (a: V, b: V): V => a || b;
export const xor = (a: V, b: V): V => a !== b;
export const equals = (a: V, b: V) => a === b;

// F₂-linear structure: xor is both add and sub (a ^ a = false);
// scale-by-integer collapses by parity (even k → false, odd k → a).
const linearImpl: Linear<V> = {
  add: xor,
  sub: xor,
  scale: (a, k) => (Math.round(k) % 2 !== 0 ? a : false),
};

export class Bool extends Cell<V> {
  static traits = { linear: linearImpl, equals } satisfies TraitDict<V>;
  declare readonly _t: typeof Bool.traits;

  constructor(v: V = false) {
    super(v, { equals });
  }

  // ── invertibles: return `: this`, propagating writability ─────────

  /** Logical negation. Involution; chains compose. */
  not(): this {
    return this.lens(not, not);
  }

  /** Symmetric difference / parity. Invertible:
   *  `a ^ b = c  ↔  a = c ^ b`. The F₂ analog of `Num#add`. */
  xor(b: Val<V>): this {
    const bf = reader(b);
    return this.lens(
      v => v !== bf(),
      n => n !== bf(),
    );
  }

  // ── derived (RO) ──────────────────────────────────────────────────

  /** `this && b`. RO: fan-in write-back isn't unique — use
   *  `Bool.lens([a, b], ...)` with an explicit policy for a writable AND. */
  and(b: Val<V>): Bool {
    const bf = reader(b);
    return Bool.derive(() => this.value && bf());
  }
  or(b: Val<V>): Bool {
    const bf = reader(b);
    return Bool.derive(() => this.value || bf());
  }
  /** `this → b ≡ ¬this ∨ b`. */
  implies(b: Val<V>): Bool {
    const bf = reader(b);
    return Bool.derive(() => !this.value || bf());
  }
  /** Boolean equality — XNOR. */
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

/** Writable `Bool`. Literal seeds a fresh cell; existing `Writable<Bool>`
 *  passes through by identity. RO sources are rejected at the type level —
 *  use `Bool.derive(...)` for reactive RO tracking, or `cell.value` to
 *  snapshot. */
export function bool(v: Init<Bool> = false): Writable<Bool> {
  if (v instanceof Bool) return v as Writable<Bool>;
  return new Bool(v) as Writable<Bool>;
}
