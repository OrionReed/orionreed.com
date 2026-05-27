// tri.ts — three-valued logical type (Kleene logic).
//
// `Tri.value ∈ { true, false, "mixed" }`. The natural sum-type
// extension of Bool: same involutive `.not()`, but the unknown /
// mixed state is fixed under negation. Strong-Kleene AND/OR
// respects the partial-information reading — `mixed AND false` is
// `false` (the only uncertain branch can't rescue a known false);
// `mixed AND true` stays `mixed` (still uncertain).
//
// The headline use: aggregate the state of N booleans. `Tri.allOf` /
// `Tri.anyOf` produce a writable Tri from a `readonly Bool[]`:
//
//   - all true  → true        ── "all checked"
//   - all false → false       ── "none checked"
//   - any disagreement → "mixed" — "indeterminate"
//
// Writing the aggregate broadcasts to every parent (the classical
// "select all" / "deselect all" UI policy). Writing `"mixed"` is a
// no-op — partial information cannot be synthesized from agreement.
//
// `Tri` is the bridge between Bool and prisms: it's morally
// `Maybe<Bool>`, the smallest sum type that surfaces the
// "indeterminate" / "loading" state as a first-class value. Mixed-
// state checkbox trees, partial selection UIs, SQL-style three-valued
// logic, and "loading" states for async predicates all reduce to it.

import { type Init, Signal, type Writable } from "../signal";
import type { TraitDict } from "../traits";
import type { Bool } from "./bool";

type V = boolean | "mixed";

const equals = (a: V, b: V) => a === b;

/** Kleene negation: `true` / `false` swap, `"mixed"` is fixed. */
export const not = (a: V): V => (a === "mixed" ? "mixed" : !a);

/** Kleene AND: a known `false` dominates; otherwise mixed unless both
 *  are known and true. */
export const and = (a: V, b: V): V => {
  if (a === false || b === false) return false;
  if (a === true && b === true) return true;
  return "mixed";
};

/** Kleene OR: a known `true` dominates; otherwise mixed unless both
 *  are known and false. */
export const or = (a: V, b: V): V => {
  if (a === true || b === true) return true;
  if (a === false && b === false) return false;
  return "mixed";
};

export class Tri extends Signal<V> {
  static traits = { equals } satisfies TraitDict<V>;
  declare readonly _t: typeof Tri.traits;

  constructor(v: V = "mixed") {
    super(v, { equals });
  }

  /** Kleene negation. Involution on `true` / `false`; fixed at
   *  `"mixed"`. Chains fuse via the base engine just like `Bool#not`. */
  not(): this {
    return this.lens(not, not);
  }

  /** Aggregate over N writable Bools. Reads as Kleene AND collapsed
   *  to a three-state classifier; writes broadcast the new value to
   *  every parent.
   *
   *  Read:
   *    - all true  → `true`
   *    - all false → `false`
   *    - any disagreement → `"mixed"`
   *
   *  Write:
   *    - `true`    → set every parent to `true`
   *    - `false`   → set every parent to `false`
   *    - `"mixed"` → no-op (writing partial information is structurally
   *                  impossible from a single boolean target).
   *
   *  GetPut holds: writing back the read aggregate from an "all-agree"
   *  state is identity; from a `"mixed"` state the write is a no-op,
   *  also identity. */
  static allOf(parents: readonly Bool[]): Writable<Tri> {
    return Tri.lens(
      parents as never,
      (vs: readonly boolean[]) => {
        let anyT = false;
        let anyF = false;
        for (const v of vs) {
          if (v) anyT = true;
          else anyF = true;
          if (anyT && anyF) return "mixed";
        }
        return anyT;
      },
      (target, _vs) => {
        if (target === "mixed") return parents.map(() => undefined) as never;
        return parents.map(() => target) as never;
      },
    );
  }

  /** Dual of `allOf` — Kleene OR's three-state classifier:
   *    - any true   → `true`
   *    - all false  → `false`
   *    - else       → `"mixed"`
   *
   *  Write policy is the same broadcast: `true` / `false` set every
   *  parent; `"mixed"` is a no-op. */
  static anyOf(parents: readonly Bool[]): Writable<Tri> {
    return Tri.lens(
      parents as never,
      (vs: readonly boolean[]) => {
        let anyT = false;
        let anyF = false;
        for (const v of vs) {
          if (v) anyT = true;
          else anyF = true;
        }
        if (anyT && !anyF) return true;
        if (!anyT && anyF) return false;
        return "mixed";
      },
      (target, _vs) => {
        if (target === "mixed") return parents.map(() => undefined) as never;
        return parents.map(() => target) as never;
      },
    );
  }
}

/** Writable `Tri`. Strict factory: `Tri.value | Writable<Tri>` in,
 *  `Writable<Tri>` out. Default initial value is `"mixed"`. */
export function tri(v: Init<Tri> = "mixed"): Writable<Tri> {
  if (v instanceof Tri) return v as Writable<Tri>;
  return new Tri(v) as Writable<Tri>;
}
