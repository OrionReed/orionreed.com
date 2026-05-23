// relate-targets.test.ts — concrete correctness + performance targets
// for the relation prototype. Each target is an executable assertion;
// failures here mean we've regressed against the bar we set.
//
// The targets are calibrated against published systems where
// possible:
//
//   - Cassowary: 0.99 success rate, 1.4ms per resolve on 900 cells (C++)
//   - Kiwi: 595K solves/sec on linear constraints (TypeScript port)
//   - PickNikRobotics IK: 0.99 success, 200µs avg (KDL on 7-DOF)
//
// For our system (JS, dense LU, nonlinear constraints), realistic
// targets are roughly 5-10x slower per cell-equivalent than Cassowary
// C++ but better than Penrose (which targets offline diagram
// generation, not 60fps interaction).

import { describe, expect, it } from "vitest";
import { dist, eq, midpoint, pinPoint } from "../constraints";
import { batch, num, vec } from "../index";
import { clusterHealth, hardPin, relate } from "../relate";

// ─── Performance targets ─────────────────────────────────────────────
//
// Per drag frame, after warm-up:
//
// | Cells | Constraints | Sparsity     | Target time |
// |  10   |   10        | dense        |  < 0.5 ms   |
// |  50   |   50        | dense        |  < 5 ms     |
// | 100   |  100        | dense        |  < 30 ms    |  (current dense LU)
// | 100   |  100        | sparse(<=4)  |  < 5 ms     |  (when sparse path lands)
// | 1000  | 1000        | sparse(<=4)  |  < 50 ms    |  (when sparse path lands)
//
// Convergence: ≤ 3 Newton iterations per frame in steady-state drag
// for clusters that share their previous-frame solution.
//
// Memory: O(cells + constraints + slots) total per cluster; no
// allocations in the per-frame hot path.

describe("Performance targets — current dense path", () => {
  it("10-cell, 10-constraint cluster: drag-frame < 0.5ms", () => {
    const cells = Array.from({ length: 10 }, () => num(0));
    for (let i = 1; i < 10; i++) {
      relate({
        cells: [cells[i]!, cells[i - 1]!],
        residual: ([a, b], out) => {
          out[0] = (a as number) - (b as number);
        },
        m: 1,
      });
    }
    // Warm.
    cells[0]!.value = 1;
    const start = performance.now();
    for (let i = 0; i < 100; i++) cells[0]!.value = i * 0.01;
    const elapsed = (performance.now() - start) / 100;
    expect(elapsed).toBeLessThan(0.5);
  });

  it("50-cell chain: drag-frame < 5ms", () => {
    const cells = Array.from({ length: 50 }, () => num(0));
    for (let i = 1; i < 50; i++) {
      relate({
        cells: [cells[i]!, cells[i - 1]!],
        residual: ([a, b], out) => {
          out[0] = (a as number) - (b as number);
        },
        m: 1,
      });
    }
    cells[0]!.value = 1;
    const start = performance.now();
    for (let i = 0; i < 50; i++) cells[0]!.value = i * 0.02;
    const elapsed = (performance.now() - start) / 50;
    expect(elapsed).toBeLessThan(5);
  });

  it("100-cell chain (single chain): drag-frame < 30ms", () => {
    const cells = Array.from({ length: 100 }, () => num(0));
    for (let i = 1; i < 100; i++) {
      relate({
        cells: [cells[i]!, cells[i - 1]!],
        residual: ([a, b], out) => {
          out[0] = (a as number) - (b as number);
        },
        m: 1,
      });
    }
    cells[0]!.value = 1;
    const start = performance.now();
    for (let i = 0; i < 30; i++) cells[0]!.value = i * 0.03;
    const elapsed = (performance.now() - start) / 30;
    // Dense LU path is O(n³); 100^3 = 1M ops × few iters. JS at
    // ~100M ops/sec → ~10-30ms. Pass on the high end of this range.
    expect(elapsed).toBeLessThan(30);
  });
});

