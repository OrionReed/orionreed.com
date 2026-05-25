// flex.test.ts — flex-like layout combinator on plain Num signals.

import { describe, expect, it } from "vitest";
import { num } from "../../signals";
import { flexH, propagators, stack } from "..";

describe("flexH: fit mode (container drives)", () => {
  it("3 equal items grow to fill container", () => {
    const containerW = num(300);
    const itemWs = [num(50), num(50), num(50)];
    const itemXs = [num(0), num(0), num(0)];
    const gap = num(10);
    const containerX = num(0);

    const p = propagators();
    p.add(
      flexH({
        containerX,
        containerWidth: containerW,
        gap,
        items: itemWs.map((w, i) => ({ x: itemXs[i]!, w, grow: 1, shrink: 1 })),
      }),
    );

    // 3 items + 2 gaps = 300. 2 gaps = 20. Items get 280 / 3 each
    // (none had max bound, all grew equally from 50).
    expect(itemWs[0]!.value).toBeCloseTo(280 / 3, 6);
    expect(itemWs[1]!.value).toBeCloseTo(280 / 3, 6);
    expect(itemWs[2]!.value).toBeCloseTo(280 / 3, 6);
    expect(itemXs[0]!.value).toBeCloseTo(0, 6);
    expect(itemXs[1]!.value).toBeCloseTo(280 / 3 + 10, 6);
    p.dispose();
  });

  it("min/max bounds clamp items", () => {
    const containerW = num(500);
    const itemWs = [num(50), num(50), num(50)];
    const itemXs = [num(0), num(0), num(0)];
    const gap = num(0);
    const containerX = num(0);

    const p = propagators();
    p.add(
      flexH({
        containerX,
        containerWidth: containerW,
        gap,
        items: [
          { x: itemXs[0]!, w: itemWs[0]!, minW: 50, maxW: 100 }, // capped at 100
          { x: itemXs[1]!, w: itemWs[1]!, minW: 50, maxW: 100 },
          { x: itemXs[2]!, w: itemWs[2]!, minW: 50, maxW: 100 },
        ],
      }),
    );

    // 500 to fill across 3 items with max 100 each = 300 max items can absorb.
    // Remaining 200 has nowhere to go (no overflow item). All hit max=100.
    expect(itemWs[0]!.value).toBe(100);
    expect(itemWs[1]!.value).toBe(100);
    expect(itemWs[2]!.value).toBe(100);
    p.dispose();
  });

  it("shrink: too small container clamps items at minW", () => {
    const containerW = num(200);
    const itemWs = [num(100), num(100), num(100)];
    const itemXs = [num(0), num(0), num(0)];
    const gap = num(0);
    const containerX = num(0);

    const p = propagators();
    p.add(
      flexH({
        containerX,
        containerWidth: containerW,
        gap,
        items: [
          { x: itemXs[0]!, w: itemWs[0]!, minW: 80, maxW: 200 },
          { x: itemXs[1]!, w: itemWs[1]!, minW: 80, maxW: 200 },
          { x: itemXs[2]!, w: itemWs[2]!, minW: 80, maxW: 200 },
        ],
      }),
    );

    // 200 / 3 = 66.7; below min(80). All clamp at 80.
    // Total layout width = 240, overflows container (no scroll handling).
    expect(itemWs[0]!.value).toBe(80);
    expect(itemWs[1]!.value).toBe(80);
    expect(itemWs[2]!.value).toBe(80);
    p.dispose();
  });

  it("uneven grow weights", () => {
    const containerW = num(400);
    const itemWs = [num(50), num(50), num(50)];
    const itemXs = [num(0), num(0), num(0)];
    const gap = num(0);
    const containerX = num(0);

    const p = propagators();
    p.add(
      flexH({
        containerX,
        containerWidth: containerW,
        gap,
        items: [
          { x: itemXs[0]!, w: itemWs[0]!, grow: 1 },
          { x: itemXs[1]!, w: itemWs[1]!, grow: 2 }, // gets 2x the slack
          { x: itemXs[2]!, w: itemWs[2]!, grow: 1 },
        ],
      }),
    );

    // sumW = 150; slack = 400 - 150 = 250; weights 1+2+1 = 4.
    // item0: 50 + 250 * 1/4 = 112.5
    // item1: 50 + 250 * 2/4 = 175
    // item2: 50 + 250 * 1/4 = 112.5
    expect(itemWs[0]!.value).toBeCloseTo(112.5, 6);
    expect(itemWs[1]!.value).toBeCloseTo(175, 6);
    expect(itemWs[2]!.value).toBeCloseTo(112.5, 6);
    p.dispose();
  });

  it("drag container reactively re-layouts", () => {
    const containerW = num(300);
    const itemWs = [num(50), num(50)];
    const itemXs = [num(0), num(0)];
    const gap = num(0);
    const containerX = num(0);
    const p = propagators();
    p.add(
      flexH({
        containerX,
        containerWidth: containerW,
        gap,
        items: [
          { x: itemXs[0]!, w: itemWs[0]! },
          { x: itemXs[1]!, w: itemWs[1]! },
        ],
      }),
    );

    // Initial: each grows from 50 to 150.
    expect(itemWs[0]!.value).toBe(150);
    expect(itemWs[1]!.value).toBe(150);
    expect(itemXs[1]!.value).toBe(150);

    // Drag container.
    containerW.value = 200;
    // Each shrinks to 100.
    expect(itemWs[0]!.value).toBe(100);
    expect(itemWs[1]!.value).toBe(100);
    expect(itemXs[1]!.value).toBe(100);

    // Drag again.
    containerW.value = 600;
    expect(itemWs[0]!.value).toBe(300);
    expect(itemWs[1]!.value).toBe(300);
    p.dispose();
  });
});

