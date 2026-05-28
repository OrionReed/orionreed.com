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

describe("sum merge: same-source repeats are dedupe'd, not double-counted", () => {
  it("a lens that writes to its parent twice in one batch counts as ONE contribution", () => {
    // A user-authored lens whose setter writes its parent multiple
    // times inside a single bwd dispatch. The slot identity of
    // ALL its writes is the lens itself (`activeBwdWriter` is set
    // to it for the duration of its setter), so the merge's per-
    // slot map records only the LATEST value — the prior write is
    // overwritten, not summed alongside.
    //
    // This is the property that lets sum / mean be correct under
    // arbitrary user lens authoring, not just under `_fanin`'s
    // happens-to-be-one-write-per-parent contract.
    const root = withMerge(num(0), sumPolicy);
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
    expect(root.value).toBe(5);
  });

  it("a single lens writing its parent multiple times keeps the last value (within its own cascade)", () => {
    // ONE top-level call, lens writes parent three times in its
    // setter. All three writes share the same cascade id (we never
    // returned to `activeBwdWriter === undefined`), and they all
    // share the same slot identity (the lens itself). So the slot
    // map ends with one entry holding the LAST write; sum = that
    // last value.
    const root = withMerge(num(0), sumPolicy);
    const lens = installNumLens(
      () => root.value,
      v => {
        batch(() => {
          root.value = v;
          root.value = v + 1;
          root.value = v + 2; // this one wins for this slot
        });
      },
    );
    lens.value = 1;
    expect(root.value).toBe(3);
  });

  it("two SEPARATE top-level writes are separate cascades; merge resets between", () => {
    // Each `lens.value = …` at top level bumps the cascade id, so
    // the slot map clears. Use a fan-in to combine them.
    const root = withMerge(num(0), sumPolicy);
    const lensA = installNumLens(
      () => root.value,
      v => {
        root.value = v;
      },
    );
    const lensB = installNumLens(
      () => root.value,
      v => {
        root.value = v * 10;
      },
    );
    lensA.value = 1; // cascade 1: slot lensA = 1; commits 1
    lensB.value = 2; // cascade 2: slot lensB = 20; commits 20 (reset)
    expect(root.value).toBe(20);
  });

  it("re-entry of the same lens setter within one cascade is one slot", () => {
    // Lens that writes the parent, then reads parent, then writes
    // again based on what it read. Two writes to root through the
    // same slot ⇒ second replaces first; final root reflects only
    // the second write.
    const root = withMerge(num(0), sumPolicy);
    const lens = installNumLens(
      () => root.value,
      v => {
        batch(() => {
          root.value = v;
          const observed = root.value; // already commits at this point
          root.value = observed + 100;
        });
      },
    );
    lens.value = 7;
    expect(root.value).toBe(107);
  });
});
