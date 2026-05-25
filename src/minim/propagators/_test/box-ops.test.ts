// box-ops.test.ts — Box-relational propagator combinators.

import { describe, expect, it } from "vitest";
import { num } from "../../signals";
import { attach, box, centerInside, follow, lockSize, pinEdge, propagators } from "..";

describe("attach", () => {
  it("sidebar.left = panel.right + gap", () => {
    const panel = box({ x: 0, w: 200, y: 0, h: 100 });
    const sidebar = box({ x: 0, w: 50, y: 0, h: 100 });
    const p = propagators();
    p.add(attach(panel, sidebar, "right", "left", { gap: 8 }));

    // sidebar.x should be 200 + 8 = 208.
    expect(sidebar.x.value).toBe(208);

    panel.w.value = 300;
    expect(sidebar.x.value).toBe(308);
    p.dispose();
  });

  it("body.top = header.bottom (no gap)", () => {
    const header = box({ x: 0, y: 0, w: 200, h: 50 });
    const body = box({ x: 0, y: 0, w: 200, h: 200 });
    const p = propagators();
    p.add(attach(header, body, "bottom", "top"));
    expect(body.y.value).toBe(50);

    header.h.value = 80;
    expect(body.y.value).toBe(80);
    p.dispose();
  });

  it("reactive gap signal", () => {
    const a = box({ x: 0, w: 100, y: 0, h: 50 });
    const b = box({ x: 0, w: 100, y: 0, h: 50 });
    const gap = num(10);
    const p = propagators();
    p.add(attach(a, b, "right", "left", { gap }));
    expect(b.x.value).toBe(110);

    gap.value = 50;
    expect(b.x.value).toBe(150);
    p.dispose();
  });
});

describe("centerInside", () => {
  it("inner centered in outer", () => {
    const outer = box({ x: 0, y: 0, w: 200, h: 100 });
    const inner = box({ x: 0, y: 0, w: 60, h: 40 });
    const p = propagators();
    p.add(centerInside(outer, inner));
    expect(inner.x.value).toBe(70); // (200-60)/2
    expect(inner.y.value).toBe(30); // (100-40)/2

    outer.w.value = 400;
    expect(inner.x.value).toBe(170); // (400-60)/2
    p.dispose();
  });
});

describe("pinEdge", () => {
  it("pin right edge to viewport width — width grows/shrinks", () => {
    const b = box({ x: 50, y: 0, w: 100, h: 50 });
    const viewportW = num(300);
    const p = propagators();
    p.add(pinEdge(b, "right", viewportW));
    expect(b.w.value).toBe(250); // 300 - 50

    viewportW.value = 500;
    expect(b.w.value).toBe(450);
    p.dispose();
  });
});

describe("lockSize", () => {
  it("lockSize prevents external writes from changing dimension", () => {
    const b = box({ x: 0, y: 0, w: 100, h: 50 });
    const p = propagators();
    p.add(lockSize(b, "w", 200));
    expect(b.w.value).toBe(200);

    b.w.value = 100;
    expect(b.w.value).toBe(200); // bounced back
    p.dispose();
  });
});

describe("follow", () => {
  it("follower mirrors leader exactly", () => {
    const lead = box({ x: 10, y: 20, w: 100, h: 50 });
    const fol = box({ x: 0, y: 0, w: 0, h: 0 });
    const p = propagators();
    p.add(follow(lead, fol));
    expect(fol.x.value).toBe(10);
    expect(fol.y.value).toBe(20);
    expect(fol.w.value).toBe(100);
    expect(fol.h.value).toBe(50);

    lead.x.value = 100;
    lead.w.value = 200;
    expect(fol.x.value).toBe(100);
    expect(fol.w.value).toBe(200);
    p.dispose();
  });
});
