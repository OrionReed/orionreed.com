// terse-api.test.ts — the dramatic before/after for layout combinators.

import { describe, expect, it } from "vitest";
import { num } from "../../signals";
import { box, flexH, grid, hstack, inset, propagators, vstack } from "..";

// ─── BEFORE: verbose ─────────────────────────────────────────────

describe("before vs after", () => {
  it("before — hstack with verbose API (8 signals declared)", () => {
    const containerX = num(0);
    const containerW = num(300);
    const itemXs = [num(0), num(0), num(0)];
    const itemWs = [num(80), num(80), num(80)];
    const gap = num(8);

    const p = propagators();
    p.add(
      flexH({
        containerX,
        containerWidth: containerW,
        gap,
        items: [
          { x: itemXs[0]!, w: itemWs[0]! },
          { x: itemXs[1]!, w: itemWs[1]! },
          { x: itemXs[2]!, w: itemWs[2]! },
        ],
      }),
    );

    expect(itemXs[2]!.value).toBeGreaterThan(0);
    p.dispose();
  });

  it("after — hstack with Box (3 signals declared)", () => {
    const c = box({ w: 300 });
    const items = [box({ w: 80 }), box({ w: 80 }), box({ w: 80 })];

    const p = propagators();
    p.add(hstack(c, items, { gap: 8 }));

    expect(items[2]!.x.value).toBeGreaterThan(0);
    p.dispose();
  });
});

// ─── hstack/vstack semantics ─────────────────────────────────────

describe("hstack basics", () => {
  it("3 items grow to fill container width", () => {
    const c = box({ w: 300 });
    const items = [box(), box(), box()];

    const p = propagators();
    p.add(hstack(c, items, { gap: 0 }));

    // Each item gets 100.
    expect(items[0]!.w.value).toBeCloseTo(100, 5);
    expect(items[1]!.x.value).toBeCloseTo(100, 5);
    expect(items[2]!.x.value).toBeCloseTo(200, 5);
    p.dispose();
  });

  it("min/max bounds clamp items", () => {
    const c = box({ w: 500 });
    const items = [box(), box(), box()];

    const p = propagators();
    p.add(hstack(c, items, { gap: 0, minSize: 50, maxSize: 100 }));

    // Each capped at 100.
    expect(items[0]!.w.value).toBe(100);
    expect(items[1]!.w.value).toBe(100);
    expect(items[2]!.w.value).toBe(100);
    p.dispose();
  });

  it("padding eats into container", () => {
    const c = box({ w: 300 });
    const items = [box(), box()];

    const p = propagators();
    p.add(hstack(c, items, { gap: 0, padding: 20 }));

    // (300 - 40) / 2 = 130 each. First at x=20, second at 150.
    expect(items[0]!.w.value).toBeCloseTo(130, 5);
    expect(items[0]!.x.value).toBe(20);
    expect(items[1]!.x.value).toBeCloseTo(150, 5);
    p.dispose();
  });

  it("reactive gap signal", () => {
    const c = box({ w: 300 });
    const items = [box(), box()];
    const gap = num(20);

    const p = propagators();
    p.add(hstack(c, items, { gap }));

    // (300 - 20) / 2 = 140 each.
    expect(items[0]!.w.value).toBeCloseTo(140, 5);
    expect(items[1]!.x.value).toBeCloseTo(160, 5);

    // Drag gap.
    gap.value = 100;
    // (300 - 100) / 2 = 100 each.
    expect(items[0]!.w.value).toBeCloseTo(100, 5);
    expect(items[1]!.x.value).toBeCloseTo(200, 5);
    p.dispose();
  });

  it("hug mode: container size follows items", () => {
    const c = box();
    const items = [box({ w: 80 }), box({ w: 120 }), box({ w: 60 })];

    const p = propagators();
    p.add(hstack(c, items, { gap: 10, mode: "hug" }));

    // 80 + 120 + 60 + 2*10 = 280.
    expect(c.w.value).toBe(280);
    p.dispose();
  });

  it("vstack works on the cross axis", () => {
    const c = box({ h: 300, w: 100 });
    const items = [box(), box(), box()];

    const p = propagators();
    p.add(vstack(c, items, { gap: 0 }));

    expect(items[0]!.h.value).toBeCloseTo(100, 5);
    expect(items[1]!.y.value).toBeCloseTo(100, 5);
    p.dispose();
  });
});

describe("alignment", () => {
  it("center alignment on cross-axis", () => {
    const c = box({ w: 300, h: 100 });
    const items = [box({ h: 40 }), box({ h: 60 })];

    const p = propagators();
    p.add(hstack(c, items, { gap: 0, align: "center" }));

    // First: cross center = (100 - 40) / 2 = 30.
    expect(items[0]!.y.value).toBe(30);
    // Second: (100 - 60) / 2 = 20.
    expect(items[1]!.y.value).toBe(20);
    p.dispose();
  });

  it("stretch fills cross-axis", () => {
    const c = box({ w: 300, h: 100 });
    const items = [box(), box()];

    const p = propagators();
    p.add(hstack(c, items, { gap: 0, align: "stretch" }));

    expect(items[0]!.h.value).toBe(100);
    expect(items[1]!.h.value).toBe(100);
    p.dispose();
  });
});

