// layout-real.bench.test.ts — realistic layout benchmarks.
//
// "How does this compare to a real layout engine?" The reference
// targets:
// - Yoga (RN/C native): ~50µs / medium tree
// - Cassowary / kiwi.js: <1ms / 100 constraint solve
// - Browser CSS Flex: <5ms / 1000-element page
// - 60fps frame budget: 16.6ms

import { describe, expect, it } from "vitest";
import { num } from "../../signals";
import { adder, distributeH, flexH, propagators, stack } from "..";

describe("real layout perf", () => {
  it("flexH: 100 items with min/max bounds, drag container 1000 times", () => {
    const N = 100;
    const itemWs = Array.from({ length: N }, () => num(10));
    const itemXs = Array.from({ length: N }, () => num(0));
    const containerW = num(2000);
    const containerX = num(0);
    const gap = num(4);

    const p = propagators({ iterations: 100 });
    p.add(
      flexH({
        containerX,
        containerWidth: containerW,
        gap,
        items: itemWs.map((w, i) => ({
          x: itemXs[i]!,
          w,
          minW: 5,
          maxW: 100,
          grow: 1,
        })),
      }),
    );

    // Warm.
    containerW.value = 2001;

    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      containerW.value = 800 + (i % 1500);
    }
    const ms = (performance.now() - t0) / 1000;
    console.log(`  flexH N=${N} (drag container): ${ms.toFixed(4)}ms / drag tick`);
    expect(Number.isFinite(ms)).toBe(true);
    p.dispose();
  });

  it("flexH: 1000 items, drag container 100 times", () => {
    const N = 1000;
    const itemWs = Array.from({ length: N }, () => num(8));
    const itemXs = Array.from({ length: N }, () => num(0));
    const containerW = num(8000);
    const containerX = num(0);
    const gap = num(2);

    const p = propagators({ iterations: 100 });
    p.add(
      flexH({
        containerX,
        containerWidth: containerW,
        gap,
        items: itemWs.map((w, i) => ({
          x: itemXs[i]!,
          w,
          minW: 4,
          maxW: 50,
          grow: 1,
        })),
      }),
    );

    // Warm.
    containerW.value = 8001;

    const t0 = performance.now();
    for (let i = 0; i < 100; i++) {
      containerW.value = 5000 + (i % 5000);
    }
    const ms = (performance.now() - t0) / 100;
    console.log(`  flexH N=${N} (drag container): ${ms.toFixed(4)}ms / drag tick`);
    expect(Number.isFinite(ms)).toBe(true);
    p.dispose();
  });

  it("nested flex: 10 rows × 10 items, drag outer container 1000 times", () => {
    const ROWS = 10;
    const COLS = 10;
    const containerX = num(0);
    const containerY = num(0);
    const containerW = num(1000);
    const gap = num(8);

    const rowYs = Array.from({ length: ROWS }, () => num(0));
    const rowHs = Array.from({ length: ROWS }, () => num(50));
    const items = Array.from({ length: ROWS }, () =>
      Array.from({ length: COLS }, () => ({ x: num(0), w: num(20) })),
    );

    const p = propagators({ iterations: 100 });
    p.add(
      stack({
        origin: containerY,
        items: rowHs.map((size, i) => ({ pos: rowYs[i]!, size })),
        gap,
      }),
    );
    for (let r = 0; r < ROWS; r++) {
      p.add(
        flexH({
          containerX,
          containerWidth: containerW,
          gap,
          items: items[r]!.map(it => ({ x: it.x, w: it.w, minW: 10, maxW: 200 })),
        }),
      );
    }

    containerW.value = 1001;

    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      containerW.value = 800 + (i % 800);
    }
    const ms = (performance.now() - t0) / 1000;
    console.log(`  nested ${ROWS}×${COLS} (drag outer): ${ms.toFixed(4)}ms / drag tick`);
    expect(Number.isFinite(ms)).toBe(true);
    p.dispose();
  });

  it("compare: same task with distributeH (no min/max) for reference", () => {
    const N = 100;
    const itemWs = Array.from({ length: N }, () => num(10));
    const itemXs = Array.from({ length: N }, () => num(0));
    const containerW = num(2000);
    const containerX = num(0);
    const gap = num(0);

    const p = propagators({ iterations: 100 });
    p.add(distributeH({ containerX, containerWidth: containerW, itemXs, itemWidths: itemWs, gap }));

    containerW.value = 2001;

    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      containerW.value = 800 + (i % 1500);
    }
    const ms = (performance.now() - t0) / 1000;
    console.log(`  distributeH N=${N} (for comparison): ${ms.toFixed(4)}ms / drag tick`);
    expect(Number.isFinite(ms)).toBe(true);
    p.dispose();
  });

  it("install: 1000-item flexH", () => {
    const N = 1000;
    const itemWs = Array.from({ length: N }, () => num(8));
    const itemXs = Array.from({ length: N }, () => num(0));
    const containerW = num(8000);
    const containerX = num(0);
    const gap = num(2);

    const t0 = performance.now();
    const p = propagators({ iterations: 100 });
    p.add(
      flexH({
        containerX,
        containerWidth: containerW,
        gap,
        items: itemWs.map((w, i) => ({
          x: itemXs[i]!,
          w,
          minW: 4,
          maxW: 50,
        })),
      }),
    );
    const ms = performance.now() - t0;
    console.log(`  install flexH N=${N}: ${ms.toFixed(3)}ms`);
    expect(Number.isFinite(ms)).toBe(true);
    p.dispose();
  });

  it("propagating chain: drag pulls cascading layout", () => {
    // 20 chained adders: drag one, see how fast cascade resolves.
    const N = 20;
    const cells = Array.from({ length: N }, () => num(0));
    const p = propagators({ iterations: 100 });
    for (let i = 0; i < N - 2; i += 2) {
      p.add(adder(cells[i]!, cells[i + 1]!, cells[i + 2]!));
    }
    cells[1]!.value = 1;

    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      cells[1]!.value = i;
    }
    const ms = (performance.now() - t0) / 1000;
    console.log(`  adder chain N=${N} (cascade): ${ms.toFixed(4)}ms / drag tick`);
    expect(Number.isFinite(ms)).toBe(true);
    p.dispose();
  });
});
