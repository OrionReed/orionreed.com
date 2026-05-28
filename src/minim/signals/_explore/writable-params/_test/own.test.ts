// own.test.ts — verify the symmetric drag-through semantics.
//
// The headline test: in `b = a.add(own(slack))` with `slack = num().clamp(...)`,
// dragging A fires slack's clamp the SAME way dragging B does.

import { describe, expect, it } from "vitest";
import { effect, Num, num, own, vec } from "../../../index";

// ─── Symmetric drag-through ─────────────────────────────────────────

describe("Num.add(own(...)) — symmetric drag-through (the headline)", () => {
  it("drag B: slack absorbs, residual to A (existing w() behavior)", () => {
    const a = num(100);
    const slack = num(30).clamp(5, 50);
    const b = a.add(own(slack));
    expect(b.value).toBe(130);

    // Drag B in-range: slack absorbs fully.
    b.value = 145;
    expect(slack.value).toBe(45);
    expect(a.peek()).toBe(100); // a unchanged
    expect(b.value).toBe(145);

    // Drag B past slack's range: slack saturates, residual to a.
    b.value = 300;
    // Bwd trace: sv=100, gv=45 (slack from prior write), delta = 300 - 145 = 155.
    // slack desired = 45 + 155 = 200, clamps to 50. actualDelta = 50 - 45 = 5.
    // residual = 155 - 5 = 150. a := 100 + 150 = 250.
    // b reads: 250 + 50 = 300 → PutGet HOLDS.
    expect(slack.value).toBe(50);
    expect(a.peek()).toBe(250);
    expect(b.value).toBe(300); // residual mechanism preserves PG
  });

  it("drag A in-range: slack absorbs (THE NEW BEHAVIOR)", () => {
    const a = num(100);
    const slack = num(30).clamp(5, 50);
    const b = a.add(own(slack));
    expect(b.value).toBe(130);

    // Drag A; we want b to STAY at 130. Slack should absorb.
    a.value = 110;
    // desired_slack = 130 - 110 = 20. In range. Slack := 20.
    expect(slack.value).toBe(20);
    expect(b.value).toBe(130); // ← b stays! This is the symmetric magic.
  });

  it("drag A past slack range: slack saturates, b drifts (residual to view)", () => {
    const a = num(100);
    const slack = num(30).clamp(5, 50);
    const b = a.add(own(slack));

    // Drag A way past where slack could absorb.
    a.value = 200;
    // desired_slack = 130 - 200 = -70. Clamps to 5. Slack := 5.
    // b naturally re-derives: 200 + 5 = 205.
    expect(slack.value).toBe(5);
    expect(b.value).toBe(205); // ← b drifted by the unabsorbed delta.
  });

  it("drift-on-saturation: bIntended follows A through saturation", () => {
    const a = num(100);
    const slack = num(30).clamp(5, 50);
    const b = a.add(own(slack));

    a.value = 200; // slack saturates at 5; bIntended drifts to 205
    expect(b.value).toBe(205);

    // Drag A back with a large jump. bIntended was drifted to 205;
    // desired_slack = 205 - 110 = 95, clamps to 50, SATURATED AGAIN,
    // and bIntended drifts again to 110 + 50 = 160. b ends at 160.
    a.value = 110;
    expect(slack.value).toBe(50);
    expect(b.value).toBe(160);

    // Continuous small back-drag (no re-saturation) keeps b stable.
    a.value = 115; // desired = 160 - 115 = 45. In range. slack := 45.
    expect(slack.value).toBe(45);
    expect(b.value).toBe(160);
  });
});

// ─── External observability ─────────────────────────────────────────

describe("external reads of the owned slack still work", () => {
  it("derive over slack tracks reactively", () => {
    const a = num(100);
    const slack = num(30).clamp(5, 50);
    const b = a.add(own(slack));
    const slackDisplay = Num.derive([slack], ([s]) => s);

    expect(slackDisplay.value).toBe(30);

    b.value = 145; // drag b → slack := 45. bIntended becomes 145.
    expect(slackDisplay.value).toBe(45);

    a.value = 120; // drag a → slack := bIntended - aNow = 145 - 120 = 25
    expect(slackDisplay.value).toBe(25);
  });

  it("effects subscribed to slack fire on drag-a (the NEW capability)", () => {
    const a = num(100);
    const slack = num(30).clamp(5, 50);
    const b = a.add(own(slack));

    let fires = 0;
    let last = 0;
    const stop = effect(() => {
      last = slack.value;
      fires++;
    });

    expect(fires).toBe(1);
    expect(last).toBe(30);

    a.value = 110; // drag a → slack should fire reactively
    expect(fires).toBe(2);
    expect(last).toBe(20);

    stop();
  });
});

