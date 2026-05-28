// multi-merge.test.ts — multiple merge cells in one DAG, in various
// topological arrangements. The contract: each merge cell is its own
// local fold; cross-cascade reset happens independently per cell;
// nothing leaks between them.

import { describe, expect, it } from "vitest";
import { maxPolicy, Num, num, peekMergeAcc, peekMergeSlots, sumPolicy } from "../index";

describe("two merges in PARALLEL above the same root", () => {
  it("each merge sees only the contributions arriving through its own chain", () => {
    // Topology:
    //   root → mergeA = root.merge(sum)
    //        → mergeB = root.merge(max)
    //   Writing through mergeA's children doesn't trigger mergeB's
    //   intercept (and vice versa). Verified by observable values
    //   on root, not by internal slot maps (which are reset lazily
    //   when a merge's own intercept fires next, not eagerly when
    //   some other merge fires).
    const root = num(0);
    const mergeA = root.merge(sumPolicy);
    const mergeB = root.merge(maxPolicy);
    const aChild = mergeA.add(1);
    aChild.value = 7;
    // Through mergeA: aChild.bwd(7) = 6 → mergeA slot[aChild] = 6
    //   → mergeA fold = sum(0, 6) = 6 → root = 6.
    expect(root.value).toBe(6);

    const bChild = mergeB.add(10);
    bChild.value = 50;
    // Through mergeB only: bChild.bwd(50) = 40 → mergeB slot[bChild] = 40
    //   → mergeB fold = max(-Inf, 40) = 40 → root = 40.
    // mergeA's intercept did NOT fire on this cascade, so root's
    // value comes entirely from mergeB's fold.
    expect(root.value).toBe(40);
  });

  it("introspecting slot maps between cascades shows lazy reset (internal detail)", () => {
    // Documenting the implementation: a merge's slot map only
    // resets when the merge's OWN setter fires (it checks cascade
    // id at entry). Between cascades that don't touch it, the
    // stale slot map persists. This is invisible to normal users
    // and only matters for debug introspection.
    const root = num(0);
    const mergeA = root.merge(sumPolicy);
    const mergeB = root.merge(maxPolicy);
    mergeA.value = 5; // mergeA fires, slot map populated
    expect(peekMergeSlots(mergeA)!.size).toBe(1);
    mergeB.value = 10; // mergeB fires, NOT mergeA
    // mergeA's stale slot map persists — but it's about to be
    // wiped on its next fire. Not user-visible.
    expect(peekMergeSlots(mergeA)!.size).toBe(1);
    expect(peekMergeSlots(mergeB)!.size).toBe(1);
    mergeA.value = 7; // mergeA fires; sees fresh cascade id; resets and re-populates
    expect(peekMergeSlots(mergeA)!.size).toBe(1);
    expect(peekMergeAcc(mergeA)).toBe(7);
  });

  it("writes through one merge don't trigger the other's intercept", () => {
    const root = num(0);
    const mergeA = root.merge(sumPolicy);
    const mergeB = root.merge(maxPolicy);
    mergeA.value = 5;
    expect(peekMergeAcc(mergeA)).toBe(5);
    expect(peekMergeAcc(mergeB)).toBe(Number.NEGATIVE_INFINITY); // never fired
  });
});

describe("merge-on-merge in series (stacking)", () => {
  it("outer merge's commit flows INTO inner merge's slot map", () => {
    // root → inner = root.merge(sum) → outer = inner.merge(max)
    // Writing fan above outer:
    //   - fan splits to two of outer's children
    //   - both children write outer; outer folds with max; commits to inner
    //   - inner sees outer as its one slot; folds with sum; commits to root
    const root = num(0);
    const inner = root.merge(sumPolicy);
    const outer = inner.merge(maxPolicy);
    const a = outer.add(1);
    const b = outer.scale(2);
    const fan = Num.lens(
      [a, b] as const,
      ([x, y]) => x + y,
      (t, [x, y]) => {
        const tot = x + y || 1;
        return [(t * x) / tot, (t * y) / tot];
      },
    );
    fan.value = 6;
    // outer slots: {a, b}; outer fold = max(5, 0) = 5 (root=0 → a=1,b=0; tot=1; updates [6,0]; a.bwd=5, b.bwd=0)
    // outer commits 5 to inner.
    // inner slots: {outer}=5; inner fold = sum(0, 5) = 5.
    // root = 5.
    expect(peekMergeSlots(outer)!.size).toBe(2);
    expect(peekMergeSlots(inner)!.size).toBe(1);
    expect(root.value).toBe(5);
  });

  it("the inner merge's slot key is the OUTER merge cell, not the leaf writer above outer", () => {
    const root = num(0);
    const inner = root.merge(sumPolicy);
    const outer = inner.merge(maxPolicy);
    outer.value = 10; // direct write at top
    const innerSlots = peekMergeSlots(inner)!;
    // The contribution to inner came from outer's setter, so the
    // slot key is `outer` itself (the cell whose setter wrote inner).
    expect(innerSlots.has(outer)).toBe(true);
  });
});

