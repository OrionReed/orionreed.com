// memo.test.ts — exploring the "stateful lens" (formerly `symmetric`/
// complement) WITHOUT a bespoke engine kind and WITHOUT an idempotence
// requirement on any user function.
//
// Thesis: a lens that must remember information the source can destroy
// (the `spreadOf` → 0 collapse in md-traits-cross-domain) decomposes into
//   (1) a PURE lens (forward is a pure projection ⇒ fully equality-checked), and
//   (2) an eager `hold` — a scan node (value evolves from its own previous
//       value + reactive inputs), built from `signal` + `effect`.
//
// The memory lives in (2). It is read-only to the outside, refreshed once
// per input change (glitch-free ⇒ no idempotence burden on `step`), and
// always fresh at read time. The lens's `put` consults it; nothing the
// engine does speculatively can corrupt it.
//
// These tests pin the guarantees we care about:
//   • degeneracy memory     — collapse to 0 then reinflate restores geometry
//   • eager freshness        — memory tracks the LATEST valid state, not a stale one
//   • no over-firing         — one downstream fire per settle
//   • step called once/change — no idempotence required

import { describe, expect, it, vi } from "vitest";
import { batch, effect, hold, lens, signal } from "../index";

// `hold` is the engine helper: an eager scan from signal + effect.
// `step(observed, prev)` — `prev` is `undefined` on the first run. Runs
// once per input change (effects are glitch-free), so `step` may be a
// plain accumulator; it is never re-run within a settle.

// ── A "spread" lens over 3 scalar sources. ──────────────────────────
// view = ‖deviations from mean‖. Backward: place each source at
// mean + spread · unitDeviation. At spread 0 the unit deviations are
// undefined (0/0), so they're remembered in a `hold`.
const mean3 = (v: readonly number[]) => (v[0]! + v[1]! + v[2]!) / 3;
const devs3 = (v: readonly number[]) => {
  const m = mean3(v);
  return [v[0]! - m, v[1]! - m, v[2]! - m];
};
const norm3 = (d: readonly number[]) => Math.hypot(d[0]!, d[1]!, d[2]!);

interface Scene {
  a: ReturnType<typeof signal<number>>;
  b: ReturnType<typeof signal<number>>;
  c: ReturnType<typeof signal<number>>;
  spread: { value: number };
  steps: () => number;
}

function scene(a0: number, b0: number, c0: number): Scene {
  const a = signal(a0);
  const b = signal(b0);
  const c = signal(c0);
  let steps = 0;

  const units = hold<number[], number[]>(
    () => [a.value, b.value, c.value],
    (v, prev) => {
      steps++;
      const d = devs3(v);
      const s = norm3(d);
      // Refresh while non-degenerate; otherwise RETAIN the last valid.
      return s > 1e-9 ? [d[0]! / s, d[1]! / s, d[2]! / s] : (prev ?? d);
    },
  );

  const spread = lens(
    [a, b, c] as const,
    (v) => norm3(devs3(v as number[])),
    (s, v) => {
      const m = mean3(v as number[]);
      const u = units.value;
      const t = s as number;
      return [m + t * u[0]!, m + t * u[1]!, m + t * u[2]!];
    },
  );

  return { a, b, c, spread: spread as { value: number }, steps: () => steps };
}

const SQRT2 = Math.SQRT2;