// ─── Double-claim ───────────────────────────────────────────────────

describe("ownership: single claim only", () => {
  it("double-claim throws", () => {
    const a = num(100);
    const otherA = num(50);
    const slack = num(30).clamp(5, 50);
    const ownSlack = own(slack);

    a.add(ownSlack); // first claim
    expect(() => otherA.add(ownSlack)).toThrow(/already claimed/);
  });

  it("can't claim the same own() in two different methods", () => {
    const a = num(100);
    const slack = num(30).clamp(5, 50);
    const ownSlack = own(slack);

    a.add(ownSlack);
    expect(() => a.sub(ownSlack)).toThrow(/already claimed/);
  });

  it("two different own()s of distinct cells coexist", () => {
    const a = num(100);
    const s1 = num(10).clamp(0, 20);
    const s2 = num(30).clamp(0, 60);
    const b = a.add(own(s1));
    const c = a.add(own(s2));
    expect(b.value).toBe(110);
    expect(c.value).toBe(130);

    a.value = 120;
    // For b: desired_s1 = 110 - 120 = -10, clamps to 0. b drifts to 120.
    // For c: desired_s2 = 130 - 120 = 10, in range. s2 := 10. c stays at 130.
    expect(s1.value).toBe(0);
    expect(b.value).toBe(120);
    expect(s2.value).toBe(10);
    expect(c.value).toBe(130);
  });
});

// ─── Composition ────────────────────────────────────────────────────

describe("composition", () => {
  it("two-stage chain: c on top of b, both with own slacks", () => {
    const a = num(100);
    const slack1 = num(30).clamp(5, 50);
    const slack2 = num(40).clamp(10, 80);
    const b = a.add(own(slack1));
    const c = b.add(own(slack2));

    expect(b.value).toBe(130);
    expect(c.value).toBe(170);

    // Drag a: cascade should fire both reactions.
    a.value = 110;
    // For b's reaction: desired_slack1 = 130 - 110 = 20. In range. slack1 := 20.
    // b becomes 130 (re-derived).
    // For c's reaction: b changed from 130 to 130... actually no — b is computed
    // from a and slack1. After a := 110 and slack1 := 20, b = 130 (same). But b's
    // value re-derives lazily; c's reaction subscribes to b.
    // We need to think about whether c's reaction fires when b's value doesn't
    // actually change.
    expect(slack1.value).toBe(20);
    expect(b.value).toBe(130);
    expect(c.value).toBe(170); // c shouldn't have moved
  });

  it("drag c routes through slack2; if saturated, residual goes to b", () => {
    const a = num(100);
    const slack1 = num(30).clamp(5, 50);
    const slack2 = num(40).clamp(10, 80);
    const b = a.add(own(slack1));
    const c = b.add(own(slack2));

    // Drag c by a lot.
    c.value = 500;
    // c's bwd: delta = 500 - 170 = 330.
    //   slack2 desired = 40 + 330 = 370, clamps to 80. actualDelta = 40.
    //   residual = 330 - 40 = 290. b (the receiver) := 130 + 290 = 420.
    // b's bwd then fires (b is itself a lens with own slack):
    //   delta = 420 - 130 = 290.
    //   slack1 desired = 30 + 290 = 320, clamps to 50. actualDelta = 20.
    //   residual = 290 - 20 = 270. a := 100 + 270 = 370.
    // Reads cascade: b = 370+50 = 420; c = 420+80 = 500. PutGet HOLDS.
    expect(slack2.value).toBe(80);
    expect(slack1.value).toBe(50);
    expect(a.peek()).toBe(370);
    expect(b.value).toBe(420);
    expect(c.value).toBe(500); // residual chains all the way → PG holds
  });
});

// ─── PutGet checks ──────────────────────────────────────────────────

describe("lens laws under own()", () => {
  it("PutGet: in-range write reads back exactly", () => {
    const a = num(100);
    const slack = num(30).clamp(5, 50);
    const b = a.add(own(slack));

    b.value = 140; // in range
    expect(b.value).toBe(140);

    b.value = 100; // out of [a+lo, a+hi] = [105, 150]
    // Residual mechanism extends PG: write a residual that lands b at exactly 100.
    // delta = 100 - 140 = -40. slack desired = 40 + (-40) = 0, clamps to 5.
    //   actualDelta = 5 - 40 = -35. residual = -40 - (-35) = -5.
    //   a := 100 + (-5) = 95. b reads 95 + 5 = 100. PutGet HOLDS.
    expect(b.value).toBe(100); // residual mechanism makes PG hold even past clamps
  });

  it("GetPut: read-then-write is a no-op", () => {
    const a = num(100);
    const slack = num(30).clamp(5, 50);
    const b = a.add(own(slack));

    const r = b.value;
    b.value = r;
    expect(a.peek()).toBe(100);
    expect(slack.value).toBe(30);
    expect(b.value).toBe(130);
  });
});

