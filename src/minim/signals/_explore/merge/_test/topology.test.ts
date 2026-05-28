// topology.test.ts — the `.merge()` chain method against a
// representative sample of DAG shapes and lens kinds, NOT just the
// canonical `_fanin` diamond.
//
// The premise: the merge must work uniformly across all the ways a
// user can construct lenses. The slot identity is the upstream lens
// cell (caller of the merge cell's setter), so any lens that goes
// through the engine's `_setWithExclusion` path — which is all of
// them, since that's the only legal write route — inherits the
// dedupe-by-slot guarantee.

import { describe, expect, it } from "vitest";
import {
  batch,
  field,
  maxPolicy,
  Num,
  num,
  peekMergeSlots,
  Signal,
  spreadPolicy,
  sumPolicy,
  Vec,
  vec,
} from "../index";

function installNumLens(getter: () => number, setter: (v: number) => void): Num {
  return Signal.install(
    Num as unknown as new (...args: never[]) => Signal<number>,
    getter,
    setter,
  ) as unknown as Num;
}

describe("1. asymmetric bwd paths through the merge", () => {
  it("a short path (1 lens) and a long path (3 fused lenses) compose distinct slots", () => {
    const merged = num(10).merge(maxPolicy);
    const short = merged.add(1); // 1 hop in fused chain
    const long = merged.add(1).scale(2).add(5); // 3 hops, fuses to 1 cell
    const sum = Num.lens(
      [short, long] as const,
      ([s, l]) => s + l,
      (target, [s, l]) => {
        const tot = s + l || 1;
        return [(target * s) / tot, (target * l) / tot];
      },
    );
    sum.value = 60;
    expect(peekMergeSlots(merged)!.size).toBe(2);
  });

  it("sequential writes to different-depth lenses don't poison each other's slot", () => {
    const merged = num(0).merge(maxPolicy);
    const short = merged.add(1);
    const long = merged.scale(2).add(3);
    short.value = 50;
    expect(merged.value).toBe(49); // 50 - 1
    long.value = 100;
    // Fresh cascade; max sees only the one new contribution
    // (merged via long.bwd = (100 - 3) / 2 = 48.5).
    expect(merged.value).toBe(48.5);
  });
});

describe("2. field lenses via field() composed with .merge()", () => {
  it("two field lenses on the same object merge cell are distinct slots", () => {
    // Use spreadPolicy: each field write spreads against the
    // current root, producing a full object as its raw arrival.
    // Per-slot dedupe + spread fold preserves both partial updates.
    type Stats = { hp: number; mana: number };
    const root = num<Stats>({ hp: 100, mana: 50 });
    const merged = root.merge(spreadPolicy<Stats>({ hp: 100, mana: 50 }));
    const hp = field(merged as unknown as Signal<Stats>, "hp", Num);
    const mana = field(merged as unknown as Signal<Stats>, "mana", Num);
    const fan = Signal.install(
      Num as unknown as new (...args: never[]) => Signal<number>,
      () => hp.value + mana.value,
      (_t: number) => {
        // Distribute trivially: write 75 to hp, 30 to mana.
        // The exact target shape doesn't matter for this test;
        // we want both field-lens setters to fire in one cascade.
        batch(() => {
          hp.value = 75;
          mana.value = 30;
        });
      },
    ) as unknown as Num;
    fan.value = 105;
    expect(root.value).toEqual({ hp: 75, mana: 30 });
  });

  it("Vec.x and Vec.y as slots; spread merge per axis", () => {
    type V = { x: number; y: number };
    const root = vec(0, 0) as unknown as Signal<V>;
    const merged = root.merge(spreadPolicy<V>({ x: 0, y: 0 }));
    const v = merged as unknown as Vec;
    const fan = Signal.install(
      Vec as unknown as new (...args: never[]) => Signal<V>,
      () => v.value,
      (_t: V) => {
        batch(() => {
          v.x.value = 7;
          v.y.value = 9;
        });
      },
    ) as unknown as Vec;
    fan.value = { x: 7, y: 9 };
    expect(root.value).toEqual({ x: 7, y: 9 });
  });
});

