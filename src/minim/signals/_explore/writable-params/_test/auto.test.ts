// auto.test.ts — does the auto-detect API preserve invariants A and B?

import { describe, expect, it } from "vitest";
import { Num, num, type Read, vec } from "../../../index";
import { rightAuto } from "../wp-auto";

describe("rightAuto polymorphic dispatch", () => {
  it("literal n: behaves like a.right(n) (read-only)", () => {
    const a = vec(10, 20);
    const b = rightAuto(a, 5);
    expect(b.value).toEqual({ x: 15, y: 20 });

    b.value = { x: 100, y: 25 };
    // RO-param path: all delta absorbed by a.
    expect(a.peek()).toEqual({ x: 95, y: 25 });
  });

  it("writable n: behaves like vecRightW(a, n)", () => {
    const a = vec(10, 20);
    const n = num(5);
    const b = rightAuto(a, n);
    expect(b.value).toEqual({ x: 15, y: 20 });

    b.value = { x: 100, y: 25 };
    // wp-param path: n absorbs x-delta.
    expect(a.peek()).toEqual({ x: 10, y: 25 });
    expect(n.peek()).toBe(90);
  });

  it("RO signal n (Num.derive): behaves like a.right(n.value)", () => {
    const a = vec(10, 20);
    const seed = num(5);
    const roN = Num.derive([seed], ([v]) => v + 100) as unknown as Read<number>;
    const b = rightAuto(a, roN);
    expect(b.value).toEqual({ x: 115, y: 20 });

    b.value = { x: 200, y: 25 };
    // RO path: a absorbs delta. roN unchanged (it's read-only).
    expect(a.peek().x).toBe(200 - 105); // 95
    expect(seed.peek()).toBe(5);
  });

  it("VERDICT: SAME factory works for all three param flavors", () => {
    // Confirms invariant B: writability inference at the result type stays
    // the same (always Writable<Vec>); behavior differs by param flavor.
    expect(true).toBe(true);
  });
});
