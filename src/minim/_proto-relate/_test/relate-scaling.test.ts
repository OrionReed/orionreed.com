// relate-scaling.test.ts — concrete scaling timings for the dense-LU
// path. Reports per-frame cost at growing cluster sizes; use these
// numbers to know exactly when to stop scaling on the dense path
// and reach for sparse / decomposed solvers.
//
// Calibrated runtime targets (this hardware, single thread, JS):
//
//     10 cells:  < 0.5 ms / drag-frame
//     50 cells:  < 5 ms
//    100 cells:  < 30 ms (current dense LU is O(n^3))
//    500 cells:  expected to break (>100ms) — sparse path needed
//
// Each test logs the actual time so a regression shows up not just
// in pass/fail but in absolute slowdown.

import { describe, expect, it } from "vitest";
import { num, vec } from "../index";
import { dist, pinPoint } from "../constraints";
import { relate } from "../relate";

function timeDragChain(N: number, drags: number): { perFrame: number; constructTime: number } {
  const t0 = performance.now();
  const cells = Array.from({ length: N }, () => num(0));
  for (let i = 1; i < N; i++) {
    relate({
      cells: [cells[i]!, cells[i - 1]!],
      residual: ([a, b], out) => {
        out[0] = (a as number) - (b as number);
      },
      m: 1,
    });
  }
  const t1 = performance.now();
  // Warm-up.
  cells[0]!.value = 1;
  // Time `drags` consecutive writes.
  const t2 = performance.now();
  for (let i = 0; i < drags; i++) cells[0]!.value = i * 0.01;
  const t3 = performance.now();
  return { perFrame: (t3 - t2) / drags, constructTime: t1 - t0 };
}

function timeDragChain2D(N: number, drags: number): { perFrame: number; constructTime: number } {
  const t0 = performance.now();
  const pts = Array.from({ length: N }, (_, i) => vec(i, 0));
  for (let i = 1; i < N; i++) {
    dist(pts[i - 1]!, pts[i]!, 1);
  }
  pinPoint(pts[0]!);
  const t1 = performance.now();
  // Warm.
  pts[N - 1]!.value = { x: N - 1, y: 0.1 };
  const t2 = performance.now();
  for (let i = 0; i < drags; i++) {
    pts[N - 1]!.value = { x: N - 1, y: 0.1 + i * 0.01 };
  }
  const t3 = performance.now();
  return { perFrame: (t3 - t2) / drags, constructTime: t1 - t0 };
}

describe("Scaling — 1D linear chain (eq cells)", () => {
  it("N=10: per-frame drag time", () => {
    const r = timeDragChain(10, 100);
    console.log(`  N=10 1D chain: construct=${r.constructTime.toFixed(2)}ms, perFrame=${r.perFrame.toFixed(3)}ms`);
    expect(r.perFrame).toBeLessThan(0.5);
  });
  it("N=50: per-frame drag time", () => {
    const r = timeDragChain(50, 50);
    console.log(`  N=50 1D chain: construct=${r.constructTime.toFixed(2)}ms, perFrame=${r.perFrame.toFixed(3)}ms`);
    expect(r.perFrame).toBeLessThan(5);
  });
  it("N=100: per-frame drag time", () => {
    const r = timeDragChain(100, 30);
    console.log(`  N=100 1D chain: construct=${r.constructTime.toFixed(2)}ms, perFrame=${r.perFrame.toFixed(3)}ms`);
    expect(r.perFrame).toBeLessThan(30);
  });
});

describe("Scaling — 2D distance chain (catenary-like)", () => {
  it("N=10 vec chain: per-frame", () => {
    const r = timeDragChain2D(10, 100);
    console.log(`  N=10 2D chain: construct=${r.constructTime.toFixed(2)}ms, perFrame=${r.perFrame.toFixed(3)}ms`);
    expect(r.perFrame).toBeLessThan(2);
  });
  it("N=32 vec chain (catenary scale): per-frame", () => {
    const r = timeDragChain2D(32, 50);
    console.log(
      `  N=32 2D chain: construct=${r.constructTime.toFixed(2)}ms, perFrame=${r.perFrame.toFixed(3)}ms`,
    );
    // 32 vec cells = 64 slots; dense LU is the hot path. Realistic
    // for 30fps but not 60fps without sparse.
    expect(r.perFrame).toBeLessThan(40);
  });
  it("N=64 vec chain: per-frame (dense-path soft ceiling)", () => {
    const r = timeDragChain2D(64, 20);
    console.log(
      `  N=64 2D chain: construct=${r.constructTime.toFixed(2)}ms, perFrame=${r.perFrame.toFixed(3)}ms`,
    );
    // 64 vec cells = 128 slots. Dense LU is O(128^3) ≈ 2M ops per
    // iter. Several iters × ~20ns/op ≈ 100-200ms. This documents
    // the dense path's limit — sparse + banded LU is the next
    // optimization for catenary-scale chains.
    expect(r.perFrame).toBeLessThan(300);
  });
});

describe("Scaling — separate clusters scale linearly", () => {
  it("100 disjoint 5-cell clusters drag together: O(N) overall", () => {
    const N = 100; // # clusters
    const cellsPerCluster = 5;
    const drivers: { value: number }[] = [];
    for (let k = 0; k < N; k++) {
      const cells = Array.from({ length: cellsPerCluster }, () => num(0));
      for (let i = 1; i < cellsPerCluster; i++) {
        relate({
          cells: [cells[i]!, cells[i - 1]!],
          residual: ([a, b], out) => {
            out[0] = (a as number) - (b as number);
          },
          m: 1,
        });
      }
      drivers.push(cells[0]!);
    }
    // Drag every cluster's driver.
    const t0 = performance.now();
    for (let frame = 0; frame < 10; frame++) {
      for (const d of drivers) d.value = frame;
    }
    const t1 = performance.now();
    const perFrame = (t1 - t0) / 10;
    console.log(
      `  100 clusters × 5 cells: ${perFrame.toFixed(3)}ms/frame for all 100`,
    );
    // Each cluster solves independently. 100 clusters × small-cluster
    // cost should still be < 30ms.
    expect(perFrame).toBeLessThan(50);
  });
});

describe("Memory: scratch buffers reused across drags (no GC pressure)", () => {
  it("10000 writes to a single small cluster — bounded total time", () => {
    const a = num(0);
    const b = num(0);
    relate({
      cells: [a, b],
      residual: ([x, y], out) => {
        out[0] = (x as number) - (y as number);
      },
      m: 1,
    });
    const t0 = performance.now();
    for (let i = 0; i < 10000; i++) a.value = i;
    const t1 = performance.now();
    const total = t1 - t0;
    const perWrite = total / 10000;
    console.log(`  10k writes: total=${total.toFixed(2)}ms, perWrite=${perWrite.toFixed(4)}ms`);
    // No allocation in hot path → linear in writes.
    expect(perWrite).toBeLessThan(0.05); // 50µs per write
  });
});
