// values.test.ts — value-class behaviour + writability + field lenses.

import { describe, it, expect } from "vitest";
import {
  num, vec,
  NumSignal, NumComputed, NumLens,
  VecSignal, VecComputed, VecLens,
  NumNS, VecNS,
  effect,
} from "../index";

describe("Num — three flavours", () => {
  it("num(v) is a NumSignal (writable)", () => {
    const n = num(5);
    expect(n).toBeInstanceOf(NumSignal);
    expect(n.value).toBe(5);
    n.value = 10;
    expect(n.value).toBe(10);
  });

  it("static Num.derive returns NumComputed (RO)", () => {
    const n = num(3);
    const sq = NumNS.derive(() => n.value * n.value);
    expect(sq).toBeInstanceOf(NumComputed);
    expect(sq.value).toBe(9);
    n.value = 4;
    expect(sq.value).toBe(16);
    expect(() => { (sq as unknown as { value: number }).value = 0 }).toThrow();
  });

  it("static Num.lens returns NumLens (RW derived)", () => {
    const n = num(0);
    const doubled = NumNS.lens(() => n.value * 2, (v) => { n.value = v / 2 });
    expect(doubled).toBeInstanceOf(NumLens);
    expect(doubled.value).toBe(0);
    doubled.value = 10;
    expect(n.value).toBe(5);
  });

  it("invertible methods return NumLens (writable derived)", () => {
    const n = num(3);
    const plus = n.add(2);
    expect(plus).toBeInstanceOf(NumLens);
    expect(plus.value).toBe(5);
    plus.value = 10;
    expect(n.value).toBe(8);  // bwd: 10 - 2
    const scaled = n.scale(3);
    expect(scaled.value).toBe(24);
    scaled.value = 30;
    expect(n.value).toBe(10);  // bwd: 30 / 3
  });

  it("non-invertible methods return NumComputed (RO)", () => {
    const n = num(10);
    const cl = n.clamp(0, 5);
    expect(cl).toBeInstanceOf(NumComputed);
    expect(cl.value).toBe(5);
    n.value = -1;
    expect(cl.value).toBe(0);
  });

  it("static traits dict is visible per concrete class", () => {
    expect(NumSignal.traits.linear).toBeDefined();
    expect(NumComputed.traits.lerp).toBeDefined();
    expect(NumLens.traits.metric).toBeDefined();
  });
});

describe("Vec — three flavours + field lenses", () => {
  it("vec(x,y) is a VecSignal", () => {
    const v = vec(1, 2);
    expect(v).toBeInstanceOf(VecSignal);
    expect(v.value).toEqual({ x: 1, y: 2 });
  });

  it("writable field lens (.x on VecSignal)", () => {
    const v = vec(1, 2);
    expect(v.x).toBeInstanceOf(NumLens);
    expect(v.x.value).toBe(1);
    v.x.value = 99;
    expect(v.value).toEqual({ x: 99, y: 2 });
  });

  it("field cache: same lens object on each access", () => {
    const v = vec();
    expect(v.x).toBe(v.x);
    expect(v.y).toBe(v.y);
  });

  it("normalize() returns VecComputed (RO)", () => {
    const v = vec(3, 4);
    const n = v.normalize();
    expect(n).toBeInstanceOf(VecComputed);
    expect(n.value.x).toBeCloseTo(0.6);
    expect(n.value.y).toBeCloseTo(0.8);
    expect(() => { (n as unknown as { value: { x: number; y: number } }).value = { x: 0, y: 0 } }).toThrow();
  });

  it("normalize().x is a NumComputed (RO field on RO)", () => {
    const v = vec(3, 4);
    const n = v.normalize();
    expect(n.x).toBeInstanceOf(NumComputed);
    expect(n.x.value).toBeCloseTo(0.6);
    expect(() => { (n.x as unknown as { value: number }).value = 5 }).toThrow();
  });

  it("invertible add returns VecLens (writable)", () => {
    const v = vec(1, 1);
    const moved = v.add({ x: 5, y: 0 });
    expect(moved).toBeInstanceOf(VecLens);
    expect(moved.value).toEqual({ x: 6, y: 1 });
    moved.value = { x: 10, y: 10 };
    expect(v.value).toEqual({ x: 5, y: 10 });  // bwd: subtract {5,0}
  });

  it("chain of invertible methods (writability propagates)", () => {
    const v = vec(0, 0);
    const chain = v.add({ x: 1, y: 1 }).scale(2);
    expect(chain).toBeInstanceOf(VecLens);
    expect(chain.value).toEqual({ x: 2, y: 2 });
    chain.value = { x: 10, y: 10 };
    expect(v.value).toEqual({ x: 4, y: 4 });
  });

  it("magnitude is a lazy NumComputed (RO)", () => {
    const v = vec(3, 4);
    expect(v.magnitude).toBeInstanceOf(NumComputed);
    expect(v.magnitude.value).toBe(5);
    v.value = { x: 5, y: 12 };
    expect(v.magnitude.value).toBe(13);
  });

  it("VecNS.derive returns VecComputed", () => {
    const a = vec(1, 0);
    const flipped = VecNS.derive(() => ({ x: -a.value.x, y: -a.value.y }));
    expect(flipped).toBeInstanceOf(VecComputed);
    expect(flipped.value.x).toBe(-1);
    expect(flipped.value.y).toBeCloseTo(0);
  });

  it("VecNS.lens returns VecLens (writable)", () => {
    const a = vec(0, 0);
    const swapped = VecNS.lens(
      () => ({ x: a.value.y, y: a.value.x }),
      (v) => { a.value = { x: v.y, y: v.x } },
    );
    swapped.value = { x: 5, y: 10 };
    expect(a.value).toEqual({ x: 10, y: 5 });
  });

  it("reactive across derived → effect", () => {
    const v = vec(1, 2);
    const sum = NumNS.derive(() => v.value.x + v.value.y);
    let seen = 0;
    effect(() => { seen = sum.value });
    expect(seen).toBe(3);
    v.x.value = 10;
    expect(seen).toBe(12);
  });
});