describe("stateful lens via pure-lens + hold (no engine kind, no idempotence)", () => {
  it("forward spread is the deviation norm", () => {
    const s = scene(1, 2, 3);
    expect(s.spread.value).toBeCloseTo(SQRT2, 9); // ‖[-1,0,1]‖
  });

  it("DEGENERACY MEMORY: collapse to 0 then reinflate restores geometry", () => {
    const s = scene(1, 2, 3);
    void s.spread.value;

    s.spread.value = 0; // collapse — directions destroyed in the sources
    expect(s.a.value).toBeCloseTo(2, 9);
    expect(s.b.value).toBeCloseTo(2, 9);
    expect(s.c.value).toBeCloseTo(2, 9);
    expect(s.spread.value).toBeCloseTo(0, 9);

    s.spread.value = SQRT2; // reinflate — memory restores the original shape
    expect(s.a.value).toBeCloseTo(1, 9);
    expect(s.b.value).toBeCloseTo(2, 9);
    expect(s.c.value).toBeCloseTo(3, 9);
  });

  it("EAGER FRESHNESS: memory tracks the LATEST valid geometry, not a stale one", () => {
    const s = scene(1, 2, 3);
    void s.spread.value;

    // Change a source directly (forward). The hold must capture the NEW
    // geometry eagerly, before any collapse.
    s.a.value = 0; // sources now [0, 2, 3]
    const spreadAfter = s.spread.value;

    s.spread.value = 0; // collapse
    s.spread.value = spreadAfter; // reinflate to the post-edit spread

    expect(s.a.value).toBeCloseTo(0, 9); // restores [0,2,3], not [1,2,3]
    expect(s.b.value).toBeCloseTo(2, 9);
    expect(s.c.value).toBeCloseTo(3, 9);
  });

  it("NO OVER-FIRING: one downstream fire per settle", () => {
    const s = scene(1, 2, 3);
    const fn = vi.fn(() => void s.spread.value);
    effect(fn);
    expect(fn).toHaveBeenCalledTimes(1);

    s.spread.value = 0; // one settle
    expect(fn).toHaveBeenCalledTimes(2);

    s.spread.value = SQRT2; // one settle
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("PURE FORWARD: rewriting the current spread fires nothing (source check)", () => {
    const s = scene(1, 2, 3);
    void s.spread.value;
    const fn = vi.fn(() => {
      void s.a.value;
      void s.b.value;
      void s.c.value;
    });
    effect(fn);
    expect(fn).toHaveBeenCalledTimes(1);

    s.spread.value = SQRT2; // put reproduces [1,2,3] ⇒ per-source no-op
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("NO IDEMPOTENCE NEEDED: hold's step runs exactly once per input change", () => {
    const s = scene(1, 2, 3);
    const base = s.steps(); // construction run(s)
    void s.spread.value;

    s.a.value = 5; // one input change
    const afterOne = s.steps();
    expect(afterOne).toBe(base + 1); // exactly one step, not 2+

    s.spread.value = 0; // backward write → sources change once → one step
    expect(s.steps()).toBe(afterOne + 1);
  });
});

describe("edges: when is the memory read / when is it stale", () => {
  it("UNOBSERVED memory still works — hold is eager, independent of the view", () => {
    // Never read `spread` (the lens/view is unobserved). The hold's own
    // effect keeps the memory live regardless.
    const s = scene(1, 2, 3);
    s.a.value = 0; // [0,2,3] — captured by the eager hold even though
    //                          nothing observes the spread lens
    const sp = s.spread.value; // first read happens only now
    s.spread.value = 0;
    s.spread.value = sp;
    expect(s.a.value).toBeCloseTo(0, 9);
    expect(s.c.value).toBeCloseTo(3, 9);
  });

  it("BATCH consistency — cascade reads committed (pre-batch) state via peek", () => {
    // Writing an input AND the view in one batch: the backward cascade
    // peeks COMMITTED values (pre-batch), so the memory it reads is
    // consistent with the sources it reads — no half-updated tearing.
    // (Both writes target the sources; last-write-wins on overlap, which
    //  is the inherent semantics of two writes to one cell in a batch.)
    const s = scene(1, 2, 3);
    void s.spread.value;
    expect(() =>
      batch(() => {
        s.b.value = 10; // forward write to a source
        s.spread.value = SQRT2; // backward write through the lens
      }),
    ).not.toThrow();
    // Whatever the resolution, the system stays consistent and settles:
    // re-reading spread reflects the committed sources.
    expect(s.spread.value).toBeCloseTo(norm3(devs3([s.a.value, s.b.value, s.c.value])), 9);
  });
});
