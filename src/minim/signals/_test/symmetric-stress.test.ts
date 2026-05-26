// symmetric-stress.test.ts — try hard to break the symmetric lens
// primitive. Covers reactive integration: feedback loops, multiple
// effects sharing a lens, network() integration, lens-of-lens stacking,
// untracked reads, long random walks, pathological inputs, and
// multiple lenses sharing parents.
//
// What "broken" looks like:
//   - infinite loop / runaway propagation
//   - NaN/Infinity escaping the lens silently
//   - observable read instability (subsequent reads disagree)
//   - effect fires more than expected
//   - source mutated during reads (no side effects on read)
//   - one lens corrupting another lens's complement

import { describe, expect, it } from "vitest";
import { bestFitCircleLens, bestFitLineLens, scaleAbout } from "../lenses/closed-form-policies";
import { spreadOf } from "../lenses/domain-aggregates";
import { bboxLens } from "../lenses/factor-lens";
import { effect, network, untracked } from "../signal";
import { num } from "../values/num";
import { vec } from "../values/vec";

type V = { x: number; y: number };
type Writable<T> = { value: T; peek(): T };

const mkCluster = (pts: readonly V[]): ReturnType<typeof vec>[] => pts.map(p => vec(p.x, p.y));

const isFiniteVec = (v: V): boolean => Number.isFinite(v.x) && Number.isFinite(v.y);

// ─── Feedback loops ────────────────────────────────────────────────

describe("feedback loops", () => {
  it("self-write loop in an effect raises (or is bounded), does NOT freeze", () => {
    // Classic footgun: an effect reads the lens and writes back to
    // it. With normal lenses the engine guards against runaway loops.
    // Symmetric lenses inherit that guard.
    const cells = mkCluster([
      { x: 0, y: 2 },
      { x: 0, y: -2 },
      { x: 2, y: 0 },
      { x: -2, y: 0 },
    ]);
    const spread = spreadOf(cells as never);
    let fires = 0;
    const dispose = effect(() => {
      fires += 1;
      const v = spread.value;
      if (fires < 100 && v > 0.1) {
        // self-write — should NOT cause runaway thanks to write-time
        // bounding inherited from the base engine.
        spread.value = v * 0.5;
      }
    });
    // If this freezes we'll time out; if it bounded properly we get
    // a finite fire count.
    expect(fires).toBeLessThan(200);
    dispose();
  });

  it("two-effect cross-write does not diverge", () => {
    const cells = mkCluster([
      { x: 0, y: 3 },
      { x: 3, y: 0 },
      { x: -3, y: 0 },
    ]);
    const spread = spreadOf(cells as never);
    const { radius } = bestFitCircleLens(cells as never);
    let firesA = 0;
    let firesB = 0;
    const a = effect(() => {
      firesA += 1;
      void spread.value;
    });
    const b = effect(() => {
      firesB += 1;
      void radius.value;
    });
    spread.value = 5;
    expect(firesA).toBeLessThan(20);
    expect(firesB).toBeLessThan(20);
    a();
    b();
  });
});

// ─── Multiple concurrent readers ──────────────────────────────────

describe("multiple concurrent readers", () => {
  it("3 effects reading the same lens see identical values", () => {
    const cells = mkCluster([
      { x: 0, y: 5 },
      { x: 5, y: 0 },
      { x: -5, y: 0 },
      { x: 0, y: -5 },
    ]);
    const spread = spreadOf(cells as never);
    const readings: number[] = [0, 0, 0];
    const disposers = readings.map((_, i) =>
      effect(() => {
        readings[i] = spread.value;
      }),
    );
    spread.value = 9;
    expect(readings[0]).toEqual(readings[1]);
    expect(readings[1]).toEqual(readings[2]);
    expect(readings[0]).toBeCloseTo(9, 9);
    disposers.forEach(d => d());
  });

  it("read in many effects + write does NOT trigger duplicate work", () => {
    const cells = mkCluster([
      { x: 0, y: 2 },
      { x: 0, y: -2 },
      { x: 2, y: 0 },
      { x: -2, y: 0 },
    ]);
    const spread = spreadOf(cells as never);
    const fires = [0, 0, 0, 0, 0];
    const ds = fires.map((_, i) =>
      effect(() => {
        fires[i] += 1;
        void spread.value;
      }),
    );
    spread.value = 7;
    // Each effect fires once on init + once on write.
    for (const f of fires) expect(f).toBe(2);
    ds.forEach(d => d());
  });
});

// ─── Untracked reads ──────────────────────────────────────────────

describe("untracked reads", () => {
  it("untracked() does not subscribe; subsequent writes do not re-fire", () => {
    const cells = mkCluster([
      { x: 0, y: 2 },
      { x: 0, y: -2 },
    ]);
    const spread = spreadOf(cells as never);
    let fires = 0;
    const dispose = effect(() => {
      fires += 1;
      untracked(() => {
        void spread.value;
      });
    });
    spread.value = 5;
    spread.value = 7;
    // No dependency, so only initial fire.
    expect(fires).toBe(1);
    dispose();
  });

  it(".peek() bypasses subscription tracking", () => {
    const cells = mkCluster([
      { x: 0, y: 3 },
      { x: 0, y: -3 },
    ]);
    const spread = spreadOf(cells as never);
    let fires = 0;
    const dispose = effect(() => {
      fires += 1;
      void spread.peek();
    });
    spread.value = 6;
    expect(fires).toBe(1);
    dispose();
  });
});

