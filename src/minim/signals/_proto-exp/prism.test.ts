// _proto-exp/prism.test.ts — prism sanity.

import { describe, expect, it } from "vitest";
import { effect, signal } from "../signal";
import { Num } from "../values/num";
import { caseOf, present, presentOr } from "./prism";

describe("presentOr: nullable narrowing with fallback", () => {
  it("reads value when present, fallback when absent", () => {
    const s = signal<number | undefined>(42);
    const view = presentOr(s, Num, 0);
    expect(view.value).toBe(42);
    s.value = undefined;
    expect(view.value).toBe(0);
    s.value = 99;
    expect(view.value).toBe(99);
  });

  it("writes pass through when present, are silently ignored when absent", () => {
    const s = signal<number | undefined>(10);
    const view = presentOr(s, Num, 0);
    (view as unknown as { value: number }).value = 50;
    expect(s.value).toBe(50);

    s.value = undefined;
    (view as unknown as { value: number }).value = 100;
    expect(s.value).toBe(undefined); // ignored
  });

  it("effect observes through the prism", () => {
    const s = signal<number | undefined>(1);
    const view = presentOr(s, Num, -1);
    let observed = NaN;
    const stop = effect(() => { observed = view.value });
    expect(observed).toBe(1);
    s.value = undefined;
    expect(observed).toBe(-1);
    s.value = 5;
    expect(observed).toBe(5);
    stop();
  });
});

describe("present: strict narrowing (throws on absence)", () => {
  it("reads succeed when present", () => {
    const s = signal<number | undefined>(7);
    const view = present(s, Num);
    expect(view.value).toBe(7);
  });

  it("reads throw when absent", () => {
    const s = signal<number | undefined>(undefined);
    const view = present(s, Num);
    expect(() => view.value).toThrow(/undefined/);
  });

  it("writes throw when absent", () => {
    const s = signal<number | undefined>(undefined);
    const view = present(s, Num);
    expect(() => { (view as unknown as { value: number }).value = 5 }).toThrow(/absent/);
  });
});

describe("caseOf: tagged-union narrowing", () => {
  type Result = { tag: "ok"; n: number } | { tag: "err"; msg: string };

  it("ok-prism reads when in ok case", () => {
    const r = signal<Result>({ tag: "ok", n: 42 });
    const ok = caseOf<Result, number>(
      r, Num,
      (s) => s.tag === "ok",
      (s) => (s as { tag: "ok"; n: number }).n,
      (n) => ({ tag: "ok" as const, n }),
    );
    expect(ok.value).toBe(42);

    r.value = { tag: "err", msg: "boom" };
    expect(ok.value).toBeUndefined();

    r.value = { tag: "ok", n: 99 };
    expect(ok.value).toBe(99);
  });

  it("writing to a prism in the wrong case is a no-op", () => {
    const r = signal<Result>({ tag: "err", msg: "x" });
    const ok = caseOf<Result, number>(
      r, Num,
      (s) => s.tag === "ok",
      (s) => (s as { tag: "ok"; n: number }).n,
      (n) => ({ tag: "ok" as const, n }),
    );
    (ok as unknown as { value: number | undefined }).value = 100;
    expect(r.value).toEqual({ tag: "err", msg: "x" }); // unchanged
  });

  it("writing to a prism in the right case updates the payload", () => {
    const r = signal<Result>({ tag: "ok", n: 1 });
    const ok = caseOf<Result, number>(
      r, Num,
      (s) => s.tag === "ok",
      (s) => (s as { tag: "ok"; n: number }).n,
      (n) => ({ tag: "ok" as const, n }),
    );
    (ok as unknown as { value: number | undefined }).value = 200;
    expect(r.value).toEqual({ tag: "ok", n: 200 });
  });
});
