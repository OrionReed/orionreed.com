// cluster-api.test.ts — user-facing API: signal-driven constraint
// factories, `Strength` constants, inequality factories (`clamp` /
// `leq` / `geq`), and the `pin()` helper.

import { describe, expect, it } from "vitest";
import { num, vec } from "../../signals";
import {
  clamp,
  constraints,
  distance,
  gap,
  geq,
  inside,
  leq,
  pin,
  Strength,
  spring,
} from "../index";

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
    const s = constraints({ iterations: 30 });
    s.add(spring(a, b, 1, Strength.STRONG));
    s.add(pin(a));
    a.value = { x: 0.0001, y: 0 };
    expect(Math.hypot(b.value.x - a.value.x, b.value.y - a.value.y)).toBeCloseTo(1, 1);
  });
});

describe("API — inequality factories", () => {
  it("clamp(x, 0, 10) pins a far-above x to 10", () => {
    const x = num(50);
    const s = constraints({ iterations: 10 });
    s.add(clamp(x, 0, 10));
    x.value = 50.0001;
    expect(x.value).toBeLessThanOrEqual(10 + 1e-3);
    expect(x.value).toBeGreaterThanOrEqual(0);
  });

  it("leq(a, b) saturates: a above b is pulled down", () => {
    const a = num(5);
    const b = num(3);
    const s = constraints({ iterations: 30 });
    s.add(leq(a, b));
    s.add(pin(b));
    b.value = 3.0001;
    expect(a.value).toBeLessThanOrEqual(b.value + 1e-2);
  });

  it("geq(a, b): a below b is pushed up", () => {
    const a = num(0);
    const b = num(5);
    const s = constraints({ iterations: 30 });
    s.add(geq(a, b));
    s.add(pin(b));
    b.value = 5.0001;
    expect(a.value).toBeGreaterThanOrEqual(5 - 1e-2);
  });

  it("gap(a, b, d): two points pushed apart when too close", () => {
    const a = vec(0, 0);
    const b = vec(0.5, 0);
    const s = constraints({ iterations: 30 });
    s.add(gap(a, b, 5));
    s.add(pin(a));
    a.value = { x: 0.0001, y: 0 };
    expect(Math.hypot(b.value.x - a.value.x, b.value.y - a.value.y)).toBeGreaterThanOrEqual(
      5 - 1e-2,
    );
  });

  it("gap(a, b, d): no force when already far apart", () => {
    const a = vec(0, 0);
    const b = vec(20, 0);
    const s = constraints({ iterations: 10 });
    s.add(gap(a, b, 5));
    s.add(pin(a));
    a.value = { x: 0.0001, y: 0 };
    expect(b.value.x).toBeCloseTo(20, 1);
    expect(b.value.y).toBeCloseTo(0, 1);
  });

  it("inside(P, xLo, yLo, xHi, yHi): pulls P inside the AABB", () => {
    const P = vec(50, 50);
    const s = constraints({ iterations: 20 });
    s.add(inside(P, 0, 0, 10, 10));
    P.value = { x: 50.0001, y: 50 };
    expect(P.value.x).toBeLessThanOrEqual(10 + 1e-2);
    expect(P.value.y).toBeLessThanOrEqual(10 + 1e-2);
    expect(P.value.x).toBeGreaterThanOrEqual(0);
    expect(P.value.y).toBeGreaterThanOrEqual(0);
  });

  it("inside is dormant when P is already inside", () => {
    const P = vec(5, 5);
    const s = constraints({ iterations: 10 });
    s.add(inside(P, 0, 0, 10, 10));
    P.value = { x: 5.0001, y: 5 };
    expect(P.value.x).toBeCloseTo(5, 1);
    expect(P.value.y).toBeCloseTo(5, 1);
  });

  it("inside + gap: two circles confined to a box stay separated", () => {
    const a = vec(2, 5);
    const b = vec(8, 5);
    const s = constraints({ iterations: 30 });
    s.add(inside(a, 0, 0, 10, 10));
    s.add(inside(b, 0, 0, 10, 10));
    s.add(gap(a, b, 4));
    s.add(pin(a));
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
    const s = constraints({ iterations: 30 });
    s.add(distance(a, b, 1));
    s.add(pin(a));
    a.value = { x: 7.0001, y: 11 };
    expect(a.value.x).toBeCloseTo(7, 1);
    expect(a.value.y).toBeCloseTo(11, 1);
    expect(Math.hypot(b.value.x - 7, b.value.y - 11)).toBeCloseTo(1, 1);
  });

  it("removing a pin relation restores prior mass", () => {
    const a = num(0);
    const b = num(0);
    const s = constraints({ iterations: 20 });
    s.add(leq(a, b));
    const r = s.add(pin(a));
    expect(s.solver.massOf(s._bind(a))).toBe(0);
    s.remove(r);
    expect(s.solver.massOf(s._bind(a))).toBe(1);
  });
});

