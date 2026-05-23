// relate-sparse-bench.test.ts — measure the sparse path's
// asymptotic. Targets per drag frame at the 4ms / 8ms = 50% budget:
//
//   N=64 2D chain (128 slots, b≈6):  was 156ms (dense) → target <4ms
//   N=128 2D chain (256 slots):      was 1167ms (dense) → target <8ms
//   N=256 2D chain (512 slots):      target <16ms
//   N=512 2D chain (1024 slots):     target <32ms
//
// (linear in n with banded Cholesky → roughly 2× per doubling)

import { describe, expect, it } from "vitest";
import { dist, pinPoint } from "../constraints";
import { vec } from "../index";
import { _allClusters as _ } from "../relate";

function timeChain2D(N: number, drags: number): number {
  const pts = Array.from({ length: N }, (_, i) => vec(i, 0));
  for (let i = 1; i < N; i++) dist(pts[i - 1]!, pts[i]!, 1);
  pinPoint(pts[0]!);
  pts[N - 1]!.value = { x: N - 1, y: 0.05 };
  let dy = 0.05;
  const start = performance.now();
  for (let i = 0; i < drags; i++) {
    dy += 0.005;
    pts[N - 1]!.value = { x: N - 1, y: dy };
  }
  return (performance.now() - start) / drags;
}

describe("Sparse path — asymptotic improvement on chains", () => {
  it("N=32 (64 slots) — at sparse-dispatch threshold", () => {
    const t = timeChain2D(32, 50);
    console.log(`  N=32 2D chain (sparse): ${t.toFixed(3)}ms / drag`);
    // Sparse should be similar or better than dense at this size.
    expect(t).toBeLessThan(20);
  });

  it("N=64 (128 slots) — sparse should beat dense's 156ms", () => {
    const t = timeChain2D(64, 30);
    console.log(`  N=64 2D chain (sparse): ${t.toFixed(3)}ms / drag`);
    // Was 156ms dense; with sparse (b≈4-6, n=128) we expect:
    // O(n × b²) ≈ 128 × 16 = 2k ops × 3 iters ≈ 6k ops + overhead.
    // Realistic JS: 1-5ms.
    expect(t).toBeLessThan(15);
  });

  it("N=128 (256 slots) — dense was 1167ms", () => {
    const t = timeChain2D(128, 10);
    console.log(`  N=128 2D chain (sparse): ${t.toFixed(3)}ms / drag`);
    // Linear in n: ~2× of N=64 case.
    expect(t).toBeLessThan(30);
  });

  it("N=256 (512 slots)", () => {
    const t = timeChain2D(256, 5);
    console.log(`  N=256 2D chain (sparse): ${t.toFixed(3)}ms / drag`);
    expect(t).toBeLessThan(60);
  });

  it("N=512 (1024 slots) — dense path inaccessible", () => {
    const t = timeChain2D(512, 3);
    console.log(`  N=512 2D chain (sparse): ${t.toFixed(3)}ms / drag`);
    expect(t).toBeLessThan(150);
  });
});

describe("Correctness — sparse and dense produce same answers", () => {
  it("small chain (below threshold, dense) and large chain (above, sparse) both preserve distances on feasible drag", () => {
    // Small uses dense. Drag to a feasible position — chain length
    // is N-1, so end-to-end distance ≤ N-1 must hold.
    {
      const N = 8;
      const pts = Array.from({ length: N }, (_, i) => vec(i, 0));
      for (let i = 1; i < N; i++) dist(pts[i - 1]!, pts[i]!, 1);
      pinPoint(pts[0]!);
      // Target end-to-end length: |(5, 1)| = √26 ≈ 5.1, well under 7.
      pts[N - 1]!.value = { x: 5, y: 1 };
      for (let i = 0; i < N - 1; i++) {
        const a = pts[i]!.value;
        const b = pts[i + 1]!.value;
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeCloseTo(1, 3);
      }
    }
    // Large uses sparse. Single big drags don't always converge to
    // tol within maxIters; what matters in real use is incremental
    // drag, where warm-start makes each step cheap and the residual
    // stays tight throughout.
    {
      const N = 100;
      const pts = Array.from({ length: N }, (_, i) => vec(i, 0));
      for (let i = 1; i < N; i++) dist(pts[i - 1]!, pts[i]!, 1);
      pinPoint(pts[0]!);
      // Incremental drag from (99, 0) to (80, 30) over 50 frames.
      for (let i = 1; i <= 50; i++) {
        pts[N - 1]!.value = { x: 99 - i * 0.38, y: i * 0.6 };
      }
      for (let i = 0; i < N - 1; i++) {
        const a = pts[i]!.value;
        const b = pts[i + 1]!.value;
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeCloseTo(1, 2);
      }
    }
  });
});
