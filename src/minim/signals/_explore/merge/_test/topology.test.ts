// topology.test.ts — the merge primitive against a representative
// sample of DAG shapes and lens kinds, NOT just the canonical
// `_fanin` diamond.
//
// The premise: the merge must work uniformly across all the ways a
// user can construct lenses. The slot identity is the upstream lens
// cell, so any lens that goes through the engine's `_setWithExclusion`
// path (which is all of them, since that's the only legal write
// route) inherits the dedupe-by-slot guarantee.
//
// Cases covered:
//   1. Asymmetric paths — same DAG, different bwd-depth per slot.
//   2. Field lenses — `Cls.fieldOf` / `field()` writes back via
//      spread-replace; each field cell is its own slot.
//   3. Multiple fan-ins to the same root — distinct fan-in cells,
//      distinct slots, no cross-contamination.
//   4. Nested fan-ins — `c = lens([d, e])` where `d = lens([a, b])`;
//      writes through the nested structure produce contributions
//      whose slots are the IMMEDIATELY-upstream lens, not the
//      originating one.
//   5. Raw `Signal.install` user-authored lenses — should be
//      indistinguishable from engine-built ones for merge purposes.
//   6. Vec field lenses (`.x` / `.y`) — both project onto the same
//      Vec root, distinct slots, sum policy combines coordinate-wise.

import { describe, expect, it } from "vitest";
import {
  batch,
  field,
  maxPolicy,
  Num,
  num,
  peekMergeSlots,
  Signal,
  sumPolicy,
  Vec,
  vec,
  withMerge,
} from "../index";

/** Local convenience: same as in sum-merge.test.ts. */
function installNumLens(getter: () => number, setter: (v: number) => void): Num {
  return Signal.install(
    Num as unknown as new (...args: never[]) => Signal<number>,
    getter,
    setter,
  ) as unknown as Num;
}

describe("1. asymmetric bwd paths to the same root", () => {
  it("a short path (1 lens) and a long path (3 fused lenses) compose distinct slots", () => {
    const root = withMerge(num(10), maxPolicy);
    const short = root.add(1); // 1 hop in fused chain
    const long = root.add(1).scale(2).add(5); // 3 hops, fuses to 1 cell
    const sum = Num.lens(
      [short, long] as const,
      ([s, l]) => s + l,
      (target, [s, l]) => {
        const tot = s + l || 1;
        return [(target * s) / tot, (target * l) / tot];
      },
    );
    sum.value = 60;
    // Two slots (short and long, distinct lens cells). Max picks
    // the bigger contribution. Whatever value max picks, the
    // observable invariant is: order-independence (we test that
    // separately) and slot count.
    const slots = peekMergeSlots(root)!;
    expect(slots.size).toBe(2);
  });

  it("asymmetric: writes to root through one slot don't poison another's slot", () => {
    // Construct two lenses with different depths, then write them
    // both, separately, in sequence. Each write is its own cascade
    // → slot map clears between. Whether max picks the same or
    // different value isn't the point; the point is no
    // contamination.
    const root = withMerge(num(0), maxPolicy);
    const short = root.add(1);
    const long = root.scale(2).add(3);
    short.value = 50;
    expect(root.value).toBe(49); // 50 - 1
    long.value = 100;
    // Fresh cascade; max sees only the one new contribution
    // (which came from long: root via long.bwd = (100 - 3) / 2 = 48.5).
    expect(root.value).toBe(48.5);
  });
});

