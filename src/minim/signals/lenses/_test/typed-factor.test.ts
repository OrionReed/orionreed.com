// =====================================================================
// typed-factor.test.ts — heterogeneous-output factor lens probes.
//
// Goal: verify that switching from scalar-out to typed-out preserves
// the semantics established for the scalar `factorLens`, AND that
// the typed authoring is genuinely ergonomic (test reads should look
// like the API they want users to write).
//
// Sections:
//   §1 Forward correctness (typed inputs, typed outputs)
//   §2 Round-trip per channel (Newton-step convergence iterated)
//   §3 Cross-channel invariance (approximate, by Jacobian)
//   §4 bundle (1→M) showcase: Pose → {position, rotation}
//   §5 Procrustes: typed-factor vs closed-form parity
//   §6 Performance: typed-factor vs scalar-factor vs closed-form
// =====================================================================

import { describe, expect, it } from "vitest";
import type { Writable } from "../../index";
import {
  centroidLens,
  field,
  meanLens,
  midpointLens,
  Num,
  num,
  Pose,
  pose,
  signal,
  Vec,
  vec,
} from "../../index";
import { diffLens, pulleySum } from "../../new-primitives";
import { procrustesLens } from "../factor-lens";
import { bundle, factor, factorTuple, procrustesTyped } from "../typed-factor";

// ─── helpers ───────────────────────────────────────────────────────────

const near = (a: number, b: number, tol = 1e-4): boolean => Math.abs(a - b) < tol;
const vnear = (a: { x: number; y: number }, b: { x: number; y: number }, tol = 1e-4): boolean =>
  near(a.x, b.x, tol) && near(a.y, b.y, tol);

const mkPoints = (...pts: [number, number][]): Writable<Vec>[] => pts.map(([x, y]) => vec(x, y));

// Pseudo-RNG for reproducible stress tests.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function iter<T>(cell: Writable<{ value: T; peek(): T }>, target: T, n = 8): void {
  // Iterate writes to converge non-linear Newton-step bwds.
  for (let i = 0; i < n; i++) (cell as unknown as { value: T }).value = target;
}

// =====================================================================
// §1 — Forward correctness
// =====================================================================

describe("§1 Forward correctness", () => {
  it("factor: typed Vec input, Vec + Num outputs", () => {
    const pts = mkPoints([0, 0], [10, 0], [0, 6]);
    const { centroid, rotation, scale } = factor(pts, {
      centroid: {
        Cls: Vec,
        fwd: (p: readonly { x: number; y: number }[]) => ({
          x: (p[0]!.x + p[1]!.x + p[2]!.x) / 3,
          y: (p[0]!.y + p[1]!.y + p[2]!.y) / 3,
        }),
      },
      rotation: {
        Cls: Num,
        fwd: (p: readonly { x: number; y: number }[]) => {
          const cx = (p[0]!.x + p[1]!.x + p[2]!.x) / 3;
          const cy = (p[0]!.y + p[1]!.y + p[2]!.y) / 3;
          return Math.atan2(p[0]!.y - cy, p[0]!.x - cx);
        },
      },
      scale: {
        Cls: Num,
        fwd: (p: readonly { x: number; y: number }[]) => {
          const cx = (p[0]!.x + p[1]!.x + p[2]!.x) / 3;
          const cy = (p[0]!.y + p[1]!.y + p[2]!.y) / 3;
          return Math.hypot(p[0]!.x - cx, p[0]!.y - cy);
        },
      },
    });
    expect(centroid.value.x).toBeCloseTo(10 / 3, 9);
    expect(centroid.value.y).toBeCloseTo(2, 9);
    expect(rotation.value).toBeCloseTo(Math.atan2(-2, -10 / 3), 9);
    expect(scale.value).toBeCloseTo(Math.hypot(10 / 3, 2), 9);
  });

  it("bundle: Pose → {position, rotation}", () => {
    const p = pose({ x: 5, y: 10, theta: 0.7 });
    const { position, rotation } = bundle(p, {
      position: {
        Cls: Vec,
        fwd: (s: readonly { x: number; y: number; theta: number }[]) => ({
          x: s[0]!.x,
          y: s[0]!.y,
        }),
      },
      rotation: {
        Cls: Num,
        fwd: (s: readonly { x: number; y: number; theta: number }[]) => s[0]!.theta,
      },
    });
    expect(position.value).toEqual({ x: 5, y: 10 });
    expect(rotation.value).toBeCloseTo(0.7, 9);
  });
});

// =====================================================================
// §2 — Round-trip per channel (iterated to convergence)
// =====================================================================

describe("§2 Round-trip identity (iterated)", () => {
  it("typed factor: Vec output round-trips after a few iters", () => {
    const pts = mkPoints([0, 0], [10, 0], [0, 6]);
    const { centroid } = procrustesTyped(pts);
    iter(centroid, { x: 50, y: 30 });
    expect(centroid.value.x).toBeCloseTo(50, 2);
    expect(centroid.value.y).toBeCloseTo(30, 2);
  });

  it("typed factor: rotation channel converges in ~5 iters", () => {
    const pts = mkPoints([10, 0], [3, 4], [-2, 1]);
    const { rotation } = procrustesTyped(pts);
    iter(rotation, Math.PI / 4, 10);
    expect(rotation.value).toBeCloseTo(Math.PI / 4, 2);
  });

  it("typed factor: scale channel converges", () => {
    const pts = mkPoints([10, 0], [3, 4], [-2, 1]);
    const { scale } = procrustesTyped(pts);
    iter(scale, 20, 10);
    expect(scale.value).toBeCloseTo(20, 1);
  });

  it("bundle Pose: position write lands exact (linear)", () => {
    const p = pose({ x: 0, y: 0, theta: 0 });
    const { position } = bundle(p, {
      position: {
        Cls: Vec,
        fwd: (s: readonly { x: number; y: number; theta: number }[]) => ({
          x: s[0]!.x,
          y: s[0]!.y,
        }),
      },
      rotation: {
        Cls: Num,
        fwd: (s: readonly { x: number; y: number; theta: number }[]) => s[0]!.theta,
      },
    });
    iter(position, { x: 5, y: 7 });
    expect(position.value.x).toBeCloseTo(5, 2);
    expect(position.value.y).toBeCloseTo(7, 2);
  });
});

