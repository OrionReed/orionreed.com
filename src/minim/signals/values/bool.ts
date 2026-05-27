// bool.ts — reactive boolean.
//
// Two writable invertibles ride the plain endo `.lens(fwd, bwd)`:
//
//   `not()` — the canonical involution. The boolean answer to
//             `Matrix#invert()`. Chained `.not().not()` fuses to identity.
//
//   `xor(b)` — the F₂ group operation. Invertible because xor is its
//              own inverse: `a ^ b = c ↔ a = c ^ b`. The boolean answer
//              to `Num#add`. Carries Bool's `linear` trait (add = sub
//              = xor; scale collapses by integer parity).
//
// `and` / `or` / `implies` / `eq` / `nand` / `nor` return bare `Bool`
// (RO). They're lossy fan-ins — writing through `a && b` is ambiguous
// whenever the source disagrees with the target. Lift to a writable
// form via `Bool.lens([a, b], fwd, bwd)` with an explicit policy when
// you need that. Bridges from continuous types (e.g.
// `Num.greaterThan(t): Bool`) declare the policy in their own bwd.

import { type Init, reader, Signal, type Val, type Writable } from "../signal";
import { type Linear, type TraitDict } from "../traits";

type V = boolean;

export const not = (a: V): V => !a;
export const and = (a: V, b: V): V => a && b;
export const or = (a: V, b: V): V => a || b;
export const xor = (a: V, b: V): V => a !== b;
export const equals = (a: V, b: V) => a === b;

// F₂-linear structure (the only nontrivial vector-space structure on
// Bool): xor is BOTH addition and subtraction (a ^ a = false), so the
// group is its own inverse. Scale-by-integer collapses by parity:
// even-k zeroes the value, odd-k passes it through. Lets Bool
// participate in generic `Linear` consumers (parity reductions, etc.).
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

  // ── invertibles: return `: this`, propagating writability ─────────

  /** Logical negation. Involution — its own inverse; chains fuse. */
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

  /** `this && b`. RO: writes aren't unique under fan-in. For a writable
   *  AND, use `Bool.lens([a, b], ...)` with an explicit redistribution
   *  policy in the bwd. */
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

/** Writable `Bool`. Strict factory: `boolean | Writable<Bool>` in,
 *  `Writable<Bool>` out. Literal seeds a fresh cell; existing
 *  `Writable<Bool>` passes through by identity.
 *
 *  RO sources are rejected at the type level — reach for
 *  `Bool.derive(...)` to track them reactively, or `signal.value` to
 *  snapshot. */
export function bool(v: Init<Bool> = false): Writable<Bool> {
  if (v instanceof Bool) return v as Writable<Bool>;
  return new Bool(v) as Writable<Bool>;
}
