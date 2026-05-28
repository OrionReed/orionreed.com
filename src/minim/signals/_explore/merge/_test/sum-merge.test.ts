// sum-merge.test.ts — non-idempotent fold (sum) within a propagation,
// using the `.merge()` chain method. The slot-keyed dedupe makes sum
// correct under arbitrary upstream lens authoring: any lens that
// writes its parent multiple times in one cascade counts as one
// contribution per slot (the last write).
//
// ⚠ See semantic-guarantees.test.ts for the user-facing contract.
//   `raw`/`committed` arrays here observe per-arrival arrival order
//   and intermediate fold values — both implementation details, not
//   contract. The G4 (per-slot dedupe) and G5 (commutative fold)
//   guarantees are what users should rely on.

import { describe, expect, it } from "vitest";
import { batch, Num, num, Signal, sumPolicy } from "../index";

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
  const merged = root.merge(sumPolicy);
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

describe("sum merge: in-cascade behaviour", () => {
  it("sum-of-contributions: diamond cascade adds both deposits", () => {
    const { root, sum, raw, committed } = mergedDiamond(1);
    sum.value = 10;
    expect(raw).toEqual([4, 2.5]);
    expect(committed).toEqual([4, 6.5]);
    expect(root.value).toBe(6.5);
  });

  it("order-independence: cascade with reversed lens order yields same sum", () => {
    function diamondReversed(rootInit: number) {
      const root = num(rootInit);
      const merged = root.merge(sumPolicy);
      const a = merged.add(1);
      const b = merged.scale(2);
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
    expect(rev.root.value).toBeCloseTo(fwd.root.value);
  });

  it("sequential propagations reset: each cascade sums its own deposits only", () => {
    const { root, sum } = mergedDiamond(1);
    sum.value = 10;
    expect(root.value).toBe(6.5);
    sum.value = 20.5;
    expect(root.value).toBe(13);
  });
});

describe("sum merge: same-source repeats are dedupe'd, not double-counted", () => {
  it("a lens that writes to its parent twice in one batch counts as ONE contribution", () => {
    const root = num(0);
    const merged = root.merge(sumPolicy);
    const naughty = installNumLens(
      () => merged.value,
      v => {
        batch(() => {
          merged.value = v;
          merged.value = v;
        });
      },
    );
    naughty.value = 5;
    expect(root.value).toBe(5);
  });

  it("a single lens writing its parent multiple times keeps the last value (within its own cascade)", () => {
    const root = num(0);
    const merged = root.merge(sumPolicy);
    const lens = installNumLens(
      () => merged.value,
      v => {
        batch(() => {
          merged.value = v;
          merged.value = v + 1;
          merged.value = v + 2;
        });
      },
    );
    lens.value = 1;
    expect(root.value).toBe(3);
  });

  it("two SEPARATE top-level writes are separate cascades; merge resets between", () => {
    const root = num(0);
    const merged = root.merge(sumPolicy);
    const lensA = installNumLens(
      () => merged.value,
      v => {
        merged.value = v;
      },
    );
    const lensB = installNumLens(
      () => merged.value,
      v => {
        merged.value = v * 10;
      },
    );
    lensA.value = 1;
    lensB.value = 2;
    expect(root.value).toBe(20);
  });

  it("re-entry of the same lens setter within one cascade is one slot", () => {
    const root = num(0);
    const merged = root.merge(sumPolicy);
    const lens = installNumLens(
      () => merged.value,
      v => {
        batch(() => {
          merged.value = v;
          const observed = merged.value;
          merged.value = observed + 100;
        });
      },
    );
    lens.value = 7;
    expect(root.value).toBe(107);
  });
});