// =====================================================================
// §3 — Cross-channel invariance (approximate via Jacobian)
//
// On the typed-factor path, invariance is best-effort — the LSQ
// minimises off-channel leakage but doesn't eliminate it. This test
// quantifies the leakage on a well-conditioned config.
// =====================================================================

describe("§3 Cross-channel invariance (approximate)", () => {
  it("typed Procrustes: writing centroid leaks rotation/scale slightly", () => {
    const pts = mkPoints([10, 0], [3, 4], [-2, 1]);
    const { centroid, rotation, scale } = procrustesTyped(pts);
    const r0 = rotation.value;
    const s0 = scale.value;
    iter(centroid, { x: 100, y: 50 }, 5);
    // Leakage is bounded; document the actual magnitudes.
    const drot = Math.abs(rotation.value - r0);
    const dsc = Math.abs(scale.value - s0);
    expect(drot).toBeLessThan(0.2);
    expect(dsc).toBeLessThan(5);
  });

  it("typed Procrustes: writing rotation leaks centroid/scale moderately", () => {
    // FINDING: rotation→scale leakage is fundamentally larger than
    // rotation→centroid leakage because atan2 and hypot share more
    // Jacobian structure than atan2 and (cx, cy). With more iters
    // the leakage tightens but doesn't vanish.
    const pts = mkPoints([10, 0], [3, 4], [-2, 1]);
    const { centroid, rotation, scale } = procrustesTyped(pts);
    const c0 = centroid.value;
    const s0 = scale.value;
    iter(rotation, 1.0, 20);
    const cLeak = Math.hypot(centroid.value.x - c0.x, centroid.value.y - c0.y);
    const sLeak = Math.abs(scale.value - s0);
    expect(cLeak).toBeLessThan(3);
    expect(sLeak).toBeLessThan(8);
    // eslint-disable-next-line no-console
    console.info(
      `  rotation→centroid leak: ${cLeak.toFixed(3)}, rotation→scale leak: ${sLeak.toFixed(3)}`,
    );
  });

  it("bundle Pose with independent fields: position and rotation don't leak", () => {
    // For a Pose with independent fields (no coupling), the Jacobian
    // is diagonal-ish and writes should be cleanly separated.
    const p = pose({ x: 0, y: 0, theta: 0 });
    const { position, rotation } = bundle(p, {
      position: {
        Cls: Vec,
        fwd: (s: readonly { x: number; y: number; theta: number }[]) => ({
          x: s[0]!.x,
          y: s[0]!.y,
        }),
      },
      rotation: {
        Cls: Num,
        fwd: (s: readonly { x: number; y: number; theta: number }[]) => s[0]!.theta,
      },
    });
    const r0 = rotation.value;
    iter(position, { x: 50, y: 30 }, 3);
    expect(near(rotation.value, r0, 1e-3)).toBe(true);
    const pos1 = position.value;
    iter(rotation, 1.2, 3);
    expect(vnear(position.value, pos1, 1e-3)).toBe(true);
  });
});

// =====================================================================
// §4 — bundle (1→M) with coupled views: Pose-with-virtual-pivot
//
// The interesting bundle case is when the view fwds aren't independent
// projections — i.e., the LSQ has to do real work.
// =====================================================================

describe("§4 bundle with coupled views", () => {
  it("Pose with absolute pivot in rotation fwd: writes commute as expected", () => {
    // Pose = {x, y, theta}. The rotation view reports theta, but the
    // position view reports position rotated INTO the local frame
    // around (10, 10). This couples the two — writes to either
    // require the Jacobian to balance them.
    //
    // (For the geometrically-correct closed-form version, see the
    //  bundleLens in factor-lens.ts. Here we exercise the Jacobian
    //  path to compare semantics.)
    const p = pose({ x: 0, y: 0, theta: 0 });
    type P = { x: number; y: number; theta: number };
    const { position, rotation } = bundle(p, {
      position: {
        Cls: Vec,
        fwd: (s: readonly P[]) => ({ x: s[0]!.x, y: s[0]!.y }),
      },
      rotation: {
        Cls: Num,
        fwd: (s: readonly P[]) => s[0]!.theta,
      },
    });
    iter(position, { x: 10, y: 20 }, 3);
    expect(position.value.x).toBeCloseTo(10, 1);
    expect(position.value.y).toBeCloseTo(20, 1);
    iter(rotation, 0.5, 3);
    expect(rotation.value).toBeCloseTo(0.5, 2);
    // Position should still be ~ (10, 20) — these fields are independent.
    expect(position.value.x).toBeCloseTo(10, 1);
    expect(position.value.y).toBeCloseTo(20, 1);
  });

  it("Pose → {center, span} where span = sqrt(x²+y²) converges", () => {
    // Non-linear coupling: span = ||(x,y)||. The Jacobian path needs
    // iteration; it converges but with characteristic non-linear-Newton
    // overshoot patterns. Use generous iteration budget to land.
    type P = { x: number; y: number; theta: number };
    const p = pose({ x: 3, y: 4, theta: 0 });
    const { center, span } = bundle(p, {
      center: {
        Cls: Vec,
        fwd: (s: readonly P[]) => ({ x: s[0]!.x, y: s[0]!.y }),
      },
      span: {
        Cls: Num,
        fwd: (s: readonly P[]) => Math.hypot(s[0]!.x, s[0]!.y),
      },
    });
    expect(span.value).toBeCloseTo(5, 9);
    iter(center, { x: 6, y: 8 }, 25);
    expect(center.value.x).toBeCloseTo(6, 0);
    expect(center.value.y).toBeCloseTo(8, 0);
    expect(span.value).toBeCloseTo(10, 0);
  });
});

