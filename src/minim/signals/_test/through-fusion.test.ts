// through-fusion.test.ts — fusion-specific semantics of `.lens()`.
//
// .lens() fuses with a prior .lens() so N consecutive calls
// collapse to one lens cell on one dep-graph node. This file asserts
// the soundness of that fold across reads, writes, intermediates,
// reactive args, equality, and cleanup.

import { describe, expect, it } from "vitest";
import { effect, Num, num, signal } from "../index";

describe(".lens() fusion", () => {
  it("2-deep chain: reads compose correctly", () => {
    const a = num(3);
    const c = a
      .lens(
        v => v * 2,
        v => v / 2,
      )
      .lens(
        v => v + 10,
        v => v - 10,
      );
    expect(c.value).toBe(16); // (3 * 2) + 10
    a.value = 5;
    expect(c.value).toBe(20);
  });

  it("2-deep chain: writes invert in correct order", () => {
    const a = num(0);
    const c = a
      .lens(
        v => v * 2,
        v => v / 2,
      )
      .lens(
        v => v + 10,
        v => v - 10,
      );
    c.value = 50;
    // bwd: (50 - 10) / 2 = 20
    expect(a.value).toBe(20);
  });

  it("4-deep chain: reads & writes both compose", () => {
    const a = num(1);
    const c = a
      .lens(
        v => v + 1,
        v => v - 1,
      )
      .lens(
        v => v * 2,
        v => v / 2,
      )
      .lens(
        v => v - 3,
        v => v + 3,
      )
      .lens(
        v => v * 5,
        v => v / 5,
      );
    // fwd(1) = ((((1+1) * 2) - 3) * 5) = ((4 - 3) * 5) = 5
    expect(c.value).toBe(5);
    c.value = 100;
    // bwd(100) = (((100 / 5) + 3) / 2) - 1 = ((20 + 3) / 2) - 1 = 10.5
    expect(a.value).toBeCloseTo(10.5);
    // forward round-trips back to 100
    expect(c.value).toBe(100);
  });

  it("intermediate lens stays usable after fusion built on top of it", () => {
    const a = num(2);
    const m = a.lens(
      v => v * 3,
      v => v / 3,
    ); // intermediate
    const c = m.lens(
      v => v + 1,
      v => v - 1,
    ); // fused over m
    // Both should read consistent values from a.
    expect(m.value).toBe(6);
    expect(c.value).toBe(7);
    a.value = 4;
    expect(m.value).toBe(12);
    expect(c.value).toBe(13);
  });

  it("write to intermediate propagates to root AND fused sees the update", () => {
    const a = num(1);
    const m = a.lens(
      v => v * 2,
      v => v / 2,
    );
    const c = m.lens(
      v => v + 10,
      v => v - 10,
    );
    m.value = 8; // bwd: 8 / 2 = 4
    expect(a.value).toBe(4);
    expect(c.value).toBe(18); // (4 * 2) + 10
  });

  it("write to fused reaches root without passing through intermediate's setter", () => {
    // Witness: if intermediate had side effects in its setter (which
    // through-lenses *shouldn't* but we install a sentinel anyway),
    // fusion bypasses them. Use a Num.lens (NOT through) to give it
    // a discrete setter we can spy.
    const a = num(0);
    let intermediateSetterCalls = 0;
    const m = Num.lens(
      () => a.value * 2,
      v => {
        intermediateSetterCalls++;
        a.value = v / 2;
      },
    );
    // .lens() on a non-through lens does NOT fuse across the boundary.
    const c = m.lens(
      v => v + 10,
      v => v - 10,
    );
    c.value = 30;
    expect(intermediateSetterCalls).toBe(1); // m.setter ran (no fusion across non-through)
    expect(a.value).toBe(10);

    // Now stack two through() calls on a plain source — these *do* fuse.
    const b = num(0);
    const fused = b
      .lens(
        v => v * 2,
        v => v / 2,
      )
      .lens(
        v => v + 10,
        v => v - 10,
      );
    fused.value = 30;
    expect(b.value).toBe(10); // direct write to b, no intermediate cell allocated
  });

  it("reactive args in fwd/bwd: closures track signal deps across fusion", () => {
    const a = num(1);
    const k = signal(2);
    const off = signal(10);
    const c = a
      .lens(
        v => v * k.value,
        v => v / k.value,
      )
      .lens(
        v => v + off.value,
        v => v - off.value,
      );
    expect(c.value).toBe(12); // 1 * 2 + 10
    k.value = 5;
    expect(c.value).toBe(15); // 1 * 5 + 10
    off.value = 100;
    expect(c.value).toBe(105);
  });

  it("effect on fused fires when root changes via fusion path", () => {
    const a = num(1);
    const c = a
      .lens(
        v => v * 2,
        v => v / 2,
      )
      .lens(
        v => v + 1,
        v => v - 1,
      );
    const observed: number[] = [];
    const stop = effect(() => {
      observed.push(c.value);
    });
    expect(observed).toEqual([3]); // initial: (1*2)+1
    a.value = 5;
    expect(observed).toEqual([3, 11]); // (5*2)+1
    a.value = 10;
    expect(observed).toEqual([3, 11, 21]);
    stop();
  });

  it("equality on fused output prevents redundant downstream fires", () => {
    // sin is non-injective: sin(0) = sin(π). Fused fwd that ends in
    // sin should not fire when root changes from a value mapping to
    // sin(x) = 0 to another value mapping to the same 0 — modulo
    // floating-point.
    const a = num(0);
    const c = a
      .lens(
        v => v * Math.PI,
        v => v / Math.PI,
      )
      .lens(
        v => Math.round(Math.sin(v) * 1e9) / 1e9,
        v => Math.asin(v) || 0,
      );
    let fires = 0;
    const stop = effect(() => {
      void c.value;
      fires++;
    });
    expect(fires).toBe(1);
    a.value = 0; // same root, no-op write at root level
    expect(fires).toBe(1);
    a.value = 1; // a*π = π, sin(π) ≈ 0 — same as before
    expect(fires).toBe(1);
    a.value = 0.5; // sin(π/2) = 1
    expect(fires).toBe(2);
    stop();
  });

  it("intermediate's getter not called when only fused is read", () => {
    // Hard to assert directly (the getter is private), so we use a
    // user-visible side channel: a counter in the intermediate's fwd
    // closure. After fusion, the user's intermediate fwd should NOT
    // run on reads of the fused.
    let intermediateFwdCalls = 0;
    const a = num(2);
    const m = a.lens(
      v => {
        intermediateFwdCalls++;
        return v * 2;
      },
      v => v / 2,
    );
    intermediateFwdCalls = 0;
    const c = m.lens(
      v => v + 1,
      v => v - 1,
    );
    intermediateFwdCalls = 0; // reset after construction (fusion captures the closure)

    // Reading c invokes the FUSED closure, which still calls
    // intermediate fwd (because the composed fwd is `v => (v*2)+1`
    // built by capturing the intermediate fwd reference). This is the
    // expected behavior — the intermediate's user-supplied fwd IS
    // part of the composition; what gets bypassed is the intermediate
    // CELL's dep graph node + the engine's per-level work.
    expect(c.value).toBe(5);
    expect(intermediateFwdCalls).toBe(1); // intermediate fwd participates in the fused getter

    // The win isn't "intermediate fwd skipped" — it's "intermediate
    // cell skipped". Witness: reading c does NOT add m to the dep
    // graph (m doesn't gain a subscriber from c's read).
    const subsBefore = (m as unknown as { subs: unknown }).subs;
    void c.value;
    void c.value;
    void c.value;
    const subsAfter = (m as unknown as { subs: unknown }).subs;
    expect(subsBefore).toBe(subsAfter); // m's sub list unchanged
  });

  it("fused lens cleans up its dep on root after _unwatched", () => {
    const a = num(0);
    const c = a
      .lens(
        v => v * 2,
        v => v / 2,
      )
      .lens(
        v => v + 1,
        v => v - 1,
      );
    const stop = effect(() => {
      void c.value;
    });
    // a should have a subscriber (the fused lens, transitively the effect).
    expect((a as unknown as { subs: unknown }).subs).not.toBeUndefined();
    stop();
    // After effect disposes, the fused lens unwatches, its dep on a is purged.
    expect((a as unknown as { subs: unknown }).subs).toBeUndefined();
  });

  it("fusion preserves class identity (Num.lens → Num)", () => {
    const a = num(0);
    const c = a
      .lens(
        v => v + 1,
        v => v - 1,
      )
      .lens(
        v => v * 2,
        v => v / 2,
      );
    expect(c).toBeInstanceOf(Num);
  });

  it("fusion does NOT cross non-through boundaries (manual lens)", () => {
    // A manual Num.lens is not tagged with _fusedOf, so a subsequent
    // .lens() starts a fresh fusion-chain over the manual lens.
    const a = num(0);
    const manual = Num.lens(
      () => a.value * 2,
      v => {
        a.value = v / 2;
      },
    );
    const c = manual.lens(
      v => v + 1,
      v => v - 1,
    );
    a.value = 5;
    expect(c.value).toBe(11); // (5*2)+1
    c.value = 21;
    // bwd: (21-1) = 20 → manual.setter(20) → a = 20/2 = 10
    expect(a.value).toBe(10);
  });

  it("fusion across many siblings on the same root: independent", () => {
    const a = num(2);
    const c1 = a
      .lens(
        v => v + 1,
        v => v - 1,
      )
      .lens(
        v => v * 10,
        v => v / 10,
      );
    const c2 = a
      .lens(
        v => v * 5,
        v => v / 5,
      )
      .lens(
        v => v - 3,
        v => v + 3,
      );
    expect(c1.value).toBe(30); // (2+1)*10
    expect(c2.value).toBe(7); // (2*5)-3
    c1.value = 100;
    // bwd: 100/10 = 10, then 10-1 = 9
    expect(a.value).toBe(9);
    // c2 reads new a: (9*5)-3 = 42
    expect(c2.value).toBe(42);
  });

  it("write-then-read round-trip on deeply fused chain is exact", () => {
    const a = num(0);
    const c = a
      .lens(
        v => v + 7,
        v => v - 7,
      )
      .lens(
        v => v * 3,
        v => v / 3,
      )
      .lens(
        v => v - 11,
        v => v + 11,
      );
    for (const target of [0, 1, -50, 99.5, 1e6, -1e-6]) {
      c.value = target;
      expect(c.value).toBeCloseTo(target, 9);
    }
  });

  it("idempotent projection through fusion (clamp ∘ clamp = clamp)", () => {
    // .clamp uses .lens internally; clamp twice should still be
    // PutGet-compliant.
    const a = num(0);
    const c = a.clamp(0, 10).clamp(2, 8);
    c.value = 5;
    expect(a.value).toBe(5);
    c.value = 15;
    // outer clamp(2,8) clamps 15 → 8, then inner clamp(0,10) clamps 8 → 8
    expect(a.value).toBe(8);
    c.value = -3;
    expect(a.value).toBe(2);
    // Read: a=2 → inner clamp(0,10)(2)=2 → outer clamp(2,8)(2)=2.
    expect(c.value).toBe(2);
  });
});