describe("Convergence targets — steady-state drag", () => {
  it("4-bar linkage drag: ≤3 iters per frame after warm-up", () => {
    const O0 = vec(0, 0);
    const O3 = vec(4, 0);
    pinPoint(O0);
    pinPoint(O3);
    const A = vec(1, 0);
    const B = vec(4, 2);
    const a = 1;
    const c = 2;
    const b = Math.hypot(1 - 4, 0 - 2);
    dist(O0, A, a);
    dist(A, B, b);
    dist(O3, B, c);
    // Swing; first 2 frames are warm-up.
    let max = 0;
    for (let i = 0; i < 30; i++) {
      const theta = -0.6 + i * 0.02;
      batch(() => {
        A.value = { x: a * Math.cos(theta), y: a * Math.sin(theta) };
      });
      if (i > 1) {
        const h = clusterHealth(A)!.peek();
        if (h.iters > max) max = h.iters;
      }
    }
    expect(max).toBeLessThanOrEqual(3);
  });

  it("equilateral triangle small-angle drag: ≤2 iters per frame", () => {
    const A = vec(0, 0);
    const B = vec(1, 0);
    const C = vec(0.5, Math.sqrt(3) / 2);
    dist(A, B, 1);
    dist(B, C, 1);
    dist(C, A, 1);
    pinPoint(B);

    let max = 0;
    for (let i = 1; i < 50; i++) {
      const theta = Math.PI - i * 0.005;
      batch(() => {
        A.value = { x: 1 + Math.cos(theta), y: Math.sin(theta) };
      });
      const h = clusterHealth(A)!.peek();
      if (h.iters > max) max = h.iters;
    }
    expect(max).toBeLessThanOrEqual(2);
  });
});

describe("Correctness targets — IK success rate", () => {
  it("3-link 2D IK on 100 random reachable targets: ≥95% success rate", () => {
    const L = [1, 1, 0.5];
    const t1 = num(0.1);
    const t2 = num(0.1);
    const t3 = num(0.1);
    const tipX = num(L[0]! + L[1]! + L[2]!);
    const tipY = num(0);
    relate({
      cells: [t1, t2, t3, tipX, tipY],
      residual: ([a1, a2, a3, x, y], out) => {
        const A1 = a1 as number;
        const A2 = a2 as number;
        const A3 = a3 as number;
        out[0] =
          (x as number) -
          (L[0]! * Math.cos(A1) + L[1]! * Math.cos(A1 + A2) + L[2]! * Math.cos(A1 + A2 + A3));
        out[1] =
          (y as number) -
          (L[0]! * Math.sin(A1) + L[1]! * Math.sin(A1 + A2) + L[2]! * Math.sin(A1 + A2 + A3));
      },
      m: 2,
    });
    // Deterministic LCG.
    let seed = 1;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) | 0;
      return ((seed >>> 0) % 1000000) / 1000000;
    };
    let successes = 0;
    const N = 100;
    for (let i = 0; i < N; i++) {
      const r = 0.5 + rand() * 1.9;
      const phi = rand() * 2 * Math.PI;
      batch(() => {
        tipX.value = r * Math.cos(phi);
        tipY.value = r * Math.sin(phi);
      });
      const fwdX =
        L[0]! * Math.cos(t1.value) +
        L[1]! * Math.cos(t1.value + t2.value) +
        L[2]! * Math.cos(t1.value + t2.value + t3.value);
      const fwdY =
        L[0]! * Math.sin(t1.value) +
        L[1]! * Math.sin(t1.value + t2.value) +
        L[2]! * Math.sin(t1.value + t2.value + t3.value);
      const err = Math.hypot(fwdX - tipX.value, fwdY - tipY.value);
      if (err < 1e-3) successes++;
    }
    expect(successes / N).toBeGreaterThanOrEqual(0.95);
  });
});

describe("Memory + integration targets", () => {
  it("repeated-drag does not leak — cluster scratch buffers reused", () => {
    // The relation runtime allocates xScratch, rScratch, pinMask,
    // valsScratch ONCE per cluster and reuses them. After warm-up,
    // a long sequence of writes should not trigger any new
    // allocations (verifiable indirectly: heap-size delta should be
    // O(1), not O(N writes)).
    //
    // We can't directly measure GC in vitest, but we can sanity-
    // check that 1000 writes complete in reasonable time (i.e. no
    // pathological GC behavior).
    const a = num(0);
    const b = num(0);
    const c = num(0);
    relate({
      cells: [a, b, c],
      residual: ([x, y, z], out) => {
        out[0] = (x as number) - (y as number);
        out[1] = (y as number) - (z as number);
      },
      m: 2,
    });
    const start = performance.now();
    for (let i = 0; i < 1000; i++) a.value = i;
    const elapsed = performance.now() - start;
    // 1000 writes over a 3-cell cluster: should be << 100ms.
    expect(elapsed).toBeLessThan(100);
  });

  it("baseline tests preserved — refactor non-breaking (sanity)", () => {
    // Spot-check that the standard pythagoras pattern works after
    // the polymorphic-cell refactor.
    const a = num(3);
    const b = num(4);
    const c = num(5);
    relate({
      cells: [a, b, c],
      residual: ([x, y, z], out) => {
        out[0] = (x as number) ** 2 + (y as number) ** 2 - (z as number) ** 2;
      },
      m: 1,
    });
    a.value = 6;
    expect(a.value).toBe(6);
    expect(a.value ** 2 + b.value ** 2).toBeCloseTo(c.value ** 2, 6);
  });
});

void hardPin;
void midpoint;
void eq;