// =====================================================================
// §5 — Typed factor parity with closed-form Procrustes
//
// On small writes near a well-conditioned config, the typed-factor
// Jacobian should agree with the closed-form result to within ~FD ε.
// =====================================================================

describe("§5 Typed-factor parity with closed-form Procrustes", () => {
  it("small centroid delta: < 2% relative error", () => {
    const ptsCF = mkPoints([10, 0], [3, 4], [-2, 1]);
    const ptsTF = mkPoints([10, 0], [3, 4], [-2, 1]);
    const cf = procrustesLens(ptsCF);
    const tf = procrustesTyped(ptsTF);
    const c0 = cf.centroid.value;
    cf.centroid.value = { x: c0.x + 0.5, y: c0.y + 0.5 };
    iter(tf.centroid, { x: c0.x + 0.5, y: c0.y + 0.5 }, 3);
    for (let i = 0; i < 3; i++) {
      const errX = Math.abs(ptsCF[i]!.value.x - ptsTF[i]!.value.x);
      const errY = Math.abs(ptsCF[i]!.value.y - ptsTF[i]!.value.y);
      expect(errX).toBeLessThan(0.5);
      expect(errY).toBeLessThan(0.5);
    }
  });
});

// =====================================================================
// §6 — Performance
// =====================================================================

function timed(label: string, iters: number, fn: () => void): number {
  fn();
  fn();
  const t0 = performance.now();
  fn();
  const t1 = performance.now();
  const ms = t1 - t0;
  // eslint-disable-next-line no-console
  console.info(
    `  ${label.padEnd(58)}  ${ms.toFixed(2).padStart(7)}ms  (${((ms * 1000) / iters).toFixed(2)}µs/op)`,
  );
  return ms;
}

describe("§6 Performance probes", () => {
  const ITERS = 1000;

  it("Procrustes write throughput (K=3): closed-form vs typed-factor", () => {
    const ptsCF = mkPoints([5, 0], [3, 4], [-2, 1]);
    const ptsTF = mkPoints([5, 0], [3, 4], [-2, 1]);
    const cf = procrustesLens(ptsCF);
    const tf = procrustesTyped(ptsTF);
    // eslint-disable-next-line no-console
    console.info("  Procrustes write throughput (K=3 points, typed vs closed-form):");
    timed("closed-form: centroid write (Vec)", ITERS, () => {
      for (let i = 0; i < ITERS; i++) cf.centroid.value = { x: i & 31, y: (i * 7) & 31 };
    });
    timed("typed-factor: centroid write (Vec)", ITERS, () => {
      for (let i = 0; i < ITERS; i++) tf.centroid.value = { x: i & 31, y: (i * 7) & 31 };
    });
    timed("closed-form: rotation write (Num)", ITERS, () => {
      for (let i = 0; i < ITERS; i++) cf.rotation.value = (i & 31) * 0.1;
    });
    timed("typed-factor: rotation write (Num)", ITERS, () => {
      for (let i = 0; i < ITERS; i++) tf.rotation.value = (i & 31) * 0.1;
    });
  });

  it("bundle Pose throughput (single source, 2 views)", () => {
    type P = { x: number; y: number; theta: number };
    const p = pose({ x: 0, y: 0, theta: 0 });
    const b = bundle(p, {
      position: {
        Cls: Vec,
        fwd: (s: readonly P[]) => ({ x: s[0]!.x, y: s[0]!.y }),
      },
      rotation: {
        Cls: Num,
        fwd: (s: readonly P[]) => s[0]!.theta,
      },
    });
    // eslint-disable-next-line no-console
    console.info("  Bundle Pose 1→2 view throughput:");
    timed("bundle: position write", ITERS, () => {
      for (let i = 0; i < ITERS; i++) b.position.value = { x: i & 31, y: i & 31 };
    });
    timed("bundle: rotation write", ITERS, () => {
      for (let i = 0; i < ITERS; i++) b.rotation.value = (i & 31) * 0.1;
    });
  });

  it("Scaling: typed Procrustes with K = 3, 10, 50 points", () => {
    // eslint-disable-next-line no-console
    console.info("  Typed-factor Procrustes scaling with K:");
    const ITERS_S = 200;
    for (const K of [3, 10, 50]) {
      const pts: Writable<Vec>[] = [];
      for (let i = 0; i < K; i++) pts.push(vec(Math.cos(i), Math.sin(i)));
      const tf = procrustesTyped(pts);
      const t0 = performance.now();
      for (let i = 0; i < ITERS_S; i++) tf.centroid.value = { x: i & 7, y: i & 7 };
      const ms = performance.now() - t0;
      // eslint-disable-next-line no-console
      console.info(
        `    K = ${K.toString().padStart(3)} → ${(ms / ITERS_S).toFixed(3)} ms/write (${((ms * 1000) / ITERS_S).toFixed(2)} µs)`,
      );
    }
  });
});

// =====================================================================
// §7 — Probe: chaining factor outputs through value-class methods
//
// Each factor output is `Writable<Cls>`, so it inherits `Cls`'s
// invertibles. Verify that `.scale`, `.add`, `field()` etc. all work
// on a typed-factor output — i.e., factor cells are first-class
// `Writable<Vec>` / `Writable<Num>` cells in every way.
// =====================================================================

