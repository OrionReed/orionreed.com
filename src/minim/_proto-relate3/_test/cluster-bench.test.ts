// cluster-bench.test.ts — head-to-head perf vs `_proto-avbd`
// (preEffect-based) and `_proto-relate2` (lazy via getter).
// Same numerical kernel; only the reactive layer differs.

import { describe, expect, it } from "vitest";
import { vec, type Vec, type Writable } from "../../signals";
import { Cluster, distance as relate3Distance } from "../index";
import { distance as avbdDistance, Solver as AvbdSolver } from "../../_proto-avbd";
import { Cluster as Cluster2, distance as relate2Distance } from "../../_proto-relate2";

type WVec = Writable<Vec>;

function buildR3(N: number, iters: number) {
  const cells: WVec[] = [];
  for (let i = 0; i < N; i++) cells.push(vec(i, 0));
  const c = new Cluster({ iterations: iters });
  for (let i = 1; i < N; i++) relate3Distance(c, cells[i - 1]!, cells[i]!, 1);
  c.pin(cells[0]!);
  c.pin(cells[N - 1]!);
  return { c, cells };
}

function buildR2(N: number, iters: number) {
  const cells: WVec[] = [];
  for (let i = 0; i < N; i++) cells.push(vec(i, 0));
  const c = new Cluster2({ iterations: iters });
  for (let i = 1; i < N; i++) relate2Distance(c, cells[i - 1]!, cells[i]!, 1);
  c.pin(cells[0]!);
  c.pin(cells[N - 1]!);
  return { c, cells };
}

function buildAvbd(N: number, iters: number) {
  const cells: WVec[] = [];
  for (let i = 0; i < N; i++) cells.push(vec(i, 0));
  const s = new AvbdSolver({ iterations: iters });
  for (let i = 1; i < N; i++) avbdDistance(s, cells[i - 1]!, cells[i]!, 1);
  s.pin(cells[0]!);
  s.pin(cells[N - 1]!);
  return { s, cells };
}

describe("3-way bench: writeBack vs lazy getter vs preEffect", () => {
  it("chain N=256 iter=5", () => {
    const N = 256;
    const drags = 50;

    // _proto-relate3 (writeBack)
    const r3 = buildR3(N, 5);
    r3.cells[N - 1]!.value = { x: N - 5, y: 1 };
    let dy = 1;
    const t3start = performance.now();
    for (let i = 0; i < drags; i++) {
      dy += 0.01;
      r3.cells[N - 1]!.value = { x: N - 5, y: dy };
    }
    const t3 = (performance.now() - t3start) / drags;

    // _proto-relate2 (lazy via getter)
    const r2 = buildR2(N, 5);
    r2.cells[N - 1]!.value = { x: N - 5, y: 1 };
    void r2.cells[N - 1]!.value;
    let dy2 = 1;
    const t2start = performance.now();
    for (let i = 0; i < drags; i++) {
      dy2 += 0.01;
      r2.cells[N - 1]!.value = { x: N - 5, y: dy2 };
      void r2.cells[N - 1]!.value; // force read to trigger lazy solve
    }
    const t2 = (performance.now() - t2start) / drags;

    // _proto-avbd (preEffect)
    const av = buildAvbd(N, 5);
    av.cells[N - 1]!.value = { x: N - 5, y: 1 };
    let dyA = 1;
    const tAstart = performance.now();
    for (let i = 0; i < drags; i++) {
      dyA += 0.01;
      av.cells[N - 1]!.value = { x: N - 5, y: dyA };
    }
    const tA = (performance.now() - tAstart) / drags;

    console.log(
      `  chain N=256 iter=5:\n    relate3 (writeBack): ${t3.toFixed(3)}ms\n    relate2 (lazy):      ${t2.toFixed(3)}ms\n    avbd    (preEffect): ${tA.toFixed(3)}ms`,
    );
    expect(Number.isFinite(t3)).toBe(true);
    expect(Number.isFinite(t2)).toBe(true);
    expect(Number.isFinite(tA)).toBe(true);
  });

  it("lattice 32x32 iter=5", () => {
    const W = 32,
      H = 32;
    const drags = 20;

    function buildR3Lattice() {
      const cells: WVec[][] = [];
      for (let j = 0; j < H; j++) {
        const row: WVec[] = [];
        for (let i = 0; i < W; i++) row.push(vec(i, j));
        cells.push(row);
      }
      const c = new Cluster({ iterations: 5 });
      for (let j = 0; j < H; j++)
        for (let i = 1; i < W; i++) relate3Distance(c, cells[j]![i - 1]!, cells[j]![i]!, 1);
      for (let i = 0; i < W; i++)
        for (let j = 1; j < H; j++) relate3Distance(c, cells[j - 1]![i]!, cells[j]![i]!, 1);
      c.pin(cells[0]![0]!);
      c.pin(cells[0]![W - 1]!);
      return { c, cells };
    }

    function buildAvbdLattice() {
      const cells: WVec[][] = [];
      for (let j = 0; j < H; j++) {
        const row: WVec[] = [];
        for (let i = 0; i < W; i++) row.push(vec(i, j));
        cells.push(row);
      }
      const s = new AvbdSolver({ iterations: 5 });
      for (let j = 0; j < H; j++)
        for (let i = 1; i < W; i++) avbdDistance(s, cells[j]![i - 1]!, cells[j]![i]!, 1);
      for (let i = 0; i < W; i++)
        for (let j = 1; j < H; j++) avbdDistance(s, cells[j - 1]![i]!, cells[j]![i]!, 1);
      s.pin(cells[0]![0]!);
      s.pin(cells[0]![W - 1]!);
      return { s, cells };
    }

    const r3 = buildR3Lattice();
    r3.cells[H - 1]![W - 1]!.value = { x: W - 0.5, y: H - 0.5 };
    let dy = 0.5;
    const t3start = performance.now();
    for (let i = 0; i < drags; i++) {
      dy += 0.05;
      r3.cells[H - 1]![W - 1]!.value = { x: W - 0.5, y: H - 1 + dy };
    }
    const t3 = (performance.now() - t3start) / drags;

    const av = buildAvbdLattice();
    av.cells[H - 1]![W - 1]!.value = { x: W - 0.5, y: H - 0.5 };
    let dyA = 0.5;
    const tAstart = performance.now();
    for (let i = 0; i < drags; i++) {
      dyA += 0.05;
      av.cells[H - 1]![W - 1]!.value = { x: W - 0.5, y: H - 1 + dyA };
    }
    const tA = (performance.now() - tAstart) / drags;

    console.log(
      `  lattice 32×32 iter=5:\n    relate3 (writeBack): ${t3.toFixed(3)}ms\n    avbd    (preEffect): ${tA.toFixed(3)}ms`,
    );
    expect(Number.isFinite(t3)).toBe(true);
    expect(Number.isFinite(tA)).toBe(true);
  });
});
