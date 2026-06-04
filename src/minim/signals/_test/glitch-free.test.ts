// glitch-free.test.ts — diamond-shape glitch-freedom under the new
// fusion. Effects downstream of a diamond must see consistent
// snapshots across both branches. alien-signals' two-phase
// notify-then-pull achieves this; these tests verify the new field-
// path fast path and law-driven setter dispatch preserve it.

import { describe, expect, it } from "vitest";
import { derive, effect, Num, num, cell, transform } from "../index";

describe("glitch-free: diamond shapes", () => {
  it("classic diamond: a → b1, a → b2, leaf reads (b1, b2)", () => {
    const a = cell(0);
    const b1 = derive(() => a.value + 1);
    const b2 = derive(() => a.value * 10);
    const observed: { b1: number; b2: number; aviabranches: number }[] = [];
    effect(() => {
      const v1 = b1.value;
      const v2 = b2.value;
      observed.push({ b1: v1, b2: v2, aviabranches: v1 - 1 });
    });
    a.value = 5;
    a.value = 10;
    for (const o of observed) {
      expect(o.b1 - 1).toBe(o.b2 / 10);
    }
    expect(observed[observed.length - 1]).toMatchObject({ b1: 11, b2: 100 });
  });

  it("3-deep field chain in diamond: tr.translate.x and tr.translate.y", () => {
    const tr = transform({ translate: { x: 0, y: 0 } });
    const x = tr.translate.x;
    const y = tr.translate.y;
    const observed: Array<{ x: number; y: number; sum: number }> = [];
    effect(() => {
      const xv = x.value;
      const yv = y.value;
      observed.push({ x: xv, y: yv, sum: xv + yv });
    });
    tr.value = { ...tr.value, translate: { x: 3, y: 4 } };
    tr.value = { ...tr.value, translate: { x: 10, y: 20 } };
    expect(observed[observed.length - 1]).toEqual({ x: 10, y: 20, sum: 30 });
    for (const o of observed) {
      expect(o.sum).toBe(o.x + o.y);
    }
  });

  it("equality short-circuit: re-fires only on actual change", () => {
    const a = num(5);
    const sq = Num.derive(a, v => v * v);
    let fires = 0;
    effect(() => {
      void sq.value;
      fires++;
    });
    fires = 0;
    a.value = -5;
    expect(fires).toBe(0);
    a.value = 6;
    expect(fires).toBe(1);
  });

  it("clamp (projection): two clamp lenses see same clamped value", () => {
    const a = num(50);
    const c1 = a.clamp(0, 10);
    const c2 = a.clamp(0, 10);
    const observed: Array<{ c1: number; c2: number }> = [];
    effect(() => {
      observed.push({ c1: c1.value, c2: c2.value });
    });
    a.value = 100;
    a.value = -50;
    a.value = 5;
    for (const o of observed) {
      expect(o.c1).toBe(o.c2);
    }
  });

  it("cyclic in diamond: fused chain agrees with sibling read", () => {
    const a = num(10 * Math.PI);
    const c = a.cyclic(2 * Math.PI);
    const observed: Array<{ raw: number; cyclic: number }> = [];
    effect(() => {
      observed.push({ raw: a.value, cyclic: c.value });
    });
    a.value = 11 * Math.PI;
    a.value = 12 * Math.PI;
    for (const o of observed) {
      expect(o.raw).toBe(o.cyclic);
    }
  });
});
