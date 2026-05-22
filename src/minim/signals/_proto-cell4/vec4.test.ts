// _proto-cell4/vec4.test.ts — semantic + perf sanity for Vec4.
//
// We're checking that the composition pattern correctly handles:
//   - source-mode Vec4 construction
//   - derived-mode (Vec4.derive)
//   - lens-mode (Vec4.lens)
//   - field lenses to Num4 (cross-class)
//   - field-lens identity (memo)
//   - invertible chain writes through to source
//   - .through() fusion across chain
//   - effects subscribing through field lenses

import { describe, expect, it } from "vitest";
import { effect } from "../_proto-cell2/cell2";
import { Num4 } from "./num4";
import { Vec4, vec4 } from "./vec4";

describe("Vec4 composition: source-mode", () => {
  it("constructs writable, reads/writes the slot", () => {
    const v = vec4(3, 4);
    expect(v).toBeInstanceOf(Vec4);
    expect(v.value).toEqual({ x: 3, y: 4 });
    v.value = { x: 10, y: 20 };
    expect(v.value).toEqual({ x: 10, y: 20 });
  });
});

describe("Vec4 composition: field lenses to Num4", () => {
  it("v.x is a Num4 that reads/writes the x slot of v.value", () => {
    const v = vec4(5, 7);
    expect(v.x).toBeInstanceOf(Num4);
    expect(v.x.value).toBe(5);
    v.x.value = 99;
    expect(v.value).toEqual({ x: 99, y: 7 });
  });

  it("v.x has stable identity across reads (memo)", () => {
    const v = vec4(0, 0);
    expect(v.x).toBe(v.x);
    expect(v.y).toBe(v.y);
    expect(v.x).not.toBe(v.y);
  });

  it("effect subscribes through v.x to v", () => {
    const v = vec4(1, 2);
    let observed = -1;
    const stop = effect(() => { observed = v.x.value });
    expect(observed).toBe(1);
    v.value = { x: 42, y: 99 };
    expect(observed).toBe(42);
    stop();
  });
});

describe("Vec4 composition: invertibles via .through (auto-fuse)", () => {
  it("v.add({0, 1}) writes back through", () => {
    const v = vec4(0, 0);
    const shifted = v.add({ x: 10, y: 20 });
    expect(shifted.value).toEqual({ x: 10, y: 20 });
    shifted.value = { x: 100, y: 200 };
    expect(v.value).toEqual({ x: 90, y: 180 });
  });

  it("v.add(b).scale(2) chain fuses to one cell, writes back", () => {
    const v = vec4(0, 0);
    const chain = v.add({ x: 1, y: 1 }).scale(2);
    expect(chain.value).toEqual({ x: 2, y: 2 });
    chain.value = { x: 10, y: 10 };
    // bwd: scale-inv → /2 = {5,5}; add-inv → -{1,1} = {4,4}
    expect(v.value).toEqual({ x: 4, y: 4 });
  });
});

describe("Vec4 composition: derive / lens", () => {
  it("Vec4.derive returns a read-style Vec4 (writes throw)", () => {
    const a = vec4(1, 2);
    const doubled = Vec4.derive(() => ({ x: a.value.x * 2, y: a.value.y * 2 }));
    expect(doubled.value).toEqual({ x: 2, y: 4 });
    expect(() => { doubled.value = { x: 0, y: 0 } }).toThrow();
  });

  it("Vec4.lens returns a writable bidirectional view", () => {
    const a = vec4(0, 0);
    const swapped = Vec4.lens(
      () => ({ x: a.value.y, y: a.value.x }),
      (s) => { a.value = { x: s.y, y: s.x } },
    );
    swapped.value = { x: 9, y: 7 };
    expect(a.value).toEqual({ x: 7, y: 9 });
  });
});

describe("Vec4 composition: cross-class field-lens chains", () => {
  it("field lens onto Num4 invertibles compose with outer Vec4 fusion", () => {
    const v = vec4(0, 0);
    const doubledX = v.x.add(10).scale(2); // Num4 chain (fused)
    doubledX.value = 30;
    // bwd: scale-inv /2 = 15; add-inv -10 = 5; written to v.x → v.x = 5
    expect(v.value).toEqual({ x: 5, y: 0 });
  });

  it("write to outer Vec4 propagates to field-lens reads", () => {
    const v = vec4(0, 0);
    let xObs = -1, yObs = -1;
    effect(() => { xObs = v.x.value });
    effect(() => { yObs = v.y.value });
    v.value = { x: 5, y: 7 };
    expect(xObs).toBe(5);
    expect(yObs).toBe(7);
  });
});
