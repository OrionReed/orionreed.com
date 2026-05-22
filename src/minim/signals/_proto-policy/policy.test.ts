// policy.test.ts — confirm polarViaPolicy + argminVecViaPolicy match
// the production polar + argminVec semantics. If they match, the
// consolidation is real (same behaviour, one underlying primitive).

import { describe, it, expect } from "vitest";
import { num, vec, polar, argminVec } from "../index";
import { polarViaPolicy, argminVecViaPolicy } from "./policy";

describe("polarViaPolicy parity with polar", () => {
  it("rotate policy: write updates r and a, same as polar", () => {
    const c = vec(0, 0); const r = num(10); const a = num(0);
    const p = polar(c, r, a, "rotate");

    const c2 = vec(0, 0); const r2 = num(10); const a2 = num(0);
    const p2 = polarViaPolicy(c2.x, c2.y, r2, a2, "rotate");

    p.value = { x: 5, y: 8 };
    p2.value = { x: 5, y: 8 };

    expect(r2.value).toBeCloseTo(r.value);
    expect(a2.value).toBeCloseTo(a.value);
    expect(c2.value).toEqual(c.value);
  });

  it("circular policy: nearest-angle shortest-arc on accumulated angle", () => {
    const c = vec(0, 0); const r = num(10); const a = num(10 * Math.PI);
    const p = polar(c, r, a, "circular");

    const c2 = vec(0, 0); const r2 = num(10); const a2 = num(10 * Math.PI);
    const p2 = polarViaPolicy(c2.x, c2.y, r2, a2, "circular");

    p.value = { x: 10, y: 1 };
    p2.value = { x: 10, y: 1 };

    expect(a2.value).toBeCloseTo(a.value);
    expect(r2.value).toBe(r.value);
  });

  it("translate policy: write shifts center, leaves r/a", () => {
    const c = vec(0, 0); const r = num(10); const a = num(0);
    const p = polar(c, r, a, "translate");

    const c2 = vec(0, 0); const r2 = num(10); const a2 = num(0);
    const p2 = polarViaPolicy(c2.x, c2.y, r2, a2, "translate");

    p.value = { x: 100, y: 50 };
    p2.value = { x: 100, y: 50 };

    expect(c2.value).toEqual(c.value);
    expect(r2.value).toBe(r.value);
    expect(a2.value).toBe(a.value);
  });
});

describe("argminVecViaPolicy parity with argminVec", () => {
  it("2-link arm converges identically", () => {
    const mkArm = () => {
      const a1 = num(0.1), a2 = num(0.1);
      return {
        a1, a2,
        tip: argminVec(
          [a1, a2],
          ([t1, t2]) => ({
            x: 100 * Math.cos(t1) + 100 * Math.cos(t1 + t2),
            y: 100 * Math.sin(t1) + 100 * Math.sin(t1 + t2),
          }),
          [1, 1],
        ),
      };
    };
    const mkArmPolicy = () => {
      const a1 = num(0.1), a2 = num(0.1);
      return {
        a1, a2,
        tip: argminVecViaPolicy(
          [a1, a2],
          ([t1, t2]) => ({
            x: 100 * Math.cos(t1) + 100 * Math.cos(t1 + t2),
            y: 100 * Math.sin(t1) + 100 * Math.sin(t1 + t2),
          }),
          [1, 1],
        ),
      };
    };

    const stock = mkArm();
    const policy = mkArmPolicy();
    const target = { x: 0, y: 150 };
    for (let i = 0; i < 50; i++) {
      stock.tip.value = target;
      policy.tip.value = target;
    }
    expect(policy.a1.value).toBeCloseTo(stock.a1.value, 6);
    expect(policy.a2.value).toBeCloseTo(stock.a2.value, 6);
  });
});
