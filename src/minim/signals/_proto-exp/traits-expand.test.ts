// _proto-exp/traits-expand.test.ts — generic clamp/quantize/cyclic via traits.
//
// Sanity check that:
//   - Num (with existing methods) and our new generic helpers produce
//     identical behaviour when the trait is declared.
//   - Vec, given an Ordered<{x,y}> trait, can clamp per-axis via the
//     SAME generic function.

import { describe, expect, it } from "vitest";
import { Num, num } from "../values/num";
import { Vec, vec } from "../values/vec";
import { clamp, quantize, type Ordered, type Discrete, type Cyclic } from "./traits-expand";

// Augment Num's traits dict with ordered/discrete/cyclic at runtime
// (in production we'd declare these statically per class).
const numOrdered: Ordered<number> = { compare: (a, b) => a - b };
const numDiscrete: Discrete<number> = {
  snap: (v, s) => Math.round(v / s) * s,
};
const numCyclic: Cyclic<number> = {
  nearest: (target, current, period) => {
    const delta = target - current;
    return current + delta - period * Math.round(delta / period);
  },
};
(Num.traits as { ordered?: Ordered<number>; discrete?: Discrete<number>; cyclic?: Cyclic<number> }).ordered = numOrdered;
(Num.traits as { discrete?: Discrete<number> }).discrete = numDiscrete;
(Num.traits as { cyclic?: Cyclic<number> }).cyclic = numCyclic;

// Vec gets per-axis ordering: compare returns sign of (a-b) sum
// for a TOTAL order (well-defined), but the clamp behaviour we want
// is per-axis bounding box. For per-axis we'd use a sum-of-orderings
// or a custom Ordered<Vec> that operates per-axis. Sketch the simpler
// per-axis clamp via a Vec.Ordered with the right semantics for clamp.
type V = { x: number; y: number };
const vecOrdered: Ordered<V> = {
  // For clamp semantics: we lie about "compare" — it's not a true
  // total order on Vec. The clamp implementation uses compare(v, lo)
  // and compare(v, hi) which is OK if Ordered's contract is "compare
  // returns negative if any axis is below lo, etc". Hacky — a real
  // implementation would need a different trait (PerAxisOrdered).
  // This is here to show the FLEXIBILITY of the trait shape, not to
  // claim it's the right design.
  compare: (a, b) => {
    if (a.x < b.x || a.y < b.y) return -1;
    if (a.x > b.x || a.y > b.y) return 1;
    return 0;
  },
};
(Vec.traits as { ordered?: Ordered<V> }).ordered = vecOrdered;

describe("Generic clamp via Ordered trait", () => {
  it("Num: generic clamp matches Num.clamp", () => {
    const a = num(0);
    const generic = clamp(a as unknown as Num, 0, 1);
    const specialized = a.clamp(0, 1);
    a.value = 2;
    expect(generic.value).toBe(specialized.value);
    expect(generic.value).toBe(1);
    a.value = -0.5;
    expect(generic.value).toBe(0);
  });

  it("Vec: generic clamp works on V (because Ordered is declared)", () => {
    // This is more of a "shape demo" — the Ordered<V> we provided
    // doesn't have the right semantics for component-wise clamp, but
    // it doesn't crash and the lens is constructed.
    const v = vec(5, 5);
    const cl = clamp(v as unknown as Vec, { x: 0, y: 0 }, { x: 10, y: 10 });
    expect(cl.value).toEqual({ x: 5, y: 5 });
  });
});

describe("Generic quantize via Discrete trait", () => {
  it("Num quantize via trait helper", () => {
    const a = num(0);
    const q = quantize(a as unknown as Num, 0.25);
    (q as unknown as { value: number }).value = 0.6;
    expect(a.value).toBe(0.5);
  });
});