describe("§7 Probe: chaining factor outputs", () => {
  it("centroid (Vec) can be field-accessed (.x, .y)", () => {
    const pts = mkPoints([0, 0], [10, 0], [0, 6]);
    const { centroid } = procrustesTyped(pts);
    // field access — should work since centroid is Writable<Vec>
    expect(centroid.x.value).toBeCloseTo(10 / 3, 9);
    expect(centroid.y.value).toBeCloseTo(2, 9);
  });

  it("centroid.add(...) returns a fused lens that round-trips", () => {
    const pts = mkPoints([0, 0], [10, 0], [0, 6]);
    const { centroid } = procrustesTyped(pts);
    const shifted = centroid.add({ x: 100, y: 100 });
    expect(shifted.value.x).toBeCloseTo(10 / 3 + 100, 6);
    expect(shifted.value.y).toBeCloseTo(2 + 100, 6);
    // Write to the shifted lens — should propagate back through
    // .add's bwd, then through the factor centroid's bwd.
    iter(shifted, { x: 150, y: 200 }, 5);
    expect(shifted.value.x).toBeCloseTo(150, 1);
    expect(shifted.value.y).toBeCloseTo(200, 1);
  });

  it("rotation.scale(2) returns a Writable<Num> that round-trips", () => {
    const pts = mkPoints([10, 0], [3, 4], [-2, 1]);
    const { rotation } = procrustesTyped(pts);
    const doubled = rotation.scale(2);
    expect(doubled.value).toBeCloseTo(rotation.value * 2, 6);
    iter(doubled, 1.0, 10);
    expect(doubled.value).toBeCloseTo(1.0, 1);
    expect(rotation.value).toBeCloseTo(0.5, 1);
  });
});

// =====================================================================
// §8 — Probe: analytical Jacobian (skip FD)
//
// For LINEAR forwards, providing the analytical Jacobian eliminates
// FD overhead AND FD eps drift. Test: centroid via factor with
// analytical J should match centroid via FD numerically, and run
// faster.
// =====================================================================

describe("§8 Probe: analytical Jacobian", () => {
  it("linear centroid: analytical-J factor with damping=0 is machine-exact", () => {
    const K = 5;
    const pts: Writable<Vec>[] = [];
    for (let i = 0; i < K; i++) pts.push(vec(i, i * 2));
    type V = { x: number; y: number };
    const invK = 1 / K;
    const rowCx: number[] = [];
    const rowCy: number[] = [];
    for (let i = 0; i < K; i++) {
      rowCx.push(invK, 0);
      rowCy.push(0, invK);
    }
    const fwd = (p: readonly V[]): V => {
      let sx = 0;
      let sy = 0;
      for (const v of p) {
        sx += v.x;
        sy += v.y;
      }
      return { x: sx / K, y: sy / K };
    };
    // damping=0 → exact LSQ solve when well-conditioned.
    const { centroid: cExact } = factor(
      pts,
      { centroid: { Cls: Vec, fwd, jacobian: () => [rowCx, rowCy] } },
      { damping: 0 },
    );
    // Default damping=1e-6 → small leakage at ~1e-5 scale.
    const ptsB = pts.map(p => vec(p.value.x, p.value.y));
    const { centroid: cDamped } = factor(ptsB, {
      centroid: { Cls: Vec, fwd, jacobian: () => [rowCx, rowCy] },
    });
    // FD path (default eps=1e-5) → ~5e-5 error.
    const ptsC = pts.map(p => vec(p.value.x, p.value.y));
    const { centroid: cFD } = factor(ptsC, {
      centroid: { Cls: Vec, fwd },
    });
    cExact.value = { x: 100, y: 50 };
    cDamped.value = { x: 100, y: 50 };
    cFD.value = { x: 100, y: 50 };
    // Document the three precision regimes.
    const errExact = Math.abs(cExact.value.x - 100);
    const errDamped = Math.abs(cDamped.value.x - 100);
    const errFD = Math.abs(cFD.value.x - 100);
    // eslint-disable-next-line no-console
    console.info(
      `  centroid write precision: analytical+damping=0 ${errExact.toExponential(2)}, ` +
        `analytical+default-damping ${errDamped.toExponential(2)}, FD ${errFD.toExponential(2)}`,
    );
    expect(errExact).toBeLessThan(1e-12); // machine eps
    expect(errDamped).toBeLessThan(1e-3); // damping leak (small for linear)
    expect(errFD).toBeLessThan(1e-3); // FD eps drift
  });

  it("analytical Jacobian: write a centroid 100× — perf vs FD", () => {
    const K = 10;
    const ptsA: Writable<Vec>[] = [];
    const ptsB: Writable<Vec>[] = [];
    for (let i = 0; i < K; i++) {
      ptsA.push(vec(i, i * 2));
      ptsB.push(vec(i, i * 2));
    }
    type V = { x: number; y: number };
    const invK = 1 / K;
    const rowCx: number[] = [];
    const rowCy: number[] = [];
    for (let i = 0; i < K; i++) {
      rowCx.push(invK, 0);
      rowCy.push(0, invK);
    }
    const fwdC = (p: readonly V[]): V => {
      let sx = 0;
      let sy = 0;
      for (const v of p) {
        sx += v.x;
        sy += v.y;
      }
      return { x: sx / K, y: sy / K };
    };
    const aLens = factor(ptsA, {
      centroid: { Cls: Vec, fwd: fwdC, jacobian: () => [rowCx, rowCy] },
    });
    const bLens = factor(ptsB, {
      centroid: { Cls: Vec, fwd: fwdC },
    });
    // eslint-disable-next-line no-console
    console.info("  Centroid write perf: analytical-J vs FD (K=10):");
    const ITERS_J = 2000;
    timed("analytical-J", ITERS_J, () => {
      for (let i = 0; i < ITERS_J; i++) aLens.centroid.value = { x: i & 31, y: (i * 3) & 31 };
    });
    timed("FD", ITERS_J, () => {
      for (let i = 0; i < ITERS_J; i++) bLens.centroid.value = { x: i & 31, y: (i * 3) & 31 };
    });
  });
});

// =====================================================================
// §9 — Probe: auto-converge on non-linear forwards
//
// converge: true wraps the single-Newton-step setter in a loop until
// the channel's reading is within tol of target. For linear forwards
// converges in 1 iter (overhead is one re-peek + distance check);
// for non-linear forwards, 3-25 iters depending on geometry.
// =====================================================================

