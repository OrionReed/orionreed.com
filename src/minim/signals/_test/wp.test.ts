// wp.test.ts — upstream `w()` writable-parameter behavior across
// Num and Vec value methods.
//
// The contract: bare params behave as today (RO context); wrapped
// params (`w(sig)`) become writable handles whose absorption is
// controlled by `weight` (default 1 = full absorb). Reactive weights
// are supported. Wrapping a non-writable signal throws at construction.

import { describe, expect, it } from "vitest";
import { num, vec, w } from "../index";

describe("Num.add: w() promotion", () => {
  it("bare param: receiver absorbs (today's behavior)", () => {
    const a = num(10);
    const b = num(5);
    const c = a.add(b);
    expect(c.value).toBe(15);
    c.value = 30;
    expect(a.peek()).toBe(25);
    expect(b.peek()).toBe(5);
  });

  it("w(b): b absorbs (default weight=1)", () => {
    const a = num(10);
    const b = num(5);
    const c = a.add(w(b));
    expect(c.value).toBe(15);
    c.value = 30;
    expect(a.peek()).toBe(10);
    expect(b.peek()).toBe(20);
  });

  it("w(b, {weight: 0.5}): symmetric split", () => {
    const a = num(10);
    const b = num(5);
    const c = a.add(w(b, { weight: 0.5 }));
    c.value = 25; // delta = 10; each gets +5
    expect(a.peek()).toBe(15);
    expect(b.peek()).toBe(10);
  });

  it("w(b, {weight: 0}): equivalent to RO (no-op promotion)", () => {
    const a = num(10);
    const b = num(5);
    const c = a.add(w(b, { weight: 0 }));
    c.value = 30;
    expect(a.peek()).toBe(25);
    expect(b.peek()).toBe(5);
  });

  it("reactive weight: drag the policy slider live", () => {
    const a = num(10);
    const b = num(5);
    const stiffness = num(1);
    const c = a.add(w(b, { weight: stiffness }));

    c.value = 25; // weight=1: b absorbs full 10
    expect(a.peek()).toBe(10);
    expect(b.peek()).toBe(15);

    // Reset; flip stiffness to 0.5
    a.value = 10;
    b.value = 5;
    stiffness.value = 0.5;
    c.value = 25;
    expect(a.peek()).toBe(15);
    expect(b.peek()).toBe(10);
  });

  it("PutGet (bare and wrapped)", () => {
    const a = num(10);
    const b = num(5);
    const c1 = a.add(b);
    const c2 = a.add(w(b));
    c1.value = 100;
    expect(c1.value).toBe(100);
    c2.value = 200;
    expect(c2.value).toBe(200);
  });
});

describe("Num.sub: w() promotion", () => {
  it("bare: receiver absorbs", () => {
    const a = num(20);
    const b = num(5);
    const c = a.sub(b); // = 15
    c.value = 25; // delta = 10
    expect(a.peek()).toBe(30); // a += 10
    expect(b.peek()).toBe(5);
  });

  it("w(b): b absorbs (negated sign)", () => {
    const a = num(20);
    const b = num(5);
    const c = a.sub(w(b));
    c.value = 5; // delta = -10 from cur=15
    expect(a.peek()).toBe(20);
    expect(b.peek()).toBe(15); // b -= -10 = +10
  });
});

describe("Num.scale: w() promotion", () => {
  it("bare: receiver absorbs", () => {
    const a = num(10);
    const k = num(2);
    const c = a.scale(k); // = 20
    c.value = 40;
    expect(a.peek()).toBe(20); // 40 / 2
    expect(k.peek()).toBe(2);
  });

  it("w(k): k absorbs (a anchored when a ≠ 0)", () => {
    const a = num(10);
    const k = num(2);
    const c = a.scale(w(k));
    c.value = 40;
    expect(a.peek()).toBe(10);
    expect(k.peek()).toBe(4); // 40 / 10
  });

  it("w(k, {weight: 0}): equivalent to RO", () => {
    const a = num(10);
    const k = num(2);
    const c = a.scale(w(k, { weight: 0 }));
    c.value = 40;
    expect(a.peek()).toBe(20);
    expect(k.peek()).toBe(2);
  });
});

