// _proto-exp/realistic.bench.test.ts — realistic-workload comparison.
//
// Synthetic loops measure isolated paths. This bench simulates a
// scene-like workload: N bodies, each with (position: Vec, velocity:
// Num angular), per-frame writes to angle, derived position via
// trig, effects that read the positions (simulating render).
//
// We bench against:
//   - current Signal engine (Vec / num as today)
//   - Src/Der engine (Source<number> + Derived<{x,y}> wired manually)
//
// The question: does the 30%+ derived-path win show up at workload
// scale, or do other costs dominate?

import { describe, it } from "vitest";
import { signal as sigSignal, computed as sigComputed, effect as sigEffect } from "../signal";
import { source as c2Source, computed as c2Computed, effect as c2Effect, lens as c2Lens } from "../_proto-cell2/cell2";

const N_BODIES = 200;
const N_FRAMES = 1_000;

function timed(label: string, fn: () => void): void {
  // warm + steady-state, take min of 5
  fn(); fn();
  const times: number[] = [];
  for (let r = 0; r < 5; r++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  const min = Math.min(...times);
  const perFrame = min / N_FRAMES;
  // eslint-disable-next-line no-console
  console.info(
    `  ${label.padEnd(50)}  min ${min.toFixed(1).padStart(7)}ms  (${perFrame.toFixed(3)}ms/frame, ${(perFrame * 1000).toFixed(2)}µs/body/frame)`,
  );
}

describe("realistic: N-body orbit simulation", () => {
  it("Signal vs Src/Der engine — same workload", () => {
    // ── Signal engine setup ──
    const sigAngles = Array.from({ length: N_BODIES }, () => sigSignal(0));
    const sigVelocities = Array.from({ length: N_BODIES }, (_, i) => 0.01 + i * 0.0001);
    const sigPositions = sigAngles.map((a, i) => {
      const r = 50 + i;
      return sigComputed(() => ({
        x: r * Math.cos(a.value),
        y: r * Math.sin(a.value),
      }));
    });
    let sigSink = 0;
    for (const p of sigPositions) {
      sigEffect(() => { sigSink += p.value.x + p.value.y });
    }
    sigSink = 0;

    // ── Src/Der engine setup ──
    const c2Angles = Array.from({ length: N_BODIES }, () => c2Source(0));
    const c2Velocities = Array.from({ length: N_BODIES }, (_, i) => 0.01 + i * 0.0001);
    const c2Positions = c2Angles.map((a, i) => {
      const r = 50 + i;
      return c2Computed(() => ({
        x: r * Math.cos(a.value),
        y: r * Math.sin(a.value),
      }));
    });
    let c2Sink = 0;
    for (const p of c2Positions) {
      c2Effect(() => { c2Sink += p.value.x + p.value.y });
    }
    c2Sink = 0;

    timed(`[Signal]  ${N_BODIES} bodies × ${N_FRAMES} frames (angle write → pos read → effect)`, () => {
      for (let f = 0; f < N_FRAMES; f++) {
        for (let i = 0; i < N_BODIES; i++) {
          sigAngles[i].value = sigAngles[i].peek() + sigVelocities[i];
        }
      }
    });
    timed(`[Src/Der] ${N_BODIES} bodies × ${N_FRAMES} frames (angle write → pos read → effect)`, () => {
      for (let f = 0; f < N_FRAMES; f++) {
        for (let i = 0; i < N_BODIES; i++) {
          c2Angles[i].value = c2Angles[i].peek() + c2Velocities[i];
        }
      }
    });
  });
});

describe("realistic: per-frame chain (long derived chain per body)", () => {
  it("Signal vs Src/Der — 4-deep derived chain × N bodies × M frames", () => {
    const M = 500;

    // Signal: chain of 4 computeds per body
    const sigSources = Array.from({ length: N_BODIES }, () => sigSignal(0));
    const sigChains = sigSources.map((s) => {
      const a = sigComputed(() => s.value * 2);
      const b = sigComputed(() => a.value + 1);
      const c = sigComputed(() => b.value * 3);
      const d = sigComputed(() => c.value - 5);
      return d;
    });
    let sigAcc = 0;
    for (const c of sigChains) sigEffect(() => { sigAcc += c.value });
    sigAcc = 0;

    // Src/Der: same chain
    const c2Sources = Array.from({ length: N_BODIES }, () => c2Source(0));
    const c2Chains = c2Sources.map((s) => {
      const a = c2Computed(() => s.value * 2);
      const b = c2Computed(() => a.value + 1);
      const c = c2Computed(() => b.value * 3);
      const d = c2Computed(() => c.value - 5);
      return d;
    });
    let c2Acc = 0;
    for (const c of c2Chains) c2Effect(() => { c2Acc += c.value });
    c2Acc = 0;

    timed(`[Signal]  ${N_BODIES} × 4-deep chain × ${M} frames`, () => {
      for (let f = 0; f < M; f++) for (let i = 0; i < N_BODIES; i++) sigSources[i].value = f;
    });
    timed(`[Src/Der] ${N_BODIES} × 4-deep chain × ${M} frames`, () => {
      for (let f = 0; f < M; f++) for (let i = 0; i < N_BODIES; i++) c2Sources[i].value = f;
    });
  });
});

describe("realistic: drag scenario (storm of writes through invertible lens)", () => {
  it("Signal vs Src/Der — write storm through a 3-deep lens chain", async () => {
    const M = 50_000;

    // Signal: source → lens(*2) → lens(+10) → lens(*3) via raw lens API
    // (so we're comparing engine-level lens chains, not the Num value
    //  class which would add through-fusion).
    const sigSrc = sigSignal(0);
    const { lens: sigLensFn } = await import("../signal");
    const sa = sigLensFn(() => sigSrc.value * 2, v => { sigSrc.value = v / 2 });
    const sb = sigLensFn(() => sa.value + 10, v => { sa.value = v - 10 });
    const sigLens = sigLensFn(() => sb.value * 3, v => { sb.value = v / 3 });

    // Src/Der: 3-deep manual lens chain (no fusion in the bare engine).
    const c2Src = c2Source(0);
    const a = c2Lens(() => c2Src.value * 2, v => { c2Src.value = v / 2 });
    const b = c2Lens(() => a.value + 10, v => { a.value = v - 10 });
    const c = c2Lens(() => b.value * 3, v => { b.value = v / 3 });

    timed(`[Signal]  ${M} writes through fused .scale.add.scale lens`, () => {
      for (let i = 0; i < M; i++) sigLens.value = i;
    });
    timed(`[Src/Der] ${M} writes through 3-deep nested lens`, () => {
      for (let i = 0; i < M; i++) c.value = i;
    });
  });
});
