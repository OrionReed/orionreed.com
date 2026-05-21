// values.test.ts — Num/Vec runtime + Writable<R> behaviour.

import { describe, it, expect } from "vitest";
import {
  Num, num, Vec, vec, effect, isLens, isComputed,
} from "../index";

describe("Num", () => {
  it("num(v) writable, .value/.set/.bind work", () => {
    const n = num(5);
    expect(n).toBeInstanceOf(Num);
    expect(n.value).toBe(5);
    n.value = 10;
    expect(n.value).toBe(10);
    n.set(42);
    expect(n.value).toBe(42);
  });

  it("Num.derive returns RO", () => {
    const n = num(3);
    const sq = Num.derive(() => n.value * n.value);
    expect(isComputed(sq)).toBe(true);
    expect(sq.value).toBe(9);
    n.value = 4;
    expect(sq.value).toBe(16);
  });

  it("Num.lens returns writable", () => {
    const n = num(0);
    const doubled = Num.lens(() => n.value * 2, (v) => { n.value = v / 2 });
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
});

describe("Vec", () => {
  it("vec writable, fields cached, lens write propagates", () => {
    const v = vec(1, 2);
    expect(v.x).toBe(v.x);
    v.x.value = 99;
    expect(v.value).toEqual({ x: 99, y: 2 });
  });

  it("normalize is non-invertible", () => {
    const v = vec(3, 4);
    const n = v.normalize();
    expect(isComputed(n)).toBe(true);
    expect(n.value.x).toBeCloseTo(0.6);
  });

  it("invertible chain writes through", () => {
    const v = vec(0, 0);
    const chain = v.add({ x: 1, y: 1 }).scale(2);
    chain.value = { x: 10, y: 10 };
    expect(v.value).toEqual({ x: 4, y: 4 });
  });

  it("magnitude lazy memoised", () => {
    const v = vec(3, 4);
    expect(v.magnitude).toBe(v.magnitude);
    expect(v.magnitude.value).toBe(5);
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
