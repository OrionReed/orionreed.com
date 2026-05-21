// hyper.test.ts — hyperLens (N→M bidirectional reactive views).
//
// Three motivating examples from STRUCTURE-NOTES.md, exercising:
//   - read fan-in (output observes all inputs)
//   - per-output write fan-out (different policies per output)
//   - read-only outputs (no inverse policy registered)
//   - batched writes (all inputs update atomically)

import { describe, it, expect } from "vitest";
import { effect } from "./signal";
import { num } from "./values/num";
import { vec, Vec } from "./values/vec";
import { type Of } from "./signal";
import { hyperLens } from "./values/hyper";

// Vec math helpers for tests (operating on plain Of<Vec> POJOs).
const vAdd = (a: Of<Vec>, b: Of<Vec>): Of<Vec> => ({ x: a.x + b.x, y: a.y + b.y });
const vSub = (a: Of<Vec>, b: Of<Vec>): Of<Vec> => ({ x: a.x - b.x, y: a.y - b.y });
const vScale = (a: Of<Vec>, k: number): Of<Vec> => ({ x: a.x * k, y: a.y * k });
const vDist = (a: Of<Vec>, b: Of<Vec>) => Math.hypot(a.x - b.x, a.y - b.y);
const vMid = (a: Of<Vec>, b: Of<Vec>) => vScale(vAdd(a, b), 0.5);
const vNorm = (v: Of<Vec>): Of<Vec> => {
  const m = Math.hypot(v.x, v.y);
  return m === 0 ? { x: 0, y: 0 } : { x: v.x / m, y: v.y / m };
};

// ─── Example 1: pointOnLine(a, b, t) — read 3, write 1 ─────────────

describe("hyperLens: pointOnLine(a, b, t)", () => {
  const make = () => {
    const a = vec(0, 0);
    const b = vec(10, 0);
    const t = num(0.5);
    const { p } = hyperLens(
      [a, b, t] as const,
      ([av, bv, tv]) => ({
        p: vAdd(av, vScale(vSub(bv, av), tv)),
      }),
      {
        // Drag the point → translate both endpoints by delta_p (preserves t).
        // (The "distribute by (1-t, t) weighting" feels intuitive but
        // doesn't invert correctly under p = a + t*(b-a). Two correct
        // policies are: translate both equally, or move only one endpoint.
        // We pick the first — natural "drag the midpoint, both endpoints
        // follow" semantics.)
        p: (next, [av, bv, tv]) => {
          const cur = vAdd(av, vScale(vSub(bv, av), tv));
          const delta = vSub(next, cur);
          return [vAdd(av, delta), vAdd(bv, delta), tv];
        },
      },
    );
    return { a, b, t, p };
  };

  it("read: midpoint of segment", () => {
    const { p } = make();
    expect(p.value).toEqual({ x: 5, y: 0 });
  });

  it("read: tracks t", () => {
    const { t, p } = make();
    t.value = 0.25;
    expect(p.value).toEqual({ x: 2.5, y: 0 });
    t.value = 1;
    expect(p.value).toEqual({ x: 10, y: 0 });
  });

  it("read: tracks endpoint moves", () => {
    const { b, p } = make();
    b.value = { x: 20, y: 0 };
    expect(p.value).toEqual({ x: 10, y: 0 });
  });

  it("write: translates both endpoints by delta_p, preserves t", () => {
    const { a, b, t, p } = make();
    p.value = { x: 5, y: 4 };  // up by 4
    expect(a.value).toEqual({ x: 0, y: 4 });
    expect(b.value).toEqual({ x: 10, y: 4 });
    expect(t.value).toBe(0.5);
    expect(p.value).toEqual({ x: 5, y: 4 });
  });

  it("write at t=0.25 still translates both equally", () => {
    const { a, b, t, p } = make();
    t.value = 0.25;
    expect(p.value).toEqual({ x: 2.5, y: 0 });
    p.value = { x: 7.5, y: 0 };  // right by 5
    expect(a.value.x).toBeCloseTo(5, 10);
    expect(b.value.x).toBeCloseTo(15, 10);
    expect(t.value).toBe(0.25);
  });

  it("subscriber dedup: same value, no rerun", () => {
    const { p } = make();
    let runs = 0;
    effect(() => { void p.value; runs++; });
    expect(runs).toBe(1);
    // Writing the same value triggers the input cascade; but each input
    // writes its current value (===) so the cascade short-circuits.
    p.value = { x: 5, y: 0 };
    expect(runs).toBe(1);
  });
});