describe("Num.clamp: w() stretches the bound", () => {
  it("bare: classic projection (out-of-range gets clamped)", () => {
    const t = num(50);
    const c = t.clamp(0, 100);
    c.value = 150;
    // Classic clamp: writes 100 back; t becomes 100.
    expect(t.peek()).toBe(100);
    expect(c.value).toBe(100);
  });

  it("w(hi): hi stretches to admit overruns", () => {
    const t = num(50);
    const hi = num(100);
    const c = t.clamp(0, w(hi));
    c.value = 150;
    expect(hi.peek()).toBe(150); // stretched
    expect(t.peek()).toBe(150); // weight=1 → target written through
    expect(c.value).toBe(150); // PutGet restored
  });

  it("w(lo): lo stretches downward", () => {
    const t = num(50);
    const lo = num(0);
    const c = t.clamp(w(lo), 100);
    c.value = -25;
    expect(lo.peek()).toBe(-25);
    expect(t.peek()).toBe(-25);
  });

  it("partial stretch: weight 0.5 absorbs half the overrun", () => {
    const t = num(50);
    const hi = num(100);
    const c = t.clamp(0, w(hi, { weight: 0.5 }));
    c.value = 150;
    // Overrun = 50; hi gets +25 → 125; target lands on newHi (125).
    expect(hi.peek()).toBe(125);
    expect(c.value).toBe(125);
  });

  it("in-range write: bounds unchanged", () => {
    const t = num(50);
    const hi = num(100);
    const c = t.clamp(0, w(hi));
    c.value = 75;
    expect(hi.peek()).toBe(100);
    expect(t.peek()).toBe(75);
  });
});

describe("Vec.right / .up / .down / .left: w() promotion", () => {
  it("bare offset: receiver absorbs", () => {
    const a = vec(0, 0);
    const n = num(5);
    const b = a.right(n);
    b.value = { x: 100, y: 0 };
    expect(a.peek()).toEqual({ x: 95, y: 0 });
  });

  it("w(n): n absorbs x-delta", () => {
    const a = vec(0, 0);
    const n = num(5);
    const b = a.right(w(n));
    b.value = { x: 100, y: 25 };
    expect(a.peek()).toEqual({ x: 0, y: 25 }); // x anchored; y written
    expect(n.peek()).toBe(100);
  });

  it("w(n) on .up: n absorbs y-delta (with sign)", () => {
    const a = vec(0, 0);
    const n = num(5);
    const b = a.up(w(n));
    expect(b.value).toEqual({ x: 0, y: -5 });
    b.value = { x: 0, y: -50 };
    expect(a.peek()).toEqual({ x: 0, y: 0 });
    expect(n.peek()).toBe(50);
  });

  it(".right(w(n, {weight: 0.5})): split absorption", () => {
    const a = vec(0, 0);
    const n = num(0);
    const b = a.right(w(n, { weight: 0.5 }));
    b.value = { x: 100, y: 0 };
    expect(a.peek()).toEqual({ x: 50, y: 0 });
    expect(n.peek()).toBe(50);
  });
});

describe("Vec.offset (two-arg): mixed RO and wp params", () => {
  it("both wrapped: each absorbs its axis", () => {
    const a = vec(0, 0);
    const dx = num(0);
    const dy = num(0);
    const b = a.offset(w(dx), w(dy));
    b.value = { x: 100, y: 50 };
    expect(a.peek()).toEqual({ x: 0, y: 0 });
    expect(dx.peek()).toBe(100);
    expect(dy.peek()).toBe(50);
  });

  it("only dx wrapped: dx absorbs x, a absorbs y (RO dy)", () => {
    const a = vec(10, 20);
    const dx = num(0);
    const b = a.offset(w(dx), 5);
    expect(b.value).toEqual({ x: 10, y: 25 });
    b.value = { x: 100, y: 50 };
    // dx wrapped: absorbs x-delta. a's x anchored. a.y absorbs y delta.
    expect(a.peek()).toEqual({ x: 10, y: 45 });
    expect(dx.peek()).toBe(90); // 100 - 10
  });
});

