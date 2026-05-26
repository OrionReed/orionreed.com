// range.bench.test.ts — interval-cell vs exact-cell propagation perf.

import { describe, expect, it } from "vitest";
import { num } from "../../signals";
import { add as adder, intervalAdder, propagators, type Range, rangeCell } from "..";

describe("range vs exact perf", () => {
  it("100-cell exact-adder chain, drag head 1000 times", () => {
    const N = 100;
    const cells = Array.from({ length: N }, () => num(0));
    const p = propagators({ iterations: 200 });
    for (let i = 0; i < N - 2; i += 2) {
      p.add(adder(cells[i]!, cells[i + 1]!, cells[i + 2]!));
    }
    cells[1]!.value = 1;
    cells[1]!.value = 0;

    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) cells[1]!.value = i;
    const ms = (performance.now() - t0) / 1000;
    console.log(`  EXACT adder chain N=${N}: ${ms.toFixed(4)}ms / drag tick`);
    expect(Number.isFinite(ms)).toBe(true);
    p.dispose();
  });

  it("100-cell interval-adder chain, drag head 1000 times", () => {
    const N = 100;
    const cells = Array.from({ length: N }, () => rangeCell(-1000, 1000));
    const p = propagators({ iterations: 200 });
    for (let i = 0; i < N - 2; i += 2) {
      p.add(intervalAdder(cells[i]!, cells[i + 1]!, cells[i + 2]!));
    }
    cells[1]!.value = [1, 1] as Range;
    cells[1]!.value = [0, 0] as Range;

    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) cells[1]!.value = [i, i] as Range;
    const ms = (performance.now() - t0) / 1000;
    console.log(`  INTERVAL adder chain N=${N}: ${ms.toFixed(4)}ms / drag tick`);
    expect(Number.isFinite(ms)).toBe(true);
    p.dispose();
  });

  it("interval-adder with progressive narrowing (no drag)", () => {
    // Build a 50-cell adder chain, all unknown; progressively narrow
    // half the cells. Measure how interval propagation compounds.
    const N = 50;
    const cells = Array.from({ length: N }, () => rangeCell(-1000, 1000));
    const p = propagators({ iterations: 500 });
    for (let i = 0; i < N - 2; i += 2) {
      p.add(intervalAdder(cells[i]!, cells[i + 1]!, cells[i + 2]!));
    }

    // Each narrowing event causes O(chain length) propagation. Measure.
    const t0 = performance.now();
    for (let i = 0; i < N; i += 2) {
      cells[i]!.value = [i, i] as Range; // narrow each input cell to a singleton
    }
    const ms = performance.now() - t0;
    console.log(`  INTERVAL progressive narrowing (${N / 2} writes): ${ms.toFixed(3)}ms`);
    expect(Number.isFinite(ms)).toBe(true);
    p.dispose();
  });
});
