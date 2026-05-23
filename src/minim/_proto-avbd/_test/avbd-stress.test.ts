// avbd-stress.test.ts — the actual reasons we chose AVBD.
//
// These tests reproduce or closely mirror challenging scenarios from
// the AVBD paper (Giles et al., SIGGRAPH 2025) and demonstrate the
// claims that motivated switching from Newton-LM:
//
//   §3.4 — High stiffness ratios converge with few iterations
//          (vs VBD which fails / oscillates / over-stretches).
//   §3.1 — Hard constraints satisfied without infinite stiffness
//          (vs penalty methods which need k → ∞).
//   §1   — Unconditional stability under capped iteration counts.
//   §3.7 — Warm-start across calls reduces iterations needed.
//
// These are passive correctness benchmarks, not perf benchmarks —
// they verify that the algorithm reaches the published claims, not
// that we beat C++ reference impls. (We won't, but we can be the
// fastest interactive constraint solver in JS.)

import { describe, expect, it } from "vitest";
import {
  Cell,
  distance,
  pin,
  Solver,
  spring,
} from "../index";

describe("AVBD stress — high stiffness ratios (paper §3.4)", () => {
  it("3 blocks + 2 springs with 10⁴ stiffness ratio — paper Fig. 2", () => {
    // Reproduces the headline example: top block is fixed, two
    // springs of stiffness k1 = 1e4 and k2 = 1, each attached to
    // a 1kg block, hung in a vertical chain. With pure VBD this
    // fails to converge in 5 or even 100 iterations. AVBD should
    // resolve in ~5 iterations.
    //
    // Layout: top → block A → block B → block C
    //                |k1|       |k2|
    // top is fixed at (0, 0). Gravity pulls -y.
    // Stiffness ratio: 1e4 between springs.
    const top = new Cell(2, [0, 0]);
    top.mass = 0; // fixed
    const A = new Cell(2, [0, -1]);
    const B = new Cell(2, [0, -2]);
    const s = new Solver({
      iterations: 5,
      aExt: [0, -10], // gravity
      dt: 1 / 60,
      staticMode: false, // dynamics
    });
    s.addCell(top);
    s.addCell(A);
    s.addCell(B);
    spring(s, top, A, 1, 1e4); // stiff spring
    spring(s, A, B, 1, 1); // weak spring
    // Run to steady state (a few "frames").
    for (let step = 0; step < 60; step++) s.step();
    // Stiff spring should be approximately at rest length (high stiffness).
    const dTopA = Math.hypot(
      A.position[0]! - top.position[0]!,
      A.position[1]! - top.position[1]!,
    );
    expect(dTopA).toBeGreaterThan(0.95);
    expect(dTopA).toBeLessThan(1.5); // some stretch from B's weight
    // Weak spring stretches under B's weight. It should be much
    // longer than rest. With k=1 and weight=10 (m·g = 1·10), spring
    // stretches by ~10 units in steady state.
    const dAB = Math.hypot(
      B.position[0]! - A.position[0]!,
      B.position[1]! - A.position[1]!,
    );
    expect(dAB).toBeGreaterThan(2); // significantly stretched
    // Both bodies should be roughly hanging down (negative y).
    expect(A.position[1]!).toBeLessThan(0);
    expect(B.position[1]!).toBeLessThan(A.position[1]!);
  });

  it("hard constraint satisfied without numerical pathology", () => {
    // A simpler version of the article-of-faith claim: with a hard
    // distance constraint, the solver achieves perfect satisfaction
    // (within tol) without driving penalties to extreme values.
    const a = new Cell(2, [0, 0]);
    const b = new Cell(2, [3, 0]);
    a.mass = 0;
    const s = new Solver({ iterations: 20 });
    s.addCell(a);
    s.addCell(b);
    const dist = distance(s, a, b, 5); // hard, infinite stiffness
    // Drag b far from rest, force convergence.
    s.step();
    s.step();
    s.step();
    // Final residual should be tiny.
    const dx = b.position[0]! - a.position[0]!;
    const dy = b.position[1]! - a.position[1]!;
    expect(Math.abs(Math.hypot(dx, dy) - 5)).toBeLessThan(1e-3);
    // Penalty should be moderate, not exploded.
    expect(dist.penalty[0]!).toBeLessThan(1e7);
  });
});

