// multi-parent.test.ts — forward multi-dep reads + backward splits.
//
// The one load-bearing engine shape beyond single-chain lenses: a write
// that SPLITS across N parents (the dual of a getter reading N parents).
//   - derive([...])      — read-only N-input view.
//   - iso([...], …)      — split ignores the parents (source-independent).
//   - lens([...], …)     — split reads the current parents (source-reading).
// Degeneracy memory — info the source can't hold across a singularity —
// lives in a `hold` (eager scan = signal + effect) the put reads, NOT in a
// bespoke engine kind. The last two tests are the old "complement lens"
// cases rebuilt from `hold` + `lens` to prove the recipe covers them.

import { describe, expect, it, vi } from "vitest";
import { type Signal, derive, effect, hold, iso, lens, signal, sumPolicy } from "../index";

describe("forward multi-dep read (derive-N)", () => {
  it("derive-N recomputes when any parent changes", () => {
    const a = signal(1);
    const b = signal(2);
    const c = signal(3);
    const sum = derive([a, b, c], (v) => (v[0] as number) + (v[1] as number) + (v[2] as number));
    expect(sum.value).toBe(6);
    b.value = 20;
    expect(sum.value).toBe(24);
  });

  it("read-only derive-N rejects writes", () => {
    const a = signal(1);
    const b = signal(2);
    const sum = derive([a, b], (v) => (v[0] as number) + (v[1] as number));
    expect(() => {
      (sum as Signal<number>).value = 9;
    }).toThrow();
  });
});

describe("multi-output backward", () => {
  it("iso split distributes a write across parents (source-independent)", () => {
    const a = signal(0);
    const b = signal(0);
    const total = iso(
      [a, b],
      (v) => (v[0] as number) + (v[1] as number),
      (t) => [(t as number) / 2, (t as number) / 2],
    );
    total.value = 10;
    expect(a.value).toBe(5);
    expect(b.value).toBe(5);
    expect(total.value).toBe(10);
  });

  it("lens split reads current parents (meanDiff isomorphism)", () => {
    const a = signal(10);
    const b = signal(4);
    const mean = lens(
      [a, b],
      (v) => ((v[0] as number) + (v[1] as number)) / 2,
      (t, v) => {
        const d = (v[0] as number) - (v[1] as number);
        return [(t as number) + d / 2, (t as number) - d / 2];
      },
    );
    const diff = lens(
      [a, b],
      (v) => (v[0] as number) - (v[1] as number),
      (t, v) => {
        const m = ((v[0] as number) + (v[1] as number)) / 2;
        return [m + (t as number) / 2, m - (t as number) / 2];
      },
    );
    expect(mean.value).toBe(7);
    expect(diff.value).toBe(6);

    // Writing mean preserves diff (cross-channel invariance).
    mean.value = 10;
    expect(a.value).toBe(13);
    expect(b.value).toBe(7);
    expect(mean.value).toBe(10);
    expect(diff.value).toBe(6);

    // Writing diff preserves mean.
    diff.value = 2;
    expect(mean.value).toBe(10);
    expect(diff.value).toBe(2);
  });

  it("undefined update leaves a parent untouched", () => {
    const a = signal(1);
    const b = signal(2);
    const cell = iso(
      [a, b],
      (v) => (v[0] as number) + (v[1] as number),
      (t) => [t, undefined], // only write a
    );
    cell.value = 99;
    expect(a.value).toBe(99);
    expect(b.value).toBe(2);
  });
});

