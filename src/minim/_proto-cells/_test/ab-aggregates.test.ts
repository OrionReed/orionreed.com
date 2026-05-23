// ab-aggregates.test.ts — A/B parity tests for aggregate primitives.
//
// Each test pairs the original implementation (from `signals/`)
// against the prototype (from `_proto-cells/aggregates.ts`) and
// verifies they produce identical results across read+write
// scenarios. Where the prototype's behavior diverges intentionally,
// it's documented inline.

import { describe, expect, it } from "vitest";
import * as O from "@minim/signals";
import {
  argminNumLens,
  axesLens,
  centroidLens,
  maxLens,
  meanLens,
  midpointLens,
  minLens,
  polarCircular,
  sumLens,
} from "../aggregates";
import { Num as PNum, num as pnum, Vec as PVec, vec as pvec } from "../index";

const eq = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

describe("A/B: meanLens (Num) ↔ mix(Num, parts, mean, deltaEven)", () => {
  it("read parity", () => {
    const oA = O.num(1),
      oB = O.num(2),
      oC = O.num(3);
    const oMix = O.mix(O.Num, [oA, oB, oC], O.Mix.mean, O.Mix.deltaEven);

    const pA = pnum(1),
      pB = pnum(2),
      pC = pnum(3);
    const pMix = meanLens(PNum, [pA, pB, pC]);

    expect(oMix.value).toBe(2);
    expect(pMix.value).toBe(2);

    oA.value = 10;
    pA.value = 10;
    expect(oMix.value).toBeCloseTo(pMix.value);
  });

  it("write parity (delta-even distribution)", () => {
    const oA = O.num(1),
      oB = O.num(2),
      oC = O.num(3);
    const oMix = O.mix(O.Num, [oA, oB, oC], O.Mix.mean, O.Mix.deltaEven);

    const pA = pnum(1),
      pB = pnum(2),
      pC = pnum(3);
    const pMix = meanLens(PNum, [pA, pB, pC]) as PNum & { value: number };

    oMix.value = 10;
    pMix.value = 10;

    expect(eq(oA.value, pA.value)).toBe(true);
    expect(eq(oB.value, pB.value)).toBe(true);
    expect(eq(oC.value, pC.value)).toBe(true);

    // delta-even: each input gains (10 - 2) = 8.
    expect(pA.value).toBe(9);
    expect(pB.value).toBe(10);
    expect(pC.value).toBe(11);
  });
});

describe("A/B: meanLens (Vec) ↔ mix(Vec, parts, mean, deltaEven)", () => {
  it("read parity for Vec mean", () => {
    const oA = O.vec(0, 0),
      oB = O.vec(2, 4),
      oC = O.vec(4, 8);
    const oMix = O.mix(O.Vec, [oA, oB, oC], O.Mix.mean, O.Mix.deltaEven);

    const pA = pvec(0, 0),
      pB = pvec(2, 4),
      pC = pvec(4, 8);
    const pMix = meanLens(PVec, [pA, pB, pC]);

    expect(oMix.value).toEqual({ x: 2, y: 4 });
    expect(pMix.value).toEqual({ x: 2, y: 4 });
  });

  it("write parity for Vec midpoint via mean+deltaEven", () => {
    const oA = O.vec(0, 0),
      oB = O.vec(10, 10);
    const oMix = O.mix(O.Vec, [oA, oB], O.Mix.mean, O.Mix.deltaEven);

    const pA = pvec(0, 0),
      pB = pvec(10, 10);
    const pMix = meanLens(PVec, [pA, pB]) as PVec & { value: { x: number; y: number } };

    oMix.value = { x: 100, y: 100 };
    pMix.value = { x: 100, y: 100 };

    expect(oA.value).toEqual(pA.value);
    expect(oB.value).toEqual(pB.value);
  });
});

describe("A/B: minLens / maxLens ↔ mix(Num, parts, min/max)", () => {
  it("min parity", () => {
    const oA = O.num(3),
      oB = O.num(1),
      oC = O.num(2);
    const oMin = O.mix(O.Num, [oA, oB, oC], O.Mix.min);

    const pA = pnum(3),
      pB = pnum(1),
      pC = pnum(2);
    const pMin = minLens([pA, pB, pC]);

    expect(oMin.value).toBe(1);
    expect(pMin.value).toBe(1);

    pA.value = 0;
    expect(pMin.value).toBe(0);
  });

  it("max parity", () => {
    const pA = pnum(3),
      pB = pnum(1),
      pC = pnum(2);
    const pMax = maxLens([pA, pB, pC]);
    expect(pMax.value).toBe(3);

    pB.value = 100;
    expect(pMax.value).toBe(100);
  });
});

describe("A/B: sumLens (RO) ↔ mix(Num, parts, sum)", () => {
  it("sum read parity", () => {
    const oA = O.num(1),
      oB = O.num(2),
      oC = O.num(3);
    const oSum = O.mix(O.Num, [oA, oB, oC], O.Mix.sum);

    const pA = pnum(1),
      pB = pnum(2),
      pC = pnum(3);
    const pSum = sumLens(PNum, [pA, pB, pC]);

    expect(oSum.value).toBe(6);
    expect(pSum.value).toBe(6);
  });
});

