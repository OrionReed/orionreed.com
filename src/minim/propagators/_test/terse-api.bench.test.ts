// terse-api.bench.test.ts — perf of the new Box-based API.

import { describe, expect, it } from "vitest";
import { box, grid, hstack, inset, propagators, vstack } from "..";

describe("terse-api perf", () => {
  it("hstack N=100 (drag container)", () => {
    const c = box({ w: 1000 });
    const items = Array.from({ length: 100 }, () => box({ w: 8 }));
    const p = propagators();
    p.add(hstack(c, items, { gap: 4, minSize: 4, maxSize: 50 }));

    c.w.value = 1001;

    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) c.w.value = 800 + (i % 1500);
    const ms = (performance.now() - t0) / 1000;
    console.log(`  hstack N=100: ${ms.toFixed(4)}ms / drag tick`);
    expect(Number.isFinite(ms)).toBe(true);
    p.dispose();
  });

  it("hstack N=1000 (drag container)", () => {
    const c = box({ w: 8000 });
    const items = Array.from({ length: 1000 }, () => box({ w: 8 }));
    const p = propagators();
    p.add(hstack(c, items, { gap: 2, minSize: 4, maxSize: 50 }));

    c.w.value = 8001;

    const t0 = performance.now();
    for (let i = 0; i < 100; i++) c.w.value = 5000 + (i % 5000);
    const ms = (performance.now() - t0) / 100;
    console.log(`  hstack N=1000: ${ms.toFixed(4)}ms / drag tick`);
    expect(Number.isFinite(ms)).toBe(true);
    p.dispose();
  });

  it("nested 10x10 (hstack of vstacks)", () => {
    const window = box({ w: 1000, h: 800 });
    const cols = Array.from({ length: 10 }, () => box());
    const colItems = cols.map(() => Array.from({ length: 10 }, () => box()));
    const p = propagators();
    p.add(hstack(window, cols, { gap: 8, align: "stretch" }));
    for (let i = 0; i < cols.length; i++) {
      p.add(vstack(cols[i]!, colItems[i]!, { gap: 4, align: "stretch" }));
    }

    window.w.value = 1001;

    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) window.w.value = 800 + (i % 800);
    const ms = (performance.now() - t0) / 1000;
    console.log(`  nested 10x10: ${ms.toFixed(4)}ms / drag tick`);
    expect(Number.isFinite(ms)).toBe(true);
    p.dispose();
  });

  it("grid 10x10 (drag container)", () => {
    const c = box({ w: 1000, h: 800 });
    const items = Array.from({ length: 100 }, () => box());
    const p = propagators();
    p.add(grid(c, items, { cols: 10, gap: 4, padding: 8 }));

    c.w.value = 1001;

    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) c.w.value = 800 + (i % 800);
    const ms = (performance.now() - t0) / 1000;
    console.log(`  grid 10x10: ${ms.toFixed(4)}ms / drag tick`);
    expect(Number.isFinite(ms)).toBe(true);
    p.dispose();
  });

  it("app shell: inset + hstack(stretch)", () => {
    const window = box({ w: 1024, h: 768 });
    const content = box();
    const panes = [box(), box(), box()];
    const p = propagators();
    p.add(inset(window, content, { padding: 24 }));
    p.add(hstack(content, panes, { gap: 12, align: "stretch" }));

    window.w.value = 1025;

    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) window.w.value = 800 + (i % 800);
    const ms = (performance.now() - t0) / 1000;
    console.log(`  app shell (inset + hstack): ${ms.toFixed(4)}ms / drag tick`);
    expect(Number.isFinite(ms)).toBe(true);
    p.dispose();
  });
});