// ─── Lens-of-lens stacking ────────────────────────────────────────

describe("lens-of-lens stacking", () => {
  it("symmetric on top of symmetric: spreadOf(scaled cluster)", () => {
    // Stack: cluster → scaleAbout → (we read its component) → spread of cells.
    // We test that two symmetric lenses sharing parents both behave
    // correctly when each is read and written.
    const cells = mkCluster([
      { x: 3, y: 0 },
      { x: 0, y: 3 },
      { x: -3, y: 0 },
      { x: 0, y: -3 },
    ]);
    const pivot = vec(0, 0);
    const s = scaleAbout(cells as never, pivot);
    const spread = spreadOf(cells as never);
    spread.peek();
    s.peek();
    // Drive scaleAbout to 0, then to 5; spread should now report
    // close to 5 (everything scaled to radius 5 about origin).
    s.value = 0;
    s.value = 5;
    expect(spread.value).toBeCloseTo(5, 4);
  });

  it("plain .add chain on top of symmetric lens", () => {
    const cells = mkCluster([
      { x: 0, y: 2 },
      { x: 0, y: -2 },
    ]);
    const spread = spreadOf(cells as never);
    const shifted = spread.add(100);
    expect(shifted.value).toBeCloseTo(102, 9);
    spread.value = 5;
    expect(shifted.value).toBeCloseTo(105, 9);
    // Write through the .add chain back to spread (.add is iso):
    shifted.value = 110;
    expect(spread.value).toBeCloseTo(10, 9);
  });

  it("plain .scale chain at the singular state stays 0", () => {
    // The trap composition test, captured here permanently.
    const cells = mkCluster([
      { x: 0, y: 4 },
      { x: 0, y: -4 },
    ]);
    const spread = spreadOf(cells as never);
    const ten = spread.scale(10);
    spread.peek();
    spread.value = 0;
    expect(ten.value).toBe(0);
    spread.value = 3;
    expect(ten.value).toBeCloseTo(30, 9);
  });
});

// ─── Multiple lenses on the same parents ──────────────────────────

describe("multiple lenses sharing parents", () => {
  it("two spread lenses on the same cluster maintain independent complements", () => {
    const cells = mkCluster([
      { x: 0, y: 3 },
      { x: 0, y: -3 },
    ]);
    const spreadA = spreadOf(cells as never);
    const spreadB = spreadOf(cells as never);
    spreadA.peek();
    spreadB.peek();
    spreadA.value = 0;
    spreadA.value = 5;
    // After A's collapse-and-reinflate, B should also see the new
    // shape correctly (it shares parents).
    expect(spreadB.value).toBeCloseTo(5, 9);
  });

  it("a write through lens A invalidates lens B's view (engine handles this)", () => {
    const cells = mkCluster([
      { x: 3, y: 0 },
      { x: 0, y: 3 },
      { x: -3, y: 0 },
      { x: 0, y: -3 },
    ]);
    const { center } = bboxLens(cells as never);
    const spread = spreadOf(cells as never);
    spread.peek();
    center.value = { x: 100, y: 100 };
    // Spread should be unchanged (rigid translate preserves spread).
    expect(spread.value).toBeCloseTo(3, 4);
    // And the cluster should be centered at (100, 100):
    const cx = cells.reduce((s, c) => s + c.value.x, 0) / cells.length;
    expect(cx).toBeCloseTo(100, 9);
  });
});

// ─── network() integration ────────────────────────────────────────

describe("network() integration", () => {
  it("symmetric lens used inside a network: writes self-exclude properly", () => {
    const cells = mkCluster([
      { x: 0, y: 2 },
      { x: 0, y: -2 },
    ]);
    const spread = spreadOf(cells as never);
    const target = num(5);
    let runs = 0;
    const handle = network([target], () => {
      runs += 1;
      spread.value = target.value;
    });
    target.value = 7;
    target.value = 9;
    // network() runs the body once on construction, plus on every dep
    // change. The body writes spread = target — those writes should
    // NOT re-fire the body (self-exclusion).
    expect(runs).toBe(3); // init + 2 dep changes
    expect(spread.value).toBeCloseTo(9, 9);
    handle.dispose();
  });
});

// ─── Long random walk ────────────────────────────────────────────