// ─── Cross-product: non-Iso layers stacked under fusion ────────────────
//
// Reference implementations build the equivalent unfused chain via
// `Num.lens(getter, setter)` (which Signal.install's, no `_fusedOf` tag,
// so subsequent layers don't fuse across it — see "fusion does NOT cross
// non-through boundaries"). We then walk identical write sequences on
// both the fused chain and the unfused stack and assert root/view agree
// to floating-point tolerance after every step.
//
// The point is to catch a real bug if cyclic's `bwdStateless: true` lie
// (cyclic uses .lens which hardcodes stateless, but cyclic's bwd
// reads `this.peek()`) causes any divergence when stacked with
// Projection or Iso layers. Spoiler from code-trace analysis: it
// doesn't — the captured `this` is the receiver cell, which stays
// fresh via the dep graph — but this is the test that would catch it
// if it ever started lying.

const TAU = 2 * Math.PI;
const wrapDelta = (delta: number, period: number): number =>
  delta - period * Math.round(delta / period);
const clampFn = (lo: number, hi: number) => (v: number) => (v < lo ? lo : v > hi ? hi : v);
const quantizeFn = (step: number) => (v: number) => Math.round(v / step) * step;

describe(".lens() fusion: non-Iso compositions match unfused reference", () => {
  it("scale then cyclic (Iso then Stateful): fused ≡ unfused", () => {
    const a1 = num(0);
    const fused = a1.scale(2).cyclic(TAU);

    const a2 = num(0);
    const scaleRef = Num.lens(
      () => a2.value * 2,
      v => {
        a2.value = v / 2;
      },
    );
    const cyclicRef = Num.lens(
      () => scaleRef.value,
      v => {
        const cur = scaleRef.peek();
        scaleRef.value = cur + wrapDelta(v - cur, TAU);
      },
    );

    for (const target of [5, 0, -3, 100, 0.5, 12.6, -50, 0.001]) {
      fused.value = target;
      cyclicRef.value = target;
      expect(a1.value).toBeCloseTo(a2.value, 9);
      expect(fused.value).toBeCloseTo(cyclicRef.value, 9);
    }
  });

  it("cyclic then scale (Stateful then Iso): fused ≡ unfused", () => {
    const a1 = num(0);
    const fused = a1.cyclic(TAU).scale(2);

    const a2 = num(0);
    const cyclicRef = Num.lens(
      () => a2.value,
      v => {
        const cur = a2.peek();
        a2.value = cur + wrapDelta(v - cur, TAU);
      },
    );
    const scaleRef = Num.lens(
      () => cyclicRef.value * 2,
      v => {
        cyclicRef.value = v / 2;
      },
    );

    for (const target of [5, 0, -3, 100, 0.5, 12.6, -50, 0.001]) {
      fused.value = target;
      scaleRef.value = target;
      expect(a1.value).toBeCloseTo(a2.value, 9);
      expect(fused.value).toBeCloseTo(scaleRef.value, 9);
    }
  });

  it("clamp then cyclic (Projection then Stateful): fused ≡ unfused", () => {
    const a1 = num(100); // out of clamp range
    const fused = a1.clamp(0, 10).cyclic(TAU);

    const a2 = num(100);
    const clampRef = Num.lens(
      () => clampFn(0, 10)(a2.value),
      v => {
        a2.value = clampFn(0, 10)(v);
      },
    );
    const cyclicRef = Num.lens(
      () => clampRef.value,
      v => {
        const cur = clampRef.peek();
        clampRef.value = cur + wrapDelta(v - cur, TAU);
      },
    );

    for (const target of [0.5, 5, 15, -3, 100, 12.6]) {
      fused.value = target;
      cyclicRef.value = target;
      expect(a1.value).toBeCloseTo(a2.value, 9);
      expect(fused.value).toBeCloseTo(cyclicRef.value, 9);
    }
  });

  it("cyclic then clamp (Stateful then Projection): fused ≡ unfused", () => {
    const a1 = num(0);
    const fused = a1.cyclic(TAU).clamp(0, Math.PI);

    const a2 = num(0);
    const cyclicRef = Num.lens(
      () => a2.value,
      v => {
        const cur = a2.peek();
        a2.value = cur + wrapDelta(v - cur, TAU);
      },
    );
    const clampRef = Num.lens(
      () => clampFn(0, Math.PI)(cyclicRef.value),
      v => {
        cyclicRef.value = clampFn(0, Math.PI)(v);
      },
    );

    for (const target of [0.5, 5, -3, 100, 12.6, Math.PI / 2]) {
      fused.value = target;
      clampRef.value = target;
      expect(a1.value).toBeCloseTo(a2.value, 9);
      expect(fused.value).toBeCloseTo(clampRef.value, 9);
    }
  });

  it("scale.cyclic.clamp (3-layer Iso/Stateful/Projection): fused ≡ unfused", () => {
    const a1 = num(0);
    const fused = a1.scale(2).cyclic(TAU).clamp(0, 5);

    const a2 = num(0);
    const scaleRef = Num.lens(
      () => a2.value * 2,
      v => {
        a2.value = v / 2;
      },
    );
    const cyclicRef = Num.lens(
      () => scaleRef.value,
      v => {
        const cur = scaleRef.peek();
        scaleRef.value = cur + wrapDelta(v - cur, TAU);
      },
    );
    const clampRef = Num.lens(
      () => clampFn(0, 5)(cyclicRef.value),
      v => {
        cyclicRef.value = clampFn(0, 5)(v);
      },
    );

    for (const target of [3, 0, -2, 8, 100, 0.5]) {
      fused.value = target;
      clampRef.value = target;
      expect(a1.value).toBeCloseTo(a2.value, 9);
      expect(fused.value).toBeCloseTo(clampRef.value, 9);
    }
  });

  it("cyclic.cyclic (Stateful.Stateful): fused ≡ unfused", () => {
    const a1 = num(0);
    const fused = a1.cyclic(TAU).cyclic(Math.PI);

    const a2 = num(0);
    const outer = Num.lens(
      () => a2.value,
      v => {
        const cur = a2.peek();
        a2.value = cur + wrapDelta(v - cur, TAU);
      },
    );
    const inner = Num.lens(
      () => outer.value,
      v => {
        const cur = outer.peek();
        outer.value = cur + wrapDelta(v - cur, Math.PI);
      },
    );

    for (const target of [0.5, 5, -3, 12.6, 100, 0.001]) {
      fused.value = target;
      inner.value = target;
      expect(a1.value).toBeCloseTo(a2.value, 9);
      expect(fused.value).toBeCloseTo(inner.value, 9);
    }
  });

  it("quantize.quantize (Projection.Projection): fused ≡ unfused", () => {
    const a1 = num(0);
    const fused = a1.quantize(0.25).quantize(0.5);

    const a2 = num(0);
    const q025 = Num.lens(
      () => quantizeFn(0.25)(a2.value),
      v => {
        a2.value = quantizeFn(0.25)(v);
      },
    );
    const q05 = Num.lens(
      () => quantizeFn(0.5)(q025.value),
      v => {
        q025.value = quantizeFn(0.5)(v);
      },
    );

    for (const target of [0.6, 0.62, 0.88, -0.7, 3.14, 5]) {
      fused.value = target;
      q05.value = target;
      expect(a1.value).toBeCloseTo(a2.value, 9);
      expect(fused.value).toBeCloseTo(q05.value, 9);
    }
  });

  it("cyclic PutGet-within-range with non-Iso below (stale-receiver witness)", () => {
    // The specific failure mode the chat's analysis predicts:
    //   write a value within ±period/2 of current → read it back exactly
    //   (modulo wrap). If cyclic's `this.peek()` were reading stale
    //   data after a write through the fused setter, the *next* write
    //   would compute `cur` against a stale reference and the
    //   accumulated angle would drift away from the visible target.
    //
    // Walk a sequence of small deltas and check that the visible angle
    // (mod period) stays at the most recently written value.
    const a = num(0);
    const c = a.scale(2).cyclic(TAU);
    const targets = [0.1, 0.2, 0.15, -0.05, 1.0, 0.7, -0.3, 0.0];
    for (const t of targets) {
      c.value = t;
      // Read back through composed fwd; mod TAU because cyclic.
      const view = c.value;
      const wrapped = wrapDelta(view - t, TAU);
      expect(Math.abs(wrapped)).toBeLessThan(1e-9);
    }
  });

  it("external writes to root keep stateful-receiver fresh: fused ≡ unfused", () => {
    // Exercises the dep-graph link from intermediate cell to root: if
    // the intermediate weren't subscribed, an external write to root
    // wouldn't mark it Pending, and cyclic's `this.peek()` would
    // return stale on the next fused write — diverging from the
    // unfused reference.
    const a1 = num(0);
    const fused = a1.scale(2).cyclic(TAU);

    const a2 = num(0);
    const scaleRef = Num.lens(
      () => a2.value * 2,
      v => {
        a2.value = v / 2;
      },
    );
    const cyclicRef = Num.lens(
      () => scaleRef.value,
      v => {
        const cur = scaleRef.peek();
        scaleRef.value = cur + wrapDelta(v - cur, TAU);
      },
    );

    // Prime so the fused intermediate's getter runs and links to root.
    fused.value = 0.5;
    cyclicRef.value = 0.5;
    expect(a1.value).toBeCloseTo(a2.value, 9);

    // Interleave external root writes with fused writes.
    for (const [rootBump, target] of [
      [10 * TAU, 0.5],
      [-3 * TAU, 1.2],
      [50, -0.4],
      [-100, 0.0],
    ] as const) {
      a1.value = a1.value + rootBump;
      a2.value = a2.value + rootBump;
      fused.value = target;
      cyclicRef.value = target;
      expect(a1.value).toBeCloseTo(a2.value, 9);
      expect(fused.value).toBeCloseTo(cyclicRef.value, 9);
    }
  });
});
