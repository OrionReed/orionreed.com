// types.test.ts — type-level smoke tests. These run at TS compile time.
//
// We're verifying invariant B: writability inference for the lens RESULT
// remains determined by the receiver/factory shape, independent of which
// params happen to be writable.

import { describe, expectTypeOf, it } from "vitest";
import { Num, num, type Read, Signal, Vec, vec, type Writable } from "../../../index";
import { clampSlide, clampStretch, numAddW, numWithSlack, vecRightW } from "../wp";
import { rightAuto } from "../wp-auto";

describe("Type-level: result writability", () => {
  it("vecRightW returns Writable<Vec>", () => {
    const a = vec(0, 0);
    const n = num(0);
    const b = vecRightW(a, n);
    expectTypeOf(b).toExtend<Writable<Vec>>();
    // The .value setter must be assignable.
    b.value = { x: 1, y: 1 };
  });

  it("numAddW returns Writable<Num>", () => {
    const a = num(0);
    const b = num(0);
    const c = numAddW(a, b);
    expectTypeOf(c).toExtend<Writable<Num>>();
    c.value = 5;
  });

  it("clampStretch returns Writable<Num>", () => {
    const t = num(0);
    const lo = num(-10);
    const hi = num(10);
    const view = clampStretch(t, lo, hi);
    expectTypeOf(view).toExtend<Writable<Num>>();
    view.value = 100;
  });

  it("clampSlide returns Writable<Num>", () => {
    const view = clampSlide(num(0), num(-10), num(10));
    expectTypeOf(view).toExtend<Writable<Num>>();
    view.value = 100;
  });

  it("numWithSlack returns Writable<Num>", () => {
    const view = numWithSlack(num(0), num(0));
    expectTypeOf(view).toExtend<Writable<Num>>();
    view.value = 100;
  });
});

describe("Type-level: rightAuto polymorphism", () => {
  it("returns Writable<Vec> for literal n", () => {
    const a = vec(0, 0);
    const b = rightAuto(a, 5);
    expectTypeOf(b).toExtend<Writable<Vec>>();
  });

  it("returns Writable<Vec> for writable n", () => {
    const a = vec(0, 0);
    const n = num(5);
    const b = rightAuto(a, n);
    expectTypeOf(b).toExtend<Writable<Vec>>();
  });

  it("returns Writable<Vec> for RO n", () => {
    const a = vec(0, 0);
    const roN = Num.derive([num(5)], ([v]) => v + 1) as unknown as Read<number>;
    const b = rightAuto(a, roN);
    expectTypeOf(b).toExtend<Writable<Vec>>();
  });
});

describe("Type-level: API for wp factories accepts only writables (current design)", () => {
  it("vecRightW does NOT accept a literal number for n", () => {
    const a = vec(0, 0);
    // @ts-expect-error — n must be Writable<Num>; literal rejected.
    vecRightW(a, 5);
  });

  it("vecRightW does NOT accept a RO Num for n", () => {
    const a = vec(0, 0);
    const roN = Num.derive([num(5)], ([v]) => v + 1);
    // @ts-expect-error — roN is Num (RO), not Writable<Num>.
    vecRightW(a, roN);
  });
});

describe("Type-level: existing API unchanged", () => {
  it("a.right(literal) still works and returns Writable<Vec>", () => {
    const a = vec(0, 0);
    const b = a.right(5);
    expectTypeOf(b).toExtend<Writable<Vec>>();
  });

  it("a.right(reactive) still treats reactive as RO", () => {
    const a = vec(0, 0);
    const n = num(5);
    const b = a.right(n); // n treated as Val<number>; RO behavior
    expectTypeOf(b).toExtend<Writable<Vec>>();
  });
});
