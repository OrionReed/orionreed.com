// =====================================================================
// memory.test.ts — path-dependent lens combinators `remember` / `continuous`.
//
//   §1 remember: forward, fast-path scaling, collapse + reinflation,
//      magnitude no-op, signed (totalLens) seeding, lens laws.
//   §2 continuous: forward, winding across branch cuts, write + apply,
//      degenerate freeze, period-π axis, monodromy.
// =====================================================================

import { describe, expect, it } from "vitest";
import { continuous, type Num, num, remember, type Vec, vec, type Writable } from "../../index";

const near = (a: number, b: number, tol = 1e-9): boolean => Math.abs(a - b) < tol;
const vnear = (a: { x: number; y: number }, b: { x: number; y: number }, tol = 1e-9): boolean =>
  near(a.x, b.x, tol) && near(a.y, b.y, tol);
const mkPoints = (...pts: [number, number][]): Writable<Vec>[] => pts.map(([x, y]) => vec(x, y));

// A scaleAbout-style radius about a fixed pivot, built on Vec's Linear.
const radiusAbout = (pts: readonly Writable<Vec>[], pivot: { x: number; y: number }) =>
  remember(pts, {
    anchor: () => pivot,
    feature: vals => Math.hypot(vals[0]!.x - pivot.x, vals[0]!.y - pivot.y),
  });

// =====================================================================
// §1 — remember
// =====================================================================

describe("§1 remember", () => {
  it("forward reads the feature (radius of point 0 about pivot)", () => {
    const pts = mkPoints([3, 4], [0, 10]);
    const r = radiusAbout(pts, { x: 0, y: 0 });
    expect(near(r.value, 5)).toBe(true);
  });

  it("write scales the whole cluster about the anchor (fast path)", () => {
    const pts = mkPoints([10, 0], [0, 20]);
    const r = radiusAbout(pts, { x: 0, y: 0 });
    r.value = 20; // point 0 radius 10 → 20, so k = 2
    expect(vnear(pts[0]!.value, { x: 20, y: 0 })).toBe(true);
    expect(vnear(pts[1]!.value, { x: 0, y: 40 })).toBe(true);
  });

  it("collapse to 0 then reinflate restores the remembered shape", () => {
    const pts = mkPoints([10, 0], [0, 20], [-6, 8]);
    const r = radiusAbout(pts, { x: 0, y: 0 });
    const shape0 = pts.map(p => ({ ...p.value }));
    r.value = 0; // collapse onto the pivot
    for (const p of pts) expect(vnear(p.value, { x: 0, y: 0 })).toBe(true);
    r.value = 10; // reinflate — point 0 had radius 10, so the shape returns exactly
    for (let i = 0; i < pts.length; i++) {
      expect(vnear(pts[i]!.value, shape0[i]!)).toBe(true);
    }
  });

  it("magnitude no-op: a same-magnitude (negative) target leaves the cluster put", () => {
    const pts = mkPoints([10, 0], [0, 10]);
    const r = radiusAbout(pts, { x: 0, y: 0 });
    r.value = -10; // |−10| === current radius 10 ⇒ no-op
    expect(vnear(pts[0]!.value, { x: 10, y: 0 })).toBe(true);
    expect(vnear(pts[1]!.value, { x: 0, y: 10 })).toBe(true);
  });

  it("mean-radius about the live centroid preserves the centroid on write", () => {
    const pts = mkPoints([5, 0], [-5, 0], [0, 5], [0, -5]);
    type P = { x: number; y: number };
    const meanR = remember(pts, {
      anchor: (vals: readonly P[]) => {
        let sx = 0;
        let sy = 0;
        for (const v of vals) {
          sx += v.x;
          sy += v.y;
        }
        return { x: sx / vals.length, y: sy / vals.length };
      },
      feature: (vals: readonly P[], c: P) => {
        let s = 0;
        for (const v of vals) s += Math.hypot(v.x - c.x, v.y - c.y);
        return s / vals.length;
      },
    });
    expect(near(meanR.value, 5)).toBe(true);
    meanR.value = 10;
    // centroid stays at origin; every point now sits at radius 10
    let sx = 0;
    let sy = 0;
    for (const p of pts) {
      sx += p.value.x;
      sy += p.value.y;
      expect(near(Math.hypot(p.value.x, p.value.y), 10)).toBe(true);
    }
    expect(vnear({ x: sx / 4, y: sy / 4 }, { x: 0, y: 0 })).toBe(true);
  });

  it("signed total (magnitude:false) scales proportionally and seeds an even split", () => {
    const total = (parts: Writable<Num>[]) =>
      remember(parts, {
        anchor: () => 0,
        feature: vals => vals.reduce((s, v) => s + v, 0),
        magnitude: false,
        seed: () => parts.map(() => 1 / parts.length),
      });

    const parts = [num(1), num(2), num(3), num(4)] as Writable<Num>[];
    const t = total(parts);
    expect(t.value).toBe(10);
    t.value = 100;
    expect(parts.map(p => p.value)).toEqual([10, 20, 30, 40]);

    const zeros = [num(0), num(0), num(0)] as Writable<Num>[];
    const tz = total(zeros);
    tz.value = 9;
    expect(zeros.map(p => p.value)).toEqual([3, 3, 3]); // uniform seed
  });

  it("law GetPut: writing the current feature does not move the sources", () => {
    const pts = mkPoints([3, 4], [-2, 7], [9, -1]);
    const r = radiusAbout(pts, { x: 1, y: 1 });
    const before = pts.map(p => ({ ...p.value }));
    r.value = r.value;
    for (let i = 0; i < pts.length; i++) expect(vnear(pts[i]!.value, before[i]!)).toBe(true);
  });

  it("law PutGet: a written feature reads back exactly", () => {
    const pts = mkPoints([10, 0], [0, 5]);
    const r = radiusAbout(pts, { x: 0, y: 0 });
    for (const target of [1, 7, 25, 0.5]) {
      r.value = target;
      expect(near(r.value, target)).toBe(true);
    }
  });

  it("throws on a value class with no Linear trait", () => {
    expect(() => remember([] as never, { anchor: () => 0, feature: () => 0 })).toThrow(
      /need ≥ 1 source/,
    );
  });
});

