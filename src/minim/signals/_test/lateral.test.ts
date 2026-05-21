// lateral.test.ts — eq / freeze / gated.

import { describe, it, expect } from "vitest";
import { num, signal, effect, eq, gated } from "../index";

describe("eq(a, b)", () => {
  it("initial sync: b := a", () => {
    const a = num(5);
    const b = num(0);
    eq(a, b);
    expect(b.value).toBe(5);
  });

  it("write to a propagates to b", () => {
    const a = num(0);
    const b = num(0);
    eq(a, b);
    a.value = 7;
    expect(b.value).toBe(7);
  });

  it("write to b propagates to a", () => {
    const a = num(0);
    const b = num(0);
    eq(a, b);
    b.value = 9;
    expect(a.value).toBe(9);
  });

  it("doesn't infinite-loop on round-trip", () => {
    const a = num(0);
    const b = num(0);
    eq(a, b);
    let aRuns = 0;
    effect(() => { void a.value; aRuns++; });
    aRuns = 0;
    for (let i = 1; i <= 100; i++) a.value = i;
    expect(b.value).toBe(100);
    expect(aRuns).toBe(100); // one per write — no extra ping-pong
  });

  it("disposer stops sync", () => {
    const a = num(0);
    const b = num(0);
    const stop = eq(a, b);
    a.value = 5;
    expect(b.value).toBe(5);
    stop();
    a.value = 99;
    expect(b.value).toBe(5);
  });

  it("doesn't fire on float-equal writes", () => {
    const a = num(0.1);
    const b = num(0.2);
    eq(a, b);
    expect(b.value).toBeCloseTo(0.1);
    let aRuns = 0;
    effect(() => { void a.value; aRuns++; });
    aRuns = 0;
    b.value = b.peek();
    expect(aRuns).toBe(0);
  });
});

describe("gated(s, when)", () => {
  it("accepts writes when predicate is true", () => {
    const target = num(0);
    const open = signal(true);
    const g = gated(target, open);
    g.value = 5;
    expect(target.value).toBe(5);
  });

  it("drops writes when predicate is false", () => {
    const target = num(0);
    const open = signal(false);
    const g = gated(target, open);
    g.value = 5;
    expect(target.value).toBe(0); // dropped
  });

  it("toggles dynamically", () => {
    const target = num(0);
    const open = signal(true);
    const g = gated(target, open);
    g.value = 5;
    expect(target.value).toBe(5);
    open.value = false;
    g.value = 99;
    expect(target.value).toBe(5); // unchanged
    open.value = true;
    g.value = 42;
    expect(target.value).toBe(42);
  });
});
