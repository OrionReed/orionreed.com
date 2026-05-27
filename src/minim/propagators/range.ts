// range.ts — interval cells + interval combinators. PROTOTYPE.
//
// A `Range` cell holds an interval `[lo, hi]` representing partial
// knowledge about a numeric value. Operations narrow (intersect)
// rather than replace, so propagators can fire in any order without
// losing information. Termination is structural: every fire shrinks
// at least one interval (or no-ops), and intervals form a finite-
// height lattice when bounded.
//
// **Non-coloring property preserved.** A Range cell IS just
// `signal<[number, number]>(...)` with custom equality. No new type,
// no `Cell<T>` wrapper. The "merge instead of replace" semantic is
// in the COMBINATOR'S step body — when a propagator wants to
// contribute info, it merges with the current cell value.
//
// At the boundary with exact-value cells, you provide trivial
// adapter combinators (`snap`, `lift`, `pinned`) that link a Range
// cell to a Num cell. So a layout system can use Range internally
// for partial-info propagation while exposing exact Num signals to
// renderers / drag handlers / lens chains.

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
 *  contradiction. The merge IS the write — no separate "contribute"
 *  API is needed because the combinators do this internally. */
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
 *  NARROW their output cell — never overwrite. Order-independent:
 *  propagators can fire in any sequence and converge to the same
 *  fixpoint. */
export function intervalAdder(a: RangeCell, b: RangeCell, c: RangeCell): Propagator[] {
  return [
    propagator([a, b], [c], () => {
      // c narrows to (a + b)
      rangeMerge(c, intervalAdd(a.value, b.value));
    }),
    propagator([a, c], [b], () => {
      // b narrows to (c - a)
      rangeMerge(b, intervalSub(c.value, a.value));
    }),
    propagator([b, c], [a], () => {
      // a narrows to (c - b)
      rangeMerge(a, intervalSub(c.value, b.value));
    }),
  ];
}

/** `a = b` over interval cells. Two propagators each merging the
 *  other's range into ours. Symmetric: order doesn't matter on
 *  initial fire because both directions narrow to the same
 *  intersection. */
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

/** Sum of N range cells = total. Order-independent: any one cell
 *  can be the unknown, or all can be partially known.
 *
 *  N+1 propagators: total derived from sum, plus one per part
 *  derived from total minus sum-of-others. Each NARROWS its output
 *  cell; the network fixpoint collects all the partial info. */
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

/** Pin a Num signal to the midpoint of a Range cell. The Num is
 *  read-only-ish from the propagator's perspective — propagators
 *  narrow the Range; the Num always reflects the midpoint. Drag
 *  the Num: bwd writes the EXACT value into the Range as a
 *  singleton (which may contradict an existing narrower bound).
 *
 *  Useful for wiring a Range cell into a UI — renderers read the
 *  exact midpoint, drag handlers write exact values back. */
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

// (`lift` is intentionally NOT exported in this prototype — sugar
// for "create a Range cell and snap to a Num" requires bundling
// both the cell and the propagators, which doesn't fit the current
// "combinator returns Propagator[]" pattern. Users wire snap()
// manually for now; if the pattern recurs, sugar comes later.)