describe("A/B: midpointLens ↔ handle.midpoint pattern", () => {
  it("two-vec midpoint: write distributes equally", () => {
    const a = pvec(0, 0);
    const b = pvec(100, 100);
    const m = midpointLens(a, b) as PVec & { value: { x: number; y: number } };
    expect(m.value).toEqual({ x: 50, y: 50 });
    m.value = { x: 100, y: 100 };
    expect(a.value).toEqual({ x: 50, y: 50 });
    expect(b.value).toEqual({ x: 150, y: 150 });
  });
});

describe("A/B: centroidLens ↔ centroid handle", () => {
  it("4-vec centroid: write rigidly translates all", () => {
    const vs = [pvec(0, 0), pvec(10, 0), pvec(10, 10), pvec(0, 10)];
    const c = centroidLens(vs) as PVec & { value: { x: number; y: number } };
    expect(c.value).toEqual({ x: 5, y: 5 });

    c.value = { x: 100, y: 100 };
    // Centroid moved from (5,5) to (100,100): all by Δ = (95, 95).
    expect(vs[0]!.value).toEqual({ x: 95, y: 95 });
    expect(vs[1]!.value).toEqual({ x: 105, y: 95 });
    expect(vs[2]!.value).toEqual({ x: 105, y: 105 });
    expect(vs[3]!.value).toEqual({ x: 95, y: 105 });
  });
});

describe("A/B: axesLens ↔ axes(x, y)", () => {
  it("read+write parity with original axes", () => {
    const ox = O.num(1),
      oy = O.num(2);
    const oV = O.axes(ox, oy);

    const px = pnum(1),
      py = pnum(2);
    const pV = axesLens(px, py) as PVec & { value: { x: number; y: number } };

    expect(oV.value).toEqual(pV.value);

    oV.value = { x: 10, y: 20 };
    pV.value = { x: 10, y: 20 };

    expect(ox.value).toBe(px.value);
    expect(oy.value).toBe(py.value);
  });
});

describe("A/B: polarCircular ↔ polar(c, r, a, 'circular')", () => {
  it("read+write parity: drag updates only angle", () => {
    const oC = O.vec(0, 0);
    const oR = O.num(10);
    const oA = O.num(0);
    const oP = O.polar(oC, oR, oA, "circular");

    const pC = pvec(0, 0);
    const pR = pnum(10);
    const pA = pnum(0);
    const pP = polarCircular(pC, pR, pA) as PVec & { value: { x: number; y: number } };

    expect(oP.value).toEqual(pP.value);

    // Drag to (0, 10) — pure 90° rotation.
    oP.value = { x: 0, y: 10 };
    pP.value = { x: 0, y: 10 };

    expect(eq(oA.value, pA.value)).toBe(true);
    expect(oR.value).toBe(pR.value); // unchanged
    expect(oC.value).toEqual(pC.value); // unchanged
    expect(eq(pA.value, Math.PI / 2)).toBe(true);
  });

  it("shortest-arc inverse: drag near accumulated angle", () => {
    const c = pvec(0, 0);
    const r = pnum(10);
    const a = pnum(20 * Math.PI); // 10 revolutions
    const p = polarCircular(c, r, a) as PVec & { value: { x: number; y: number } };
    expect(p.value.x).toBeCloseTo(10);
    expect(p.value.y).toBeCloseTo(0);

    p.value = { x: 10, y: 1 }; // tiny CCW
    const da = a.value - 20 * Math.PI;
    expect(Math.abs(da)).toBeLessThan(0.5); // shortest-arc, no jump
  });
});

describe("A/B: argminNumLens ↔ argminNum (numerical pseudoinverse)", () => {
  it("write distributes via Newton step (Iso linear: parity)", () => {
    const ox = O.num(1),
      oy = O.num(2);
    // f(x, y) = x + y. Linear, weights [1, 1] → equal split.
    const oR = O.argminNum([ox, oy], xs => xs[0]! + xs[1]!, [1, 1]);

    const px = pnum(1),
      py = pnum(2);
    const pR = argminNumLens([px, py], xs => xs[0]! + xs[1]!, [1, 1]);

    expect(oR.value).toBeCloseTo(pR.value);

    oR.value = 10;
    pR.value = 10;
    expect(eq(ox.value, px.value, 1e-3)).toBe(true);
    expect(eq(oy.value, py.value, 1e-3)).toBe(true);
  });

  it("frozen weight (0) leaves input untouched", () => {
    const x = pnum(1),
      y = pnum(2);
    const r = argminNumLens([x, y], xs => xs[0]! + xs[1]!, [0, 1]);
    r.value = 10;
    expect(x.value).toBe(1); // frozen
    expect(y.value).toBeCloseTo(9, 3);
  });

  it("non-linear forward: Newton step works", () => {
    // f(a, b) = a^2 + b^2. Ranges across (0, ∞).
    const a = pnum(3),
      b = pnum(4);
    const r = argminNumLens([a, b], xs => xs[0]! ** 2 + xs[1]! ** 2, [1, 1]);
    expect(r.value).toBeCloseTo(25);
    r.value = 26; // small Newton step
    // Should move both a and b slightly.
    expect(Math.abs(a.value - 3)).toBeLessThan(0.5);
    expect(Math.abs(b.value - 4)).toBeLessThan(0.5);
  });
});
