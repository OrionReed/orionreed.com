// fanin.test.ts — multi-output backward + complement-carrying lenses.
//
// The one load-bearing engine gap beyond single-chain lenses: a write
// that fans OUT to N parents (the dual of a getter reading N parents).
// This subsumes both `_fanin` (N→M coupled writables) and symmetric /
// complement lenses (private per-lens memory). The complement needs ZERO
// engine support — it is closure-captured state in putr/putl, never a
// node, never subscribed.
//
// Covered:
//   - Forward fan-in (read N) — plain derive-N.
//   - Multi-output backward: stateless + stateful (arity-dispatched).
//   - Cross-channel invariance (meanDiff isomorphism).
//   - Coalescing: one fan-out write → effects fire once.
//   - Shared ancestor: last-write-wins without a merge; combines WITH one.
//   - Symmetric complement: putl threads private memory; trap recovery.

import { describe, expect, it, vi } from "vitest";
import { Signal, effect, signal, sumPolicy } from "../index";

describe("forward fan-in (read N)", () => {
  it("derive-N recomputes when any parent changes", () => {
    const a = signal(1);
    const b = signal(2);
    const c = signal(3);
    const sum = Signal.fanin([a, b, c], (v) => (v[0] as number) + (v[1] as number) + (v[2] as number));
    expect(sum.value).toBe(6);
    b.value = 20;
    expect(sum.value).toBe(24);
  });

  it("read-only fan-in rejects writes", () => {
    const a = signal(1);
    const b = signal(2);
    const sum = Signal.fanin([a, b], (v) => (v[0] as number) + (v[1] as number));
    expect(() => {
      (sum as Signal<number>).value = 9;
    }).toThrow();
  });
});

describe("multi-output backward", () => {
  it("stateless bwd splits a write across parents", () => {
    const a = signal(0);
    const b = signal(0);
    const total = Signal.fanin(
      [a, b],
      (v) => (v[0] as number) + (v[1] as number),
      (t) => [(t as number) / 2, (t as number) / 2], // arity 1 → no peek
    );
    total.value = 10;
    expect(a.value).toBe(5);
    expect(b.value).toBe(5);
    expect(total.value).toBe(10);
  });

  it("stateful bwd reads current parent values (meanDiff isomorphism)", () => {
    const a = signal(10);
    const b = signal(4);
    const mean = Signal.fanin(
      [a, b],
      (v) => ((v[0] as number) + (v[1] as number)) / 2,
      (t, v) => {
        const d = (v![0] as number) - (v![1] as number);
        return [(t as number) + d / 2, (t as number) - d / 2];
      },
    );
    const diff = Signal.fanin(
      [a, b],
      (v) => (v[0] as number) - (v[1] as number),
      (t, v) => {
        const m = ((v![0] as number) + (v![1] as number)) / 2;
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
    const lens = Signal.fanin(
      [a, b],
      (v) => (v[0] as number) + (v[1] as number),
      (t) => [t, undefined], // only write a
    );
    lens.value = 99;
    expect(a.value).toBe(99);
    expect(b.value).toBe(2);
  });
});

describe("fan-out coalescing", () => {
  it("one fan-out write fires downstream effects once", () => {
    const a = signal(0);
    const b = signal(0);
    const total = Signal.fanin(
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

describe("shared ancestor under a fan-out", () => {
  it("two parents sharing a source: last-write-wins without a merge", () => {
    // Both outputs route to the same root via plain lenses. No merge ⇒
    // the documented last-write-wins footgun.
    const root = signal(0);
    const viaA = Signal.lens(
      root,
      (v) => v,
      (t) => t,
    );
    const viaB = Signal.lens(
      root,
      (v) => v,
      (t) => t,
    );
    const fork = Signal.fanin(
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
    const viaA = Signal.lens(
      m,
      (v) => v,
      (t) => t,
    );
    const viaB = Signal.lens(
      m,
      (v) => v,
      (t) => t,
    );
    const fork = Signal.fanin(
      [viaA, viaB],
      (v) => (v[0] as number) + (v[1] as number),
      (t) => [(t as number) + 1, (t as number) + 100],
    );
    fork.value = 0; // viaA contributes 1, viaB contributes 100 → sum 101
    expect(root.value).toBe(101);
  });
});

describe("symmetric lens — complement is private closure state", () => {
  it("putl threads complement (monotonic snap)", () => {
    const src = signal(0);
    const snapped = Signal.symmetric<number, { last: number }>([src], {
      missing: { last: 0 },
      putr: (s, c) => {
        c.last = s[0] as number;
        return s[0] as number;
      },
      putl: (t, _s, c) => {
        const next = t < c.last ? c.last : t;
        c.last = next;
        return [next];
      },
    });
    snapped.value = 5;
    expect(src.value).toBe(5);
    snapped.value = 3; // below last → snaps up to 5
    expect(src.value).toBe(5);
    snapped.value = 8;
    expect(src.value).toBe(8);
  });

  it("trap recovery: scale-to-zero round trip restores directions", () => {
    type V = { x: number; y: number };
    type C = { units: V[]; centroid: V };
    const p0 = signal<V>({ x: 1, y: 0 });
    const p1 = signal<V>({ x: -1, y: 0 });

    const spread = Signal.symmetric<number, C>([p0, p1], {
      missing: { units: [{ x: 0, y: 0 }, { x: 0, y: 0 }], centroid: { x: 0, y: 0 } },
      putr: (positions, c) => {
        const pos = positions as V[];
        const n = pos.length;
        let cx = 0;
        let cy = 0;
        for (const p of pos) {
          cx += p.x;
          cy += p.y;
        }
        cx /= n;
        cy /= n;
        c.centroid.x = cx;
        c.centroid.y = cy;
        let sum = 0;
        for (let i = 0; i < n; i++) {
          const dx = pos[i]!.x - cx;
          const dy = pos[i]!.y - cy;
          const r = Math.hypot(dx, dy);
          sum += r;
          if (r > 1e-9) {
            c.units[i]!.x = dx / r;
            c.units[i]!.y = dy / r;
          }
        }
        return sum / n;
      },
      putl: (target, positions, c) => {
        const n = (positions as V[]).length;
        const out: V[] = [];
        for (let i = 0; i < n; i++) {
          out.push({
            x: c.centroid.x + c.units[i]!.x * (target as number),
            y: c.centroid.y + c.units[i]!.y * (target as number),
          });
        }
        return out;
      },
    });

    // Read once to populate the complement (units + centroid).
    expect(spread.value).toBeCloseTo(1);

    // Collapse: a plain lens would destroy the directions here.
    spread.value = 0;
    expect(p0.value).toEqual({ x: 0, y: 0 });
    expect(p1.value).toEqual({ x: 0, y: 0 });

    // Re-inflate: directions recovered from the complement.
    spread.value = 2;
    expect(p0.value).toEqual({ x: 2, y: 0 });
    expect(p1.value).toEqual({ x: -2, y: 0 });
  });
});
