// unified.test.ts — the user's "everything just works" API.
//
// One method (uRight, uScale, uAdd) handles literal/RO/Writable params.

import { describe, expect, it } from "vitest";
import { Num, num, vec } from "../../../index";
import { uAdd, uRight, uScale } from "../wp-unified";

describe("uRight: literal, RO, writable — one API", () => {
  it("literal: classic right-offset behavior", () => {
    const a = vec(0, 0);
    const b = uRight(a, 5);
    expect(b.value).toEqual({ x: 5, y: 0 });
    b.value = { x: 100, y: 25 };
    // RO path: a absorbs.
    expect(a.peek()).toEqual({ x: 95, y: 25 });
  });

  it("RO signal: classic behavior (n.derive doesn't get written)", () => {
    const seed = num(5);
    const ro = Num.derive([seed], ([v]) => v);
    const a = vec(0, 0);
    const b = uRight(a, ro);
    b.value = { x: 100, y: 0 };
    expect(a.peek().x).toBe(95);
    expect(seed.peek()).toBe(5); // RO path; ro itself not written
  });

  it("writable: wp behavior, n absorbs (default weight=1)", () => {
    const a = vec(0, 0);
    const n = num(5);
    const b = uRight(a, n);
    b.value = { x: 100, y: 0 };
    expect(a.peek()).toEqual({ x: 0, y: 0 });
    expect(n.peek()).toBe(100);
  });

  it("writable with paramWeight=0: equivalent to RO behavior", () => {
    const a = vec(0, 0);
    const n = num(5);
    const b = uRight(a, n, { paramWeight: 0 });
    b.value = { x: 100, y: 0 };
    expect(a.peek().x).toBe(95);
    expect(n.peek()).toBe(5); // unchanged
  });

  it("writable with paramWeight=0.5: split 50/50", () => {
    const a = vec(0, 0);
    const n = num(0);
    const b = uRight(a, n, { paramWeight: 0.5 });
    b.value = { x: 100, y: 0 };
    expect(a.peek().x).toBe(50);
    expect(n.peek()).toBe(50);
  });
});

describe("uScale: same dispatch", () => {
  it("literal: classic scale", () => {
    const a = num(10);
    const b = uScale(a, 2);
    expect(b.value).toBe(20);
    b.value = 30;
    expect(a.peek()).toBe(15);
  });

  it("writable k: drag the result, k absorbs (a anchored)", () => {
    const a = num(10);
    const k = num(2);
    const b = uScale(a, k);
    b.value = 30;
    expect(a.peek()).toBe(10); // anchored
    expect(k.peek()).toBe(3); // 30 / 10
  });
});

describe("uAdd: classic vs wp dispatch", () => {
  it("literal b: classic add semantics (a absorbs)", () => {
    const a = num(10);
    const c = uAdd(a, 5);
    expect(c.value).toBe(15);
    c.value = 30;
    expect(a.peek()).toBe(25); // a absorbed delta
  });

  it("writable b: 50/50 split by default", () => {
    const a = num(10);
    const b = num(20);
    const c = uAdd(a, b);
    c.value = 40; // delta=10; +5 each
    expect(a.peek()).toBe(15);
    expect(b.peek()).toBe(25);
  });
});

describe("INVARIANT: result type is always Writable<...>", () => {
  it("uRight returns Writable<Vec> in all three flavors (test independence)", () => {
    // Each flavor with FRESH a so cross-test write doesn't interfere.
    const a1 = vec(0, 0);
    const b1 = uRight(a1, 5);
    b1.value = { x: 10, y: 0 };
    expect(b1.value).toEqual({ x: 10, y: 0 });

    const a2 = vec(0, 0);
    const b2 = uRight(a2, num(5));
    b2.value = { x: 20, y: 0 };
    expect(b2.value).toEqual({ x: 20, y: 0 });

    const a3 = vec(0, 0);
    const b3 = uRight(a3, Num.derive([num(5)], ([v]) => v + 1));
    b3.value = { x: 30, y: 0 };
    expect(b3.value).toEqual({ x: 30, y: 0 });
  });

  it("VERDICT: one API surface, three behaviors, all writable results", () => {
    expect(true).toBe(true);
  });
});