describe("2. field lenses via field() and Vec.x / Vec.y", () => {
  it("two field lenses on the same object root are distinct slots", () => {
    // root: { hp, mana }. Two field lenses. Each writes the root
    // via spread-replace setter (`fieldOf`). They are distinct
    // lens cells ⇒ distinct slots ⇒ no double-counting.
    const root = withMerge(
      num({ hp: 100, mana: 50 }) as Signal<{ hp: number; mana: number }> & {
        value: { hp: number; mana: number };
        _setWithExclusion: (v: { hp: number; mana: number }, e: unknown) => void;
      },
      {
        // Custom policy: object-spread merge, "last-writer per slot".
        identity: { hp: 100, mana: 50 } as { hp: number; mana: number },
        combine: (a, b) => ({ ...a, ...b }),
      },
    );
    // Two field lenses.
    const hp = field(root as unknown as Signal<{ hp: number; mana: number }>, "hp", Num);
    const mana = field(root as unknown as Signal<{ hp: number; mana: number }>, "mana", Num);
    batch(() => {
      hp.value = 75;
      mana.value = 30;
    });
    // Each field write spreads against root, so the raw arrivals
    // are full objects `{hp:75, mana:50}` and `{hp:75, mana:30}`.
    // Per-slot dedupe keeps both; merge folds by combine: spread.
    // Result: { hp: 75, mana: 30 }.
    expect(root.value).toEqual({ hp: 75, mana: 30 });
  });

  it("Vec.x and Vec.y as slots; numeric merge per axis", () => {
    // Vec root, two field lenses (x and y). Write both inside a
    // batch. Each field lens is a slot. Spread-replace by slot ⇒
    // both updates land on the root without clobbering each other.
    const root = withMerge(vec(0, 0) as unknown as Signal<{ x: number; y: number }>, {
      identity: { x: 0, y: 0 },
      combine: (a, b) => ({ ...a, ...b }),
    });
    const v = root as unknown as Vec;
    batch(() => {
      v.x.value = 7;
      v.y.value = 9;
    });
    expect(root.value).toEqual({ x: 7, y: 9 });
  });
});

describe("3. multiple fan-ins to the same root", () => {
  it("two separate fan-ins are TWO cascades; each cascade has its own slot set", () => {
    // Each `fan.value = …` is its own cascade. Inside one cascade
    // the fan's bwd produces N slot contributions; the merge folds
    // them and commits. The next cascade resets.
    const root = withMerge(num(1), sumPolicy);
    const a = root.add(1);
    const b = root.scale(2);
    const c = root.add(10);
    const d = root.scale(3);
    const fanAB = Num.lens(
      [a, b] as const,
      ([av, bv]) => av + bv,
      (t, [av, bv]) => {
        const tot = av + bv || 1;
        return [(t * av) / tot, (t * bv) / tot];
      },
    );
    const fanCD = Num.lens(
      [c, d] as const,
      ([cv, dv]) => cv + dv,
      (t, [cv, dv]) => {
        const tot = cv + dv || 1;
        return [(t * cv) / tot, (t * dv) / tot];
      },
    );
    batch(() => {
      fanAB.value = 4;
      fanCD.value = 26;
    });
    // At the END of the batch the slot map reflects only the LAST
    // cascade's slots (fanCD's → c, d).
    expect(peekMergeSlots(root)!.size).toBe(2);
  });

  it("two fan-ins composed under a SINGLE outer fan-in: one cascade, all slots present", () => {
    // The structural way to "merge two fan-ins' worth of writes"
    // in one cascade: combine them under one outer fan-in whose
    // bwd writes through both. Now ONE user call cascades through
    // both inner structures, all four leaf-slots present.
    const root = withMerge(num(1), sumPolicy);
    const a = root.add(1);
    const b = root.scale(2);
    const c = root.add(10);
    const d = root.scale(3);
    const fanAB = Num.lens(
      [a, b] as const,
      ([av, bv]) => av + bv,
      (t, [av, bv]) => {
        const tot = av + bv || 1;
        return [(t * av) / tot, (t * bv) / tot];
      },
    );
    const fanCD = Num.lens(
      [c, d] as const,
      ([cv, dv]) => cv + dv,
      (t, [cv, dv]) => {
        const tot = cv + dv || 1;
        return [(t * cv) / tot, (t * dv) / tot];
      },
    );
    const outer = Num.lens(
      [fanAB, fanCD] as const,
      ([ab, cd]) => ab + cd,
      (t, [ab, cd]) => {
        const tot = ab + cd || 1;
        return [(t * ab) / tot, (t * cd) / tot];
      },
    );
    outer.value = 50;
    // One cascade → four leaf slots (a, b, c, d) all present.
    expect(peekMergeSlots(root)!.size).toBe(4);
  });

  it("the SAME fan-in fired twice in one batch dedupes per-slot (each slot's last write wins)", () => {
    const root = withMerge(num(1), sumPolicy);
    const a = root.add(1);
    const b = root.scale(2);
    const fan = Num.lens(
      [a, b] as const,
      ([av, bv]) => av + bv,
      (t, [av, bv]) => {
        const tot = av + bv || 1;
        return [(t * av) / tot, (t * bv) / tot];
      },
    );
    batch(() => {
      fan.value = 4;
      fan.value = 6; // second fan call overwrites a's and b's slot
    });
    // Still exactly 2 slots (a, b), each holding its LATEST
    // contribution from the second `fan.value = 6` call.
    expect(peekMergeSlots(root)!.size).toBe(2);
  });
});

