// cluster-bench.test.ts — sanity perf bench for the writeBack
// reactive integration. Asserts only that timings are finite;
// the console output is the actual signal.

import { describe, expect, it } from "vitest";
import { type Vec, vec, type Writable } from "../../signals";
import { Cluster, distance } from "../index";

type WVec = Writable<Vec>;

function buildChain(N: number, iters: number) {
  const cells: WVec[] = [];
  for (let i = 0; i < N; i++) cells.push(vec(i, 0));
  const c = new Cluster({ iterations: iters });
  for (let i = 1; i < N; i++) distance(c, cells[i - 1]!, cells[i]!, 1);
  c.pin(cells[0]!);
  c.pin(cells[N - 1]!);
  return { c, cells };
}

describe("relate3 perf sanity", () => {
  it("chain N=256 iter=5 — drag a free endpoint 50 times", () => {
    const N = 256;
    const drags = 50;
    const { cells } = buildChain(N, 5);
    cells[N - 1]!.value = { x: N - 5, y: 1 };
    let dy = 1;
    const t0 = performance.now();
    for (let i = 0; i < drags; i++) {
      dy += 0.01;
      cells[N - 1]!.value = { x: N - 5, y: dy };
    }
    const ms = (performance.now() - t0) / drags;
    console.log(`  chain N=${N} iter=5: ${ms.toFixed(3)}ms / drag`);
    expect(Number.isFinite(ms)).toBe(true);
  });

  it("lattice 32×32 iter=5 — drag a corner 20 times", () => {
    const W = 32,
      H = 32;
    const drags = 20;
    const cells: WVec[][] = [];
    for (let j = 0; j < H; j++) {
      const row: WVec[] = [];
      for (let i = 0; i < W; i++) row.push(vec(i, j));
      cells.push(row);
    }
    const c = new Cluster({ iterations: 5 });
    for (let j = 0; j < H; j++)
      for (let i = 1; i < W; i++) distance(c, cells[j]![i - 1]!, cells[j]![i]!, 1);
    for (let i = 0; i < W; i++)
      for (let j = 1; j < H; j++) distance(c, cells[j - 1]![i]!, cells[j]![i]!, 1);
    c.pin(cells[0]![0]!);
    c.pin(cells[0]![W - 1]!);

    cells[H - 1]![W - 1]!.value = { x: W - 0.5, y: H - 0.5 };
    let dy = 0.5;
    const t0 = performance.now();
    for (let i = 0; i < drags; i++) {
      dy += 0.05;
      cells[H - 1]![W - 1]!.value = { x: W - 0.5, y: H - 1 + dy };
    }
    const ms = (performance.now() - t0) / drags;
    console.log(`  lattice ${W}×${H} iter=5: ${ms.toFixed(3)}ms / drag`);
    expect(Number.isFinite(ms)).toBe(true);
  });
});
