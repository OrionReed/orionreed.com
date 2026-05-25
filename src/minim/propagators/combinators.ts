// combinators.ts — propagator combinators. PROTOTYPE.
//
// Each combinator returns one or more `Propagator`s. Multi-direction
// relations (adder, multiplier, eq) return ARRAYS — pass them via
// `p.add(...)` which spreads. This is intentional: each direction
// is a separate propagator with its own reads/writes, so the
// network can run only the directions that make sense given the
// current freshness.

import type { Signal, Writable } from "../signals";
import { type Propagator, propagator } from "./propagator";

// ─── Numerical (Num signals) ────────────────────────────────────

type Num = Writable<Signal<number>>;

/** `a + b = c`. Three propagators: any two determine the third. */
export function adder(a: Num, b: Num, c: Num): Propagator[] {
  return [
    propagator([a, b], [c], () => {
      c.value = a.value + b.value;
    }),
    propagator([a, c], [b], () => {
      b.value = c.value - a.value;
    }),
    propagator([b, c], [a], () => {
      a.value = c.value - b.value;
    }),
  ];
}

/** `a * b = c`. Three propagators; division-by-zero yields no
 *  contribution (skip the write). */
export function multiplier(a: Num, b: Num, c: Num): Propagator[] {
  return [
    propagator([a, b], [c], () => {
      c.value = a.value * b.value;
    }),
    propagator([a, c], [b], () => {
      const av = a.value;
      if (av !== 0) b.value = c.value / av;
    }),
    propagator([b, c], [a], () => {
      const bv = b.value;
      if (bv !== 0) a.value = c.value / bv;
    }),
  ];
}

/** `a = b` for two arbitrary signals (any value type). Two
 *  propagators (one per direction). */
export function eq<T>(
  a: Writable<Signal<T>>,
  b: Writable<Signal<T>>,
): Propagator[] {
  return [
    propagator([a], [b], () => {
      b.value = a.value;
    }),
    propagator([b], [a], () => {
      a.value = b.value;
    }),
  ];
}

/** Constant: pin a signal to a fixed value. The propagator subscribes
 *  to its own target so external writes that diverge from the constant
 *  wake the network and the value gets restored. */
export function constant<T>(s: Writable<Signal<T>>, v: T): Propagator {
  return propagator([s], [s], () => {
    s.value = v;
  });
}

// ─── Layout ──────────────────────────────────────────────────────

/** All cells share the same value (mutual equality). N(N−1)
 *  propagators. */
export function allEqual<T>(...cells: Writable<Signal<T>>[]): Propagator[] {
  const props: Propagator[] = [];
  for (let i = 0; i < cells.length; i++) {
    for (let j = 0; j < cells.length; j++) {
      if (i === j) continue;
      const src = cells[i]!;
      const dst = cells[j]!;
      props.push(
        propagator([src], [dst], () => {
          dst.value = src.value;
        }),
      );
    }
  }
  return props;
}

/** `chainSum`: a₁ + a₂ + … + aₙ = total. Useful for "items + gaps =
 *  container.width" layout. Built from cumulative adder cascade. */
export function chainSum(parts: readonly Num[], total: Num): Propagator[] {
  if (parts.length === 0) return [];
  if (parts.length === 1) return eq(parts[0]!, total);
  // Build internal partial-sum cells implicitly via repeated adder.
  // Naive expansion: the total is sum of all parts. Each propagator
  // is an n-input adder. For simplicity, we use the n-way form
  // directly; multi-directional inference works if EXACTLY ONE part
  // is unknown.
  const props: Propagator[] = [];
  // Direction: parts → total
  props.push(
    propagator(parts, [total], () => {
      let s = 0;
      for (const p of parts) s += p.value;
      total.value = s;
    }),
  );
  // Direction: total + (n-1 parts) → missing part
  for (let i = 0; i < parts.length; i++) {
    const missing = parts[i]!;
    const others = parts.filter((_, j) => j !== i);
    props.push(
      propagator([total, ...others], [missing], () => {
        let s = 0;
        for (const o of others) s += o.value;
        missing.value = total.value - s;
      }),
    );
  }
  return props;
}