// ─── Example 2: wheel(center, radius, n) — read 2, write N ──────────

describe("hyperLens: wheel(center, radius, n=4)", () => {
  const N = 4;
  const make = () => {
    const center = vec(0, 0);
    const radius = num(10);
    const outs = hyperLens(
      [center, radius] as const,
      ([c, r]) => {
        const points: Record<string, Of<Vec>> = {};
        for (let i = 0; i < N; i++) {
          const a = (i / N) * Math.PI * 2;
          points[`p${i}`] = { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
        }
        return points;
      },
      // Policy for each point: preserve center, recompute radius from
      // the dragged point's distance.
      Object.fromEntries(
        Array.from({ length: N }, (_, i) => [
          `p${i}`,
          (next: Of<Vec>, [c, _r]: readonly [Of<Vec>, number]) => {
            const r = vDist(c, next);
            return [c, r] as const;
          },
        ]),
      ),
    );
    return { center, radius, p0: outs.p0!, p1: outs.p1!, p2: outs.p2!, p3: outs.p3! };
  };

  it("read: produces N points on circle", () => {
    const { p0, p1, p2, p3 } = make();
    expect(p0.value).toEqual({ x: 10, y: 0 });
    expect(p1.value.x).toBeCloseTo(0, 10);
    expect(p1.value.y).toBeCloseTo(10, 10);
    expect(p2.value.x).toBeCloseTo(-10, 10);
    expect(p3.value.y).toBeCloseTo(-10, 10);
  });

  it("write any point → updates radius (policy: preserve center)", () => {
    const { center, radius, p0 } = make();
    p0.value = { x: 20, y: 0 };  // distance from (0,0) is 20
    expect(radius.value).toBe(20);
    expect(center.value).toEqual({ x: 0, y: 0 });
  });

  it("center stays put when any point is dragged radially", () => {
    const { center, radius, p2 } = make();
    p2.value = { x: -50, y: 0 };
    expect(center.value).toEqual({ x: 0, y: 0 });
    expect(radius.value).toBe(50);
  });

  it("moving center moves all points coherently", () => {
    const { center, p0, p1 } = make();
    center.value = { x: 100, y: 0 };
    expect(p0.value).toEqual({ x: 110, y: 0 });
    expect(p1.value.x).toBeCloseTo(100, 10);
    expect(p1.value.y).toBeCloseTo(10, 10);
  });
});

// ─── Example 3: pinch(f1, f2) — read 2, write 3 ─────────────────────

describe("hyperLens: pinch(f1, f2) → (center, distance, rotation)", () => {
  const angleOf = (a: Of<Vec>, b: Of<Vec>) => Math.atan2(b.y - a.y, b.x - a.x);
  const make = () => {
    const f1 = vec(0, 0);
    const f2 = vec(10, 0);
    const { center, distance, rotation } = hyperLens(
      [f1, f2] as const,
      ([a, b]) => ({
        center: vMid(a, b),
        distance: vDist(a, b),
        rotation: angleOf(a, b),
      }),
      {
        // Drag center → translate both fingers preserving offsets
        center: (newC, [a, b]) => {
          const oldC = vMid(a, b);
          const delta = vSub(newC, oldC);
          return [vAdd(a, delta), vAdd(b, delta)];
        },
        // Snap distance → scale around midpoint, preserving rotation
        distance: (newD, [a, b]) => {
          const c = vMid(a, b);
          const dir = vNorm(vSub(b, a));
          return [vSub(c, vScale(dir, newD / 2)), vAdd(c, vScale(dir, newD / 2))];
        },
        // Rotate around midpoint, preserving distance
        rotation: (newAng, [a, b]) => {
          const c = vMid(a, b);
          const d = vDist(a, b);
          const dir: Of<Vec> = { x: Math.cos(newAng), y: Math.sin(newAng) };
          return [vSub(c, vScale(dir, d / 2)), vAdd(c, vScale(dir, d / 2))];
        },
      },
    );
    return { f1, f2, center, distance, rotation };
  };

  it("read: derived 3 outputs from 2 inputs", () => {
    const { center, distance, rotation } = make();
    expect(center.value).toEqual({ x: 5, y: 0 });
    expect(distance.value).toBe(10);
    expect(rotation.value).toBe(0);
  });

  it("write center: translates both fingers", () => {
    const { f1, f2, center } = make();
    center.value = { x: 100, y: 50 };
    expect(f1.value).toEqual({ x: 95, y: 50 });
    expect(f2.value).toEqual({ x: 105, y: 50 });
  });

  it("write distance: scales around midpoint, preserves rotation", () => {
    const { f1, f2, center, distance, rotation } = make();
    distance.value = 4;
    expect(distance.value).toBe(4);
    expect(center.value).toEqual({ x: 5, y: 0 });
    expect(rotation.value).toBe(0);
    expect(f1.value).toEqual({ x: 3, y: 0 });
    expect(f2.value).toEqual({ x: 7, y: 0 });
  });

  it("write rotation: rotates around midpoint, preserves distance", () => {
    const { center, distance, rotation } = make();
    rotation.value = Math.PI / 2;
    expect(center.value.x).toBeCloseTo(5, 10);
    expect(center.value.y).toBeCloseTo(0, 10);
    expect(distance.value).toBeCloseTo(10, 10);
    expect(rotation.value).toBeCloseTo(Math.PI / 2, 10);
  });

  it("writes are atomic (batched)", () => {
    const { f1, f2, center } = make();
    let f1Runs = 0; let f2Runs = 0;
    effect(() => { void f1.value; f1Runs++; });
    effect(() => { void f2.value; f2Runs++; });
    expect(f1Runs).toBe(1); expect(f2Runs).toBe(1);
    // Writing center triggers two input updates inside one batch
    center.value = { x: 100, y: 0 };
    // Each effect runs exactly once for the combined update
    expect(f1Runs).toBe(2);
    expect(f2Runs).toBe(2);
  });
});

// ─── Read-only output: no policy → write throws ─────────────────────

describe("hyperLens: read-only outputs", () => {
  it("output without a policy throws on write", () => {
    const a = num(1); const b = num(2);
    const { sum } = hyperLens(
      [a, b] as const,
      ([av, bv]) => ({ sum: av + bv }),
      {}, // no policies → all outputs read-only
    );
    expect(sum.value).toBe(3);
    expect(() => { sum.value = 10; }).toThrow(/read-only/);
  });

  it("mixed read-only and writable outputs", () => {
    const a = num(2); const b = num(4);
    const { sum, doubled } = hyperLens(
      [a, b] as const,
      ([av, bv]) => ({ sum: av + bv, doubled: av * 2 }),
      {
        // Only `doubled` is writable; sum stays read-only
        doubled: (next, [_av, bv]) => [next / 2, bv],
      },
    );
    expect(sum.value).toBe(6);
    expect(doubled.value).toBe(4);
    doubled.value = 20;
    expect(a.value).toBe(10);
    expect(sum.value).toBe(14);
    expect(() => { sum.value = 99; }).toThrow(/read-only/);
  });
});
