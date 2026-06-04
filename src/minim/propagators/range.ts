// range.ts — interval cells + interval combinators.
//
// A `Range` cell holds an interval `[lo, hi]` of partial knowledge.
// Operations narrow (intersect) rather than replace, so propagators
// fire in any order without losing info, and termination is
// structural (a bounded finite-height lattice; every fire shrinks
// an interval or no-ops).
//
// A Range cell is just `signal<[number, number]>` with custom
// equality — no new type. The "merge not replace" semantic lives in
// each combinator's step body.
//
// Adapter combinators (`snap`) bridge to exact Num cells, so a
// system can propagate partial info internally while exposing exact
// signals to renderers / drag handlers / lens chains.

import { type Signal, signal, type Writable } from "../signals";
import { type Propagator, propagator } from "./propagator";

// ─── Range type + helpers ───────────────────────────────────────

/** An interval `[lo, hi]`. `[-Infinity, Infinity]` = unconstrained.
 *  `lo > hi` = contradiction (empty interval). */
export type Range = readonly [number, number];

export const RANGE_TOP: Range = [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];

export function rangeEq(a: Range, b: Range): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/** Range ∩ Range = intersection (greatest-lower-bound under the lattice). */
export function rangeMeet(a: Range, b: Range): Range {
  return [Math.max(a[0], b[0]), Math.min(a[1], b[1])];
}

/** True if the range has no values (lo > hi). */
export function rangeIsContradiction(r: Range): boolean {
  return r[0] > r[1];
}

/** True if the range is a single value (lo === hi). */
export function rangeIsExact(r: Range): boolean {
  return r[0] === r[1] && Number.isFinite(r[0]);
}

/** Width of the interval, or Infinity if unbounded. */
export function rangeWidth(r: Range): number {
  return r[1] - r[0];
}

// ─── Range cell ──────────────────────────────────────────────────

export type RangeCell = Writable<Signal<Range>>;

/** Construct a Range cell. Optionally seed with bounds. */
export function rangeCell(
  lo: number = Number.NEGATIVE_INFINITY,
  hi: number = Number.POSITIVE_INFINITY,
): RangeCell {
  return signal<Range>([lo, hi], { equals: rangeEq });
}

/** Merge `partial` into `cell` via lattice intersection. Throws on
 *  contradiction. */
export function rangeMerge(cell: RangeCell, partial: Range): void {
  const cur = cell.peek();
  const merged = rangeMeet(cur, partial);
  if (rangeIsContradiction(merged)) {
    throw new RangeContradiction(
      `Range contradiction: cur=[${cur.join(",")}], partial=[${partial.join(",")}]`,
      cell,
    );
  }
  cell.value = merged;
}

export class RangeContradiction extends Error {
  constructor(
    message: string,
    readonly cell: RangeCell,
  ) {
    super(message);
    this.name = "RangeContradiction";
  }
}

// ─── Interval arithmetic ────────────────────────────────────────

export function intervalAdd(a: Range, b: Range): Range {
  return [a[0] + b[0], a[1] + b[1]];
}

export function intervalSub(a: Range, b: Range): Range {
  return [a[0] - b[1], a[1] - b[0]];
}

// ─── Interval combinators ───────────────────────────────────────

/** `a + b = c` over interval cells. Three propagators that each
 *  narrow their output; order-independent. */
export function intervalAdder(a: RangeCell, b: RangeCell, c: RangeCell): Propagator[] {
  return [
    propagator([a, b], [c], () => {
      rangeMerge(c, intervalAdd(a.value, b.value));
    }),
    propagator([a, c], [b], () => {
      rangeMerge(b, intervalSub(c.value, a.value));
    }),
    propagator([b, c], [a], () => {
      rangeMerge(a, intervalSub(c.value, b.value));
    }),
  ];
}

/** `a = b` over interval cells. Each direction narrows to the same
 *  intersection, so order doesn't matter. */
export function intervalEq(a: RangeCell, b: RangeCell): Propagator[] {
  return [
    propagator([a], [b], () => rangeMerge(b, a.value)),
    propagator([b], [a], () => rangeMerge(a, b.value)),
  ];
}

/** Constrain a Range cell to a fixed interval. The propagator
 *  re-applies on every fire (subscribes to itself), so external
 *  writes that widen the cell get re-narrowed. */
export function constrain(cell: RangeCell, lo: number, hi: number): Propagator {
  return propagator([cell], [cell], () => {
    rangeMerge(cell, [lo, hi]);
  });
}

/** Sum of N range cells = total. N+1 propagators (total from parts,
 *  each part from total minus the others); order-independent. */
export function intervalSum(parts: readonly RangeCell[], total: RangeCell): Propagator[] {
  const props: Propagator[] = [];

  // total ⊆ sum(parts)
  props.push(
    propagator(parts, [total], () => {
      let lo = 0;
      let hi = 0;
      for (const p of parts) {
        lo += p.value[0];
        hi += p.value[1];
      }
      rangeMerge(total, [lo, hi]);
    }),
  );

  // For each part: part ⊆ total − sum(other parts)
  for (let i = 0; i < parts.length; i++) {
    const target = parts[i]!;
    const others = parts.filter((_, j) => j !== i);
    props.push(
      propagator([total, ...others], [target], () => {
        let oLo = 0;
        let oHi = 0;
        for (const o of others) {
          oLo += o.value[0];
          oHi += o.value[1];
        }
        rangeMerge(target, [total.value[0] - oHi, total.value[1] - oLo]);
      }),
    );
  }

  return props;
}

// ─── Interop with exact-value cells ──────────────────────────────

/** Bridge a Range cell to an exact Num: the Num reflects the Range's
 *  midpoint; writing the Num forces the Range to that singleton
 *  (which may contradict a narrower existing bound). For wiring a
 *  Range cell into a UI. */
export function snap(rangeC: RangeCell, exact: Writable<Signal<number>>): Propagator[] {
  return [
    // range → exact midpoint
    propagator([rangeC], [exact], () => {
      const [lo, hi] = rangeC.value;
      const mid = Number.isFinite(lo) && Number.isFinite(hi) ? (lo + hi) / 2 : 0;
      exact.value = mid;
    }),
    // exact → range (forced singleton)
    propagator([exact], [rangeC], () => {
      const v = exact.value;
      rangeMerge(rangeC, [v, v]);
    }),
  ];
}

// No `lift` sugar: bundling a fresh cell + its propagators doesn't
// fit the "combinator returns Propagator[]" shape. Wire snap() by hand.
