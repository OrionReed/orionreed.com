// perf.bench.test.ts — propagator network performance baselines.
//
// Asserts only that timings are finite; the console output is the
// signal. Mirrors `src/minim/constraints/_test/cluster-bench.test.ts`.

import { describe, expect, it } from "vitest";
import { num } from "../../signals";
import { adder, align, allDifferent, distributeH, eq, propagators, type SetCell } from "..";
import { signal } from "../../signals";

const eqSet = (a: ReadonlySet<number>, b: ReadonlySet<number>): boolean => {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
};
const setCell = (init: Iterable<number>): SetCell<number> =>
  signal<ReadonlySet<number>>(new Set(init), { equals: eqSet });

describe("propagator perf", () => {
  it("layout: 100-cell chain, drag last cell 1000 times", () => {
    const N = 100;
    // Chain: a₀ + a₁ = a₂; a₂ + a₃ = a₄; ... (cumulative sums via adders).
    const cells = Array.from({ length: N }, () => num(0));
    const p = propagators({ iterations: 200 });
    for (let i = 0; i < N - 2; i += 2) {
      p.add(adder(cells[i]!, cells[i + 1]!, cells[i + 2]!));
    }

    // Warm.
    cells[1]!.value = 1;
    cells[1]!.value = 0;

    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      cells[1]!.value = i;
    }
    const ms = (performance.now() - t0) / 1000;
    console.log(`  layout-chain N=${N} adder-pairs: ${ms.toFixed(4)}ms / drag tick`);
    expect(Number.isFinite(ms)).toBe(true);
    p.dispose();
  });

  it("layout: 100-cell distributeH, resize container 1000 times", () => {
    const N = 100;
    const containerX = num(0);
    const containerWidth = num(1000);
    const itemWidths = Array.from({ length: N }, () => num(8));
    const itemXs = Array.from({ length: N }, () => num(0));
    const gap = num(0);

    const p = propagators({ iterations: 100 });
    p.add(
      distributeH({
        containerX,
        containerWidth,
        itemXs,
        itemWidths,
        gap,
        mode: "fit",
      }),
    );

    // Warm.
    containerWidth.value = 1001;
    containerWidth.value = 1000;

    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      containerWidth.value = 800 + (i % 400);
    }
    const ms = (performance.now() - t0) / 1000;
    console.log(`  distributeH N=${N} (resize container): ${ms.toFixed(4)}ms / drag tick`);
    expect(Number.isFinite(ms)).toBe(true);
    p.dispose();
  });

  it("layout: align 100 cells, drag one 1000 times", () => {
    const N = 100;
    const cells = Array.from({ length: N }, () => num(0));
    const p = propagators({ iterations: 100 });
    p.add(align(...cells));

    cells[0]!.value = 1;
    cells[0]!.value = 0;

    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      cells[0]!.value = i;
    }
    const ms = (performance.now() - t0) / 1000;
    console.log(`  align N=${N} (one→all): ${ms.toFixed(4)}ms / drag tick`);
    expect(Number.isFinite(ms)).toBe(true);
    p.dispose();
  });

  it("inference: sudoku 4x4 install + solve, repeated 100 times", () => {
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
      for (let c = 0; c < 4; c++) {
        p.add(allDifferent(...grid.map(r => r[c]!)));
      }
      p.add(allDifferent(grid[0]![0]!, grid[0]![1]!, grid[1]![0]!, grid[1]![1]!));
      p.add(allDifferent(grid[0]![2]!, grid[0]![3]!, grid[1]![2]!, grid[1]![3]!));
      p.add(allDifferent(grid[2]![0]!, grid[2]![1]!, grid[3]![0]!, grid[3]![1]!));
      p.add(allDifferent(grid[2]![2]!, grid[2]![3]!, grid[3]![2]!, grid[3]![3]!));
      p.dispose();
    }
    const ms = (performance.now() - t0) / 100;
    console.log(`  sudoku 4x4 install+solve: ${ms.toFixed(4)}ms / trial`);
    expect(Number.isFinite(ms)).toBe(true);
  });

  it("install: 1000-cell adder chain, install time", () => {
    const N = 1000;
    const cells = Array.from({ length: N }, () => num(0));
    const t0 = performance.now();
    const p = propagators({ iterations: 200 });
    for (let i = 0; i < N - 2; i += 2) {
      p.add(adder(cells[i]!, cells[i + 1]!, cells[i + 2]!));
    }
    const ms = performance.now() - t0;
    console.log(`  install 1000-cell chain: ${ms.toFixed(3)}ms`);
    expect(Number.isFinite(ms)).toBe(true);
    p.dispose();
  });

  it("eq() chain N=20: drag head, propagate to tail", () => {
    const N = 20;
    const cells = Array.from({ length: N }, () => num(0));
    const p = propagators({ iterations: 100 });
    for (let i = 0; i < N - 1; i++) {
      p.add(eq(cells[i]!, cells[i + 1]!));
    }
    cells[0]!.value = 1;
    cells[0]!.value = 0;
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      cells[0]!.value = i;
    }
    const ms = (performance.now() - t0) / 1000;
    console.log(`  eq-chain N=${N}: ${ms.toFixed(4)}ms / drag tick`);
    expect(Number.isFinite(ms)).toBe(true);
    p.dispose();
  });
});
