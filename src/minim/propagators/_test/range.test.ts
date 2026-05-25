// range.test.ts — interval-cell propagation: partial-info semantics.
//
// Probes the "monotone narrowing → order-independent" property and
// the "multi-source merge accumulates partial knowledge" property,
// the things partial-info propagation buys you that exact-value
// propagation can't.

import { describe, expect, it } from "vitest";
import { num } from "../../signals";
import {
  constrain,
  intervalAdder,
  intervalEq,
  intervalSum,
  propagators,
  type Range,
  rangeCell,
  RangeContradiction,
  rangeIsExact,
  snap,
} from "..";

describe("range cells: monotone narrowing", () => {
  it("intervalAdder: full info on inputs derives output", () => {
    const a = rangeCell(3, 3);
    const b = rangeCell(5, 5);
    const c = rangeCell();
    const p = propagators();
    p.add(intervalAdder(a, b, c));
    expect(c.value).toEqual([8, 8]);
    p.dispose();
  });

  it("intervalAdder: partial info on two cells narrows third", () => {
    const a = rangeCell(2, 4);
    const b = rangeCell(5, 7);
    const c = rangeCell();
    const p = propagators();
    p.add(intervalAdder(a, b, c));
    // c = a + b: lo = 2+5 = 7, hi = 4+7 = 11.
    expect(c.value).toEqual([7, 11]);
    p.dispose();
  });

  it("intervalAdder: back-deduces partial info on inputs", () => {
    const a = rangeCell(); // unknown
    const b = rangeCell(5, 7);
    const c = rangeCell(10, 12);
    const p = propagators();
    p.add(intervalAdder(a, b, c));
    // a = c - b: lo = 10 - 7 = 3, hi = 12 - 5 = 7.
    expect(a.value).toEqual([3, 7]);
    p.dispose();
  });

  it("intervalAdder: ALL THREE unknown — propagators stay top until info arrives", () => {
    const a = rangeCell();
    const b = rangeCell();
    const c = rangeCell();
    const p = propagators();
    p.add(intervalAdder(a, b, c));
    // Nothing to narrow. All stay at top.
    expect(a.value).toEqual([-Infinity, Infinity]);
    expect(b.value).toEqual([-Infinity, Infinity]);
    expect(c.value).toEqual([-Infinity, Infinity]);

    // Add info to a. b still unknown → c stays top (since a + ∞ = ∞).
    a.value = [1, 3];
    expect(a.value).toEqual([1, 3]);

    // Add info to b. Now c can be narrowed.
    b.value = [10, 20];
    expect(c.value).toEqual([11, 23]);

    p.dispose();
  });

  it("multi-source merge: two propagators both contribute to the same cell", () => {
    // Cell c is constrained by TWO different propagator chains; each
    // contributes partial info; the cell's state reflects the
    // INTERSECTION of all contributions.
    const a = rangeCell(0, 100);
    const b = rangeCell(0, 100);
    const c = rangeCell(); // narrowed by both chains
    const d = rangeCell(0, 50);
    const p = propagators();
    // Chain 1: a + b = c.
    p.add(intervalAdder(a, b, c));
    // Chain 2: c = d (via intervalEq).
    p.add(intervalEq(c, d));
    // Fixpoint:
    //   c from a+b: [0+0, 100+100] = [0, 200].
    //   c from d:   [0, 50].
    //   c = meet([0, 200], [0, 50]) = [0, 50].
    //   d narrowed back from c: [0, 50] ∩ [0, 50] = [0, 50] (no change).
    //   a+b narrowed from c: a + b ∈ [0, 50], so a ∈ [c.lo - b.hi, c.hi - b.lo]
    //                        = [0 - 100, 50 - 0] = [-100, 50] ∩ [0, 100] = [0, 50].
    //                        and similarly b ∈ [0, 50].
    expect(c.value).toEqual([0, 50]);
    expect(a.value).toEqual([0, 50]);
    expect(b.value).toEqual([0, 50]);
    p.dispose();
  });

  it("contradiction throws", () => {
    const a = rangeCell(5, 10);
    expect(() => {
      const p = propagators();
      p.add(constrain(a, 50, 100)); // disjoint with a's bounds
    }).toThrow(RangeContradiction);
  });

  it("converges to exact via narrowing", () => {
    const a = rangeCell(0, 100);
    const b = rangeCell(0, 100);
    const c = rangeCell(0, 100);
    const p = propagators();
    p.add(intervalAdder(a, b, c));
    p.add(constrain(c, 50, 50));
    p.add(constrain(a, 20, 20));
    // c = 50 (exact), a = 20 (exact). b = c - a = 30 (exact).
    expect(rangeIsExact(b.value)).toBe(true);
    expect(b.value).toEqual([30, 30]);
    p.dispose();
  });
});