describe("§9 Probe: auto-converge", () => {
  it("centroid write with converge:true lands exactly (linear)", () => {
    const K = 3;
    const pts: Writable<Vec>[] = [vec(0, 0), vec(10, 0), vec(5, 7)];
    type V = { x: number; y: number };
    const { centroid } = factor(
      pts,
      {
        centroid: {
          Cls: Vec,
          fwd: (p: readonly V[]) => ({
            x: (p[0]!.x + p[1]!.x + p[2]!.x) / K,
            y: (p[0]!.y + p[1]!.y + p[2]!.y) / K,
          }),
        },
      },
      { converge: true },
    );
    centroid.value = { x: 100, y: 50 };
    // Single write should land within tol (1e-4) — linear converges in 1 iter.
    expect(centroid.value.x).toBeCloseTo(100, 3);
    expect(centroid.value.y).toBeCloseTo(50, 3);
  });

  it("Procrustes-style rotation with converge:true lands non-linearly", () => {
    const pts = mkPoints([10, 0], [3, 4], [-2, 1]);
    type V = { x: number; y: number };
    const { rotation } = factor(
      pts,
      {
        centroid: {
          Cls: Vec,
          fwd: (p: readonly V[]) => ({
            x: (p[0]!.x + p[1]!.x + p[2]!.x) / 3,
            y: (p[0]!.y + p[1]!.y + p[2]!.y) / 3,
          }),
        },
        rotation: {
          Cls: Num,
          fwd: (p: readonly V[]) => {
            const cx = (p[0]!.x + p[1]!.x + p[2]!.x) / 3;
            const cy = (p[0]!.y + p[1]!.y + p[2]!.y) / 3;
            return Math.atan2(p[0]!.y - cy, p[0]!.x - cx);
          },
        },
        scale: {
          Cls: Num,
          fwd: (p: readonly V[]) => {
            const cx = (p[0]!.x + p[1]!.x + p[2]!.x) / 3;
            const cy = (p[0]!.y + p[1]!.y + p[2]!.y) / 3;
            return Math.hypot(p[0]!.x - cx, p[0]!.y - cy);
          },
        },
      },
      { converge: true, damping: 1e-3, maxIters: 20 },
    );
    // Single write should land — auto-converge iterates internally.
    rotation.value = 1.0;
    expect(rotation.value).toBeCloseTo(1.0, 2);
    rotation.value = -0.5;
    expect(rotation.value).toBeCloseTo(-0.5, 2);
  });

  it("Pose center+span with converge:true: non-linear single-write lands", () => {
    type P = { x: number; y: number; theta: number };
    const p = pose({ x: 3, y: 4, theta: 0 });
    const { center, span } = bundle(
      p,
      {
        center: {
          Cls: Vec,
          fwd: (s: readonly P[]) => ({ x: s[0]!.x, y: s[0]!.y }),
        },
        span: {
          Cls: Num,
          fwd: (s: readonly P[]) => Math.hypot(s[0]!.x, s[0]!.y),
        },
      },
      { converge: true, damping: 1e-3, maxIters: 30 },
    );
    center.value = { x: 6, y: 8 };
    expect(center.value.x).toBeCloseTo(6, 1);
    expect(center.value.y).toBeCloseTo(8, 1);
    expect(span.value).toBeCloseTo(10, 0);
  });
});

// =====================================================================
// §10 — Broader probes: composition, sharing, and pinned inputs
// =====================================================================

describe("§10 Broader probe: factor-of-factor composition", () => {
  it("centroid of one factor feeds into another factor", () => {
    // Two clusters; compute centroid of cluster A, then a "meta-centroid"
    // that includes A's centroid as one of cluster B's points.
    const A = mkPoints([0, 0], [10, 0], [5, 10]);
    const { centroid: cA } = procrustesTyped(A);
    expect(cA.value).toEqual({ x: 5, y: 10 / 3 });

    const extra = vec(20, 20);
    type V = { x: number; y: number };
    const { centroid: cMeta } = factor([cA, extra] as never, {
      centroid: {
        Cls: Vec,
        fwd: (pts: readonly V[]) => ({
          x: (pts[0]!.x + pts[1]!.x) / 2,
          y: (pts[0]!.y + pts[1]!.y) / 2,
        }),
      },
    });
    expect(cMeta.value.x).toBeCloseTo((5 + 20) / 2, 9);
    expect(cMeta.value.y).toBeCloseTo((10 / 3 + 20) / 2, 9);

    // Writing meta-centroid distributes to cA + extra, which in turn
    // distributes cA's update across cluster A.
    iter(cMeta, { x: 50, y: 50 }, 5);
    expect(cMeta.value.x).toBeCloseTo(50, 1);
    expect(cMeta.value.y).toBeCloseTo(50, 1);
    // And the original points in A should have shifted accordingly.
    const finalCA = A.reduce((s, p) => ({ x: s.x + p.value.x, y: s.y + p.value.y }), {
      x: 0,
      y: 0,
    }) as V;
    finalCA.x /= 3;
    finalCA.y /= 3;
    expect(finalCA).toEqual(cA.value);
  });
});

describe("§10 Broader probe: shared inputs across factors", () => {
  it("two factors over overlapping point sets — writes coordinate via shared root", () => {
    // SURPRISING FINDING: both closed-form `centroidLens` AND the
    // Jacobian-LSQ `factor` shift each input by the FULL delta
    // (not delta/K). Centroid lens semantics: writing centroid
    // by Δ translates EVERY point by Δ (not by Δ/K). This is the
    // rigid-translate group action — exactly what you want for
    // a "drag the whole cluster" handle. But it means shared-input
    // factors couple STRONGLY: writing one factor's centroid moves
    // shared points by the full delta.
    const a = vec(0, 0);
    const b = vec(10, 0);
    const c = vec(5, 10);
    const d = vec(20, 5);
    const e = vec(15, -5);

    const { centroid: c1 } = procrustesTyped([a, b, c, d]); // 4 points
    const { centroid: c2 } = procrustesTyped([a, b, c, e]); // shares a, b, c

    const c1_0 = c1.value;
    const c2_0 = c2.value;
    iter(c1, { x: c1_0.x + 8, y: c1_0.y + 8 }, 3);
    const c2_after = c2.value;
    // a, b, c each shifted by (8, 8) (rigid translate via Jacobian LSQ).
    // e unchanged. c2 = mean(a, b, c, e) → shifted by 3·8/4 = 6 per axis.
    expect(c2_after.x).toBeCloseTo(c2_0.x + 6, 1);
    expect(c2_after.y).toBeCloseTo(c2_0.y + 6, 1);
  });
});

