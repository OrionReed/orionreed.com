// basics.test.ts — does the simplest writable-param lens work?

import { describe, expect, it } from "vitest";
import { batch, num, vec } from "../../../index";
import { clampSlide, clampStretch, numAddW, numWithSlack, vecRightW } from "../wp";

describe("vec-with-slack (vecRightW)", () => {
  it("reads as a.x + n", () => {
    const a = vec(10, 20);
    const n = num(5);
    const b = vecRightW(a, n);
    expect(b.value).toEqual({ x: 15, y: 20 });
  });

  it("writing b moves n, not a.x", () => {
    const a = vec(10, 20);
    const n = num(5);
    const b = vecRightW(a, n);
    b.value = { x: 50, y: 25 };
    expect(a.peek()).toEqual({ x: 10, y: 25 }); // a.y did update; a.x anchored
    expect(n.peek()).toBe(40); // n absorbed 50 - 10 = 40
    expect(b.value).toEqual({ x: 50, y: 25 }); // PutGet — read back what we wrote
  });

  it("moving a moves b (forward propagation)", () => {
    const a = vec(10, 20);
    const n = num(5);
    const b = vecRightW(a, n);
    a.value = { x: 100, y: 200 };
    expect(b.value).toEqual({ x: 105, y: 200 });
  });

  it("moving n moves b (forward propagation through param)", () => {
    const a = vec(10, 20);
    const n = num(5);
    const b = vecRightW(a, n);
    n.value = 50;
    expect(b.value).toEqual({ x: 60, y: 20 });
  });

  it("PutGet: write b.value then read b.value", () => {
    const a = vec(10, 20);
    const n = num(5);
    const b = vecRightW(a, n);
    for (const target of [
      { x: 0, y: 0 },
      { x: -100, y: 50 },
      { x: 12345, y: -987 },
    ]) {
      b.value = target;
      expect(b.value).toEqual(target);
    }
  });

  it("GetPut: writing b back to its current value is a no-op", () => {
    const a = vec(10, 20);
    const n = num(5);
    const b = vecRightW(a, n);
    const initialB = b.value;
    const initialA = a.peek();
    const initialN = n.peek();
    b.value = initialB;
    expect(a.peek()).toEqual(initialA);
    expect(n.peek()).toBe(initialN);
  });

  it("PutPut: two consecutive puts equal the latter (idempotence)", () => {
    const a = vec(10, 20);
    const n = num(5);
    const b = vecRightW(a, n);
    b.value = { x: 50, y: 25 };
    b.value = { x: 80, y: 40 };
    expect(b.value).toEqual({ x: 80, y: 40 });
    // Compare against a fresh fixture written only once.
    const a2 = vec(10, 20);
    const n2 = num(5);
    const b2 = vecRightW(a2, n2);
    b2.value = { x: 80, y: 40 };
    expect(a.peek()).toEqual(a2.peek());
    expect(n.peek()).toBe(n2.peek());
  });
});

describe("numAddW", () => {
  it("symmetric absorption: write c writes half to each", () => {
    const a = num(10);
    const b = num(20);
    const c = numAddW(a, b);
    expect(c.value).toBe(30);
    c.value = 40; // delta = 10; +5 each
    expect(a.peek()).toBe(15);
    expect(b.peek()).toBe(25);
    expect(c.value).toBe(40);
  });

  it("weight=0 → b absorbs all (a is anchored)", () => {
    const a = num(10);
    const b = num(20);
    const c = numAddW(a, b, 0);
    c.value = 40;
    expect(a.peek()).toBe(10);
    expect(b.peek()).toBe(30);
  });

  it("weight=1 → a absorbs all", () => {
    const a = num(10);
    const b = num(20);
    const c = numAddW(a, b, 1);
    c.value = 40;
    expect(a.peek()).toBe(20);
    expect(b.peek()).toBe(20);
  });

  it("numWithSlack: a is anchored, slack absorbs", () => {
    const a = num(10);
    const s = num(0);
    const c = numWithSlack(a, s);
    expect(c.value).toBe(10);
    c.value = 25;
    expect(a.peek()).toBe(10); // anchored
    expect(s.peek()).toBe(15);
    expect(c.value).toBe(25);
  });
});

describe("clampStretch (range expands to fit)", () => {
  it("write inside range: t updates, lo/hi unchanged", () => {
    const t = num(5);
    const lo = num(0);
    const hi = num(10);
    const view = clampStretch(t, lo, hi);
    view.value = 7;
    expect(t.peek()).toBe(7);
    expect(lo.peek()).toBe(0);
    expect(hi.peek()).toBe(10);
  });

  it("write below lo: lo stretches down", () => {
    const t = num(5);
    const lo = num(0);
    const hi = num(10);
    const view = clampStretch(t, lo, hi);
    view.value = -50;
    expect(t.peek()).toBe(-50);
    expect(lo.peek()).toBe(-50);
    expect(hi.peek()).toBe(10);
  });

  it("write above hi: hi stretches up", () => {
    const t = num(5);
    const lo = num(0);
    const hi = num(10);
    const view = clampStretch(t, lo, hi);
    view.value = 100;
    expect(t.peek()).toBe(100);
    expect(lo.peek()).toBe(0);
    expect(hi.peek()).toBe(100);
  });

  it("reads continue to clamp (after stretch, read = source if in range)", () => {
    const t = num(50);
    const lo = num(0);
    const hi = num(10);
    const view = clampStretch(t, lo, hi);
    // Initially: t=50 outside [0,10] → reads as 10 (clamped)
    expect(view.value).toBe(10);
    // After widening hi to 100, view = t = 50.
    hi.value = 100;
    expect(view.value).toBe(50);
  });
});

describe("clampSlide (window translates to follow)", () => {
  it("write inside: range unchanged", () => {
    const t = num(5);
    const lo = num(0);
    const hi = num(10);
    const view = clampSlide(t, lo, hi);
    view.value = 7;
    expect(lo.peek()).toBe(0);
    expect(hi.peek()).toBe(10);
  });

  it("write below: window shifts left preserving width", () => {
    const t = num(5);
    const lo = num(0);
    const hi = num(10);
    const view = clampSlide(t, lo, hi);
    view.value = -5;
    expect(lo.peek()).toBe(-5);
    expect(hi.peek()).toBe(5);
    expect(t.peek()).toBe(-5);
  });

  it("write above: window shifts right preserving width", () => {
    const t = num(5);
    const lo = num(0);
    const hi = num(10);
    const view = clampSlide(t, lo, hi);
    view.value = 25;
    expect(lo.peek()).toBe(15);
    expect(hi.peek()).toBe(25);
    expect(t.peek()).toBe(25);
  });
});

describe("downstream observers see new values atomically", () => {
  it("a, b, c all observed in a batch after one write", () => {
    const a = vec(10, 20);
    const n = num(5);
    const b = vecRightW(a, n);

    const seen: number[] = [];
    let lastB = b.value;
    let lastN = n.peek();
    // Track every change.
    const observe = () => {
      seen.push(b.value.x);
      lastB = b.value;
      lastN = n.peek();
    };

    observe(); // initial
    batch(() => {
      b.value = { x: 50, y: 25 };
    });
    observe();
    expect(lastB).toEqual({ x: 50, y: 25 });
    expect(lastN).toBe(40);
    expect(seen).toEqual([15, 50]); // no intermediate glitch
  });
});