describe("API — solver state introspection", () => {
  it("forces array is observable", () => {
    const s = constraints();
    const a = vec(0, 0);
    const b = vec(1, 0);
    s.add(distance(a, b, 1));
    expect(s.solver.terms.length).toBe(1);
  });
});

describe("API — variadic add", () => {
  it("single relation returns the relation", () => {
    const s = constraints();
    const a = vec(0, 0);
    const b = vec(1, 0);
    const r = s.add(distance(a, b, 1));
    expect(s.solver.terms.length).toBe(1);
    expect(typeof r.bind).toBe("function");
  });

  it("multiple relations returns an array (destructure-friendly)", () => {
    const s = constraints();
    const a = vec(0, 0);
    const b = vec(1, 0);
    const c = vec(2, 0);
    const [r1, r2] = s.add(distance(a, b, 1), distance(b, c, 1));
    expect(s.solver.terms.length).toBe(2);
    expect(typeof r1.bind).toBe("function");
    expect(typeof r2.bind).toBe("function");
  });
});

describe("API — settable solver opts", () => {
  it("iterations is mutable post-construction", () => {
    const s = constraints({ iterations: 10 });
    expect(s.iterations).toBe(10);
    s.iterations = 30;
    expect(s.iterations).toBe(30);
    expect(s.solver.iterations).toBe(30);
  });

  it("alpha, beta, gamma, postStabilize all round-trip", () => {
    const s = constraints();
    s.alpha = 0.95;
    expect(s.alpha).toBe(0.95);
    s.beta = 1e6;
    expect(s.beta).toBe(1e6);
    s.gamma = 0.98;
    expect(s.gamma).toBe(0.98);
    s.postStabilize = true;
    expect(s.postStabilize).toBe(true);
    s.postStabilize = false;
    expect(s.postStabilize).toBe(false);
  });
});

describe("API — mutable parameters", () => {
  it("distance.rest mutation re-solves", () => {
    const s = constraints({ iterations: 30 });
    const a = vec(0, 0);
    const b = vec(5, 0);
    const r = s.add(distance(a, b, 5));
    s.add(pin(a));
    a.value = { x: 0.0001, y: 0 };
    // Verify initial rest distance
    expect(Math.hypot(b.value.x - a.value.x, b.value.y - a.value.y)).toBeCloseTo(5, 1);

    // Mutate rest length — `r.rest` is a Signal<number>.
    r.rest.value = 10;
    expect(Math.hypot(b.value.x - a.value.x, b.value.y - a.value.y)).toBeCloseTo(10, 1);

    r.rest.value = 3;
    expect(Math.hypot(b.value.x - a.value.x, b.value.y - a.value.y)).toBeCloseTo(3, 1);
  });

  it("clamp.lo / clamp.hi mutation via signal `.value`", () => {
    const s = constraints({ iterations: 30 });
    const x = num(5);
    const r = s.add(clamp(x, 0, 10));
    expect(r.lo.value).toBe(0);
    expect(r.hi.value).toBe(10);

    // Tighten the upper bound.
    r.hi.value = 3;
    expect(r.hi.value).toBe(3);
    // Trigger a solve by writing x.
    x.value = 100;
    expect(x.value).toBeLessThanOrEqual(3 + 0.1);
  });
});