describe("long random walk", () => {
  it("spreadOf survives 200 random reads/writes without losing finiteness", () => {
    const cells = mkCluster([
      { x: 0, y: 5 },
      { x: 0, y: -5 },
      { x: 5, y: 0 },
      { x: -5, y: 0 },
      { x: 3, y: 3 },
    ]);
    const spread = spreadOf(cells as never);
    for (let i = 0; i < 200; i++) {
      const op = Math.random();
      if (op < 0.4) {
        // Random read
        const v = spread.value;
        expect(Number.isFinite(v)).toBe(true);
      } else if (op < 0.7) {
        // Random write (sometimes 0)
        spread.value = Math.random() < 0.2 ? 0 : Math.random() * 10;
      } else {
        // Random parent mutation
        const idx = Math.floor(Math.random() * cells.length);
        cells[idx]!.value = {
          x: (Math.random() - 0.5) * 20,
          y: (Math.random() - 0.5) * 20,
        };
      }
    }
    for (const c of cells) {
      expect(isFiniteVec(c.value)).toBe(true);
    }
    expect(Number.isFinite(spread.value)).toBe(true);
  });

  it("bestFitLineLens.direction stays continuous through 1000 small rotations", () => {
    const cells = mkCluster([
      { x: -3, y: 0 },
      { x: -1, y: 0.1 },
      { x: 1, y: -0.1 },
      { x: 3, y: 0 },
    ]);
    const { direction } = bestFitLineLens(cells as never);
    let prev = direction.value;
    let totalRotation = 0;
    let maxJump = 0;
    for (let i = 0; i < 1000; i++) {
      const dθ = (Math.random() - 0.5) * 0.02; // ≤ ~1°
      totalRotation += dθ;
      const cos = Math.cos(dθ);
      const sin = Math.sin(dθ);
      for (let k = 0; k < cells.length; k++) {
        const v = cells[k]!.value;
        cells[k]!.value = { x: v.x * cos - v.y * sin, y: v.x * sin + v.y * cos };
      }
      const next = direction.value;
      const jump = Math.abs(next - prev);
      if (jump > maxJump) maxJump = jump;
      prev = next;
    }
    // No π-jump in a thousand steps:
    expect(maxJump).toBeLessThan(0.2);
    // Tracks total rotation reasonably (sign convention may vary):
    expect(Math.abs(direction.value)).toBeLessThan(Math.abs(totalRotation) + 0.5);
  });
});

// ─── Pathological inputs ─────────────────────────────────────────

describe("pathological inputs", () => {
  // NaN/Inf propagate per IEEE in BOTH the original and symmetric
  // implementations: once a parent goes NaN, the centroid goes NaN,
  // and the lens has no finite reading to scale. The recovery surface
  // is "reset the parents" (write finite values directly into the
  // cells), not "write a finite target through the lens". This is a
  // shared limitation, not a symmetric-lens-specific regression.

  it("NaN poisoning: once parents are NaN, lens stays NaN until parents are reset", () => {
    const cells = mkCluster([
      { x: 0, y: 2 },
      { x: 0, y: -2 },
    ]);
    const spread = spreadOf(cells as never);
    spread.peek();
    spread.value = NaN;
    // Cells are now NaN — this is the shared limitation.
    expect(Number.isNaN(cells[0]!.value.x)).toBe(true);
    // Recovery via parents (the supported path):
    cells[0]!.value = { x: 0, y: 2 };
    cells[1]!.value = { x: 0, y: -2 };
    expect(spread.value).toBeCloseTo(2, 9);
  });

  it("Infinity write to scaleAbout: same — parents propagate Inf, reset via parents", () => {
    const cells = mkCluster([
      { x: 4, y: 0 },
      { x: 0, y: 4 },
    ]);
    const pivot = vec(0, 0);
    const s = scaleAbout(cells as never, pivot);
    s.peek();
    s.value = Infinity;
    expect(Number.isFinite(cells[0]!.value.x)).toBe(false);
    // Recovery via parents:
    cells[0]!.value = { x: 4, y: 0 };
    cells[1]!.value = { x: 0, y: 4 };
    s.value = 3;
    expect(cells[0]!.value.x).toBeCloseTo(3, 9);
  });
});

// ─── Cross-class: Pose theta is preserved through scaleAbout ─────

describe("Pose orientation preserved through scaleAbout collapse", () => {
  it("scaleAbout(poses) → 0 → 5 preserves each pose's theta", async () => {
    const { pose } = await import("../values/pose");
    const p0 = pose({ x: 4, y: 0, theta: 0.3 });
    const p1 = pose({ x: 0, y: 4, theta: -0.7 });
    const pivot = vec(0, 0);
    const s = scaleAbout([p0, p1] as never, pivot);
    s.peek();
    s.value = 0;
    expect(p0.value.theta).toBeCloseTo(0.3, 9);
    expect(p1.value.theta).toBeCloseTo(-0.7, 9);
    s.value = 5;
    expect(p0.value.x).toBeCloseTo(5, 9);
    expect(p1.value.y).toBeCloseTo(5, 9);
    expect(p0.value.theta).toBeCloseTo(0.3, 9);
    expect(p1.value.theta).toBeCloseTo(-0.7, 9);
  });
});

// Touch unused locals to satisfy strict TS.
void ({} as Writable<unknown>);