describe("range cells: order-independence", () => {
  it("declaration order doesn't change fixpoint", () => {
    // Two networks with identical relations but different declaration
    // orders. Same final state.
    const buildNet = (reverseOrder: boolean) => {
      const a = rangeCell(2, 4);
      const b = rangeCell(5, 7);
      const c = rangeCell(0, 100);
      const adderProps = intervalAdder(a, b, c);
      const order = reverseOrder ? [...adderProps].reverse() : adderProps;
      const p = propagators();
      p.add(...order);
      return { a, b, c, p };
    };

    const fwd = buildNet(false);
    const rev = buildNet(true);

    expect(fwd.a.value).toEqual(rev.a.value);
    expect(fwd.b.value).toEqual(rev.b.value);
    expect(fwd.c.value).toEqual(rev.c.value);
    fwd.p.dispose();
    rev.p.dispose();
  });

  it("intervalSum with ALL parts unknown — partial info accumulates as bounds arrive", () => {
    const N = 4;
    const parts = Array.from({ length: N }, () => rangeCell());
    const total = rangeCell(20, 30);
    const p = propagators();
    p.add(intervalSum(parts, total));
    // No info yet on any part; total constrains nothing useful (parts could
    // each be -Inf to Inf and still sum to [20, 30]).
    expect(parts[0]!.value).toEqual([-Infinity, Infinity]);

    // Add bounds on three parts; the fourth is back-deduced.
    parts[0]!.value = [3, 5] as Range;
    parts[1]!.value = [6, 7] as Range;
    parts[2]!.value = [4, 8] as Range;

    // sum(others) ∈ [3+6+4, 5+7+8] = [13, 20].
    // parts[3] ∈ total − sum(others) = [20-20, 30-13] = [0, 17].
    expect(parts[3]!.value[0]).toBeCloseTo(0);
    expect(parts[3]!.value[1]).toBeCloseTo(17);

    p.dispose();
  });
});

describe("range cells: snap (interop with exact Num)", () => {
  it("range narrows → exact reads midpoint", () => {
    const r = rangeCell(0, 10);
    const x = num(0);
    const p = propagators();
    p.add(snap(r, x));
    // Initial fire: range → exact direction runs first, writes x = 5
    // (midpoint). Then exact → range narrows r to [5, 5] (singleton).
    expect(x.value).toBe(5);
    expect(r.value).toEqual([5, 5]);

    p.dispose();
  });

  // NOTE on snap's two-direction semantics:
  //
  // snap is the boundary between exact-value and partial-info worlds.
  // Once snap runs (initial fire), the Range cell collapses to a
  // singleton at the midpoint. Subsequent external writes to either
  // cell that DON'T match the singleton produce a contradiction —
  // because narrow-merge on disjoint singletons fails by design.
  //
  // Practical takeaway: snap is for "render a range as its midpoint
  // to the UI." For drag-to-narrow (write exact, mutate range),
  // write the Range cell DIRECTLY: `r.value = [v, v]`. This skips
  // the exact-cell intermediary and avoids the disjoint-singleton
  // contradiction.
  //
  // If we eventually want a "drag-to-replace" snap (loses monotone
  // narrowing but matches user intuition), add a separate variant.
  // For now, the prototype keeps things minimal.
});
