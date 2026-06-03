// values.test.ts — value classes (Num/Vec/Bool) on the symmetric
// engine. Proves the engine supports the full value-class authoring
// surface: endo lens chains, custom equality dedup, field lenses,
// derived views, cross-type predicate bridges, and multi-parent
// aggregate lenses (axes/polar).

import { describe, expect, it, vi } from "vitest";
import { effect } from "../index";
import { Bool, bool } from "../values/bool";
import { Num, num } from "../values/num";
import { Vec, polar, vec } from "../values/vec";

describe("Num — endo lens chains", () => {
  it("chains preserve writability and invert through", () => {
    const t = num(5);
    const chain = t.add(1).scale(2); // (5+1)*2 = 12
    expect(chain.value).toBe(12);
    chain.value = 20; // 20/2 - 1 = 9
    expect(t.value).toBe(9);
  });

  it("clamp is a lossy projection (PutGet)", () => {
    const t = num(5);
    const c = t.clamp(0, 10);
    c.value = 99;
    expect(c.value).toBe(10);
    expect(t.value).toBe(10);
  });

  it("custom equality dedups effect fires", () => {
    const n = num(1);
    const fn = vi.fn(() => void n.value);
    effect(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    n.value = 1; // equal → no fire
    expect(fn).toHaveBeenCalledTimes(1);
    n.value = 2;
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("Num — predicate bridges to Bool", () => {
  it("greaterThan flips the source across the threshold", () => {
    const n = num(5);
    const gt = n.greaterThan(10);
    expect(gt.value).toBe(false);
    (gt as Bool).value = true; // bump source above 10
    expect(n.value).toBeGreaterThan(10);
    expect(gt.value).toBe(true);
  });

  it("isEven / isOdd derive from divisibleBy", () => {
    const n = num(4);
    expect(n.isEven.value).toBe(true);
    expect(n.isOdd.value).toBe(false);
    n.value = 7;
    expect(n.isEven.value).toBe(false);
    expect(n.isOdd.value).toBe(true);
  });
});

describe("Bool — invertibles + derived", () => {
  it("not() is an involution and writes back", () => {
    const b = bool(true);
    const n = b.not();
    expect(n.value).toBe(false);
    n.value = true;
    expect(b.value).toBe(false);
  });

  it("double not folds to identity behaviourally", () => {
    const b = bool(true);
    const nn = b.not().not();
    expect(nn.value).toBe(true);
    nn.value = false;
    expect(b.value).toBe(false);
  });

  it("and is RO fan-in", () => {
    const a = bool(true);
    const b = bool(false);
    const both = a.and(b);
    expect(both.value).toBe(false);
    b.value = true;
    expect(both.value).toBe(true);
  });
});

describe("Vec — fields, derived, multi-parent aggregates", () => {
  it("field lens round-trips through x/y", () => {
    const p = vec(3, 4);
    expect(p.x.value).toBe(3);
    expect(p.y.value).toBe(4);
    p.x.value = 10; // spread-replace x
    expect(p.value).toEqual({ x: 10, y: 4 });
  });

  it("magnitude is a derived RO view", () => {
    const p = vec(3, 4);
    expect(p.magnitude.value).toBe(5);
    p.value = { x: 6, y: 8 };
    expect(p.magnitude.value).toBe(10);
  });

  it("axes fan-in: vec over two writable Nums splits writes back", () => {
    const x = num(1);
    const y = num(2);
    const p = vec(x, y);
    expect(p.value).toEqual({ x: 1, y: 2 });
    p.value = { x: 5, y: 9 };
    expect(x.value).toBe(5);
    expect(y.value).toBe(9);
  });

  it("vec arithmetic chain inverts", () => {
    const p = vec(1, 1);
    const shifted = p.add({ x: 10, y: 20 });
    expect(shifted.value).toEqual({ x: 11, y: 21 });
    shifted.value = { x: 0, y: 0 };
    expect(p.value).toEqual({ x: -10, y: -20 });
  });
});

describe("Vec — polar fan-in (rotate policy)", () => {
  it("forward places point; dragging updates r and a, center fixed", () => {
    const c = vec(0, 0);
    const r = num(10);
    const a = num(0);
    const p = polar(c, r, a, "rotate");
    expect(p.value.x).toBeCloseTo(10);
    expect(p.value.y).toBeCloseTo(0);

    // Drag to (0, 5): r → 5, a → π/2, center unchanged.
    p.value = { x: 0, y: 5 };
    expect(r.value).toBeCloseTo(5);
    expect(a.value).toBeCloseTo(Math.PI / 2);
    expect(c.value).toEqual({ x: 0, y: 0 });
  });
});