describe("split coalescing", () => {
  it("one split write fires downstream effects once", () => {
    const a = signal(0);
    const b = signal(0);
    const total = iso(
      [a, b],
      (v) => (v[0] as number) + (v[1] as number),
      (t) => [(t as number) / 2, (t as number) / 2],
    );
    const fn = vi.fn(() => {
      void a.value;
      void b.value;
    });
    effect(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    total.value = 8; // commits BOTH a and b — must coalesce to one fire
    expect(fn).toHaveBeenCalledTimes(2);
    expect(a.value).toBe(4);
    expect(b.value).toBe(4);
  });
});

describe("shared ancestor under a split", () => {
  it("two parents sharing a source: last-write-wins without a merge", () => {
    // Both outputs route to the same root via plain isos. No merge ⇒ the
    // documented last-write-wins footgun.
    const root = signal(0);
    const viaA = iso(
      root,
      (v) => v,
      (t) => t,
    );
    const viaB = iso(
      root,
      (v) => v,
      (t) => t,
    );
    const fork = iso(
      [viaA, viaB],
      (v) => (v[0] as number) + (v[1] as number),
      (t) => [(t as number) + 1, (t as number) + 100],
    );
    fork.value = 0; // viaA→root:1, viaB→root:100 — last wins
    expect(root.value).toBe(100);
  });

  it("two parents sharing a MERGE: contributions combine", () => {
    const root = signal(0);
    const m = root.merge(sumPolicy);
    const viaA = iso(
      m,
      (v) => v,
      (t) => t,
    );
    const viaB = iso(
      m,
      (v) => v,
      (t) => t,
    );
    const fork = iso(
      [viaA, viaB],
      (v) => (v[0] as number) + (v[1] as number),
      (t) => [(t as number) + 1, (t as number) + 100],
    );
    fork.value = 0; // viaA contributes 1, viaB contributes 100 → sum 101
    expect(root.value).toBe(101);
  });
});

// ── degeneracy memory via `hold` (no bespoke complement kind) ────────

describe("hold + lens recovers info the source cannot hold", () => {
  it("running-max memory (monotonic snap)", () => {
    const src = signal(0);
    // Memory = running max of the source. Every accepted write flows
    // through src, so the scan stays current.
    const high = hold(
      () => src.value,
      (obs, prev) => (prev === undefined ? obs : Math.max(obs, prev)),
    );
    const snapped = iso(
      src,
      (s) => s,
      (t) => Math.max(t as number, high.value),
    );
    snapped.value = 5;
    expect(src.value).toBe(5);
    snapped.value = 3; // below the running max → snaps up to 5
    expect(src.value).toBe(5);
    snapped.value = 8;
    expect(src.value).toBe(8);
  });

  it("trap recovery: scale-to-zero round trip restores directions", () => {
    type V = { x: number; y: number };
    const p0 = signal<V>({ x: 1, y: 0 });
    const p1 = signal<V>({ x: -1, y: 0 });

    // Memory = per-point unit directions + centroid, recomputed from the
    // positions — but at a singularity (r≈0) the previous directions are
    // retained. THIS is the degeneracy memory the source destroys.
    const shape = hold(
      () => [p0.value, p1.value] as V[],
      (pos, prev) => {
        const n = pos.length;
        let cx = 0;
        let cy = 0;
        for (const p of pos) {
          cx += p.x;
          cy += p.y;
        }
        cx /= n;
        cy /= n;
        const units: V[] = [];
        for (let i = 0; i < n; i++) {
          const dx = pos[i]!.x - cx;
          const dy = pos[i]!.y - cy;
          const r = Math.hypot(dx, dy);
          units.push(r > 1e-9 ? { x: dx / r, y: dy / r } : (prev?.units[i] ?? { x: 0, y: 0 }));
        }
        return { centroid: { x: cx, y: cy }, units };
      },
    );

    const spread = lens(
      [p0, p1],
      (pos) => {
        const ps = pos as V[];
        let cx = 0;
        let cy = 0;
        for (const p of ps) {
          cx += p.x;
          cy += p.y;
        }
        cx /= ps.length;
        cy /= ps.length;
        let sum = 0;
        for (const p of ps) sum += Math.hypot(p.x - cx, p.y - cy);
        return sum / ps.length;
      },
      (target) => {
        const { centroid, units } = shape.value;
        return units.map((u) => ({
          x: centroid.x + u.x * (target as number),
          y: centroid.y + u.y * (target as number),
        }));
      },
    );

    expect(spread.value).toBeCloseTo(1);

    // Collapse: a plain lens would destroy the directions here.
    spread.value = 0;
    expect(p0.value).toEqual({ x: 0, y: 0 });
    expect(p1.value).toEqual({ x: 0, y: 0 });

    // Re-inflate: directions recovered from the hold's memory.
    spread.value = 2;
    expect(p0.value).toEqual({ x: 2, y: 0 });
    expect(p1.value).toEqual({ x: -2, y: 0 });
  });
});