/** Distribute N items horizontally inside a container, with `gap`
 *  between each. The `mode` selects which way the constraint
 *  propagates:
 *
 *  - `'fit'` (default): container width is given; gap is derived
 *    to fit `(containerWidth - sum(widths) - 2*padding) / (n-1)`.
 *    Resize container or change item widths → gap auto-adjusts.
 *  - `'hug'`: gap is given (or derived from item-cell drag);
 *    container width is derived as `sum(widths) + (n-1)*gap +
 *    2*padding`. Resize an item → container grows.
 *
 *  In both modes, item positions `itemXs` are derived from
 *  containerX, padding, widths, gap (left-to-right).
 *
 *  Why not emit BOTH directions and let propagation figure it out?
 *  Because on the initial fire (before any user write) the network
 *  has no signal of "which cell is the source of truth." Having
 *  redundant directions causes the first-declared one to overwrite
 *  the user's intent. Explicit modes side-step this; for advanced
 *  cases users can add `chainSum` directly. */
export function distributeH(opts: {
  containerX: Num;
  containerWidth: Num;
  itemXs: readonly Num[];
  itemWidths: readonly Num[];
  gap: Num;
  padding?: Num;
  mode?: "fit" | "hug";
}): Propagator[] {
  const { containerX, containerWidth, itemXs, itemWidths, gap, padding, mode = "fit" } = opts;
  const padCell: Num | undefined = padding;
  const n = itemXs.length;
  if (n !== itemWidths.length) throw new Error("distributeH: mismatched lengths");
  const props: Propagator[] = [];

  // Always: position each item from containerX + padding + cumulative widths/gaps.
  for (let i = 0; i < n; i++) {
    const reads: Num[] = [containerX, gap, ...itemWidths.slice(0, i)];
    if (padCell) reads.push(padCell);
    const xi = itemXs[i]!;
    props.push(
      propagator(reads, [xi], () => {
        const pad = padCell ? padCell.value : 0;
        let x = containerX.value + pad;
        for (let j = 0; j < i; j++) x += itemWidths[j]!.value + gap.value;
        xi.value = x;
      }),
    );
  }

  if (mode === "fit") {
    // Container width drives. Derive gap.
    if (n >= 2) {
      const reads: Num[] = [containerWidth, ...itemWidths];
      if (padCell) reads.push(padCell);
      props.push(
        propagator(reads, [gap], () => {
          let widthSum = 0;
          for (const iw of itemWidths) widthSum += iw.value;
          const pad = padCell ? padCell.value : 0;
          gap.value = (containerWidth.value - widthSum - 2 * pad) / (n - 1);
        }),
      );
    }
  } else {
    // Item widths + gap drive. Derive container width.
    const reads: Num[] = [...itemWidths, gap];
    if (padCell) reads.push(padCell);
    props.push(
      propagator(reads, [containerWidth], () => {
        let w = (n - 1) * gap.value;
        for (const iw of itemWidths) w += iw.value;
        if (padCell) w += 2 * padCell.value;
        containerWidth.value = w;
      }),
    );
  }

  return props;
}

/** Set N cells to be aligned: all share the same value (e.g. all
 *  share `y` for top-alignment). Sugar for `allEqual`. */
export function align<T>(...cells: Writable<Signal<T>>[]): Propagator[] {
  return allEqual(...cells);
}

/** `a / b = k` (constant aspect ratio). Two propagators. */
export function aspectRatio(a: Num, b: Num, k: number): Propagator[] {
  return [
    propagator([a], [b], () => {
      b.value = a.value / k;
    }),
    propagator([b], [a], () => {
      a.value = b.value * k;
    }),
  ];
}

// ─── Set narrowing (for sudoku / refinement) ────────────────────

/** A signal whose value is a Set<T>. The propagator narrows it by
 *  intersecting with the supplied set. Termination is structural:
 *  finite-height lattice (sets only shrink). */
export type SetCell<T> = Writable<Signal<ReadonlySet<T>>>;

/** "These cells must contain DIFFERENT values." If any cell is a
 *  singleton {v}, eliminate v from the others. */
export function allDifferent<T>(...cells: SetCell<T>[]): Propagator[] {
  const props: Propagator[] = [];
  for (let i = 0; i < cells.length; i++) {
    for (let j = 0; j < cells.length; j++) {
      if (i === j) continue;
      const src = cells[i]!;
      const dst = cells[j]!;
      props.push(
        propagator([src], [dst], () => {
          const sv = src.value;
          if (sv.size !== 1) return;
          const [only] = sv;
          const dv = dst.value;
          if (!dv.has(only as T)) return;
          const next = new Set(dv);
          next.delete(only as T);
          // Use peek-equals via the signal's _equals if any; here
          // we manually compare sizes since we always create a new
          // Set instance.
          if (next.size !== dv.size) dst.value = next;
        }),
      );
    }
  }
  return props;
}