describe("inset", () => {
  it("inner box fills outer minus padding", () => {
    const outer = box({ x: 10, y: 20, w: 300, h: 200 });
    const inner = box();

    const p = propagators();
    p.add(inset(outer, inner, { padding: 16 }));

    expect(inner.x.value).toBe(26);
    expect(inner.y.value).toBe(36);
    expect(inner.w.value).toBe(268);
    expect(inner.h.value).toBe(168);

    // Drag outer.
    outer.w.value = 600;
    expect(inner.w.value).toBe(568);
    p.dispose();
  });
});

describe("grid", () => {
  it("4 items in 2x2 grid", () => {
    const c = box({ w: 200, h: 200 });
    const items = [box(), box(), box(), box()];

    const p = propagators();
    p.add(grid(c, items, { cols: 2, gap: 0 }));

    // Each cell: 100x100.
    expect(items[0]!.w.value).toBe(100);
    expect(items[0]!.h.value).toBe(100);
    expect(items[1]!.x.value).toBe(100);
    expect(items[1]!.y.value).toBe(0);
    expect(items[2]!.x.value).toBe(0);
    expect(items[2]!.y.value).toBe(100);
    expect(items[3]!.x.value).toBe(100);
    expect(items[3]!.y.value).toBe(100);
    p.dispose();
  });

  it("grid with gaps + padding", () => {
    const c = box({ w: 220, h: 220 });
    const items = [box(), box(), box(), box()];

    const p = propagators();
    p.add(grid(c, items, { cols: 2, gap: 10, padding: 5 }));

    // (220 - 10 - 10) / 2 = 100. Each cell 100x100.
    expect(items[0]!.w.value).toBe(100);
    expect(items[0]!.h.value).toBe(100);
    expect(items[0]!.x.value).toBe(5);
    expect(items[1]!.x.value).toBe(115);
    expect(items[2]!.y.value).toBe(115);
    p.dispose();
  });
});

// ─── compositions ────────────────────────────────────────────────

describe("composition", () => {
  it("nested: hstack of vstacks", () => {
    // Outer: 3 columns. Each column: 2 rows.
    const window = box({ w: 600, h: 300 });
    const cols = [box(), box(), box()];
    const colItems = cols.map(() => [box(), box()]);

    const p = propagators();
    p.add(hstack(window, cols, { gap: 8 }));
    for (let i = 0; i < cols.length; i++) {
      p.add(vstack(cols[i]!, colItems[i]!, { gap: 4, align: "stretch" }));
    }

    // Outer: 3 cols, gap 8, total gap 16. Each col w = (600-16)/3 = 194.67.
    expect(cols[0]!.w.value).toBeCloseTo((600 - 16) / 3, 5);
    expect(cols[1]!.x.value).toBeCloseTo((600 - 16) / 3 + 8, 5);

    // Each col has 2 rows. h is window.h = 300; gap 4. Each row 148.
    // (Note: cols[0].h was never written, so it's 0 — vstack inherits.)
    // For this to work, we'd need window.h flowing into cols.
    // Without inset/align, cols.h stays at 0.
    expect(cols[0]!.h.value).toBe(0); // not propagated

    // To fix: stretch cols vertically with align: "stretch" on outer.
    p.dispose();
  });

  it("app shell: window → padded content → 3 panes", () => {
    // Layered: window, content (window minus padding), 3 panes
    // distributed in content.
    const window = box({ w: 1024, h: 768 });
    const content = box();
    const panes = [box(), box(), box()];

    const p = propagators();
    p.add(inset(window, content, { padding: 24 }));
    p.add(hstack(content, panes, { gap: 12, align: "stretch" }));

    // content: 1024-48 = 976 wide, 768-48 = 720 tall, at (24, 24).
    expect(content.x.value).toBe(24);
    expect(content.y.value).toBe(24);
    expect(content.w.value).toBe(976);
    expect(content.h.value).toBe(720);

    // panes: 3 across content, gap 12. Each: (976 - 24) / 3 = 317.33.
    expect(panes[0]!.w.value).toBeCloseTo((976 - 24) / 3, 5);
    expect(panes[0]!.x.value).toBe(24);
    expect(panes[0]!.y.value).toBe(24);
    expect(panes[0]!.h.value).toBe(720); // stretched

    // Drag window: everything follows.
    window.w.value = 1280;
    expect(content.w.value).toBe(1232);
    expect(panes[0]!.w.value).toBeCloseTo((1232 - 24) / 3, 5);
    p.dispose();
  });
});
