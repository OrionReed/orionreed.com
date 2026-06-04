// layout.test.ts — Box-relational layout combinators.

import { describe, expect, it } from "vitest";
import { num } from "../../signals";
import {
  attach,
  box,
  centerInside,
  follow,
  grid,
  hstack,
  inset,
  lockSize,
  pinEdge,
  propagators,
  vstack,
} from "..";

// ─── hstack basics ─────────────────────────────────────────────────

describe("hstack", () => {
  it("3 items grow to fill container with no gap", () => {
    const c = box(0, 0, 300, 100);
    const items = [box(), box(), box()];
    const p = propagators();
    p.add(hstack(c, items, { gap: 0 }));

    expect(items[0]!.w.value).toBeCloseTo(100);
    expect(items[1]!.x.value).toBeCloseTo(100);
    expect(items[2]!.x.value).toBeCloseTo(200);
    p.dispose();
  });

  it("per-item min/max via tagged item objects", () => {
    const c = box(0, 0, 500, 100);
    const a = box();
    const b = box();
    const cc = box();
    const p = propagators();
    p.add(
      hstack(
        c,
        [
          { box: a, max: 100 },
          { box: b, max: 100 },
          { box: cc, max: 100 },
        ],
        { gap: 0 },
      ),
    );

    expect(a.w.value).toBe(100);
    expect(b.w.value).toBe(100);
    expect(cc.w.value).toBe(100);
    p.dispose();
  });

  it("padding eats into container", () => {
    const c = box(0, 0, 300, 100);
    const items = [box(), box()];
    const p = propagators();
    p.add(hstack(c, items, { gap: 0, padding: 20 }));

    expect(items[0]!.w.value).toBeCloseTo(130); // (300 - 40) / 2
    expect(items[0]!.x.value).toBe(20);
    p.dispose();
  });

  it("reactive gap cell", () => {
    const c = box(0, 0, 300, 100);
    const items = [box(), box()];
    const gap = num(20);
    const p = propagators();
    p.add(hstack(c, items, { gap }));
    expect(items[0]!.w.value).toBeCloseTo(140); // (300 - 20) / 2

    gap.value = 100;
    expect(items[0]!.w.value).toBeCloseTo(100);
    p.dispose();
  });

  it("hug mode: container resizes to fit items", () => {
    const c = box();
    const items = [box(0, 0, 80), box(0, 0, 120), box(0, 0, 60)];
    const p = propagators();
    p.add(hstack(c, items, { gap: 10, mode: "hug" }));

    expect(c.w.value).toBe(280); // 80+120+60+2*10
    p.dispose();
  });

  it("uneven grow weights via tagged items", () => {
    const c = box(0, 0, 400, 100);
    const a = box();
    const b = box();
    const cc = box();
    const p = propagators();
    p.add(
      hstack(
        c,
        [
          { box: a, grow: 1 },
          { box: b, grow: 2 },
          { box: cc, grow: 1 },
        ],
        { gap: 0 },
      ),
    );

    // 400 / 4 weights = 100 per weight unit. a:100, b:200, c:100.
    expect(a.w.value).toBeCloseTo(100);
    expect(b.w.value).toBeCloseTo(200);
    expect(cc.w.value).toBeCloseTo(100);
    p.dispose();
  });
});

// ─── alignment ──────────────────────────────────────────────────────

describe("hstack alignment", () => {
  it("center alignment on cross-axis", () => {
    const c = box(0, 0, 300, 100);
    const items = [box(0, 0, 50, 40), box(0, 0, 50, 60)];
    const p = propagators();
    p.add(hstack(c, items, { gap: 0, align: "center" }));
    expect(items[0]!.y.value).toBe(30); // (100 - 40) / 2
    expect(items[1]!.y.value).toBe(20); // (100 - 60) / 2
    p.dispose();
  });

  it("stretch fills cross-axis", () => {
    const c = box(0, 0, 300, 100);
    const items = [box(), box()];
    const p = propagators();
    p.add(hstack(c, items, { gap: 0, align: "stretch" }));
    expect(items[0]!.h.value).toBe(100);
    expect(items[1]!.h.value).toBe(100);
    p.dispose();
  });
});

// ─── vstack ────────────────────────────────────────────────────────

describe("vstack", () => {
  it("vertical layout — items stack top-to-bottom", () => {
    const c = box(0, 0, 100, 300);
    const items = [box(), box(), box()];
    const p = propagators();
    p.add(vstack(c, items, { gap: 0 }));

    expect(items[0]!.h.value).toBeCloseTo(100);
    expect(items[1]!.y.value).toBeCloseTo(100);
    expect(items[2]!.y.value).toBeCloseTo(200);
    p.dispose();
  });
});

// ─── grid ──────────────────────────────────────────────────────────

