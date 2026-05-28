// sum-merge.test.ts — non-idempotent fold (sum) within a propagation.
// This file tests where the cheap-path design starts to creak: sum
// is associative and commutative (so order-independent), but it is
// NOT idempotent, which means re-folding a contribution from the
// SAME source double-counts.
//
// The §3 design assumes "deposits per slot per propagation" is at
// most one — true for the canonical fan-in lens, since `_fanin`'s
// setter writes each parent exactly once per backward write. These
// tests pin that assumption empirically and document the failure
// mode if it breaks.

import { describe, expect, it } from "vitest";
import { batch, Num, num, Signal, sumPolicy, withMerge } from "../index";

/** Local convenience: build a lens-mode Num via `Signal.install` with
 *  a sensible cast (the static is typed against generic `Signal<T>`,
 *  which fights value-class subclasses at the call site). */
function installNumLens(getter: () => number, setter: (v: number) => void): Num {
  return Signal.install(
    Num as unknown as new (...args: never[]) => Signal<number>,
    getter,
    setter,
  ) as unknown as Num;
}

function mergedDiamond(rootInit: number) {
  const root = num(rootInit);
  const committed: number[] = [];
  const origSet = root._setWithExclusion.bind(root);
  root._setWithExclusion = function (next, excluding) {
    committed.push(next);
    origSet(next, excluding);
  };
  withMerge(root, sumPolicy);
  const raw: number[] = [];
  const afterMerge = root._setWithExclusion.bind(root);
  root._setWithExclusion = function (next, excluding) {
    raw.push(next);
    afterMerge(next, excluding);
  };
  const a = root.add(1);
  const b = root.scale(2);
  const sum = Num.lens(
    [a, b] as const,
    ([av, bv]) => av + bv,
    (target, [av, bv]) => {
      const tot = av + bv;
      if (tot === 0) return [target / 2, target / 2];
      return [(target * av) / tot, (target * bv) / tot];
    },
  );
  return { root, a, b, sum, raw, committed };
}

describe("sum merge: in-cascade behaviour", () => {
  it("sum-of-contributions: diamond cascade adds both deposits", () => {
    const { root, sum, raw, committed } = mergedDiamond(1);
    sum.value = 10;
    // Raw: 4 (a.bwd) and 2.5 (b.bwd). Folded: 4, 6.5.
    expect(raw).toEqual([4, 2.5]);
    expect(committed).toEqual([4, 6.5]);
    expect(root.value).toBe(6.5);
  });

  it("order-independence: cascade with reversed lens order yields same sum", () => {
    function diamondReversed(rootInit: number) {
      const root = withMerge(num(rootInit), sumPolicy);
      const a = root.add(1);
      const b = root.scale(2);
      const s = Num.lens(
        [b, a] as const,
        ([bv, av]) => av + bv,
        (target, [bv, av]) => {
          const tot = av + bv;
          if (tot === 0) return [target / 2, target / 2];
          return [(target * bv) / tot, (target * av) / tot];
        },
      );
      return { root, s };
    }
    const fwd = mergedDiamond(1);
    fwd.sum.value = 10;
    const rev = diamondReversed(1);
    rev.s.value = 10;
    // 4 + 2.5 = 6.5 either way; addition is commutative.
    expect(rev.root.value).toBeCloseTo(fwd.root.value);
  });

  it("sequential propagations reset: each cascade sums its own deposits only", () => {
    const { root, sum } = mergedDiamond(1);
    sum.value = 10;
    expect(root.value).toBe(6.5);
    // After 1st cascade: root=6.5, a=7.5, b=13, sum_view=20.5.
    // sum.value = 20.5 distributes proportionally:
    //   a' = 20.5*(7.5/20.5) = 7.5 → root via a.bwd = 7.5-1 = 6.5
    //   b' = 20.5*(13/20.5)  = 13  → root via b.bwd = 13/2  = 6.5
    // Fresh accumulator: sum = 0+6.5+6.5 = 13.
    // Contaminated (no reset): sum = 6.5+6.5+6.5 = 19.5.
    sum.value = 20.5;
    expect(root.value).toBe(13);
  });
});

describe("sum merge: limitation — same-source repeat is double-counted", () => {
  it("if a single source writes twice in one cascade, sum double-counts", () => {
    // Demonstrate the failure: a hand-rolled lens that writes to its
    // parent TWICE inside one batch. Today's fan-in setter never
    // does this (each parent gets one write per bwd call), but
    // user-authored setters CAN. The sum merge sees both writes as
    // independent contributions and adds them — which is wrong if
    // the user's intent was "the lens contributes one value, not
    // two snapshots."
    const root = withMerge(num(0), sumPolicy);
    // A pathological "lens" that writes to root twice on each set.
    const naughty = installNumLens(
      () => root.value,
      v => {
        batch(() => {
          root.value = v;
          root.value = v;
        });
      },
    );
    naughty.value = 5;
    // Sum sees TWO contributions of 5, folds to 10.
    expect(root.value).toBe(10);
    // The "correct" semantics — if the user knew this was a single
    // logical contribution — would be 5. The merge policy can't
    // recover the user's intent without per-slot bookkeeping. This
    // is what §3's "per-slot" caveat refers to, and what the next
    // iteration of the prototype must address.
  });
});