// ─── Num.sub(own(...)) ──────────────────────────────────────────────

describe("Num.sub(own(...)) — symmetric, subtraction form", () => {
  it("drag B routes through sub-slack", () => {
    const a = num(100);
    const slack = num(30).clamp(5, 50);
    const b = a.sub(own(slack));
    expect(b.value).toBe(70);

    b.value = 80;
    // sub bwd: target = a - sig. sig desired = a - target = 100 - 80 = 20.
    expect(slack.value).toBe(20);
    expect(b.value).toBe(80);
  });

  it("drag A: sig adjusts to maintain b", () => {
    const a = num(100);
    const slack = num(30).clamp(5, 50);
    const b = a.sub(own(slack));
    expect(b.value).toBe(70);

    a.value = 110;
    // sig = a - b = 110 - 70 = 40. In range.
    expect(slack.value).toBe(40);
    expect(b.value).toBe(70);
  });
});

// ─── Num.scale(own(...)) ────────────────────────────────────────────

describe("Num.scale(own(...)) — multiplicative with sink k", () => {
  it("drag B writes k = target / a", () => {
    const a = num(10);
    const k = num(2);
    const b = a.scale(own(k));
    expect(b.value).toBe(20);

    b.value = 50;
    expect(k.value).toBe(5);
    expect(b.value).toBe(50);
  });

  it("drag A: k = b_intended / a", () => {
    const a = num(10);
    const k = num(2);
    const b = a.scale(own(k));
    expect(b.value).toBe(20);

    a.value = 20;
    // desired_k = b_intended / aNow = 20 / 20 = 1.
    expect(k.value).toBe(1);
    expect(b.value).toBe(20);
  });
});

// ─── Vec.right(own(...)) ────────────────────────────────────────────

describe("Vec.right(own(...)) — Vec with x-axis sink", () => {
  it("drag b.x routes through n", () => {
    const a = vec(100, 200);
    const n = num(50).clamp(0, 100);
    const b = a.right(own(n));
    expect(b.value).toEqual({ x: 150, y: 200 });

    b.value = { x: 175, y: 200 };
    expect(n.value).toBe(75);
    expect(b.value).toEqual({ x: 175, y: 200 });
  });

  it("drag a.x: n absorbs symmetrically", () => {
    const a = vec(100, 200);
    const n = num(50).clamp(0, 100);
    const b = a.right(own(n));

    a.value = { x: 120, y: 200 };
    // desired_n = b_intended.x - a.x = 150 - 120 = 30.
    expect(n.value).toBe(30);
    expect(b.value).toEqual({ x: 150, y: 200 });
  });

  it("drag a.y: b.y follows (no slack in y)", () => {
    const a = vec(100, 200);
    const n = num(50).clamp(0, 100);
    const b = a.right(own(n));

    a.value = { x: 100, y: 250 };
    expect(b.value).toEqual({ x: 150, y: 250 });
    expect(n.value).toBe(50); // unchanged
  });
});

// ─── Symmetric drag through QUANTIZE ────────────────────────────────

describe("own() with a quantize lens", () => {
  it("drag a: slack snaps to nearest multiple", () => {
    const a = num(100);
    const slack = num(30).quantize(5);
    const b = a.add(own(slack));
    expect(b.value).toBe(130);

    a.value = 103;
    // desired_slack = 130 - 103 = 27. Quantize snaps to nearest multiple of 5 → 25.
    expect(slack.value).toBe(25);
    expect(b.value).toBe(128); // 103 + 25, drifts by quantize residual
  });
});

// ─── Stress: multiple drags of a in sequence ────────────────────────

describe("a long drag sequence", () => {
  it("saturating jumps drift bIntended; subsequent in-range drags stabilize", () => {
    const a = num(100);
    const slack = num(30).clamp(5, 50);
    const b = a.add(own(slack));
    expect(b.value).toBe(130);

    a.value = 200; // saturate; bIntended drifts to 205
    expect(b.value).toBe(205);

    a.value = 50; // saturating-the-other-way jump
    // desired = 205 - 50 = 155. Clamps to 50. bIntended drifts to 50 + 50 = 100.
    expect(slack.value).toBe(50);
    expect(b.value).toBe(100);

    a.value = 90; // in-range from bIntended=100
    // desired = 100 - 90 = 10. In range. slack := 10. b stable at 100.
    expect(slack.value).toBe(10);
    expect(b.value).toBe(100);
  });
});
