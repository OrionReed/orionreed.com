// anim.test.ts — animator primitives + nominal trait constraints.
//
// Two things to verify:
//   1. The runtime math still works (spring settles, tween reaches target,
//      etc.) — same as prod.
//   2. The type-level constraints reject signals whose class lacks the
//      required trait (compile-time only; see `_typeOnlyProbe`).
//
// Run:
//   npx vitest run src/minim/_proto-r2/anim.test.ts

import { describe, it, expect } from "vitest";
import { signal, batch, effect } from "./signal";
import { num } from "./values/num";
import { vec } from "./values/vec";
import { box } from "./values/box";
import { spring, tween, toward, attract } from "./anim";
import {
  drive, type Tick, type Animator,
} from "../core";

/** Drive an animator to completion against a synthetic clock. */
function play(g: Animator<void>, opts: { dtMs?: number; maxFrames?: number } = {}): number {
  const dtMs = opts.dtMs ?? 16.67;
  const maxFrames = opts.maxFrames ?? 1000;
  let elapsed = 0;
  let frames = 0;
  for (; frames < maxFrames; frames++) {
    elapsed += dtMs;
    const tick: Tick = { dt: dtMs / 1000, elapsed: elapsed / 1000 };
    const r = g.next(tick);
    if (r.done) break;
  }
  return frames;
}

// We need a top-level driver that runs `drive(step)` against synthetic
// ticks. `drive` itself yields and expects a Tick back via .next(tick).
// Wrap that in a self-driving generator.
function* runDriver<R>(inner: Animator<R>): Animator<R> {
  return yield* inner;
}

describe("anim: spring", () => {
  it("settles to scalar target", () => {
    const n = num(0);
    const g = runDriver(spring(n, 10, { omega: 30, zeta: 1, precision: 1e-3 }));
    const frames = play(g);
    expect(n.value).toBeCloseTo(10, 3);
    expect(frames).toBeLessThan(500);
  });

  it("settles to vec target", () => {
    const v = vec(0, 0);
    const g = runDriver(spring(v, { x: 5, y: 5 }, { omega: 30, zeta: 1, precision: 1e-3 }));
    play(g);
    expect(v.value.x).toBeCloseTo(5, 2);
    expect(v.value.y).toBeCloseTo(5, 2);
  });

  it("reactive target — sampled per frame", () => {
    const n = num(0);
    const tgt = num(5);
    const g = runDriver(spring(n, tgt, { omega: 50, zeta: 1, precision: 1e-3 }));
    play(g, { maxFrames: 500 });
    expect(n.value).toBeCloseTo(5, 2);
  });
});

describe("anim: tween", () => {
  it("reaches target on time", () => {
    const n = num(0);
    const g = runDriver(tween(n, 10, 0.5));  // 500 ms
    const frames = play(g);
    expect(n.value).toBe(10);
    expect(frames).toBeGreaterThan(20);
    expect(frames).toBeLessThan(40);
  });

  it("vec tween", () => {
    const v = vec(0, 0);
    const g = runDriver(tween(v, { x: 100, y: 50 }, 0.5));
    play(g);
    expect(v.value).toEqual({ x: 100, y: 50 });
  });
});

describe("anim: toward", () => {
  it("constant-speed approach reaches target", () => {
    const n = num(0);
    const g = runDriver(toward(n, 1, 10)); // 10 u/s → ~100 ms
    play(g, { maxFrames: 30 });
    expect(n.value).toBe(1);
  });
});

describe("anim: attract", () => {
  it("exponentially approaches but doesn't overshoot", () => {
    const n = num(0);
    const g = runDriver(attract(n, 100, 5));
    // Run 1 second of frames (~60 frames)
    for (let i = 0; i < 60; i++) {
      const tick: Tick = { dt: 1 / 60, elapsed: i / 60 };
      const r = g.next(tick);
      expect(n.value).toBeLessThanOrEqual(100);
      if (r.done) break;
    }
    expect(n.value).toBeGreaterThan(95);
  });
});

// ─── Type-only constraint probe ─────────────────────────────────────
// These calls never execute; they exist for `@ts-expect-error` to fail
// the build if the constraint regresses.
function _typeOnlyProbe(): void {
  if (Math.random() < -1) {
    // ✓ Vec & Num both implement Linear + Metric → spring accepts them
    spring(vec(0, 0), { x: 1, y: 1 });
    spring(num(0), 1);

    // ✓ Vec implements Lerp → tween accepts
    tween(vec(0, 0), { x: 1, y: 1 }, 0.3);

    // ✗ Box has linear + lerp + equals but NOT metric → spring rejects
    // @ts-expect-error
    spring(box(0, 0, 1, 1), { x: 0, y: 0, w: 1, h: 1 });

    // ✗ Plain signal has no traits dict → spring rejects
    // @ts-expect-error
    spring(signal(0), 1);

    // ✗ Plain signal has no traits dict → tween rejects
    // @ts-expect-error
    tween(signal(0), 1, 0.3);

    // ✓ attract only needs Linear → Box accepts
    attract(box(0, 0, 1, 1), { x: 1, y: 1, w: 1, h: 1 });
  }
}
void _typeOnlyProbe;
void batch; void effect;  // imports used by other tests in same file in the future
