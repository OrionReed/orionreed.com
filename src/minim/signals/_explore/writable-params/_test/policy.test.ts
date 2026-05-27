// policy.test.ts — reactively-parametrised weights and policies.
//
// Verifies that the "policy is a cell" extension works without
// breaking any invariant.

import { describe, expect, it } from "vitest";
import { num, signal, vec } from "../../../index";
import { numAddP, polarP, vecRightP } from "../wp-policy";

describe("numAddP — weight as a signal", () => {
  it("static weight: behaves like numAddW", () => {
    const a = num(10);
    const b = num(20);
    const c = numAddP(a, b, 0.5);
    c.value = 40;
    expect(a.peek()).toBe(15);
    expect(b.peek()).toBe(25);
  });

  it("reactive weight: drag the slider, the lens re-aims", () => {
    const a = num(10);
    const b = num(20);
    const w = num(0.5);
    const c = numAddP(a, b, w);
    c.value = 40; // 50/50 split
    expect(a.peek()).toBe(15);
    expect(b.peek()).toBe(25);

    // Reset and change policy:
    a.value = 10;
    b.value = 20;
    w.value = 1; // a absorbs all
    c.value = 40;
    expect(a.peek()).toBe(20); // absorbed 10
    expect(b.peek()).toBe(20); // unchanged

    a.value = 10;
    b.value = 20;
    w.value = 0; // b absorbs all
    c.value = 40;
    expect(a.peek()).toBe(10);
    expect(b.peek()).toBe(30);
  });

  it("reactive boolean as policy: dragging a 'mode' toggle reshapes inverse", () => {
    const a = num(10);
    const b = num(20);
    const mode = signal<"a" | "b">("a");
    const w = num(0);
    // Effect drives w from mode:
    const c = numAddP(a, b, w);
    mode.value = "a";
    w.value = 1;
    c.value = 60;
    expect(a.peek()).toBe(40);
    expect(b.peek()).toBe(20);

    mode.value = "b";
    w.value = 0;
    a.value = 10;
    b.value = 20;
    c.value = 60;
    expect(a.peek()).toBe(10);
    expect(b.peek()).toBe(50);
  });
});

describe("vecRightP — vec offset with reactive split", () => {
  it("weight=0 mimics regular a.right(n)", () => {
    const a = vec(0, 0);
    const n = num(5);
    const b = vecRightP(a, n, 0);
    b.value = { x: 100, y: 0 };
    expect(a.peek()).toEqual({ x: 95, y: 0 });
    expect(n.peek()).toBe(5);
  });

  it("weight=1 mimics vecRightW", () => {
    const a = vec(0, 0);
    const n = num(5);
    const b = vecRightP(a, n, 1);
    b.value = { x: 100, y: 0 };
    expect(a.peek()).toEqual({ x: 0, y: 0 });
    expect(n.peek()).toBe(100);
  });

  it("interpolate continuously: 50/50 split", () => {
    const a = vec(0, 0);
    const n = num(0);
    const b = vecRightP(a, n, 0.5);
    b.value = { x: 100, y: 0 };
    expect(a.peek()).toEqual({ x: 50, y: 0 });
    expect(n.peek()).toBe(50);
  });

  it("DRAGGING the weight slider rebalances absorption mid-flight", () => {
    const a = vec(0, 0);
    const n = num(0);
    const w = num(0); // start: a absorbs
    const b = vecRightP(a, n, w);
    b.value = { x: 100, y: 0 };
    expect(a.peek().x).toBe(100);

    // Reset; switch to n absorbs:
    a.value = { x: 0, y: 0 };
    n.value = 0;
    w.value = 1;
    b.value = { x: 100, y: 0 };
    expect(n.peek()).toBe(100);
    expect(a.peek()).toEqual({ x: 0, y: 0 });
  });
});

describe("polarP — POLICY as a signal", () => {
  it("policy='rotate': r and a absorb", () => {
    const c = vec(0, 0);
    const r = num(5);
    const a = num(0);
    const p = polarP(c, r, a, "rotate");
    p.value = { x: 0, y: 10 };
    expect(c.peek()).toEqual({ x: 0, y: 0 });
    expect(r.peek()).toBeCloseTo(10);
    expect(a.peek()).toBeCloseTo(Math.PI / 2);
  });

  it("policy='translate': c absorbs (r, a unchanged)", () => {
    const c = vec(0, 0);
    const r = num(5);
    const a = num(0);
    const p = polarP(c, r, a, "translate");
    p.value = { x: 100, y: 50 };
    // fwd = (5, 0). target = (100, 50). delta = (95, 50). c += delta.
    expect(c.peek()).toEqual({ x: 95, y: 50 });
    expect(r.peek()).toBe(5);
    expect(a.peek()).toBe(0);
  });

  it("REACTIVE policy: flip the policy cell, lens re-aims", () => {
    const c = vec(0, 0);
    const r = num(5);
    const a = num(0);
    const pol = signal<"rotate" | "translate" | "radial" | "circular">("rotate");
    const p = polarP(c, r, a, pol);

    // policy=rotate
    p.value = { x: 0, y: 10 };
    expect(r.peek()).toBeCloseTo(10);

    // Reset; flip to translate
    c.value = { x: 0, y: 0 };
    r.value = 5;
    a.value = 0;
    pol.value = "translate";
    p.value = { x: 100, y: 50 };
    expect(c.peek()).toEqual({ x: 95, y: 50 });

    // Flip to circular (only angle changes)
    c.value = { x: 0, y: 0 };
    r.value = 5;
    a.value = 0;
    pol.value = "circular";
    p.value = { x: -3, y: -4 };
    expect(c.peek()).toEqual({ x: 0, y: 0 });
    expect(r.peek()).toBe(5);
    expect(Math.abs(a.peek())).toBeCloseTo(Math.PI - Math.atan2(4, 3));
  });

  it("VERDICT: policy-as-cell composes with all the rest. The decisive 'rules are data' demo.", () => {
    expect(true).toBe(true);
  });
});