describe("3. multiple fan-ins through the same merge", () => {
  it("two separate top-level fan-in writes are TWO cascades", () => {
    const merged = num(1).merge(sumPolicy);
    const a = merged.add(1);
    const b = merged.scale(2);
    const c = merged.add(10);
    const d = merged.scale(3);
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
    // After the batch, slot map reflects ONLY the LAST cascade's
    // slots (fanCD's → c, d).
    expect(peekMergeSlots(merged)!.size).toBe(2);
  });

  it("two fan-ins composed under a SINGLE outer fan-in: one cascade, four slots", () => {
    const merged = num(1).merge(sumPolicy);
    const a = merged.add(1);
    const b = merged.scale(2);
    const c = merged.add(10);
    const d = merged.scale(3);
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
    expect(peekMergeSlots(merged)!.size).toBe(4);
  });

  it("the SAME fan-in fired twice in one batch dedupes per-slot", () => {
    const merged = num(1).merge(sumPolicy);
    const a = merged.add(1);
    const b = merged.scale(2);
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
      fan.value = 6;
    });
    // Even after the batch (which contains 2 separate cascades),
    // the slot map at the END holds 2 entries (a, b) with values
    // from the LAST cascade (fan.value = 6).
    expect(peekMergeSlots(merged)!.size).toBe(2);
  });
});

describe("4. nested fan-ins", () => {
  it("inner fan-in's outputs are NOT slots — only leaf-most writers above merge are", () => {
    // outer.bwd splits to (inner, c). inner.bwd then splits to
    // (a, b). All three (a, b, c) end up writing through `merged`,
    // each as their own slot. `inner` ISN'T a slot — it never
    // writes merged directly; it dispatches further to a and b.
    const merged = num(1).merge(sumPolicy);
    const a = merged.add(1);
    const b = merged.scale(2);
    const c = merged.add(10);
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
    expect(peekMergeSlots(merged)!.size).toBe(3);
  });
});

describe("5. raw Signal.install user-authored lenses", () => {
  it("a hand-rolled lens is a slot like an engine-built one (when both share one cascade)", () => {
    const merged = num(0).merge(sumPolicy);
    const handRolled = installNumLens(
      () => merged.value * 2,
      v => {
        merged.value = v / 2;
      },
    );
    const engineBuilt = merged.add(10);
    const fan = Num.lens(
      [handRolled, engineBuilt] as const,
      ([h, e]) => h + e,
      (t, [h, e]) => {
        const tot = h + e || 1;
        return [(t * h) / tot, (t * e) / tot];
      },
    );
    fan.value = 33;
    expect(peekMergeSlots(merged)!.size).toBe(2);
    expect(Number.isFinite(merged.value)).toBe(true);
  });

  it("a hand-rolled lens that calls another lens has TWO slots", () => {
    // outer's setter writes merged twice: once through `inner` (slot
    // identity = inner) and once directly (slot identity = outer).
    // Two distinct slots, both contribute.
    const merged = num(0).merge(sumPolicy);
    const inner = installNumLens(
      () => merged.value,
      v => {
        merged.value = v;
      },
    );
    const outer = installNumLens(
      () => merged.value,
      v => {
        inner.value = v; // contributes under slot `inner`
        merged.value = v + 100; // contributes under slot `outer`
      },
    );
    outer.value = 1;
    expect(merged.value).toBe(102); // inner: 1, outer: 101
    expect(peekMergeSlots(merged)!.size).toBe(2);
  });
});

describe("6. coverage: every test produces a deterministic value", () => {
  it("a smoke run produces finite values, not NaN/Infinity", () => {
    const merged = num(1).merge(sumPolicy);
    const a = merged.add(1);
    const b = merged.scale(2);
    const fan = Num.lens(
      [a, b] as const,
      ([av, bv]) => av + bv,
      (t, [av, bv]) => {
        const tot = av + bv || 1;
        return [(t * av) / tot, (t * bv) / tot];
      },
    );
    fan.value = 10;
    expect(Number.isFinite(merged.value)).toBe(true);
  });
});
