// cluster-api.test.ts — user-facing API: signal-driven constraint
// factories, `Strength` constants, inequality factories (`clamp` /
// `leq` / `geq`), and the `pin()` helper.

import { describe, expect, it } from "vitest";
import { num, vec } from "../../signals";
import { Cluster, clamp, distance, gap, geq, inside, leq, Strength, spring } from "../index";

describe("API — Strength constants", () => {
  it("constants ordered low → high; HARD = ∞", () => {
    expect(typeof Strength.WEAK).toBe("number");
    expect(Strength.WEAK).toBeLessThan(Strength.MEDIUM);
    expect(Strength.MEDIUM).toBeLessThan(Strength.STRONG);
    expect(Strength.STRONG).toBeLessThan(Strength.REQUIRED);
    expect(Strength.HARD).toBe(Infinity);
  });

  it("STRONG soft spring approximates a hard distance", () => {
    const a = vec(0, 0);
    const b = vec(5, 0);
    const s = new Cluster({ iterations: 30 });
    spring(s, a, b, 1, Strength.STRONG);
    s.pin(a);
    a.value = { x: 0.0001, y: 0 };
    expect(Math.hypot(b.value.x - a.value.x, b.value.y - a.value.y)).toBeCloseTo(1, 1);
  });
});

describe("API — inequality factories", () => {
  it("clamp(x, 0, 10) pins a far-above x to 10", () => {
    const x = num(50);
    const s = new Cluster({ iterations: 10 });
    clamp(s, x, 0, 10);
    x.value = 50.0001;
    expect(x.value).toBeLessThanOrEqual(10 + 1e-3);
    expect(x.value).toBeGreaterThanOrEqual(0);
  });

  it("leq(a, b) saturates: a above b is pulled down", () => {
    const a = num(5);
    const b = num(3);
    const s = new Cluster({ iterations: 30 });
    leq(s, a, b);
    s.pin(b);
    b.value = 3.0001;
    expect(a.value).toBeLessThanOrEqual(b.value + 1e-2);
  });

  it("geq(a, b): a below b is pushed up", () => {
    const a = num(0);
    const b = num(5);
    const s = new Cluster({ iterations: 30 });
    geq(s, a, b);
    s.pin(b);
    b.value = 5.0001;
    expect(a.value).toBeGreaterThanOrEqual(5 - 1e-2);
  });

  it("gap(a, b, d): two points pushed apart when too close", () => {
    const a = vec(0, 0);
    const b = vec(0.5, 0);
    const s = new Cluster({ iterations: 30 });
    gap(s, a, b, 5);
    s.pin(a);
    a.value = { x: 0.0001, y: 0 };
    expect(Math.hypot(b.value.x - a.value.x, b.value.y - a.value.y)).toBeGreaterThanOrEqual(
      5 - 1e-2,
    );
  });

  it("gap(a, b, d): no force when already far apart", () => {
    const a = vec(0, 0);
    const b = vec(20, 0);
    const s = new Cluster({ iterations: 10 });
    gap(s, a, b, 5);
    s.pin(a);
    a.value = { x: 0.0001, y: 0 };
    expect(b.value.x).toBeCloseTo(20, 1);
    expect(b.value.y).toBeCloseTo(0, 1);
  });

  it("inside(P, xLo, yLo, xHi, yHi): pulls P inside the AABB", () => {
    const P = vec(50, 50);
    const s = new Cluster({ iterations: 20 });
    inside(s, P, 0, 0, 10, 10);
    P.value = { x: 50.0001, y: 50 };
    expect(P.value.x).toBeLessThanOrEqual(10 + 1e-2);
    expect(P.value.y).toBeLessThanOrEqual(10 + 1e-2);
    expect(P.value.x).toBeGreaterThanOrEqual(0);
    expect(P.value.y).toBeGreaterThanOrEqual(0);
  });

  it("inside is dormant when P is already inside", () => {
    const P = vec(5, 5);
    const s = new Cluster({ iterations: 10 });
    inside(s, P, 0, 0, 10, 10);
    P.value = { x: 5.0001, y: 5 };
    expect(P.value.x).toBeCloseTo(5, 1);
    expect(P.value.y).toBeCloseTo(5, 1);
  });

  it("inside + gap: two circles confined to a box stay separated", () => {
    const a = vec(2, 5);
    const b = vec(8, 5);
    const s = new Cluster({ iterations: 30 });
    inside(s, a, 0, 0, 10, 10);
    inside(s, b, 0, 0, 10, 10);
    gap(s, a, b, 4);
    s.pin(a);
    a.value = { x: 2.0001, y: 5 };
    expect(Math.hypot(b.value.x - a.value.x, b.value.y - a.value.y)).toBeGreaterThanOrEqual(
      4 - 1e-2,
    );
    expect(b.value.x).toBeLessThanOrEqual(10 + 1e-2);
  });
});

describe("API — `pin()` is the canonical drag mechanism", () => {
  it("pin(a) keeps a in place; constraint drags b", () => {
    const a = vec(7, 11);
    const b = vec(0, 0);
    const s = new Cluster({ iterations: 30 });
    distance(s, a, b, 1);
    s.pin(a);
    a.value = { x: 7.0001, y: 11 };
    expect(a.value.x).toBeCloseTo(7, 1);
    expect(a.value.y).toBeCloseTo(11, 1);
    expect(Math.hypot(b.value.x - 7, b.value.y - 11)).toBeCloseTo(1, 1);
  });

  it("unpinning restores prior mass", () => {
    const a = num(0);
    const b = num(0);
    const s = new Cluster({ iterations: 20 });
    leq(s, a, b);
    const release = s.pin(a);
    expect(s.solver.massOf(s.bind(a))).toBe(0);
    release();
    expect(s.solver.massOf(s.bind(a))).toBe(1);
  });
});

describe("API — solver state introspection", () => {
  it("forces array is observable", () => {
    const s = new Cluster();
    const a = vec(0, 0);
    const b = vec(1, 0);
    distance(s, a, b, 1);
    expect(s.solver.forces.length).toBe(1);
  });
});