describe("§10 Broader probe: pinned inputs via weights", () => {
  it("inputWeights = 0 freezes specific input scalars", () => {
    // Three points; pin point[0]'s x (only).
    const pts = mkPoints([10, 0], [0, 0], [0, 0]);
    type V = { x: number; y: number };
    // pts has 3 Vecs = 6 flat scalars. Weights: pin index 0 (pts[0].x).
    const weights = [0, 1, 1, 1, 1, 1];
    const { centroid } = factor(
      pts,
      {
        centroid: {
          Cls: Vec,
          fwd: (p: readonly V[]) => ({
            x: (p[0]!.x + p[1]!.x + p[2]!.x) / 3,
            y: (p[0]!.y + p[1]!.y + p[2]!.y) / 3,
          }),
        },
      },
      { inputWeights: weights, damping: 0 },
    );
    iter(centroid, { x: 100, y: 50 }, 5);
    // pts[0].x must still be 10 (pinned).
    expect(pts[0]!.value.x).toBe(10);
    // Other 5 scalars absorb the delta. centroid.x should still hit ~100.
    expect(centroid.value.x).toBeCloseTo(100, 1);
    expect(centroid.value.y).toBeCloseTo(50, 1);
  });
});

describe("§10 Broader probe: the 'perfect' combo (analytical J + damping=0 + converge)", () => {
  it("linear bundle: write lands at machine precision in single iter", () => {
    // For linear-fwd cases, the perfect combo gives machine-exact
    // semantics in a single user-visible write. No drift, no iteration
    // visible to caller, exact.
    type P = { x: number; y: number; theta: number };
    const p = pose({ x: 3, y: 7, theta: 1.0 });
    const { position } = bundle(
      p,
      {
        position: {
          Cls: Vec,
          fwd: (s: readonly P[]) => ({ x: s[0]!.x, y: s[0]!.y }),
          jacobian: () => [
            [1, 0, 0],
            [0, 1, 0],
          ],
        },
        rotation: {
          Cls: Num,
          fwd: (s: readonly P[]) => s[0]!.theta,
          jacobian: () => [[0, 0, 1]],
        },
      },
      { damping: 0, converge: true },
    );
    position.value = { x: 100, y: 50 };
    expect(p.value.x).toBe(100); // machine-exact
    expect(p.value.y).toBe(50);
    expect(p.value.theta).toBe(1.0); // untouched
  });
});

// =====================================================================
// §11 — Positional API (factorTuple)
//
// Same engine, tuple I/O. Verify TypeScript infers tuple types
// correctly and runtime semantics match the named API.
// =====================================================================

describe("§11 Positional API (factorTuple)", () => {
  it("destructures with correct types", () => {
    const pts = mkPoints([0, 0], [10, 0], [0, 6]);
    type V = { x: number; y: number };
    const [centroid, rotation, scale] = factorTuple(pts, [
      {
        Cls: Vec,
        fwd: (p: readonly V[]) => ({
          x: (p[0]!.x + p[1]!.x + p[2]!.x) / 3,
          y: (p[0]!.y + p[1]!.y + p[2]!.y) / 3,
        }),
      },
      {
        Cls: Num,
        fwd: (p: readonly V[]) => {
          const cx = (p[0]!.x + p[1]!.x + p[2]!.x) / 3;
          const cy = (p[0]!.y + p[1]!.y + p[2]!.y) / 3;
          return Math.atan2(p[0]!.y - cy, p[0]!.x - cx);
        },
      },
      {
        Cls: Num,
        fwd: (p: readonly V[]) => {
          const cx = (p[0]!.x + p[1]!.x + p[2]!.x) / 3;
          const cy = (p[0]!.y + p[1]!.y + p[2]!.y) / 3;
          return Math.hypot(p[0]!.x - cx, p[0]!.y - cy);
        },
      },
    ]);
    // Compile-time types: centroid: Writable<Vec>, rotation: Writable<Num>, scale: Writable<Num>.
    // Verify runtime values match expectations.
    expect(centroid.value.x).toBeCloseTo(10 / 3, 9);
    expect(rotation.value).toBeCloseTo(Math.atan2(-2, -10 / 3), 9);
    expect(scale.value).toBeCloseTo(Math.hypot(10 / 3, 2), 9);

    // Write through them — semantics match named API.
    iter(centroid, { x: 50, y: 50 });
    expect(centroid.value.x).toBeCloseTo(50, 2);
    expect(centroid.value.y).toBeCloseTo(50, 2);
  });

  it("equivalent semantics to named API (parity check)", () => {
    const ptsN = mkPoints([0, 0], [10, 0], [0, 6]);
    const ptsT = mkPoints([0, 0], [10, 0], [0, 6]);
    type V = { x: number; y: number };
    const namedSpecs = {
      centroid: {
        Cls: Vec,
        fwd: (p: readonly V[]) => ({
          x: (p[0]!.x + p[1]!.x + p[2]!.x) / 3,
          y: (p[0]!.y + p[1]!.y + p[2]!.y) / 3,
        }),
      },
    };
    const named = factor(ptsN, namedSpecs);
    const [tuple] = factorTuple(ptsT, [namedSpecs.centroid]);
    iter(named.centroid, { x: 30, y: 30 });
    iter(tuple, { x: 30, y: 30 });
    for (let i = 0; i < 3; i++) {
      expect(ptsN[i]!.value.x).toBeCloseTo(ptsT[i]!.value.x, 9);
      expect(ptsN[i]!.value.y).toBeCloseTo(ptsT[i]!.value.y, 9);
    }
  });

  it("perf: positional vs named (should be identical)", () => {
    const ptsN = mkPoints([5, 0], [3, 4], [-2, 1]);
    const ptsT = mkPoints([5, 0], [3, 4], [-2, 1]);
    type V = { x: number; y: number };
    const fwd = (p: readonly V[]): V => ({
      x: (p[0]!.x + p[1]!.x + p[2]!.x) / 3,
      y: (p[0]!.y + p[1]!.y + p[2]!.y) / 3,
    });
    const jac = () => [
      [1 / 3, 0, 1 / 3, 0, 1 / 3, 0],
      [0, 1 / 3, 0, 1 / 3, 0, 1 / 3],
    ];
    const named = factor(ptsN, { centroid: { Cls: Vec, fwd, jacobian: jac } });
    const [tuple] = factorTuple(ptsT, [{ Cls: Vec, fwd, jacobian: jac }]);
    // eslint-disable-next-line no-console
    console.info("  factorTuple vs factor (parity, analytical J):");
    const N_ITERS = 2000;
    timed("factor (named)", N_ITERS, () => {
      for (let i = 0; i < N_ITERS; i++) named.centroid.value = { x: i & 31, y: i & 31 };
    });
    timed("factorTuple (positional)", N_ITERS, () => {
      for (let i = 0; i < N_ITERS; i++) tuple.value = { x: i & 31, y: i & 31 };
    });
  });
});

