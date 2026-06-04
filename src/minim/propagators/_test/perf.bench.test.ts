// perf.bench.test.ts — propagator network performance benchmarks.

import { describe, expect, it } from "vitest";
import { cell, num } from "../../signals";
import { add, align, allDifferent, box, hstack, propagators, type SetCell } from "..";

const eqSet = (a: ReadonlySet<number>, b: ReadonlySet<number>): boolean => {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
};
const setCell = (init: Iterable<number>): SetCell<number> =>
  cell<ReadonlySet<number>>(new Set(init), { equals: eqSet });

describe("propagator perf", () => {
  it("layout: 100-cell add chain, drag head 1000x", () => {
    const N = 100;
    const cells = Array.from({ length: N }, () => num(0));
    const p = propagators({ iterations: 200 });
    for (let i = 0; i < N - 2; i += 2) {
      p.add(add(cells[i]!, cells[i + 1]!, cells[i + 2]!));
    }

    cells[1]!.value = 1; // warm
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) cells[1]!.value = i;
    const ms = (performance.now() - t0) / 1000;
    console.log(`  add chain N=${N}: ${ms.toFixed(4)}ms / drag tick`);
    expect(Number.isFinite(ms)).toBe(true);
    p.dispose();
  });

  it("layout: hstack N=100 with bounds, drag container 1000x", () => {
    const N = 100;
    const c = box(0, 0, 1000, 50);
    const items = Array.from({ length: N }, () => box());
    const p = propagators({ iterations: 100 });
    p.add(
      hstack(
        c,
        items.map(b => ({ box: b, min: 4, max: 50 })),
        { gap: 4 },
      ),
    );

    c.w.value = 1001;
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) c.w.value = 800 + (i % 1500);
    const ms = (performance.now() - t0) / 1000;
    console.log(`  hstack N=${N}: ${ms.toFixed(4)}ms / drag tick`);
    expect(Number.isFinite(ms)).toBe(true);
    p.dispose();
  });

  it("layout: hstack N=1000, drag container 100x", () => {
    const N = 1000;
    const c = box(0, 0, 8000, 50);
    const items = Array.from({ length: N }, () => box());
    const p = propagators({ iterations: 100 });
    p.add(hstack(c, items, { gap: 2 }));

    c.w.value = 8001;
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) c.w.value = 5000 + (i % 5000);
    const ms = (performance.now() - t0) / 100;
    console.log(`  hstack N=${N}: ${ms.toFixed(4)}ms / drag tick`);
    expect(Number.isFinite(ms)).toBe(true);
    p.dispose();
  });

  it("layout: align N=100 (one→all), drag head 1000x", () => {
    const N = 100;
    const cells = Array.from({ length: N }, () => num(0));
    const p = propagators({ iterations: 100 });
    p.add(align(...cells));

    cells[0]!.value = 1;
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) cells[0]!.value = i;
    const ms = (performance.now() - t0) / 1000;
    console.log(`  align N=${N}: ${ms.toFixed(4)}ms / drag tick`);
    expect(Number.isFinite(ms)).toBe(true);
    p.dispose();
  });

  it("inference: sudoku 4x4 install + solve, 100 trials", () => {
    const t0 = performance.now();
    for (let trial = 0; trial < 100; trial++) {
      const all = (): SetCell<number> => setCell([1, 2, 3, 4]);
      const grid: SetCell<number>[][] = [
        [all(), setCell([2]), all(), all()],
        [setCell([3]), all(), all(), setCell([4])],
        [all(), all(), setCell([1]), all()],
        [all(), all(), setCell([4]), all()],
      ];
      const p = propagators({ iterations: 200 });
      for (const row of grid) p.add(allDifferent(...row));
      for (let c = 0; c < 4; c++) p.add(allDifferent(...grid.map(r => r[c]!)));
      p.add(allDifferent(grid[0]![0]!, grid[0]![1]!, grid[1]![0]!, grid[1]![1]!));
      p.add(allDifferent(grid[0]![2]!, grid[0]![3]!, grid[1]![2]!, grid[1]![3]!));
      p.add(allDifferent(grid[2]![0]!, grid[2]![1]!, grid[3]![0]!, grid[3]![1]!));
      p.add(allDifferent(grid[2]![2]!, grid[2]![3]!, grid[3]![2]!, grid[3]![3]!));
      p.dispose();
    }
    const ms = (performance.now() - t0) / 100;
    console.log(`  sudoku 4x4: ${ms.toFixed(4)}ms / trial`);
    expect(Number.isFinite(ms)).toBe(true);
  });

  it("install: 1000-cell add chain", () => {
    const N = 1000;
    const cells = Array.from({ length: N }, () => num(0));
    const t0 = performance.now();
    const p = propagators({ iterations: 200 });
    for (let i = 0; i < N - 2; i += 2) {
      p.add(add(cells[i]!, cells[i + 1]!, cells[i + 2]!));
    }
    const ms = performance.now() - t0;
    console.log(`  install 1000-cell chain: ${ms.toFixed(3)}ms`);
    expect(Number.isFinite(ms)).toBe(true);
    p.dispose();
  });
});
