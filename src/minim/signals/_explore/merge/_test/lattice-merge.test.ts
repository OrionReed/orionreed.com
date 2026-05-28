// lattice-merge.test.ts — §10 step 2: order-independent merge with
// idempotent fold (max / min). This is the "cost gradient cheap
// path" from §3: no buffering, no ordering, no epoch — fold each
// contribution into an accumulator on arrival and let it descend
// eagerly.
//
// Success criteria for the prototype:
//   1. Order-of-arrival doesn't change the final value.
//   2. The result matches the fold of all contributions in the
//      cascade, not the last-write-wins clobber of the baseline.
//   3. Sequential propagations don't bleed into each other.
//   4. Explicit `batch(() => { ... })` over multiple top-level
//      writes combines them under the policy.

import { describe, expect, it } from "vitest";
import { batch, maxPolicy, minPolicy, Num, num, peekMergeAcc, withMerge } from "../index";

/** Diamond fixture matching `baseline.test.ts`, but the root is
 *  pre-merged with `policy`. Tracks BOTH the raw contributions
 *  arriving at the merge intercept (`raw`) and the values committed
 *  downstream after folding (`committed`). The two diverge for any
 *  non-trivial policy — the divergence IS the merge. */
function mergedDiamond(rootInit: number, policy: Parameters<typeof withMerge<number>>[1]) {
  const root = num(rootInit);
  const committed: number[] = [];
  // Wrap-then-merge: our logger sits BELOW the merge intercept, so
  // the values it captures are the folded `acc` values that the
  // engine actually commits.
  const origSet = root._setWithExclusion.bind(root);
  root._setWithExclusion = function (next, excluding) {
    committed.push(next);
    origSet(next, excluding);
  };
  withMerge(root, policy);
  // The merge intercept now wraps OVER our logger. To also capture
  // the RAW pre-fold values, we wrap one more layer on top.
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

describe("idempotent merge: max", () => {
  it("combines diamond bwd writes via Math.max instead of last-wins", () => {
    // root=1: a=2, b=2; sum=4. Write sum=10.
    // distribute: a'=5, b'=5; root via a.bwd = 4; root via b.bwd = 2.5
    // Baseline picks 2.5 (last); max picks 4.
    const { root, sum, raw, committed } = mergedDiamond(1, maxPolicy);
    sum.value = 10;
    // Two raw contributions arrive: 4 (from a.bwd) and 2.5 (from
    // b.bwd). The fold combines them with max; on each arrival the
    // running max is committed.
    expect(raw).toEqual([4, 2.5]);
    expect(committed).toEqual([4, 4]); // max(-Inf, 4)=4; max(4, 2.5)=4
    expect(root.value).toBe(4);
  });

  it("order-independence: swapping the fan-in order yields the same root value", () => {
    // Build the diamond with parents in [b, a] order. baseline.test.ts
    // showed this swap changes the last-wins winner; with `max` the
    // result must be invariant.
    function diamondReversed(rootInit: number) {
      const root = withMerge(num(rootInit), maxPolicy);
      const a = root.add(1);
      const b = root.scale(2);
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
    const { root, sum } = mergedDiamond(1, maxPolicy);
    sum.value = 10;
    expect(root.value).toBe(4); // max(4, 2.5)
    sum.value = 4;
    // Re-running with the new root=4: a=5, b=8, sum=13. So sum=4
    // distributes: tot=13; a' = 4*5/13 ≈ 1.538; b' = 4*8/13 ≈ 2.461;
    // root via a.bwd ≈ 0.538; root via b.bwd ≈ 1.231; max ≈ 1.231.
    // CRITICAL: this must be COMPUTED FRESH for the second
    // propagation, not contaminated by the prior cascade's
    // accumulator (which still held 4).
    expect(root.value).toBeCloseTo(1.231, 2);
    // Cross-check: the accumulator was reset between propagations.
    expect(peekMergeAcc(root)).toBeCloseTo(1.231, 2);
  });
});

describe("idempotent merge: min", () => {
  it("dual of max — picks the smaller contribution", () => {
    const { root, sum, raw, committed } = mergedDiamond(1, minPolicy);
    sum.value = 10;
    expect(raw).toEqual([4, 2.5]);
    expect(committed).toEqual([4, 2.5]); // min(+Inf,4)=4; min(4,2.5)=2.5
    expect(root.value).toBe(2.5);
  });
});

describe("multiple top-level writes are SEPARATE cascades (with or without batch)", () => {
  // The cascade boundary is "one user-initiated `.value =` call",
  // not "one batch". Batching is for FORWARD atomicity (subscribers
  // see one final state); it does NOT bundle backward writes into
  // a single merge cascade. To combine multiple lens writes into
  // one cascade, the user must construct a fan-in lens — which is
  // exactly the structural "add a merge node" contract.
  //
  // Conclusion: with or without batching, two top-level lens writes
  // produce two cascades; the merge resets between them; the final
  // root reflects only the second cascade's contribution.

  it("two top-level writes without batch: each is its own cascade", () => {
    const { root, a, b, committed } = mergedDiamond(1, maxPolicy);
    a.value = 7; // root via a.bwd = 6
    b.value = 9; // root via b.bwd = 4.5
    expect(committed).toEqual([6, 4.5]);
    expect(root.value).toBe(4.5);
  });

  it("two top-level writes INSIDE a batch: same outcome", () => {
    // The batch is observable only via forward propagation — any
    // subscriber sees one final fire. The merge sees two separate
    // cascades nonetheless.
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
    // The structural way to express "combine these": wrap them
    // in a lens. Then one user write → one cascade → all sub-
    // writes share the cascade id → merge folds across slots.
    const { root, sum } = mergedDiamond(1, maxPolicy);
    sum.value = 10; // ONE user call, ONE cascade, TWO contributions
    expect(root.value).toBe(4); // max(4, 2.5) — combined
  });
});