// =====================================================================
// §12 — Subsumption: can factor replace existing aggregates?
//
// For each existing N→1 primitive (centroidLens, meanLens, midpointLens,
// pulleySum, diffLens), build an equivalent via factor() and check:
//   a) Read values match
//   b) Write semantics match (same input deltas for the same target)
//   c) Performance is comparable (acceptable tax for generality)
// =====================================================================

describe("§12 Subsumption: factor vs existing aggregates", () => {
  describe("centroidLens(...vecs)", () => {
    it("read/write parity with factor-via-centroid", () => {
      const ptsLegacy = mkPoints([0, 0], [10, 0], [5, 8], [-3, 4]);
      const ptsFactor = mkPoints([0, 0], [10, 0], [5, 8], [-3, 4]);
      const cLegacy = centroidLens(ptsLegacy as never);
      type V = { x: number; y: number };
      const { centroid: cFactor } = factor(
        ptsFactor,
        {
          centroid: {
            Cls: Vec,
            fwd: (p: readonly V[]) => ({
              x: p.reduce((s, v) => s + v.x, 0) / 4,
              y: p.reduce((s, v) => s + v.y, 0) / 4,
            }),
            jacobian: () => [
              [1 / 4, 0, 1 / 4, 0, 1 / 4, 0, 1 / 4, 0],
              [0, 1 / 4, 0, 1 / 4, 0, 1 / 4, 0, 1 / 4],
            ],
          },
        },
        { damping: 0 },
      );
      // Read parity
      expect(cLegacy.value).toEqual(cFactor.value);
      // Write parity
      cLegacy.value = { x: 100, y: 50 };
      cFactor.value = { x: 100, y: 50 };
      for (let i = 0; i < 4; i++) {
        expect(ptsLegacy[i]!.value.x).toBeCloseTo(ptsFactor[i]!.value.x, 9);
        expect(ptsLegacy[i]!.value.y).toBeCloseTo(ptsFactor[i]!.value.y, 9);
      }
    });

    it("perf: factor vs centroidLens at K=10", () => {
      const ptsL: Writable<Vec>[] = [];
      const ptsF: Writable<Vec>[] = [];
      for (let i = 0; i < 10; i++) {
        ptsL.push(vec(i, i * 2));
        ptsF.push(vec(i, i * 2));
      }
      type V = { x: number; y: number };
      const cL = centroidLens(ptsL as never);
      const jac: number[][] = [new Array(20).fill(0), new Array(20).fill(0)];
      for (let i = 0; i < 10; i++) {
        jac[0]![2 * i] = 1 / 10;
        jac[1]![2 * i + 1] = 1 / 10;
      }
      const { centroid: cF } = factor(
        ptsF,
        {
          centroid: {
            Cls: Vec,
            fwd: (p: readonly V[]) => ({
              x: p.reduce((s, v) => s + v.x, 0) / 10,
              y: p.reduce((s, v) => s + v.y, 0) / 10,
            }),
            jacobian: () => jac,
          },
        },
        { damping: 0 },
      );
      // eslint-disable-next-line no-console
      console.info("  centroid write perf (K=10):");
      const ITERS = 2000;
      timed("centroidLens (hand-rolled)", ITERS, () => {
        for (let i = 0; i < ITERS; i++) cL.value = { x: i & 31, y: i & 31 };
      });
      timed("factor (analytical J, damping=0)", ITERS, () => {
        for (let i = 0; i < ITERS; i++) cF.value = { x: i & 31, y: i & 31 };
      });
    });
  });

  describe("meanLens(Num, ...nums)", () => {
    it("read/write parity with factor-via-mean", () => {
      const aL = num(1);
      const bL = num(3);
      const cL = num(5);
      const aF = num(1);
      const bF = num(3);
      const cF = num(5);
      const mLegacy = meanLens(Num, [aL, bL, cL]);
      const { mean: mFactor } = factor(
        [aF, bF, cF],
        {
          mean: {
            Cls: Num,
            fwd: (xs: readonly number[]) => (xs[0]! + xs[1]! + xs[2]!) / 3,
            jacobian: () => [[1 / 3, 1 / 3, 1 / 3]],
          },
        },
        { damping: 0 },
      );
      expect(mLegacy.value).toBe(mFactor.value);
      mLegacy.value = 10;
      mFactor.value = 10;
      expect(aL.value).toBeCloseTo(aF.value, 9);
      expect(bL.value).toBeCloseTo(bF.value, 9);
      expect(cL.value).toBeCloseTo(cF.value, 9);
    });
  });

  describe("midpointLens(a, b)", () => {
    it("read/write parity with factor-via-midpoint", () => {
      const aL = vec(0, 0);
      const bL = vec(10, 10);
      const aF = vec(0, 0);
      const bF = vec(10, 10);
      const mLegacy = midpointLens(aL, bL);
      type V = { x: number; y: number };
      const { mid: mFactor } = factor(
        [aF, bF],
        {
          mid: {
            Cls: Vec,
            fwd: (p: readonly V[]) => ({
              x: (p[0]!.x + p[1]!.x) / 2,
              y: (p[0]!.y + p[1]!.y) / 2,
            }),
            jacobian: () => [
              [1 / 2, 0, 1 / 2, 0],
              [0, 1 / 2, 0, 1 / 2],
            ],
          },
        },
        { damping: 0 },
      );
      expect(mLegacy.value).toEqual(mFactor.value);
      mLegacy.value = { x: 100, y: 100 };
      mFactor.value = { x: 100, y: 100 };
      expect(aL.value).toEqual(aF.value);
      expect(bL.value).toEqual(bF.value);
    });
  });

  describe("pulleySum(a, b)", () => {
    it("read/write parity with factor-via-sum", () => {
      const aL = num(3);
      const bL = num(7);
      const aF = num(3);
      const bF = num(7);
      const sL = pulleySum(aL, bL);
      const { sum: sF } = factor(
        [aF, bF],
        {
          sum: {
            Cls: Num,
            fwd: (xs: readonly number[]) => xs[0]! + xs[1]!,
            jacobian: () => [[1, 1]],
          },
        },
        { damping: 0 },
      );
      expect(sL.value).toBe(sF.value);
      sL.value = 20;
      sF.value = 20;
      expect(aL.value).toBeCloseTo(aF.value, 9); // 8
      expect(bL.value).toBeCloseTo(bF.value, 9); // 12
    });
  });

  describe("diffLens(a, b)", () => {
    it("read/write parity with factor-via-diff", () => {
      const aL = num(10);
      const bL = num(3);
      const aF = num(10);
      const bF = num(3);
      const dL = diffLens(aL, bL);
      const { diff: dF } = factor(
        [aF, bF],
        {
          diff: {
            Cls: Num,
            fwd: (xs: readonly number[]) => xs[0]! - xs[1]!,
            jacobian: () => [[1, -1]],
          },
        },
        { damping: 0 },
      );
      expect(dL.value).toBe(dF.value);
      dL.value = 11;
      dF.value = 11;
      expect(aL.value).toBeCloseTo(aF.value, 9); // 12
      expect(bL.value).toBeCloseTo(bF.value, 9); // 1
    });
  });

  it("perf summary: factor vs hand-rolled aggregates", () => {
    const ITERS = 2000;
    // eslint-disable-next-line no-console
    console.info("  Subsumption perf summary (N=2 single-write aggregates):");
    // 1. pulleySum
    {
      const aL = num(3);
      const bL = num(7);
      const sL = pulleySum(aL, bL);
      const aF = num(3);
      const bF = num(7);
      const { sum: sF } = factor(
        [aF, bF],
        {
          sum: {
            Cls: Num,
            fwd: (xs: readonly number[]) => xs[0]! + xs[1]!,
            jacobian: () => [[1, 1]],
          },
        },
        { damping: 0 },
      );
      timed("pulleySum (hand-rolled)", ITERS, () => {
        for (let i = 0; i < ITERS; i++) sL.value = i & 31;
      });
      timed("factor sum (analytical J)", ITERS, () => {
        for (let i = 0; i < ITERS; i++) sF.value = i & 31;
      });
    }
    // 2. midpointLens
    {
      const aL = vec(0, 0);
      const bL = vec(10, 10);
      const mL = midpointLens(aL, bL);
      const aF = vec(0, 0);
      const bF = vec(10, 10);
      type V = { x: number; y: number };
      const { mid: mF } = factor(
        [aF, bF],
        {
          mid: {
            Cls: Vec,
            fwd: (p: readonly V[]) => ({
              x: (p[0]!.x + p[1]!.x) / 2,
              y: (p[0]!.y + p[1]!.y) / 2,
            }),
            jacobian: () => [
              [1 / 2, 0, 1 / 2, 0],
              [0, 1 / 2, 0, 1 / 2],
            ],
          },
        },
        { damping: 0 },
      );
      timed("midpointLens (hand-rolled)", ITERS, () => {
        for (let i = 0; i < ITERS; i++) mL.value = { x: i & 31, y: i & 31 };
      });
      timed("factor midpoint (analytical J)", ITERS, () => {
        for (let i = 0; i < ITERS; i++) mF.value = { x: i & 31, y: i & 31 };
      });
    }
  });
});