describe("W-shape: two merges feeding a downstream fan-in", () => {
  it("each merge folds its own contributions; fan-in writes both merges in one cascade", () => {
    // Topology:
    //   rootL → mergeL = rootL.merge(sum)
    //   rootR → mergeR = rootR.merge(sum)
    //   fan = lens([mergeL, mergeR], ...) — fan-in writing both
    const rootL = num(0);
    const rootR = num(100);
    const mergeL = rootL.merge(sumPolicy);
    const mergeR = rootR.merge(sumPolicy);
    const fan = Num.lens(
      [mergeL, mergeR] as const,
      ([l, r]) => l + r,
      (t, [_l, _r]) => {
        // Distribute fairly: each gets half.
        return [t / 2, t / 2];
      },
    );
    fan.value = 200;
    // Cascade splits 100 to mergeL and 100 to mergeR.
    // mergeL slot[fan] = 100, sum(0, 100) = 100 → rootL = 100.
    // mergeR slot[fan] = 100, sum(0, 100) = 100 → rootR = 100.
    expect(rootL.value).toBe(100);
    expect(rootR.value).toBe(100);
    expect(peekMergeSlots(mergeL)!.size).toBe(1);
    expect(peekMergeSlots(mergeR)!.size).toBe(1);
  });
});

describe("Y-shape: one merge fanning out to multiple chains downstream", () => {
  it("multiple branches off the merge each contribute their own slot when a downstream fan-in writes back", () => {
    const root = num(0);
    const merged = root.merge(sumPolicy);
    const branch1 = merged.add(1);
    const branch2 = merged.scale(2);
    const branch3 = merged.add(10);
    const collect = Num.lens(
      [branch1, branch2, branch3] as const,
      ([a, b, c]) => a + b + c,
      (t, [a, b, c]) => {
        const tot = a + b + c || 1;
        return [(t * a) / tot, (t * b) / tot, (t * c) / tot];
      },
    );
    collect.value = 30;
    // Three slots arrive at merge in one cascade.
    expect(peekMergeSlots(merged)!.size).toBe(3);
  });
});

describe("identical merge policies in parallel chains", () => {
  it("two separate merges with the SAME policy reference observe independent values on their roots", () => {
    const root1 = num(0);
    const root2 = num(0);
    const m1 = root1.merge(sumPolicy);
    const m2 = root2.merge(sumPolicy);
    m1.value = 5;
    expect(root1.value).toBe(5);
    expect(root2.value).toBe(0); // m2 never fired
    m2.value = 10;
    expect(root1.value).toBe(5); // unchanged (m1 didn't fire)
    expect(root2.value).toBe(10);
  });
});

describe("dense network: multiple roots, multiple merges, multiple fan-ins", () => {
  it("structurally complex graph settles to a consistent state", () => {
    // Three roots, each with its own merge, all feeding into one
    // big fan-in. Pure sanity smoke — exercise the engine under a
    // realistic load.
    const rA = num(1);
    const rB = num(2);
    const rC = num(3);
    const mA = rA.merge(sumPolicy);
    const mB = rB.merge(sumPolicy);
    const mC = rC.merge(sumPolicy);
    const aHandle = mA.add(0);
    const bHandle = mB.add(0);
    const cHandle = mC.add(0);
    const total = Num.lens(
      [aHandle, bHandle, cHandle] as const,
      ([a, b, c]) => a + b + c,
      (t, [a, b, c]) => {
        const tot = a + b + c || 1;
        return [(t * a) / tot, (t * b) / tot, (t * c) / tot];
      },
    );
    total.value = 60;
    // Each root commits proportionally: (1/6)*60, (2/6)*60, (3/6)*60.
    expect(rA.value).toBeCloseTo(10);
    expect(rB.value).toBeCloseTo(20);
    expect(rC.value).toBeCloseTo(30);
  });
});

describe("merge stacked deep (3+ levels)", () => {
  it("three merges in series still propagate correctly", () => {
    const root = num(0);
    const m1 = root.merge(sumPolicy);
    const m2 = m1.merge(sumPolicy);
    const m3 = m2.merge(sumPolicy);
    m3.value = 7;
    // m3 slot[DIRECT] = 7, fold = 7, commit to m2
    // m2 slot[m3] = 7, fold = 7, commit to m1
    // m1 slot[m2] = 7, fold = 7, commit to root
    expect(root.value).toBe(7);
  });

  it("deep stack with fan-in at the top: contributions cascade through every merge", () => {
    const root = num(0);
    const m1 = root.merge(sumPolicy);
    const m2 = m1.merge(sumPolicy);
    const m3 = m2.merge(sumPolicy);
    const a = m3.add(1);
    const b = m3.scale(2);
    const fan = Num.lens(
      [a, b] as const,
      ([x, y]) => x + y,
      (t, [x, y]) => {
        const tot = x + y || 1;
        return [(t * x) / tot, (t * y) / tot];
      },
    );
    fan.value = 6;
    // root=0 → m1=0 → m2=0 → m3=0 → a=1, b=0; total=1; updates [6, 0]; a.bwd=5, b.bwd=0
    // m3 slots {a, b}; fold = 5; commit to m2
    // m2 slots {m3} = 5; fold = 5; commit to m1
    // m1 slots {m2} = 5; fold = 5; commit to root = 5.
    expect(root.value).toBe(5);
  });
});