// =====================================================================
// §2 — continuous
// =====================================================================

// Winding-aware angle of a Vec point about the origin (period 2π).
const windingAngle = (p: Writable<Vec>) =>
  continuous([p], {
    period: 2 * Math.PI,
    raw: ([v]) => ({ value: Math.atan2(v.y, v.x), defined: true }),
    apply: (target, [v]) => {
      const r = Math.hypot(v.x, v.y);
      return [{ x: r * Math.cos(target), y: r * Math.sin(target) }];
    },
  });

describe("§2 continuous", () => {
  it("forward reads the raw angle when defined", () => {
    const p = vec(1, 0);
    const a = windingAngle(p);
    expect(near(a.value, 0)).toBe(true);
  });

  it("winds across the ±π branch cut without jumping a full period", () => {
    const p = vec(1, 0);
    const a = windingAngle(p);
    // Walk CCW in small steps all the way around once; read each step so the
    // complement unwraps incrementally.
    const N = 24;
    let last = a.value;
    for (let i = 1; i <= N; i++) {
      const θ = (i / N) * 2 * Math.PI;
      p.value = { x: Math.cos(θ), y: Math.sin(θ) };
      const v = a.value;
      expect(Math.abs(v - last)).toBeLessThan(Math.PI); // never a full-period jump
      last = v;
    }
    // One full CCW loop ⇒ the unwrapped angle has accumulated ~2π (monodromy).
    expect(near(last, 2 * Math.PI, 1e-6)).toBe(true);
  });

  it("two full loops accumulate ~4π (winding number 2)", () => {
    const p = vec(1, 0);
    const a = windingAngle(p);
    const N = 48;
    for (let i = 1; i <= N; i++) {
      const θ = (i / N) * 4 * Math.PI;
      p.value = { x: Math.cos(θ), y: Math.sin(θ) };
      void a.value;
    }
    expect(near(a.value, 4 * Math.PI, 1e-6)).toBe(true);
  });

  it("write applies to the source and the next read does not jump", () => {
    const p = vec(1, 0);
    const a = windingAngle(p);
    a.value = Math.PI / 2;
    expect(vnear(p.value, { x: 0, y: 1 })).toBe(true);
    expect(near(a.value, Math.PI / 2)).toBe(true);
    // Writing past π stays continuous (no wrap to −π).
    a.value = (3 * Math.PI) / 4;
    expect(near(a.value, (3 * Math.PI) / 4)).toBe(true);
  });

  it("degenerate (defined:false) freezes the view and write stashes without moving sources", () => {
    const p = vec(2, 0);
    let alive = true;
    const a = continuous([p], {
      period: 2 * Math.PI,
      raw: ([v]) => ({ value: Math.atan2(v.y, v.x), defined: alive }),
      apply: (target, [v]) => {
        const r = Math.hypot(v.x, v.y);
        return [{ x: r * Math.cos(target), y: r * Math.sin(target) }];
      },
    });
    a.value = Math.PI / 3;
    const held = { ...p.value };
    alive = false; // axis becomes undefined
    expect(near(a.value, Math.PI / 3)).toBe(true); // holds last emitted
    a.value = 5; // write while degenerate
    expect(vnear(p.value, held)).toBe(true); // sources untouched
    expect(near(a.value, 5)).toBe(true); // but the stashed target is remembered
  });

  it("period π (axis, sign-free): an angle and angle+π read the same representative", () => {
    // A direction defined only up to π: raw uses atan of slope, period π.
    const p = vec(1, 0);
    const axis = continuous([p], {
      period: Math.PI,
      raw: ([v]) => ({ value: Math.atan2(v.y, v.x), defined: true }),
      apply: (target, [v]) => {
        const r = Math.hypot(v.x, v.y);
        return [{ x: r * Math.cos(target), y: r * Math.sin(target) }];
      },
    });
    expect(near(axis.value, 0)).toBe(true);
    // Flip to the opposite ray (≡ same axis mod π): stays near 0, not π.
    p.value = { x: -1, y: 0.0001 };
    expect(Math.abs(axis.value)).toBeLessThan(0.1);
  });
});
