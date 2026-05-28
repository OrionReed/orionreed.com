// lattice-merge.test.ts — §10 step 2: order-independent merge with
// idempotent fold (max / min) via the `.merge()` chain-position
// instance method. This is the "cost gradient cheap path" from §3.
//
// Success criteria for the prototype:
//   1. Order-of-arrival doesn't change the final value.
//   2. The result matches the fold of all contributions in the
//      cascade, not the last-write-wins clobber of the baseline.
//   3. Sequential propagations don't bleed into each other.
//   4. Multiple top-level writes are SEPARATE cascades, even when
//      batched — combining requires structural fan-in.

import { describe, expect, it } from "vitest";
import {
  batch,
  maxPolicy,
  type MergePolicy,
  minPolicy,
  Num,
  num,
  peekMergeAcc,
} from "../index";

/** Diamond fixture matching `baseline.test.ts`, but with a `.merge()`
 *  cell sitting between the underlying root signal and the downstream
 *  lenses. Tracks BOTH the raw contributions arriving at the merge
 *  (`raw`, recorded on the merge cell's setter) and the final values
 *  committed to the underlying root (`committed`). The two diverge
 *  for any non-trivial policy. */
function mergedDiamond(rootInit: number, policy: MergePolicy<number>) {
  const root = num(rootInit);
  const committed: number[] = [];
  // Tap the underlying root's setter to record what the merge
  // commits downstream after each fold.
  const origSet = root._setWithExclusion.bind(root);
  root._setWithExclusion = function (next, excluding) {
    committed.push(next);
    origSet(next, excluding);
  };

  const merged = root.merge(policy);
  // Tap the merge cell's setter to record the RAW per-arrival
  // contributions (pre-fold). Wraps the engine-installed setter the
  // `.merge()` method created.
  const raw: number[] = [];
  const mergeSet = merged._setWithExclusion.bind(merged);
  merged._setWithExclusion = function (next, excluding) {
    raw.push(next);
    mergeSet(next, excluding);
  };

  const a = merged.add(1);
  const b = merged.scale(2);
  const sum = Num.lens(
    [a, b] as const,
    ([av, bv]) => av + bv,
    (target, [av, bv]) => {
      const tot = av + bv;
      if (tot === 0) return [target / 2, target / 2];
      return [(target * av) / tot, (target * bv) / tot];
    },
  );
  return { root, merged, a, b, sum, raw, committed };
}

describe("idempotent merge: max", () => {
  it("combines diamond bwd writes via Math.max instead of last-wins", () => {
    // root=1 → merged=1: a=2, b=2; sum=4. Write sum=10.
    // distribute: a'=5, b'=5; merged via a.bwd = 4; merged via b.bwd = 2.5.
    // Per-arrival fold: max(-Inf,4)=4 committed; max(4,2.5)=4 committed.
    const { root, merged, sum, raw, committed } = mergedDiamond(1, maxPolicy);
    sum.value = 10;
    expect(raw).toEqual([4, 2.5]);
    expect(committed).toEqual([4, 4]);
    expect(root.value).toBe(4);
    expect(merged.value).toBe(4); // identity-view: merged.value === root.value
  });

  it("order-independence: swapping the fan-in order yields the same root value", () => {
    function diamondReversed(rootInit: number) {
      const root = num(rootInit);
      const merged = root.merge(maxPolicy);
      const a = merged.add(1);
      const b = merged.scale(2);
      const sum = Num.lens(
        [b, a] as const,
        ([bv, av]) => av + bv,
        (target, [bv, av]) => {
          const tot = av + bv;
          if (tot === 0) return [target / 2, target / 2];
          return [(target * bv) / tot, (target * av) / tot];
        },
      );
      return { root, sum };
    }
    const forward = mergedDiamond(1, maxPolicy);
    forward.sum.value = 10;
    const reversed = diamondReversed(1);
    reversed.sum.value = 10;
    expect(reversed.root.value).toBe(forward.root.value);
  });

  it("sequential propagations don't bleed: each starts from policy.identity", () => {
    const { root, merged, sum } = mergedDiamond(1, maxPolicy);
    sum.value = 10;
    expect(root.value).toBe(4);
    sum.value = 4;
    // After 1st cascade: root=4, a=5, b=8, sum_view=13. So sum=4
    // distributes: a'=4*5/13, b'=4*8/13; merged via a.bwd ≈ 0.538;
    // merged via b.bwd ≈ 1.231; max ≈ 1.231.
    expect(root.value).toBeCloseTo(1.231, 2);
    expect(peekMergeAcc(merged)).toBeCloseTo(1.231, 2);
  });
});

describe("idempotent merge: min", () => {
  it("dual of max — picks the smaller contribution", () => {
    const { root, sum, raw, committed } = mergedDiamond(1, minPolicy);
    sum.value = 10;
    expect(raw).toEqual([4, 2.5]);
    expect(committed).toEqual([4, 2.5]);
    expect(root.value).toBe(2.5);
  });
});

describe("multiple top-level writes are SEPARATE cascades (with or without batch)", () => {
  it("two top-level writes without batch: each is its own cascade", () => {
    const { root, a, b, committed } = mergedDiamond(1, maxPolicy);
    a.value = 7; // merged via a.bwd = 6
    b.value = 9; // merged via b.bwd = 4.5
    expect(committed).toEqual([6, 4.5]);
    expect(root.value).toBe(4.5);
  });

  it("two top-level writes INSIDE a batch: same outcome", () => {
    const { root, a, b, raw, committed } = mergedDiamond(1, maxPolicy);
    batch(() => {
      a.value = 7;
      b.value = 9;
    });
    expect(raw).toEqual([6, 4.5]);
    expect(committed).toEqual([6, 4.5]);
    expect(root.value).toBe(4.5);
  });

  it("to combine multiple writes into one cascade, use a fan-in", () => {
    const { root, sum } = mergedDiamond(1, maxPolicy);
    sum.value = 10; // ONE user call, ONE cascade, TWO contributions
    expect(root.value).toBe(4); // max(4, 2.5) — combined
  });
});
