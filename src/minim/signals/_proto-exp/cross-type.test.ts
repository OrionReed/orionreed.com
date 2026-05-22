// _proto-exp/cross-type.test.ts — sanity checks for lensTo.

import { describe, expect, it } from "vitest";
import { effect } from "../_proto-cell2/cell2";
import { Num4, num4 } from "../_proto-cell4/num4";
import { Vec4, vec4 } from "../_proto-cell4/vec4";
import { diagonalEmbed, lensTo, magnitude, lensX } from "./cross-type";

describe("lensTo: cross-type primitive", () => {
  it("magnitude: Vec → Num (read-only)", () => {
    const v = vec4(3, 4);
    const m = magnitude(v);
    expect(m).toBeInstanceOf(Num4);
    expect(m.value).toBe(5);
    v.value = { x: 5, y: 12 };
    expect(m.value).toBe(13);
    // Writing should throw (we declared it RO via throwing bwd).
    expect(() => { m.value = 100 }).toThrow();
  });

  it("lensX: re-expressed field-lens via generic lensTo", () => {
    const v = vec4(1, 2);
    const x = lensX(v);
    expect(x).toBeInstanceOf(Num4);
    expect(x.value).toBe(1);
    x.value = 99;
    expect(v.value).toEqual({ x: 99, y: 2 });
  });

  it("diagonalEmbed: 1D → 2D (lossy bwd)", () => {
    const n = num4(5);
    const v = diagonalEmbed(n);
    expect(v).toBeInstanceOf(Vec4);
    expect(v.value).toEqual({ x: 5, y: 5 });
    // Writing back: takes the .x.
    v.value = { x: 10, y: 20 };
    expect(n.value).toBe(10);
    // Read after write: embedding (10, 10), not (10, 20).
    expect(v.value).toEqual({ x: 10, y: 10 });
  });

  it("cross-type composition: lensTo + .through chains", () => {
    const v = vec4(0, 0);
    // x-lens then add 100 then scale 2 (Num4 chain)
    const cooked = lensX(v).add(100).scale(2);
    cooked.value = 220;
    // bwd: scale-inv /2 = 110; add-inv -100 = 10; written to v.x
    expect(v.value).toEqual({ x: 10, y: 0 });
  });

  it("effect subscribes through cross-type lens", () => {
    const v = vec4(3, 4);
    const m = magnitude(v);
    let observed = -1;
    const stop = effect(() => { observed = m.value });
    expect(observed).toBe(5);
    v.value = { x: 6, y: 8 };
    expect(observed).toBe(10);
    stop();
  });

  it("inline lensTo: ad-hoc cross-type lens at the call site", () => {
    // Direct use of lensTo without a named wrapper helper.
    const v = vec4(10, 20);
    const sumXY = lensTo(
      v, Num4,
      (s) => s.x + s.y,
      // Distribute the new sum proportionally to current x/y.
      (sum, s) => {
        const cur = s.x + s.y;
        if (cur === 0) return { x: sum / 2, y: sum / 2 };
        const k = sum / cur;
        return { x: s.x * k, y: s.y * k };
      },
    );
    expect(sumXY.value).toBe(30);
    sumXY.value = 60;
    expect(v.value).toEqual({ x: 20, y: 40 });
  });
});
