// values.test.ts — Num/Vec runtime behaviour.

import { describe, it, expect } from "vitest";
import {
  Num, num, Vec, vec, effect, isLens, isComputed,
} from "../index";

describe("Num", () => {
  it("num(v) is writable", () => {
    const n = num(5);
    expect(n).toBeInstanceOf(Num);
    expect(n.value).toBe(5);
    n.value = 10;
    expect(n.value).toBe(10);
  });

  it("Num.derive returns RO computed", () => {
    const n = num(3);
    const sq = Num.derive(() => n.value * n.value);
    expect(sq).toBeInstanceOf(Num);
    expect(isComputed(sq)).toBe(true);
    expect(sq.value).toBe(9);
    n.value = 4;
    expect(sq.value).toBe(16);
  });

  it("Num.lens returns writable", () => {
    const n = num(0);
    const doubled = Num.lens(() => n.value * 2, (v) => { n.value = v / 2 });
    expect(doubled).toBeInstanceOf(Num);
    expect(isLens(doubled)).toBe(true);
    doubled.value = 10;
    expect(n.value).toBe(5);
  });

  it("invertible methods produce write-through lenses", () => {
    const n = num(3);
    const plus = n.add(2);
    expect(plus.value).toBe(5);
    expect(isLens(plus)).toBe(true);
    plus.value = 10;
    expect(n.value).toBe(8);
  });

  it("clamp is non-invertible", () => {
    const n = num(10);
    const c = n.clamp(0, 5);
    expect(isComputed(c)).toBe(true);
    expect(c.value).toBe(5);
    n.value = -1;
    expect(c.value).toBe(0);
  });

  it("Num.is", () => {
    expect(Num.is(num())).toBe(true);
    expect(Num.is({} as unknown)).toBe(false);
  });
});

describe("Vec", () => {
  it("vec(x, y) is writable", () => {
    const v = vec(1, 2);
    expect(v).toBeInstanceOf(Vec);
    expect(v.value).toEqual({ x: 1, y: 2 });
  });

  it("field lens .x is writable, cached, propagates", () => {
    const v = vec(1, 2);
    expect(v.x).toBeInstanceOf(Num);
    expect(v.x).toBe(v.x);  // cached
    v.x.value = 99;
    expect(v.value).toEqual({ x: 99, y: 2 });
  });

  it("normalize is non-invertible", () => {
    const v = vec(3, 4);
    const n = v.normalize();
    expect(isComputed(n)).toBe(true);
    expect(n.value.x).toBeCloseTo(0.6);
    expect(n.value.y).toBeCloseTo(0.8);
  });

  it("add chain (writability propagates via lenses)", () => {
    const v = vec(0, 0);
    const chain = v.add({ x: 1, y: 1 }).scale(2);
    expect(chain.value).toEqual({ x: 2, y: 2 });
    chain.value = { x: 10, y: 10 };
    expect(v.value).toEqual({ x: 4, y: 4 });
  });

  it("magnitude is lazy + RO", () => {
    const v = vec(3, 4);
    expect(v.magnitude).toBe(v.magnitude);  // cached
    expect(v.magnitude.value).toBe(5);
  });

  it("Vec.derive returns RO", () => {
    const a = vec(1, 0);
    const flipped = Vec.derive(() => ({ x: -a.value.x, y: -a.value.y }));
    expect(isComputed(flipped)).toBe(true);
    expect(flipped.value.x).toBe(-1);
  });

  it("Vec.lens returns writable", () => {
    const a = vec(0, 0);
    const swapped = Vec.lens(
      () => ({ x: a.value.y, y: a.value.x }),
      (v) => { a.value = { x: v.y, y: v.x } },
    );
    swapped.value = { x: 5, y: 10 };
    expect(a.value).toEqual({ x: 10, y: 5 });
  });

  it("effect tracking across derive", () => {
    const v = vec(1, 2);
    const sum = Num.derive(() => v.value.x + v.value.y);
    let seen = 0;
    effect(() => { seen = sum.value });
    expect(seen).toBe(3);
    v.x.value = 10;
    expect(seen).toBe(12);
  });
});
