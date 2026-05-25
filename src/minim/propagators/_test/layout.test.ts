// layout.test.ts — propagators for layout combinators.
//
// Probes whether propagator-based layout works ergonomically for
// the cases lenses struggle with.

import { describe, expect, it } from "vitest";
import { num } from "../../signals";
import { align, distributeH, eq, propagators } from "..";

describe("layout: align (multi-cell same-axis)", () => {
  it("4 boxes top-aligned: writing one updates all", () => {
    const y1 = num(0);
    const y2 = num(0);
    const y3 = num(0);
    const y4 = num(0);

    const p = propagators();
    p.add(align(y1, y2, y3, y4));

    // Write through y1; the others mirror.
    y1.value = 50;
    expect(y2.value).toBe(50);
    expect(y3.value).toBe(50);
    expect(y4.value).toBe(50);

    // Write through y3; symmetric.
    y3.value = 100;
    expect(y1.value).toBe(100);
    expect(y2.value).toBe(100);
    expect(y4.value).toBe(100);

    p.dispose();
  });
});

describe("layout: distributeH", () => {
  it("3 items inside a 300px container with equal gaps; positions derived", () => {
    const containerX = num(0);
    const containerWidth = num(300);
    const w1 = num(60);
    const w2 = num(60);
    const w3 = num(60);
    const x1 = num(0);
    const x2 = num(0);
    const x3 = num(0);
    const gap = num(0);

    const p = propagators();
    p.add(
      distributeH({
        containerX,
        containerWidth,
        itemXs: [x1, x2, x3],
        itemWidths: [w1, w2, w3],
        gap,
      }),
    );

    // 300 = 3*60 + 2*gap → gap = (300 - 180) / 2 = 60.
    expect(gap.value).toBe(60);
    expect(x1.value).toBe(0);
    expect(x2.value).toBe(60 + 60); // 60 (w1) + 60 (gap) = 120
    expect(x3.value).toBe(60 + 60 + 60 + 60); // 240

    p.dispose();
  });

  it("resize the container: gap auto-updates", () => {
    const containerX = num(0);
    const containerWidth = num(200);
    const w1 = num(40);
    const w2 = num(40);
    const x1 = num(0);
    const x2 = num(0);
    const gap = num(0);

    const p = propagators();
    p.add(
      distributeH({
        containerX,
        containerWidth,
        itemXs: [x1, x2],
        itemWidths: [w1, w2],
        gap,
      }),
    );

    // 200 - 80 = 120; 1 gap → gap = 120.
    expect(gap.value).toBe(120);

    // Resize container to 100 → gap shrinks.
    containerWidth.value = 100;
    expect(gap.value).toBe(20);

    p.dispose();
  });

  it("change an item's width: gap absorbs the difference", () => {
    const containerX = num(0);
    const containerWidth = num(300);
    const w1 = num(60);
    const w2 = num(60);
    const w3 = num(60);
    const x1 = num(0);
    const x2 = num(0);
    const x3 = num(0);
    const gap = num(0);

    const p = propagators();
    p.add(
      distributeH({
        containerX,
        containerWidth,
        itemXs: [x1, x2, x3],
        itemWidths: [w1, w2, w3],
        gap,
      }),
    );

    expect(gap.value).toBe(60);
    expect(x3.value).toBe(240);

    // Grow w2 by 30 → gap shrinks accordingly.
    w2.value = 90;
    // 300 - (60+90+60) = 90; 2 gaps → gap = 45.
    expect(gap.value).toBe(45);
    expect(x1.value).toBe(0);
    expect(x2.value).toBe(60 + 45); // 105
    expect(x3.value).toBe(60 + 45 + 90 + 45); // 240

    p.dispose();
  });

  it("hug mode: container width derives from items + gap", () => {
    const containerX = num(0);
    const containerWidth = num(0);
    const w1 = num(80);
    const w2 = num(80);
    const w3 = num(80);
    const x1 = num(0);
    const x2 = num(0);
    const x3 = num(0);
    const gap = num(20);

    const p = propagators();
    p.add(
      distributeH({
        containerX,
        containerWidth,
        itemXs: [x1, x2, x3],
        itemWidths: [w1, w2, w3],
        gap,
        mode: "hug",
      }),
    );

    // 3*80 + 2*20 = 280.
    expect(containerWidth.value).toBe(280);
    expect(x1.value).toBe(0);
    expect(x2.value).toBe(80 + 20);
    expect(x3.value).toBe(80 + 20 + 80 + 20);

    // Resize an item → container grows.
    w2.value = 120;
    expect(containerWidth.value).toBe(80 + 120 + 80 + 2 * 20);

    p.dispose();
  });
});

describe("layout: composition", () => {
  it("two layout primitives stacked: align + distributeH", () => {
    // Three boxes, top-aligned (shared y) AND distributed horizontally.
    const containerX = num(0);
    const containerWidth = num(450);
    const w1 = num(100);
    const w2 = num(100);
    const w3 = num(100);
    const x1 = num(0);
    const x2 = num(0);
    const x3 = num(0);
    const y1 = num(50);
    const y2 = num(0);
    const y3 = num(0);
    const gap = num(0);

    const p = propagators();
    p.add(
      distributeH({
        containerX,
        containerWidth,
        itemXs: [x1, x2, x3],
        itemWidths: [w1, w2, w3],
        gap,
      }),
      align(y1, y2, y3),
    );

    // gap = (450 - 300) / 2 = 75.
    expect(gap.value).toBe(75);
    expect(x2.value).toBe(100 + 75);
    expect(y2.value).toBe(50);
    expect(y3.value).toBe(50);

    // Drag y2; all align.
    y2.value = 200;
    expect(y1.value).toBe(200);
    expect(y3.value).toBe(200);

    p.dispose();
  });
});
