// _proto-multiport/meld.test.ts — meld semantics + perf-vs-mean.

import { describe, expect, it } from "vitest";
import { effect } from "../signal";
import { mean } from "../mix";
import { Num, num } from "../values/num";
import { vec, Vec } from "../values/vec";
import { deltaEven, meld, proportional, replaceFirst } from "./meld";

describe("meld: RO mode (no writeback)", () => {
  it("works as mix(Vec, mean) — read tracks contributors", () => {
    const blend = meld(Vec, mean);
    const a = vec(0, 0);
    const b = vec(10, 0);
    blend.add(a);
    blend.add(b);
    expect(blend.value).toEqual({ x: 5, y: 0 });
    a.value = { x: 20, y: 0 };
    expect(blend.value).toEqual({ x: 15, y: 0 });
  });

  it("writes throw when no writeback configured", () => {
    const blend = meld(Vec, mean);
    blend.add(vec(0, 0));
    blend.add(vec(10, 10));
    expect(() => {
      (blend as unknown as { value: { x: number; y: number } }).value = { x: 99, y: 99 };
    }).toThrow();
  });
});

describe("meld: deltaEven writeback (trait-driven)", () => {
  it("writes distribute delta evenly to each contributor", () => {
    const blend = meld(Num, mean, deltaEven);
    const a = num(0);
    const b = num(10);
    blend.add(a);
    blend.add(b);
    expect(blend.value).toBe(5);
    (blend as unknown as { value: number }).value = 8;
    expect(a.value).toBe(3);
    expect(b.value).toBe(13);
  });

  it("works on Vec via Linear trait", () => {
    const blend = meld(Vec, mean, deltaEven);
    const a = vec(0, 0);
    const b = vec(10, 10);
    blend.add(a);
    blend.add(b);
    expect(blend.value).toEqual({ x: 5, y: 5 });
    (blend as unknown as { value: { x: number; y: number } }).value = { x: 15, y: 15 };
    expect(a.value).toEqual({ x: 10, y: 10 });
    expect(b.value).toEqual({ x: 20, y: 20 });
  });
});

describe("meld: proportional writeback (weight-aware)", () => {
  it("higher weight absorbs more of the delta", () => {
    const blend = meld(Num, mean, proportional);
    const a = num(0);
    const b = num(0);
    blend.add(a, { weight: 1 });
    blend.add(b, { weight: 3 });
    // Current weighted mean = (0·1 + 0·3) / 4 = 0
    // Write 4: delta = 4; a += (1/4)*4 = 1; b += (3/4)*4 = 3
    (blend as unknown as { value: number }).value = 4;
    expect(a.value).toBeCloseTo(1);
    expect(b.value).toBeCloseTo(3);
  });
});

describe("meld: custom writeback", () => {
  it("custom fn receives current parts; writes are distributed per fn", () => {
    const blend = meld(Num, mean, (next, parts) => {
      const out: number[] = new Array(parts.length);
      out[0] = next * parts.length;
      for (let i = 1; i < parts.length; i++) out[i] = parts[i]!.value;
      return out;
    });
    const a = num(0);
    const b = num(0);
    const c = num(0);
    blend.add(a);
    blend.add(b);
    blend.add(c);
    (blend as unknown as { value: number }).value = 10;
    expect(a.value).toBe(30);
    expect(b.value).toBe(0);
    expect(c.value).toBe(0);
    expect(blend.value).toBe(10);
  });

  it("replaceFirst writeback (trait-free)", () => {
    const blend = meld(Num, mean, replaceFirst);
    const a = num(0);
    const b = num(0);
    blend.add(a);
    blend.add(b);
    (blend as unknown as { value: number }).value = 99;
    expect(a.value).toBe(99);
    expect(b.value).toBe(0);
  });
});

describe("meld: mutable membership + writeback", () => {
  it("writeback uses CURRENT contributors after add/remove", () => {
    const blend = meld(Num, mean, deltaEven);
    const a = num(0);
    const b = num(0);
    blend.add(a);
    // .add returns a disposer; cast around the `Num.prototype.add`
    // (invertible arithmetic) signature collision. Runtime works
    // because Object.assign shadows the prototype method.
    const remove = blend.add(b) as unknown as () => void;
    expect(blend.value).toBe(0);
    (blend as unknown as { value: number }).value = 10;
    expect(a.value).toBe(10);
    expect(b.value).toBe(10);
    remove();
    (blend as unknown as { value: number }).value = 20;
    expect(a.value).toBe(20);
    expect(b.value).toBe(10);
  });
});

describe("meld: effects re-fire on writeback round trip", () => {
  it("write → contributors update → effect re-fires", () => {
    const blend = meld(Num, mean, deltaEven);
    blend.add(num(0));
    blend.add(num(10));
    let observed = -1;
    const stop = effect(() => { observed = blend.value });
    expect(observed).toBe(5);
    (blend as unknown as { value: number }).value = 100;
    expect(observed).toBe(100);
    stop();
  });
});

describe("meld: .port() — allocate a fresh writable port", () => {
  it("port writes contribute to the mix", () => {
    const blend = meld(Num, mean, deltaEven);
    const p1 = blend.port(0);
    const p2 = blend.port(10);
    expect(blend.value).toBe(5);
    p1.value = 20;
    expect(blend.value).toBe(15);
    void p2;
  });
});
