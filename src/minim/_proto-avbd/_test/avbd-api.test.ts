// avbd-api.test.ts — exercises the user-facing API: signal-driven
// constraint factories, `Strength` constants, inequality factories
// (`bounded` / `leq` / `geq`), and the `pin()` helper.

import { describe, expect, it } from "vitest";
import { num, vec } from "../../signals";
import {
  bounded,
  distance,
  geq,
  leq,
  pin,
  Solver,
  spring,
  Strength,
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
    const s = new Solver({ iterations: 30 });
    spring(s, a, b, 1, Strength.STRONG);
    pin(a);
    a.value = { x: 0.0001, y: 0 };
    expect(Math.hypot(b.value.x - a.value.x, b.value.y - a.value.y)).toBeCloseTo(1, 1);
  });
});

describe("API — inequality factories", () => {
  it("bounded(x, 0, 10) clamps a far-above x to 10", () => {
    const x = num(50);
    const s = new Solver({ iterations: 10 });
    bounded(s, x, 0, 10);
    x.value = 50.0001;
    expect(x.value).toBeLessThanOrEqual(10 + 1e-3);
    expect(x.value).toBeGreaterThanOrEqual(0);
  });

  it("leq(a, b) saturates: a above b is pulled down", () => {
    const a = num(5);
    const b = num(3);
    const s = new Solver({ iterations: 30 });
    leq(s, a, b);
    pin(b);
    b.value = 3.0001;
    expect(a.value).toBeLessThanOrEqual(b.value + 1e-2);
  });

  it("geq(a, b): a below b is pushed up", () => {
    const a = num(0);
    const b = num(5);
    const s = new Solver({ iterations: 30 });
    geq(s, a, b);
    pin(b);
    b.value = 5.0001;
    expect(a.value).toBeGreaterThanOrEqual(5 - 1e-2);
  });
});

describe("API — `pin()` is the canonical drag mechanism", () => {
  it("pin(a) keeps a in place; constraint drags b", () => {
    const a = vec(7, 11);
    const b = vec(0, 0);
    const s = new Solver({ iterations: 30 });
    distance(s, a, b, 1);
    pin(a);
    a.value = { x: 7.0001, y: 11 };
    expect(a.value.x).toBeCloseTo(7, 1);
    expect(a.value.y).toBeCloseTo(11, 1);
    expect(Math.hypot(b.value.x - 7, b.value.y - 11)).toBeCloseTo(1, 1);
  });

  it("unpinning restores prior mass", () => {
    const a = num(0);
    const b = num(0);
    const s = new Solver({ iterations: 20 });
    leq(s, a, b);
    const release = pin(a);
    expect(s.massOf(s.bind(a))).toBe(0);
    release();
    expect(s.massOf(s.bind(a))).toBe(1);
  });
});

describe("API — solver state introspection", () => {
  it("forces array is observable", () => {
    const s = new Solver();
    const a = vec(0, 0);
    const b = vec(1, 0);
    distance(s, a, b, 1);
    expect(s.forces.length).toBe(1);
  });
});