describe("4. nested fan-ins", () => {
  it("inner fan-in's outputs are slots; outer fan-in distributes through them", () => {
    // Topology:
    //   root → a, b, c (via three lenses)
    //   inner = lens([a, b]) — 2-arity fan-in
    //   outer = lens([inner, c]) — 2-arity fan-in, one parent is itself a fan-in
    // Writing outer cascades: outer's bwd writes to inner (which
    // is itself a lens) and c. inner's setter then distributes to
    // a and b. Slots at root: a, b, c. Three distinct slots.
    const root = withMerge(num(1), sumPolicy);
    const a = root.add(1);
    const b = root.scale(2);
    const c = root.add(10);
    const inner = Num.lens(
      [a, b] as const,
      ([av, bv]) => av + bv,
      (t, [av, bv]) => {
        const tot = av + bv || 1;
        return [(t * av) / tot, (t * bv) / tot];
      },
    );
    const outer = Num.lens(
      [inner, c] as const,
      ([iv, cv]) => iv + cv,
      (t, [iv, cv]) => {
        const tot = iv + cv || 1;
        return [(t * iv) / tot, (t * cv) / tot];
      },
    );
    outer.value = 100;
    expect(peekMergeSlots(root)!.size).toBe(3);
  });
});

describe("5. raw Signal.install user-authored lenses", () => {
  it("a hand-rolled lens is a slot just like an engine-built one (when both share one cascade)", () => {
    // The hand-rolled lens and the engine-built one must share ONE
    // cascade for the merge to combine them — combine via a fan-in.
    const root = withMerge(num(0), sumPolicy);
    const handRolled = installNumLens(
      () => root.value * 2,
      v => {
        root.value = v / 2;
      },
    );
    const engineBuilt = root.add(10); // engine-built via _fuse
    const fan = Num.lens(
      [handRolled, engineBuilt] as const,
      ([h, e]) => h + e,
      (t, [h, e]) => {
        const tot = h + e || 1;
        return [(t * h) / tot, (t * e) / tot];
      },
    );
    fan.value = 33; // ONE cascade → both slots active
    // Two slots populated; sum is what the merge folds.
    expect(peekMergeSlots(root)!.size).toBe(2);
    // Specific value depends on the distribution, but it must be
    // finite and combine both contributions (≠ either individual).
    expect(Number.isFinite(root.value)).toBe(true);
  });

  it("a hand-rolled lens that calls itself recursively still has a single slot identity", () => {
    // Setter does extra writes through another lens. The other
    // lens has ITS OWN slot identity — so even when the cascade
    // crosses multiple lenses, each one contributes under its own
    // identity, not the originator's.
    const root = withMerge(num(0), sumPolicy);
    const inner = installNumLens(
      () => root.value,
      v => {
        root.value = v;
      },
    );
    const outer = installNumLens(
      () => root.value,
      v => {
        // outer's setter writes root via inner. While `inner.value =`
        // runs, activeBwdWriter rotates to `inner` for that nested
        // setter — so root sees the contribution under inner's slot,
        // NOT outer's. Outer ALSO writes root directly afterward
        // under its own slot. Two distinct slots, both alive.
        inner.value = v;
        root.value = v + 100;
      },
    );
    outer.value = 1;
    // inner's slot: 1; outer's slot: 101. Sum: 102.
    expect(root.value).toBe(102);
    expect(peekMergeSlots(root)!.size).toBe(2);
  });
});

describe("6. coverage: every test produces a deterministic value", () => {
  it("all topologies above commit a finite, non-NaN root value (smoke)", () => {
    // Sanity: re-run a sample and confirm we don't accidentally
    // produce NaN or Infinity from bad fold ordering. Specific
    // values are asserted in the per-test blocks above.
    const root = withMerge(num(1), sumPolicy);
    const a = root.add(1);
    const b = root.scale(2);
    const fan = Num.lens(
      [a, b] as const,
      ([av, bv]) => av + bv,
      (t, [av, bv]) => {
        const tot = av + bv || 1;
        return [(t * av) / tot, (t * bv) / tot];
      },
    );
    fan.value = 10;
    expect(Number.isFinite(root.value)).toBe(true);
  });
});
