// avbd-api.test.ts — exercises the new ergonomics surface introduced
// in the post-prototype cleanup pass: typed cells (`num`/`vec`/`box`,
// `.value` accessors), `Strength` constants, inequality factories
// (`bounded`/`leq`/`geq`), and the `mass = 0` pin convention.

import { describe, expect, it } from "vitest";
import {
  bounded,
  BoxCell,
  box,
  distance,
  geq,
  leq,
  num,
  NumCell,
  Solver,
  spring,
  Strength,
  vec,
  VecCell,
} from "../index";

describe("API — typed cell factories", () => {
  it("num()/.value round-trip", () => {
    const x = num(5);
    expect(x).toBeInstanceOf(NumCell);
    expect(x.value).toBe(5);
    x.value = 7;
    expect(x.position[0]!).toBe(7);
  });

  it("vec()/.value/.x/.y round-trip", () => {
    const p = vec(3, 4);
    expect(p).toBeInstanceOf(VecCell);
    expect(p.x).toBe(3);
    expect(p.y).toBe(4);
    expect(p.value).toEqual({ x: 3, y: 4 });
    p.value = { x: 1, y: 2 };
    expect(p.position[0]!).toBe(1);
    expect(p.position[1]!).toBe(2);
    p.x = -5;
    expect(p.position[0]!).toBe(-5);
  });

  it("box()/.value round-trip", () => {
    const r = box(1, 2, 3, 4);
    expect(r).toBeInstanceOf(BoxCell);
    expect(r.value).toEqual({ x: 1, y: 2, w: 3, h: 4 });
    r.value = { x: 10, y: 20, w: 30, h: 40 };
    expect(r.position[3]!).toBe(40);
  });
});

describe("API — Strength constants", () => {
  it("Strength.MEDIUM is a number that drives a soft spring sensibly", () => {
    expect(typeof Strength.WEAK).toBe("number");
    expect(typeof Strength.STRONG).toBe("number");
    expect(Strength.WEAK).toBeLessThan(Strength.MEDIUM);
    expect(Strength.MEDIUM).toBeLessThan(Strength.STRONG);
    expect(Strength.STRONG).toBeLessThan(Strength.REQUIRED);

    const a = vec(0, 0);
    a.mass = 0;
    const b = vec(5, 0);
    const s = new Solver({ iterations: 30 });
    s.addCell(a);
    s.addCell(b);
    spring(s, a, b, 1, Strength.STRONG);
    for (let i = 0; i < 5; i++) s.step();
    expect(Math.hypot(b.x, b.y)).toBeCloseTo(1, 1);
  });
});

describe("API — inequality factories", () => {
  it("bounded(x, 0, 10) clamps from above", () => {
    const x = num(50);
    const s = new Solver({ iterations: 10 });
    s.addCell(x);
    bounded(s, x, 0, 10);
    s.step();
    s.step();
    expect(x.value).toBeLessThanOrEqual(10 + 1e-3);
    expect(x.value).toBeGreaterThanOrEqual(0);
  });

  it("leq(a, b): a ≤ b — saturates when violated, slack otherwise", () => {
    const a = num(5);
    const b = num(3);
    b.mass = 0;
    const s = new Solver({ iterations: 30 });
    s.addCell(a);
    s.addCell(b);
    leq(s, a, b);
    for (let i = 0; i < 5; i++) s.step();
    expect(a.value).toBeLessThanOrEqual(3 + 1e-2);

    // Now a starts feasible, b is far above — `leq` should be inert,
    // a stays put.
    a.value = 0;
    b.value = 10;
    for (let i = 0; i < 5; i++) s.step();
    expect(a.value).toBeCloseTo(0, 3);
  });

  it("geq(a, b): a ≥ b symmetric to leq", () => {
    const a = num(0);
    const b = num(5);
    b.mass = 0;
    const s = new Solver({ iterations: 30 });
    s.addCell(a);
    s.addCell(b);
    geq(s, a, b);
    for (let i = 0; i < 5; i++) s.step();
    expect(a.value).toBeGreaterThanOrEqual(5 - 1e-2);
  });
});

describe("API — readonly cells/forces views on Solver", () => {
  it("Solver.cells / Solver.forces are read-only arrays", () => {
    const s = new Solver();
    const a = vec(0, 0);
    s.addCell(a);
    distance(s, a, vec(1, 0), 1);
    expect(s.cells.length).toBe(1);
    expect(s.forces.length).toBe(1);
    // We don't check immutability via TS types here — runtime arrays
    // are mutable underneath. The intent is that consumers go through
    // addCell / addForce / removeForce. Spot-check the API exists:
    expect(typeof s.addCell).toBe("function");
    expect(typeof s.addForce).toBe("function");
    expect(typeof s.removeForce).toBe("function");
  });
});

describe("API — `mass = 0` is the canonical pin", () => {
  it("pinning by mass=0 keeps a cell in place across many steps", () => {
    const a = vec(7, 11);
    a.mass = 0;
    const b = vec(0, 0);
    const s = new Solver({ iterations: 5 });
    s.addCell(a);
    s.addCell(b);
    distance(s, a, b, 1);
    for (let i = 0; i < 20; i++) s.step();
    expect(a.x).toBe(7);
    expect(a.y).toBe(11);
    expect(Math.hypot(b.x - 7, b.y - 11)).toBeCloseTo(1, 2);
  });
});