describe("grid", () => {
  it("2x2 grid", () => {
    const c = box(0, 0, 200, 200);
    const items = [box(), box(), box(), box()];
    const p = propagators();
    p.add(grid(c, items, { cols: 2, gap: 0 }));

    expect(items[0]!.w.value).toBe(100);
    expect(items[0]!.h.value).toBe(100);
    expect(items[1]!.x.value).toBe(100);
    expect(items[2]!.y.value).toBe(100);
    expect(items[3]!.x.value).toBe(100);
    expect(items[3]!.y.value).toBe(100);
    p.dispose();
  });

  it("grid with gaps + padding", () => {
    const c = box(0, 0, 220, 220);
    const items = [box(), box(), box(), box()];
    const p = propagators();
    p.add(grid(c, items, { cols: 2, gap: 10, padding: 5 }));

    expect(items[0]!.w.value).toBe(100);
    expect(items[0]!.x.value).toBe(5);
    expect(items[1]!.x.value).toBe(115);
    p.dispose();
  });
});

// ─── inset ─────────────────────────────────────────────────────────

describe("inset", () => {
  it("inner fills outer minus padding", () => {
    const outer = box(10, 20, 300, 200);
    const inner = box();
    const p = propagators();
    p.add(inset(outer, inner, { padding: 16 }));

    expect(inner.x.value).toBe(26);
    expect(inner.y.value).toBe(36);
    expect(inner.w.value).toBe(268);
    expect(inner.h.value).toBe(168);

    outer.w.value = 600;
    expect(inner.w.value).toBe(568);
    p.dispose();
  });
});

// ─── attach ────────────────────────────────────────────────────────

describe("attach", () => {
  it("sidebar.left = panel.right + gap", () => {
    const panel = box(0, 0, 200, 100);
    const sidebar = box(0, 0, 50, 100);
    const p = propagators();
    p.add(attach(panel, sidebar, "right", "left", { gap: 8 }));
    expect(sidebar.x.value).toBe(208);

    panel.w.value = 300;
    expect(sidebar.x.value).toBe(308);
    p.dispose();
  });

  it("body.top = header.bottom (no gap)", () => {
    const header = box(0, 0, 200, 50);
    const body = box(0, 0, 200, 200);
    const p = propagators();
    p.add(attach(header, body, "bottom", "top"));
    expect(body.y.value).toBe(50);

    header.h.value = 80;
    expect(body.y.value).toBe(80);
    p.dispose();
  });
});

// ─── centerInside ───────────────────────────────────────────────────

describe("centerInside", () => {
  it("inner centered in outer", () => {
    const outer = box(0, 0, 200, 100);
    const inner = box(0, 0, 60, 40);
    const p = propagators();
    p.add(centerInside(outer, inner));
    expect(inner.x.value).toBe(70);
    expect(inner.y.value).toBe(30);

    outer.w.value = 400;
    expect(inner.x.value).toBe(170);
    p.dispose();
  });
});

// ─── pinEdge ────────────────────────────────────────────────────────

describe("pinEdge", () => {
  it("pin right edge to viewport width — width grows/shrinks", () => {
    const b = box(50, 0, 100, 50);
    const viewportW = num(300);
    const p = propagators();
    p.add(pinEdge(b, "right", viewportW));
    expect(b.w.value).toBe(250);

    viewportW.value = 500;
    expect(b.w.value).toBe(450);
    p.dispose();
  });
});

// ─── lockSize ───────────────────────────────────────────────────────

describe("lockSize", () => {
  it("prevents external writes from changing dimension", () => {
    const b = box(0, 0, 100, 50);
    const p = propagators();
    p.add(lockSize(b, "w", 200));
    expect(b.w.value).toBe(200);

    b.w.value = 100;
    expect(b.w.value).toBe(200); // bounced back
    p.dispose();
  });
});

// ─── follow ─────────────────────────────────────────────────────────

describe("follow", () => {
  it("follower mirrors leader exactly", () => {
    const lead = box(10, 20, 100, 50);
    const fol = box();
    const p = propagators();
    p.add(follow(lead, fol));
    expect(fol.x.value).toBe(10);
    expect(fol.w.value).toBe(100);

    lead.x.value = 100;
    lead.w.value = 200;
    expect(fol.x.value).toBe(100);
    expect(fol.w.value).toBe(200);
    p.dispose();
  });
});

// ─── nested composition ────────────────────────────────────────────

describe("composition", () => {
  it("app shell: window → padded content → 3 stretched panes", () => {
    const window = box(0, 0, 1024, 768);
    const content = box();
    const panes = [box(), box(), box()];
    const p = propagators();
    p.add(inset(window, content, { padding: 24 }));
    p.add(hstack(content, panes, { gap: 12, align: "stretch" }));

    expect(content.w.value).toBe(976);
    expect(panes[0]!.w.value).toBeCloseTo((976 - 24) / 3);
    expect(panes[0]!.h.value).toBe(720);

    window.w.value = 1280;
    expect(content.w.value).toBe(1232);
    expect(panes[0]!.w.value).toBeCloseTo((1232 - 24) / 3);
    p.dispose();
  });
});