describe("flexH: hug mode (items drive)", () => {
  it("container width = sum(items) + gaps", () => {
    const containerW = num(0);
    const itemWs = [num(80), num(120), num(60)];
    const itemXs = [num(0), num(0), num(0)];
    const gap = num(10);
    const containerX = num(0);
    const p = propagators();
    p.add(
      flexH({
        containerX,
        containerWidth: containerW,
        gap,
        mode: "hug",
        items: itemWs.map((w, i) => ({ x: itemXs[i]!, w })),
      }),
    );

    // 80 + 120 + 60 + 2*10 = 280.
    expect(containerW.value).toBe(280);
    expect(itemXs[0]!.value).toBe(0);
    expect(itemXs[1]!.value).toBe(90);
    expect(itemXs[2]!.value).toBe(220);

    // Drag an item; container grows.
    itemWs[1]!.value = 200;
    expect(containerW.value).toBe(360);
    p.dispose();
  });
});

describe("nested flex: row of rows", () => {
  it("outer container with 2 rows, each row has 3 items", () => {
    // Outer flex layout: 2 ROWS stacked vertically (stack combinator).
    // Each row is itself a flexH of 3 items.
    const containerX = num(0);
    const containerY = num(0);
    const containerW = num(600);
    const gap = num(8);

    type Item = { x: ReturnType<typeof num>; y: ReturnType<typeof num>; w: ReturnType<typeof num>; h: ReturnType<typeof num> };
    const mkItem = (h: number): Item => ({ x: num(0), y: num(0), w: num(50), h: num(h) });

    const row1 = [mkItem(40), mkItem(40), mkItem(40)];
    const row2 = [mkItem(60), mkItem(60), mkItem(60)];

    const row1Y = num(0);
    const row2Y = num(0);
    const row1H = num(40);
    const row2H = num(60);

    const p = propagators();
    // Stack the 2 rows vertically.
    p.add(
      stack({
        origin: containerY,
        items: [
          { pos: row1Y, size: row1H },
          { pos: row2Y, size: row2H },
        ],
        gap,
      }),
    );
    // Each row distributes 3 items.
    p.add(
      flexH({
        containerX,
        containerWidth: containerW,
        gap,
        items: row1.map(it => ({ x: it.x, w: it.w })),
      }),
    );
    p.add(
      flexH({
        containerX,
        containerWidth: containerW,
        gap,
        items: row2.map(it => ({ x: it.x, w: it.w })),
      }),
    );
    // Each row's items get their y from the row's y.
    for (const it of row1) it.y = row1Y; // simplification: same Y signal
    for (const it of row2) it.y = row2Y;

    // Row 1: items grow from 50 to (600 - 16)/3 = 194.67.
    expect(row1[0]!.w.value).toBeCloseTo((600 - 16) / 3, 6);
    expect(row1[1]!.x.value).toBeCloseTo((600 - 16) / 3 + 8, 6);

    // Row layout y: row1 at 0, row2 at 0+40+8 = 48.
    expect(row1Y.value).toBe(0);
    expect(row2Y.value).toBe(48);

    // Drag the container width.
    containerW.value = 1000;
    expect(row1[0]!.w.value).toBeCloseTo((1000 - 16) / 3, 6);
    expect(row2[0]!.w.value).toBeCloseTo((1000 - 16) / 3, 6);

    p.dispose();
  });
});
