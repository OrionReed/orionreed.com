// tri.ts — three-valued logical type (Kleene logic).
//
// `Tri.value ∈ { true, false, "mixed" }` — Bool plus an unknown state
// fixed under negation. Strong-Kleene AND/OR follow the partial-info
// reading (`mixed AND false` → `false`, `mixed AND true` → `mixed`).
//
// Headline use: aggregate N booleans via `Tri.allOf` / `Tri.anyOf`
// (all-agree → that value, disagreement → `"mixed"`). Writing the
// aggregate broadcasts to every parent ("select all" / "deselect all");
// writing `"mixed"` is a no-op. Morally `Maybe<Bool>` — the basis for
// mixed-state checkbox trees and "loading" predicate states.

import { Cell, type Init, type Writable } from "../signal";
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

export class Tri extends Cell<V> {
  static traits = { equals } satisfies TraitDict<V>;
  declare readonly _t: typeof Tri.traits;

  constructor(v: V = "mixed") {
    super(v, { equals });
  }

  /** Kleene negation. Involution; fixed at `"mixed"`. */
  not(): this {
    return this.lens(not, not);
  }

  /** Aggregate over N writable Bools. Read: all-true → `true`,
   *  all-false → `false`, disagreement → `"mixed"`. Write: `true` /
   *  `false` broadcast to every parent; `"mixed"` is a no-op. */
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

  /** Dual of `allOf` (Kleene OR): any-true → `true`, all-false →
   *  `false`, else `"mixed"`. Same broadcast write policy. */
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
