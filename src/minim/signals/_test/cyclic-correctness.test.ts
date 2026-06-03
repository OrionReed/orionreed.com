// cyclic-correctness.test.ts — the "non-invertible example" the chat
// raised: stateful lenses (cyclic) composed with arbitrary receivers
// must see the genuine intermediate state, not a side-channel.
//
// Original implementation: `cyclic` declared `bwdStateless: true` while
// its bwd captured `this.peek()` to read the receiver. New impl:
// `cyclic` is declared `"stateful"` and uses the engine-supplied `s`
// argument. `_fuse` threads `priorFwd(s)` honestly so the bwd sees
// the genuine intermediate value at the cyclic layer's input position.
//
// These tests assert observational equivalence with a hand-rolled
// (un-fused) reference implementation across mixed compositions.

import { describe, expect, it } from "vitest";
import { Num, num } from "../index";

const TAU = 2 * Math.PI;

describe("cyclic correctness — engine-supplied state argument", () => {
  it("cyclic alone: shortest-arc on write (regression baseline)", () => {
    const a = num(10 * Math.PI);
    const c = a.cyclic(TAU);
    expect(c.value).toBe(10 * Math.PI);
    c.value = 0.1;
    expect(Math.abs(a.value - (10 * Math.PI + 0.1))).toBeLessThan(0.5);
  });

  it("cyclic above scale: bwd reads the intermediate (scaled) state", () => {
    const a = num(10 * Math.PI);
    const c = a.scale(2).cyclic(TAU);
    expect(c.value).toBe(20 * Math.PI);
    c.value = 0.2;
    expect(c.value).toBeCloseTo(20 * Math.PI + 0.2, 6);
    expect(a.value).toBeCloseTo(10 * Math.PI + 0.1, 6);
  });

  it("cyclic above clamp: a no-op at the clamp view is absorbed", () => {
    // Pivot semantics: writing 10.1 maps through cyclic to ~10.1 at the
    // clamp's input, which clamps back to 10 — the clamp's projected view
    // is unchanged, so the backward edit is absorbed (the off-range
    // source is left intact). `c` re-reads to the clamped value.
    const a = num(50);
    const c = a.clamp(0, 10).cyclic(TAU);
    expect(c.value).toBe(10);
    c.value = 10.1;
    expect(a.value).toBe(50); // absorbed — source untouched
    expect(c.value).toBe(10); // view snaps back to the clamped projection
  });

  it("two cyclics stacked: outer sees inner's identity-fwd state", () => {
    const a = num(0);
    const c = a.cyclic(TAU).cyclic(Math.PI);
    expect(c.value).toBe(0);
    c.value = Math.PI - 0.01;
    expect(a.value).toBeCloseTo(-0.01, 6);
  });

  it("cyclic above add: bwd reads (a + offset) as state", () => {
    const a = num(10 * Math.PI);
    const c = a.add(Math.PI).cyclic(TAU);
    expect(c.value).toBe(11 * Math.PI);
    c.value = 11 * Math.PI - 0.1;
    expect(a.value).toBeCloseTo(10 * Math.PI - 0.1, 6);

    a.value = 10 * Math.PI;
    c.value = 12 * Math.PI - 0.1;
    expect(a.value).toBeCloseTo(11 * Math.PI - 0.1, 6);
  });

  it("hand-rolled reference: equivalence under composition", () => {
    function makeFused(): { a: Num; c: Num } {
      const a = num(0) as Num;
      const c = (a as Num & { value: number }).scale(2).clamp(0, 100).cyclic(TAU);
      return { a, c: c as Num };
    }
    function makeReference(): { a: Num; c: Num } {
      const a = num(0);
      const sLens = Num.lens(
        () => a.value * 2,
        v => {
          a.value = v / 2;
        },
      );
      const cLens = Num.lens(
        () => {
          const v = sLens.value;
          return v < 0 ? 0 : v > 100 ? 100 : v;
        },
        v => {
          sLens.value = v < 0 ? 0 : v > 100 ? 100 : v;
        },
      );
      const yLens = Num.lens(
        () => cLens.value,
        v => {
          const cur = cLens.peek();
          const p = TAU;
          const delta = v - cur;
          cLens.value = cur + delta - p * Math.round(delta / p);
        },
      );
      return { a, c: yLens as Num };
    }

    const fused = makeFused();
    const ref = makeReference();

    const writes = [5, 50, 0.5, 25.7, 99, 100.5, -3, 12 + TAU, 12, 12 - TAU];
    for (const w of writes) {
      (fused.c as Num & { value: number }).value = w;
      (ref.c as Num & { value: number }).value = w;
      expect(fused.a.value).toBeCloseTo(ref.a.value, 9);
      expect(fused.c.value).toBeCloseTo(ref.c.value, 9);
    }
  });
});