describe("w() input validation", () => {
  it("throws for non-signal input", () => {
    // @ts-expect-error — w() requires Writable<Signal<T>>
    expect(() => w(5)).toThrow();
  });
});

describe("Composition: wp + classical chain", () => {
  it("chain wp method then classical method preserves correctness", () => {
    const a = vec(0, 0);
    const n = num(5);
    const b = a.right(w(n)).up(3); // up uses literal — classical
    expect(b.value).toEqual({ x: 5, y: -3 });

    b.value = { x: 100, y: -10 };
    // .up's bwd: receiver := { x: 100, y: -10 + 3 } = (100, -7). a.x stays.
    // .right(w(n))'s bwd: a.x anchored; n := 100; a.y := -7.
    expect(a.peek()).toEqual({ x: 0, y: -7 });
    expect(n.peek()).toBe(100);
  });

  it("wp then wp: each wrap is independent", () => {
    const a = vec(0, 0);
    const n = num(5);
    const m = num(3);
    const b = a.right(w(n)).up(w(m));
    expect(b.value).toEqual({ x: 5, y: -3 });

    b.value = { x: 100, y: -50 };
    expect(a.peek()).toEqual({ x: 0, y: 0 });
    expect(n.peek()).toBe(100);
    expect(m.peek()).toBe(50);
  });
});

describe("Invariant A (cycles): still impossible via w() alone", () => {
  it("a wrapped param must exist before the lens — no cycles", () => {
    // Structural test: TS forbids referencing a cell before construction.
    const a = num(0);
    const b = num(0);
    const c = a.add(w(b));
    expect(c.value).toBe(0);
    // No way to make a or b reference c without effect().
  });
});

describe("Invariant B (writability inference): unchanged", () => {
  it("wp method returns the same Writable<...> as RO method", () => {
    const a = num(10);
    const n = num(5);
    const c1 = a.add(n);    // Writable<Num>
    const c2 = a.add(w(n)); // Writable<Num>
    c1.value = 30;
    c2.value = 30;
    expect(c1.value).toBe(30);
    expect(c2.value).toBe(30);
  });
});

// ─── Residual-aware behaviour: wrapped param is a saturating lens ───
//
// The headline new capability: wrapping a clamped (or otherwise
// saturating) signal makes the wrapped param absorb in-range, and any
// out-of-range residual flows to the receiver. The clamp acts as a
// natural hard-stop with the receiver as the fallback absorber.

