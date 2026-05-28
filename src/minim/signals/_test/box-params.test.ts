// box-params.test.ts — @experimental — verify share() and own() integration
// on Box's `scale` and `expand` methods. Box is the canonical "fresh"
// value class: prior to this addition it had no share() integration
// at all (Val<...>-only methods).
//
// The RO call sites are unchanged. share() and own() are dispatched on
// at the front of each method and route to dedicated helpers.

import { describe, expect, it } from "vitest";
import { box, num, own, share } from "../index";

describe("@experimental Box.expand — share() integration", () => {
  it("bare: receiver absorbs (today's RO path, unchanged)", () => {
    const b = box(0, 0, 100, 100);
    const e = b.expand(10);
    expect(e.value).toEqual({ x: -10, y: -10, w: 120, h: 120 });
    e.value = { x: -20, y: -20, w: 140, h: 140 };
    // Receiver absorbs: inverse expand by -10 of target.
    // target.w = 140, so unexpanded w = 120; receiver becomes (- 10, - 10, 120, 120)... wait
    // expand(target, -10) = { x: -20 + 10 = -10, y: -10, w: 140 - 20 = 120, h: 120 }.
    expect(b.peek()).toEqual({ x: -10, y: -10, w: 120, h: 120 });
  });

  it("share(n): n absorbs the expansion delta", () => {
    const b = box(0, 0, 100, 100);
    const n = num(10);
    const e = b.expand(share(n));
    expect(e.value).toEqual({ x: -10, y: -10, w: 120, h: 120 });

    // Write a larger expanded box: n should absorb.
    e.value = { x: -20, y: -20, w: 140, h: 140 };
    // expand: target.w - b.w = 140 - 100 = 40, so 2*new_n = 40, new_n = 20.
    expect(n.peek()).toBe(20);
    expect(b.peek()).toEqual({ x: 0, y: 0, w: 100, h: 100 });
  });

  it("own(n): drag-a (the receiver) routes through n symmetrically", () => {
    const b = box(0, 0, 100, 100);
    const n = num(10).clamp(0, 50);
    const e = b.expand(own(n));
    expect(e.value).toEqual({ x: -10, y: -10, w: 120, h: 120 });

    // Drag the receiver wider: n should adjust to keep `e` at intended.
    b.value = { x: 0, y: 0, w: 130, h: 130 };
    // bIntended.w stays at 120. New bv.w = 130. New n = (120 - 130)/2 = -5, clamped to 0.
    expect(n.value).toBe(0);
    // b reads as { x: 0, y: 0, w: 130, h: 130 } → e = expand(b, 0) = b. Drifted.
    expect(e.value).toEqual({ x: 0, y: 0, w: 130, h: 130 });
  });

  it("own(n): claim is enforced", () => {
    const b1 = box(0, 0, 100, 100);
    const b2 = box(0, 0, 200, 200);
    const n = num(10).clamp(0, 50);
    const ownN = own(n);
    b1.expand(ownN);
    expect(() => b2.expand(ownN)).toThrow(/already claimed/);
  });

  it("own(n): external writes throw", () => {
    const b = box(0, 0, 100, 100);
    const n = num(10).clamp(0, 50);
    b.expand(own(n));
    expect(() => {
      n.value = 5;
    }).toThrow(/external writes not permitted/);
  });
});

describe("@experimental Box.scale — share() and own() integration", () => {
  it("bare: receiver absorbs", () => {
    const b = box(10, 20, 40, 60);
    const s = b.scale(2);
    expect(s.value).toEqual({ x: 20, y: 40, w: 80, h: 120 });
    s.value = { x: 40, y: 80, w: 160, h: 240 };
    expect(b.peek()).toEqual({ x: 20, y: 40, w: 80, h: 120 });
  });

  it("share(k): k absorbs", () => {
    const b = box(10, 0, 40, 0);
    const k = num(2);
    const s = b.scale(share(k));
    expect(s.value).toEqual({ x: 20, y: 0, w: 80, h: 0 });

    // Drag s.w from 80 to 200. k should absorb: k := 200/40 = 5.
    s.value = { x: 50, y: 0, w: 200, h: 0 };
    expect(k.peek()).toBe(5);
    expect(b.peek()).toEqual({ x: 10, y: 0, w: 40, h: 0 });
  });

  it("own(k): drag the receiver — k absorbs symmetrically", () => {
    const b = box(0, 0, 40, 60);
    const k = num(2);
    const s = b.scale(own(k));
    expect(s.value).toEqual({ x: 0, y: 0, w: 80, h: 120 });

    // Drag receiver wider. k should adjust to maintain s.
    b.value = { x: 0, y: 0, w: 80, h: 120 };
    // wantK such that scale(bv, k) = bIntended (80, 120). k = 80/80 = 1.
    expect(k.peek()).toBe(1);
    expect(s.value).toEqual({ x: 0, y: 0, w: 80, h: 120 });
  });
});