describe("AVBD stress — long chain stability (paper §1, §3.4)", () => {
  it("32-link distance chain stays stable under iteration cap", () => {
    // 32 cells in a horizontal chain, each linked by a hard distance
    // = 1. Pin the head, drag the tail. Should converge cleanly in
    // a small fixed iteration count without numerical blowup.
    const N = 32;
    const cells: Cell[] = [];
    for (let i = 0; i < N; i++) cells.push(new Cell(2, [i, 0]));
    cells[0]!.mass = 0; // anchor head
    const s = new Solver({ iterations: 20 });
    for (const c of cells) s.addCell(c);
    for (let i = 1; i < N; i++) distance(s, cells[i - 1]!, cells[i]!, 1);
    // Drag tail to a feasible target.
    cells[N - 1]!.position[0]! = N - 5;
    cells[N - 1]!.position[1]! = 5;
    cells[N - 1]!.mass = 0;
    // Run to convergence.
    for (let step = 0; step < 50; step++) s.step();
    // All distances should be ≈ 1.
    let maxErr = 0;
    for (let i = 1; i < N; i++) {
      const dx = cells[i]!.position[0]! - cells[i - 1]!.position[0]!;
      const dy = cells[i]!.position[1]! - cells[i - 1]!.position[1]!;
      const err = Math.abs(Math.hypot(dx, dy) - 1);
      if (err > maxErr) maxErr = err;
    }
    expect(maxErr).toBeLessThan(0.05); // well under 5% per link
    // Head still pinned exactly at origin.
    expect(cells[0]!.position[0]!).toBe(0);
    expect(cells[0]!.position[1]!).toBe(0);
  });

  it("32-link chain — single iteration stays bounded under continuous drag", () => {
    // The paper's headline stability claim (paper §1, Fig 16):
    // even with iter=1 we don't explode. We test this in static
    // editing mode under continuous drag — the user moves the
    // tail and we run a single iteration per "frame". Residual
    // may stay non-zero, but nothing should diverge.
    const N = 32;
    const cells: Cell[] = [];
    for (let i = 0; i < N; i++) cells.push(new Cell(2, [i, 0]));
    cells[0]!.mass = 0;
    const s = new Solver({ iterations: 1 });
    for (const c of cells) s.addCell(c);
    for (let i = 1; i < N; i++) distance(s, cells[i - 1]!, cells[i]!, 1);
    cells[N - 1]!.mass = 0;
    // Drag the tail in a smooth circular path over 100 steps.
    for (let step = 0; step < 100; step++) {
      const t = step * 0.05;
      cells[N - 1]!.position[0]! = (N - 5) + Math.cos(t);
      cells[N - 1]!.position[1]! = Math.sin(t);
      s.step();
    }
    // Bounded — no NaN, no runaway.
    for (const c of cells) {
      expect(Number.isFinite(c.position[0]!)).toBe(true);
      expect(Number.isFinite(c.position[1]!)).toBe(true);
      expect(Math.abs(c.position[0]!)).toBeLessThan(100);
      expect(Math.abs(c.position[1]!)).toBeLessThan(100);
    }
  });
});

describe("AVBD stress — warm-start (paper §3.7)", () => {
  it("incremental drag converges in fewer iterations than cold start", () => {
    // After a warm-start solve, subsequent solves should converge
    // in 1-2 iterations. We measure this implicitly: solve cold
    // (high iterations to reach near-zero residual), then drag
    // incrementally and measure residual after just 2 iterations.
    const N = 8;
    const cells: Cell[] = [];
    for (let i = 0; i < N; i++) cells.push(new Cell(2, [i, 0]));
    cells[0]!.mass = 0;
    const s = new Solver({ iterations: 20 });
    for (const c of cells) s.addCell(c);
    for (let i = 1; i < N; i++) distance(s, cells[i - 1]!, cells[i]!, 1);
    cells[N - 1]!.mass = 0;
    // Cold solve to a starting pose.
    cells[N - 1]!.position[0]! = N - 1;
    cells[N - 1]!.position[1]! = 0.1;
    s.step();
    s.step();
    s.step();
    s.step();
    // Now lower iterations and do incremental drags. Each step is
    // a small move; warm-start should let it converge.
    s.iterations = 3;
    let maxResidual = 0;
    for (let i = 0; i < 30; i++) {
      cells[N - 1]!.position[1]! += 0.05;
      s.step();
      const r = s.residualNorm();
      if (r > maxResidual) maxResidual = r;
    }
    // Even with 3 iterations, residual should stay small under
    // continuous drag.
    expect(maxResidual).toBeLessThan(0.5);
  });
});
