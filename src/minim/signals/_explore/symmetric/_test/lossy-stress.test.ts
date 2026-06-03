// lossy-stress.test.ts — adversarial probing of the BACKWARD VALUE-GATE
// across lens arities (1→1, N→1 merge, 1→N / N→M fan-out) and edge cases.
//
// The gate's rule (postit-sized): a backward write that does NOT change a
// lens's own projected view is absorbed — the source (and whatever the
// lens hides) is left intact. This is the dual of the forward rule ("a
// node fires only when its value changes").
//
// Each `desired:` test asserts that rule UNIFORMLY. Where the engine only
// gates one arity, the others fall through and SNAP. These tests pin which
// arities are covered today and which expose the gap.

import { describe, expect, it, vi } from "vitest";
import { batch, effect, fanin, lens, signal, symmetric } from "../index";
import { num } from "../values/num";

const qf = (step: number) => (v: number) => Math.round(v / step) * step;

// ── 1→1: covered by the per-step `_fwd` gate (Route B) ──────────────

describe("1→1 lossy lens (baseline, gated)", () => {
  it("within-bucket batched writes preserve the off-grid source", () => {
    const b = num(13);
    const c = b.quantize(10); // view 10, hidden remainder 3
    void c.value;
    const fn = vi.fn(() => void b.value);
    effect(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    batch(() => {
      c.value = 11; // same bucket
      c.value = 12; // same bucket (last-write-wins)
    });
    expect(b.value).toBe(13); // preserved
    expect(fn).toHaveBeenCalledTimes(1); // source untouched → no fire
  });
});

// ── N→1 merge: composes via the gate on its (1→1) parent ────────────

describe("N→1 merge folding into a lossy 1→1 parent", () => {
  it("fold whose quantize is unchanged is absorbed (source preserved)", () => {
    const root = signal(13); // off-grid
    const q = lens(root, qf(10), (t) => t); // view 10
    const m = q.merge({ identity: 0, combine: (a, b) => a + b, remove: (a, b) => a - b });
    const a = lens(m, (v) => v, (t) => t);
    const b = lens(m, (v) => v, (t) => t);
    void m.value;
    batch(() => {
      a.value = 4;
      b.value = 8; // fold = 12; q.put(12)=12; q.fwd(12)=10 == view ⇒ gate
    });
    expect(root.value).toBe(13); // preserved through merge → lens gate
  });

  it("fold whose quantize changes propagates to the source", () => {
    const root = signal(13);
    const q = lens(root, qf(10), (t) => t);
    const m = q.merge({ identity: 0, combine: (a, b) => a + b, remove: (a, b) => a - b });
    const a = lens(m, (v) => v, (t) => t);
    const b = lens(m, (v) => v, (t) => t);
    void m.value;
    batch(() => {
      a.value = 10;
      b.value = 16; // fold = 26; q.put(26)=26 (identity); fwd(26)=30 ≠ 10
    });
    expect(root.value).toBe(26); // raw fold reaches the source…
    expect(q.value).toBe(30); // …and the view snaps on recompute
  });
});

// ── 1→N / N→M fan-out: source-gate only; the cell-level gate is the GAP ──

describe("lossless fan-out (axes) — source gate suffices", () => {
  it("rewriting the current view fires nothing", () => {
    const x = signal(3);
    const y = signal(4);
    const v = fanin(
      [x, y],
      (vals) => ({ x: vals[0] as number, y: vals[1] as number }),
      (t) => [(t as { x: number }).x, (t as { y: number }).y],
    );
    void v.value;
    const fn = vi.fn(() => {
      void x.value;
      void y.value;
    });
    effect(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    v.value = { x: 3, y: 4 }; // same → per-parent source gate stops both
    expect(x.value).toBe(3);
    expect(y.value).toBe(4);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("LOSSY fan-out (N→M) over off-grid parents — desired vs current", () => {
  // view = quantize(a+b, 5); a redistributing put = [t/2, t/2]. The
  // aggregate view is lossy AND the put discards the per-parent split, so
  // a within-bucket write moves a parent even though the view is unchanged.
  const build = () => {
    const a = signal(3);
    const b = signal(4);
    const v = fanin(
      [a, b],
      (vals) => qf(5)((vals[0] as number) + (vals[1] as number)),
      (t) => [(t as number) / 2, (t as number) / 2],
    );
    return { a, b, v };
  };

  it("within-bucket write keeps the aggregate view (5)", () => {
    const { v } = build();
    expect(v.value).toBe(5); // quantize(7, 5)
    v.value = 6; // quantize(6,5)=5 — view UNCHANGED
    expect(v.value).toBe(5);
  });

  it("desired: within-bucket write preserves BOTH parents (view unchanged)", () => {
    const { a, b, v } = build();
    void v.value;
    v.value = 6; // updates [3,3]; view stays 5
    // Postit rule: view unchanged ⇒ absorb. Both parents should be intact.
    expect(a.value).toBe(3);
    expect(b.value).toBe(4);
  });

  it("desired: within-bucket write fires no downstream effect", () => {
    const { a, b, v } = build();
    void v.value;
    const fn = vi.fn(() => {
      void a.value;
      void b.value;
    });
    effect(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    v.value = 6; // view unchanged ⇒ should be a no-op
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("cross-bucket write propagates (genuine edit)", () => {
    const { a, b, v } = build();
    void v.value;
    v.value = 8; // quantize(8,5)=10 — new bucket
    expect(a.value).toBe(4);
    expect(b.value).toBe(4);
    expect(v.value).toBe(10);
  });
});

// ── N→M symmetric (complement-carrying) — lossless by design ────────

describe("symmetric N-input lens (complement) sidesteps the gap", () => {
  it("rewriting the current view preserves both parents", () => {
    const a = signal(3);
    const b = signal(5);
    // view = a+b; complement = a-b (captured), so the inverse is exact.
    const v = symmetric([a, b], {
      missing: 0,
      putr: (vals) => (vals[0] as number) + (vals[1] as number),
      putl: (target, vals) => {
        const diff = (vals[0] as number) - (vals[1] as number);
        return [((target as number) + diff) / 2, ((target as number) - diff) / 2];
      },
    });
    expect(v.value).toBe(8);
    void v.value;
    v.value = 8; // same → putl reproduces [3,5] → source gate, no change
    expect(a.value).toBe(3);
    expect(b.value).toBe(5);
    v.value = 10; // genuine → [4,6]
    expect(a.value).toBe(4);
    expect(b.value).toBe(6);
  });
});

// ── edge cases of the equality used by the gate ─────────────────────

describe("gate equality edge cases", () => {
  it("calls fwd exactly once extra on a gated (absorbed) write — fwd must be pure", () => {
    let calls = 0;
    const s = signal(7);
    const l = lens(
      s,
      (v) => {
        calls++;
        return qf(10)(v);
      },
      (t) => t,
    );
    void l.value; // view = 10
    const before = calls;
    l.value = 12; // within bucket; gate evaluates fwd(put(12)) once
    expect(calls).toBe(before + 1); // exactly one extra projection call
    expect(s.value).toBe(7); // absorbed
  });

  it("NaN view writes are never gated (NaN !== NaN) and always reach the source", () => {
    const s = signal(0);
    const l = lens(s, (v) => v + 0, (t) => t);
    void l.value;
    const fn = vi.fn(() => void s.value);
    effect(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    l.value = Number.NaN; // fwd(NaN)=NaN, NaN===NaN is false ⇒ not absorbed
    expect(Number.isNaN(s.value)).toBe(true);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
