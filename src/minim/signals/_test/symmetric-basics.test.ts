// Stateful-lens foundations.
//
// These cover:
//   - Initial-complement behavior (init).
//   - Trip through step (complement refresh on read).
//   - bwd using the complement to recover discarded info / make write
//     decisions (monotonic snap).
//   - The headline trap scenario: a scale-to-zero round trip that would
//     destroy directions under a plain lens, but is recoverable here
//     because the unit deviations live in the complement.

import { describe, expect, it } from "vitest";
import { cell, effect, lens } from "../index";
import { Num, num } from "../values/num";
import { vec } from "../values/vec";

describe("stateful lens — single input, identity-ish", () => {
  it("init complement is used for the first read", () => {
    const src = num(7);
    let seenComplement: number | null = null;
    const view = Num.lens([src], {
      init: () => ({ v: -1 }),
      step: ([_s], c) => {
        seenComplement = c.v;
        return { v: c.v + 1 };
      },
      fwd: ([s]) => s,
      bwd: (t, _s, c) => ({ updates: [t], complement: c }),
    });
    expect(view.value).toBe(7);
    expect(seenComplement).toBe(-1);
  });

  it("step refreshes the complement on each (dirtying) read", () => {
    const src = num(10);
    let calls = 0;
    const view = Num.lens([src], {
      init: () => ({ v: 0 }),
      step: ([_s], c) => {
        calls += 1;
        return { v: c.v + 1 };
      },
      fwd: ([s]) => s,
      bwd: (t, _s, c) => ({ updates: [t], complement: c }),
    });
    view.value;
    view.value;
    view.value;
    src.value = 11;
    view.value;
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("bwd threads complement into write decisions", () => {
    // The complement stores the last write; subsequent writes use it to
    // "snap" non-monotonic writes upward (a write below the stored value
    // re-projects to the current view and is stopped by the equality check).
    const src = num(0);
    const snapped = Num.lens([src], {
      init: () => ({ last: 0 }),
      step: ([s]) => ({ last: s }),
      fwd: ([s]) => s,
      bwd: (t, _s, c) => {
        const next = t < c.last ? c.last : t; // monotonic
        return { updates: [next], complement: { last: next } };
      },
    });
    snapped.value = 5;
    expect(src.value).toBe(5);
    snapped.value = 3;
    expect(src.value).toBe(5);
    snapped.value = 8;
    expect(src.value).toBe(8);
  });
});

describe("stateful lens — multi-input scaling (the trap case)", () => {
  // Setup: N points around a centroid. View = scalar "spread" (mean
  // radial distance). The trap under plain lenses: setting spread = 0
  // collapses all points to the centroid, destroying directions; you
  // cannot recover them later by setting spread > 0.
  //
  // Stateful-lens fix: complement = unit deviation per point. `step`
  // refreshes the unit deviations whenever spread reads > 0; `bwd`
  // multiplies them by the new spread and adds the centroid back.

  type V = { x: number; y: number };
  type C = { units: V[]; centroid: V };

  const recompute = (positions: readonly V[], prev: C | undefined): C => {
    const n = positions.length;
    let cx = 0;
    let cy = 0;
    for (const p of positions) {
      cx += p.x;
      cy += p.y;
    }
    cx /= n;
    cy /= n;
    const units = positions.map((p, i) => {
      const dx = p.x - cx;
      const dy = p.y - cy;
      const r = Math.hypot(dx, dy);
      return r > 1e-9 ? { x: dx / r, y: dy / r } : (prev?.units[i] ?? { x: 0, y: 0 });
    });
    return { units, centroid: { x: cx, y: cy } };
  };

  const meanRadius = (positions: readonly V[], centroid: V): number => {
    let total = 0;
    for (const p of positions) total += Math.hypot(p.x - centroid.x, p.y - centroid.y);
    return total / positions.length;
  };

  const makeSpread = (pts: ReturnType<typeof vec>[]) =>
    Num.lens(pts, {
      init: (positions: readonly V[]) => recompute(positions, undefined),
      step: (positions: readonly V[], c: C) => recompute(positions, c),
      fwd: (positions: readonly V[], c: C) => meanRadius(positions, c.centroid),
      bwd: (newSpread: number, positions: readonly V[], c: C) => {
        const k = Math.max(0, newSpread);
        const out = positions.map((_, i) => ({
          x: c.centroid.x + c.units[i]!.x * k,
          y: c.centroid.y + c.units[i]!.y * k,
        }));
        return { updates: out, complement: c };
      },
    });

  it("read recovers spread from positions", () => {
    const pts = [vec(0, 1), vec(0, -1), vec(1, 0), vec(-1, 0)];
    const spread = makeSpread(pts);
    expect(spread.value).toBeCloseTo(1, 9);
  });

  it("write to spread scales radially about centroid", () => {
    const pts = [vec(0, 2), vec(0, -2), vec(2, 0), vec(-2, 0)];
    const spread = makeSpread(pts);
    expect(spread.value).toBeCloseTo(2, 9); // realize complement
    spread.value = 5;
    expect(pts[0]!.value.y).toBeCloseTo(5, 9);
    expect(pts[1]!.value.y).toBeCloseTo(-5, 9);
    expect(pts[2]!.value.x).toBeCloseTo(5, 9);
    expect(pts[3]!.value.x).toBeCloseTo(-5, 9);
  });

  it("THE TRAP CASE: spread → 0 → 7 recovers original directions", () => {
    const pts = [vec(0, 2), vec(0, -2), vec(2, 0), vec(-2, 0)];
    const spread = makeSpread(pts);
    // Realize the complement so we capture directions BEFORE collapsing.
    expect(spread.value).toBeCloseTo(2, 9);

    spread.value = 0;
    // All points collapsed to centroid.
    for (const p of pts) {
      expect(p.value.x).toBeCloseTo(0, 9);
      expect(p.value.y).toBeCloseTo(0, 9);
    }
    expect(spread.value).toBeCloseTo(0, 9);

    // Now reinflate. With a plain lens, directions are gone forever.
    // With the complement, they come back.
    spread.value = 7;
    expect(pts[0]!.value.y).toBeCloseTo(7, 9);
    expect(pts[1]!.value.y).toBeCloseTo(-7, 9);
    expect(pts[2]!.value.x).toBeCloseTo(7, 9);
    expect(pts[3]!.value.x).toBeCloseTo(-7, 9);
  });

  it("write does NOT depend on epsilon — 0 is truly 0", () => {
    const pts = [vec(0, 3), vec(0, -3)];
    const spread = makeSpread(pts);
    expect(spread.value).toBeCloseTo(3, 9);
    spread.value = 0;
    // Strict zero, not eps. This is the semantic correctness point.
    expect(pts[0]!.value.x).toBe(0);
    expect(pts[0]!.value.y).toBe(0);
    expect(pts[1]!.value.x).toBe(0);
    expect(pts[1]!.value.y).toBe(0);
    expect(spread.value).toBe(0);
  });

  it("composition: scaling the spread by 1000 does NOT amplify an epsilon", () => {
    const pts = [vec(0, 3), vec(0, -3)];
    const spread = makeSpread(pts);
    expect(spread.value).toBeCloseTo(3, 9);
    spread.value = 0;
    // Chain a plain-lens .scale on top — if spread were epsilon,
    // 1000*epsilon would be a visible artefact. With true 0, the
    // chain stays at 0.
    const scaled = spread.scale(1000);
    expect(scaled.value).toBe(0);
  });
});

describe("backward pass is untracked", () => {
  it("writing a lens inside an effect does not subscribe to the lens's source", () => {
    // The effect reads `a` and writes `view` (whose source is `b`). The
    // back-write must run untracked: the effect should depend on `a`
    // ONLY — never pick up `b` through the backward walk. If it did, a
    // later edit to `b` would spuriously re-run the effect (and a write
    // back into `b` from within would self-trigger).
    const a = cell(0);
    const b = cell(100);
    const view = lens(
      [b] as const,
      ([bv]) => bv,
      v => [v],
    );

    let runs = 0;
    const stop = effect(() => {
      const av = a.value; // the ONLY intended dependency
      view.value = av; // backward write into `b` — must not create a dep
      runs++;
    });

    expect(runs).toBe(1);
    expect(b.peek()).toBe(0); // the effect's back-write landed

    // An external edit to the lens's source must NOT re-run the effect.
    b.value = 55;
    expect(runs).toBe(1);

    // The real dependency still drives re-runs (and the back-write again).
    a.value = 7;
    expect(runs).toBe(2);
    expect(b.peek()).toBe(7);

    stop();
  });
});

describe("same-view back-write short-circuits", () => {
  it("a write that re-projects to the current view leaves the complement intact", () => {
    // Monotonic snap: writing below the stored high-water mark re-projects
    // to the SAME view (the stored max), so the equality check stops it —
    // the source AND the complement are left untouched.
    const src = num(5);
    const snapped = Num.lens([src], {
      init: () => ({ hi: 0 }),
      step: ([s], c) => (s > c.hi ? { hi: s } : c),
      fwd: ([_s], c) => c.hi,
      bwd: (t, _s, c) => {
        const hi = Math.max(t, c.hi);
        return { updates: [hi], complement: { hi } };
      },
    });

    expect(snapped.value).toBe(5); // hi = 5
    snapped.value = 9;
    expect(src.peek()).toBe(9); // raised the mark
    snapped.value = 3; // below the mark → re-projects to 9 → no-op
    expect(src.peek()).toBe(9); // source untouched
    expect(snapped.value).toBe(9); // complement (hi) preserved
  });
});
