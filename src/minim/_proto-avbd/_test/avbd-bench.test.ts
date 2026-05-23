// avbd-bench.test.ts — focused benchmarks on the SOA hot path.
//
// These print timing numbers but assert only finiteness; pass/fail
// shouldn't depend on machine speed.

import { describe, expect, it } from "vitest";
import { vec, type Vec, type Writable } from "../../signals";
import { distance, pin, Solver } from "../index";

type WVec = Writable<Vec>;

function chain(N: number, iters: number) {
  const cells: WVec[] = [];
  for (let i = 0; i < N; i++) cells.push(vec(i, 0));
  const s = new Solver({ iterations: iters });
  for (let i = 1; i < N; i++) distance(s, cells[i - 1]!, cells[i]!, 1);
  pin(cells[0]!);
  pin(cells[N - 1]!);
  return { s, cells };
}

function lattice(W: number, H: number, iters: number) {
  const cells: WVec[][] = [];
  for (let j = 0; j < H; j++) {
    const row: WVec[] = [];
    for (let i = 0; i < W; i++) row.push(vec(i, j));
    cells.push(row);
  }
  const s = new Solver({ iterations: iters });
  for (let j = 0; j < H; j++)
    for (let i = 1; i < W; i++) distance(s, cells[j]![i - 1]!, cells[j]![i]!, 1);
  for (let i = 0; i < W; i++)
    for (let j = 1; j < H; j++) distance(s, cells[j - 1]![i]!, cells[j]![i]!, 1);
  pin(cells[0]![0]!);
  pin(cells[0]![W - 1]!);
  return { s, cells };
}

describe("AVBD bench — SOA hot path", () => {
  it("chain N=256 iter=5", () => {
    const { s, cells } = chain(256, 5);
    cells[255]!.value = { x: 250, y: 1 };
    for (let i = 0; i < 5; i++) cells[255]!.value = { x: 250, y: 1 + 0.01 * i };
    const drags = 50;
    let dy = 1;
    const t0 = performance.now();
    for (let i = 0; i < drags; i++) {
      dy += 0.01;
      cells[255]!.value = { x: 250, y: dy };
    }
    const t = (performance.now() - t0) / drags;
    console.log(`  chain N=256 iter=5: ${t.toFixed(3)}ms/step`);
    void s;
    expect(Number.isFinite(t)).toBe(true);
  });

  it("lattice 32x32 iter=5", () => {
    const { s, cells } = lattice(32, 32, 5);
    pin(cells[31]![31]!);
    const drags = 20;
    let dy = 0.5;
    const t0 = performance.now();
    for (let i = 0; i < drags; i++) {
      dy += 0.05;
      cells[31]![31]!.value = { x: 31.5, y: 31 + dy };
    }
    const t = (performance.now() - t0) / drags;
    console.log(`  lattice 32×32 iter=5: ${t.toFixed(3)}ms/step`);
    void s;
    expect(Number.isFinite(t)).toBe(true);
  });

  it("lattice 100x100 iter=5", () => {
    const { s, cells } = lattice(100, 100, 5);
    pin(cells[99]![99]!);
    const drags = 3;
    let dy = 0.5;
    const t0 = performance.now();
    for (let i = 0; i < drags; i++) {
      dy += 0.05;
      cells[99]![99]!.value = { x: 99.5, y: 99 + dy };
    }
    const t = (performance.now() - t0) / drags;
    const perVU = (t * 1000) / (100 * 100 * 5);
    console.log(`  lattice 100×100 iter=5: ${t.toFixed(2)}ms/step, ${perVU.toFixed(2)}µs/vertex-update`);
    void s;
    expect(Number.isFinite(t)).toBe(true);
  });

  it("lattice 200x200 iter=5", () => {
    const { s, cells } = lattice(200, 200, 5);
    pin(cells[199]![199]!);
    const drags = 2;
    let dy = 0.5;
    const t0 = performance.now();
    for (let i = 0; i < drags; i++) {
      dy += 0.05;
      cells[199]![199]!.value = { x: 199.5, y: 199 + dy };
    }
    const t = (performance.now() - t0) / drags;
    const perVU = (t * 1000) / (200 * 200 * 5);
    console.log(`  lattice 200×200 iter=5: ${t.toFixed(2)}ms/step, ${perVU.toFixed(2)}µs/vertex-update`);
    void s;
    expect(Number.isFinite(t)).toBe(true);
  });
});