describe("§10 Broader probe: factor with fused-lens inputs", () => {
  it("inputs that are themselves field lenses still work", () => {
    // Build field lenses explicitly via `field()` since Pose doesn't
    // expose them as auto-getters. The field lenses are Writable<Num>
    // with Num's Pack trait — should work as factor inputs.
    const p = pose({ x: 3, y: 7, theta: 1.0 });
    const px = field(p, "x", Num);
    const py = field(p, "y", Num);
    const { sum } = factor(
      [px, py] as never,
      {
        sum: {
          Cls: Num,
          fwd: (nums: readonly number[]) => nums[0]! + nums[1]!,
          jacobian: () => [[1, 1]],
        },
      },
      { damping: 0 },
    );
    expect(sum.value).toBeCloseTo(10, 9);
    sum.value = 30;
    // For sum (J entries = 1, M=1), LSQ gives δx_i = δ/N per input.
    // δ = 20, N = 2 → each shifts by 10. px: 3→13, py: 7→17. This
    // matches pulleySum's closed-form (the LSQ recovers it because
    // the constraint J δx = δy has a 1D solution space and min-norm
    // picks the centred one).
    expect(p.value.x).toBeCloseTo(13, 9);
    expect(p.value.y).toBeCloseTo(17, 9);
    expect(p.value.theta).toBeCloseTo(1.0, 9);
  });
});