describe("Num.add: wrapped param is a clamped lens — residual flows", () => {
  it("in-range write: clamp absorbs, receiver unchanged", () => {
    const a = num(100);
    const slack = num(50).clamp(10, 100);
    const c = a.add(w(slack));
    expect(c.value).toBe(150);
    c.value = 180; // delta = 30; slack tries 80; in range; clamp accepts 80
    expect(a.peek()).toBe(100);
    expect(slack.value).toBe(80);
  });

  it("overflow above: clamp saturates, receiver absorbs the excess", () => {
    const a = num(100);
    const slack = num(50).clamp(10, 100);
    const c = a.add(w(slack));
    c.value = 250; // delta = 100; slack tries 150; clamps to 100 (delta=50); residual=50
    expect(slack.value).toBe(100);
    expect(a.peek()).toBe(150); // absorbed the 50 residual
    expect(c.value).toBe(250); // PutGet restored via residual flow
  });

  it("overflow below: clamp saturates to min; receiver absorbs the underflow", () => {
    const a = num(100);
    const slack = num(50).clamp(10, 100);
    const c = a.add(w(slack));
    c.value = 50; // delta = -100; slack tries -50; clamps to 10; residual=-60
    expect(slack.value).toBe(10);
    expect(a.peek()).toBe(40);
    expect(c.value).toBe(50);
  });

  it("repeated drags: receiver tracks every saturation event", () => {
    const a = num(100);
    const slack = num(50).clamp(10, 100);
    const c = a.add(w(slack));

    c.value = 250; // overflows by 50; a := 150
    expect(a.peek()).toBe(150);
    c.value = 200; // delta = -50; slack tries 100 - 50 = 50; in range; slack := 50
    expect(slack.value).toBe(50);
    expect(a.peek()).toBe(150); // unchanged
    expect(c.value).toBe(200);
  });

  it("primitive (no clamp) wrapped param: residual is always 0", () => {
    // Verifies the residual rule collapses to today's behavior when no
    // saturator is in the chain.
    const a = num(100);
    const b = num(50);
    const c = a.add(w(b));
    c.value = 250;
    expect(a.peek()).toBe(100);
    expect(b.peek()).toBe(150);
    expect(c.value).toBe(250);
  });
});

describe("Vec.right: bounded-slack pattern (the headline demo case)", () => {
  it("free in range; pushes receiver outside range", () => {
    const A = vec(100, 100);
    const slack = num(50).clamp(10, 100);
    const B = A.right(w(slack));
    expect(B.value).toEqual({ x: 150, y: 100 });

    // Free movement in range:
    B.value = { x: 175, y: 100 };
    expect(A.peek()).toEqual({ x: 100, y: 100 });
    expect(slack.value).toBe(75);

    // Drag past max → slack saturates, A absorbs:
    B.value = { x: 300, y: 100 };
    expect(slack.value).toBe(100);
    expect(A.peek()).toEqual({ x: 200, y: 100 });
    expect(B.value).toEqual({ x: 300, y: 100 });

    // Drag back through max range, into in-range:
    B.value = { x: 250, y: 100 };
    expect(slack.value).toBe(50);
    expect(A.peek()).toEqual({ x: 200, y: 100 });

    // Drag past min → slack saturates at 10, A absorbs underflow:
    B.value = { x: 100, y: 100 };
    expect(slack.value).toBe(10);
    expect(A.peek()).toEqual({ x: 90, y: 100 });
  });

  it("dragging A: B follows naturally via forward propagation", () => {
    const A = vec(100, 100);
    const slack = num(50).clamp(10, 100);
    const B = A.right(w(slack));

    A.value = { x: 200, y: 100 };
    expect(B.value).toEqual({ x: 250, y: 100 }); // B = 200 + 50
    A.value = { x: 0, y: 100 };
    expect(B.value).toEqual({ x: 50, y: 100 });
  });

  it("y-axis works independently — only x is bounded", () => {
    const A = vec(100, 100);
    const slack = num(50).clamp(10, 100);
    const B = A.right(w(slack));
    B.value = { x: 175, y: 250 };
    // y has no slack — should land on A
    expect(A.peek()).toEqual({ x: 100, y: 250 });
    expect(slack.value).toBe(75);
  });
});

describe("Vec.offset: bounded-slack on both axes independently", () => {
  it("x and y each have their own bounded slack", () => {
    const A = vec(0, 0);
    const sx = num(50).clamp(0, 100);
    const sy = num(50).clamp(0, 100);
    const B = A.offset(w(sx), w(sy));
    expect(B.value).toEqual({ x: 50, y: 50 });

    B.value = { x: 200, y: 200 };
    // Both slacks saturate at 100; A absorbs 100 in each axis.
    expect(sx.value).toBe(100);
    expect(sy.value).toBe(100);
    expect(A.peek()).toEqual({ x: 100, y: 100 });
    expect(B.value).toEqual({ x: 200, y: 200 });
  });
});
