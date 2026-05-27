// Symmetric-lens prototype: foundational tests.
//
// These cover:
//   - Initial-complement behavior (missing).
//   - Trip through putr (read) refreshing complement.
//   - putl (write) using complement to recover discarded info.
//   - The headline trap scenario: a scale-to-zero round trip that
//     would destroy directions under a plain lens, but is recoverable
//     here because the unit deviations live in the complement.

import { describe, expect, it } from "vitest";
import { Num, num } from "../values/num";
import { vec } from "../values/vec";

describe("symmetric lens — single input, identity-ish", () => {
  it("missing complement is used for the first read", () => {
    const src = num(7);
    let seenComplement: number | null = null;
    const view = Num.lens(src, {
      missing: { v: -1 },
      putr: (s, c) => {
        seenComplement = c.v;
        c.v += 1;
        return s;
      },
      putl: (t, _s, _c) => t,
    });
    expect(view.value).toBe(7);
    expect(seenComplement).toBe(-1);
  });

  it("putr can refresh the complement on each read", () => {
    const src = num(10);
    let calls = 0;
    const view = Num.lens(src, {
      missing: { v: 0 },
      putr: (s, c) => {
        calls += 1;
        c.v += 1;
        return s;
      },
      putl: (t, _s, _c) => t,
    });
    view.value;
    view.value;
    view.value;
    src.value = 11;
    view.value;
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("putl threads complement into write decisions", () => {
    // Lens stores the LAST WRITE as complement, and on subsequent
    // writes uses it to "snap" odd writes upward.
    const src = num(0);
    const snapped = Num.lens(src, {
      missing: { last: 0 },
      putr: (s, c) => {
        c.last = s;
        return s;
      },
      putl: (t, _s, c) => {
        const next = t < c.last ? c.last : t; // monotonic
        c.last = next;
        return next;
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

describe("symmetric lens — multi-input scaling (the trap case)", () => {
  // Setup: N points around a centroid. View = scalar "spread" (mean
  // radial distance). The trap under plain lenses: setting spread = 0
  // collapses all points to the centroid, destroying directions; you
  // cannot recover them later by setting spread > 0.
  //
  // Symmetric-lens fix: complement = unit deviation per point. When
  // spread reads > 0, refresh the unit deviations. When spread is
  // written, multiply the unit deviations by the new spread and add
  // the centroid back.

  type V = { x: number; y: number };
  type C = { units: V[]; centroid: V };

  const makeSpread = (pts: ReturnType<typeof vec>[]) =>
    Num.lens(pts, {
      missing: { units: pts.map(() => ({ x: 0, y: 0 })), centroid: { x: 0, y: 0 } },
      putr: (positions, c) => {
        const n = positions.length;
        let cx = 0;
        let cy = 0;
        for (const p of positions) {
          cx += p.x;
          cy += p.y;
        }
        cx /= n;
        cy /= n;
        let total = 0;
        for (let i = 0; i < n; i++) {
          const p = positions[i]!;
          const dx = p.x - cx;
          const dy = p.y - cy;
          const r = Math.hypot(dx, dy);
          total += r;
          if (r > 1e-9) c.units[i] = { x: dx / r, y: dy / r };
        }
        c.centroid = { x: cx, y: cy };
        return total / n;
      },
      putl: (newSpread, positions, c) => {
        const k = Math.max(0, newSpread);
        return positions.map((_, i) => {
          const u = c.units[i]!;
          return { x: c.centroid.x + u.x * k, y: c.centroid.y + u.y * k };
        });
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
