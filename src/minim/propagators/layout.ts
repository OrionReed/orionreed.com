// layout.ts — real-world layout combinators on plain Num signals.
//
// Users author normal `Num` signals and call combinators like
// `flexH(opts)`. No `RangeCell`, no shadow cells, no boundary glue.
// The combinators implement deterministic layout semantics modeled
// on CSS flex / Yoga, with min/max width support and graceful
// infeasibility handling (items clamp; slack absorbed by gap).
//
// This is the "first-class signal integration" surface: the user
// wires their normal signals together and the combinators do the
// bookkeeping. Bidirectionality (drag a child OR the container)
// works where the algorithm has a deterministic inverse.

import type { Signal, Writable } from "../signals";
import { type Propagator, propagator } from "./propagator";

type Num = Writable<Signal<number>>;

// ─── flexH: 1D flex container ────────────────────────────────────

export interface FlexHItem {
  /** Position output (left edge x). */
  x: Num;
  /** Width input/output. */
  w: Num;
  /** Minimum allowed width. Defaults to 0. */
  minW?: number;
  /** Maximum allowed width. Defaults to Infinity. */
  maxW?: number;
  /** Flex grow weight. 0 = fixed; positive = absorbs leftover space
   *  proportionally. Defaults to 1. */
  grow?: number;
  /** Flex shrink weight. 0 = no shrink; positive = absorbs negative
   *  slack proportionally. Defaults to 1. */
  shrink?: number;
}

export interface FlexHOpts {
  containerX: Num;
  containerWidth: Num;
  items: readonly FlexHItem[];
  /** Gap between items. Use exact `num(8)` for fixed gap. */
  gap: Num;
  /** Padding on left and right of container. */
  padding?: Num;
  /** Direction this layout flows in:
   *  - 'fit' (default): container.w is the input; items grow/shrink
   *    to fill it; their final widths reflect the flex algorithm.
   *  - 'hug': item widths drive container.w. */
  mode?: "fit" | "hug";
}

/** A flexbox-style horizontal layout with min/max widths and
 *  grow/shrink weights. Deterministic single-pass algorithm matching
 *  CSS flex semantics for the common case.
 *
 *  Returns a single propagator (not an array) — internally, the
 *  layout is one cohesive computation rather than many small bidir-
 *  ectional relations. This trades multi-direction flexibility for
 *  predictable algorithm + perf. */
export function flexH(opts: FlexHOpts): Propagator {
  const { containerX, containerWidth, items, gap, padding, mode = "fit" } = opts;
  const n = items.length;
  if (mode === "hug") return flexHHug(opts);

  // Reads: containerX, containerWidth, gap, padding, plus any item.w
  // for the items the user has fixed (we'll subscribe to all w's
  // anyway since the user can override an item width).
  const reads: Num[] = [containerX, containerWidth, gap];
  if (padding) reads.push(padding);
  for (const it of items) reads.push(it.w);

  // Writes: every item.x and every item.w (we may overwrite w).
  const writes: Num[] = [];
  for (const it of items) {
    writes.push(it.x);
    writes.push(it.w);
  }

  return propagator(reads, writes, () => {
    const pad = padding ? padding.value : 0;
    const g = gap.value;
    const cw = containerWidth.value;
    const cx = containerX.value;

    // 1. Start with each item at its hypothetical width (current w
    //    clamped to [minW, maxW]).
    const widths = new Array<number>(n);
    let sumW = 0;
    let totalGrow = 0;
    let totalShrink = 0;
    for (let i = 0; i < n; i++) {
      const it = items[i]!;
      const lo = it.minW ?? 0;
      const hi = it.maxW ?? Infinity;
      const w0 = clamp(it.w.value, lo, hi);
      widths[i] = w0;
      sumW += w0;
      totalGrow += it.grow ?? 1;
      totalShrink += it.shrink ?? 1;
    }

    // 2. Available space: container minus padding minus gaps.
    const totalGap = (n - 1) * g;
    const slack = cw - 2 * pad - totalGap - sumW;

    // 3. Distribute slack: positive → grow; negative → shrink.
    if (slack > 0 && totalGrow > 0) {
      // Iterative grow: respect maxW. Grow proportionally; if any
      // hit cap, redistribute among remaining.
      let remaining = slack;
      const eligible = new Set<number>();
      for (let i = 0; i < n; i++) {
        if ((items[i]!.grow ?? 1) > 0 && widths[i]! < (items[i]!.maxW ?? Infinity)) {
          eligible.add(i);
        }
      }
      while (remaining > 1e-9 && eligible.size > 0) {
        let weights = 0;
        for (const i of eligible) weights += items[i]!.grow ?? 1;
        if (weights === 0) break;
        let absorbed = 0;
        for (const i of [...eligible]) {
          const w = items[i]!.grow ?? 1;
          const share = (remaining * w) / weights;
          const cap = items[i]!.maxW ?? Infinity;
          const newW = Math.min(widths[i]! + share, cap);
          absorbed += newW - widths[i]!;
          widths[i] = newW;
          if (newW >= cap) eligible.delete(i);
        }
        if (absorbed < 1e-9) break;
        remaining -= absorbed;
      }
    } else if (slack < 0 && totalShrink > 0) {
      let remaining = -slack;
      const eligible = new Set<number>();
      for (let i = 0; i < n; i++) {
        if ((items[i]!.shrink ?? 1) > 0 && widths[i]! > (items[i]!.minW ?? 0)) {
          eligible.add(i);
        }
      }
      while (remaining > 1e-9 && eligible.size > 0) {
        let weights = 0;
        for (const i of eligible) weights += items[i]!.shrink ?? 1;
        if (weights === 0) break;
        let absorbed = 0;
        for (const i of [...eligible]) {
          const w = items[i]!.shrink ?? 1;
          const share = (remaining * w) / weights;
          const floor = items[i]!.minW ?? 0;
          const newW = Math.max(widths[i]! - share, floor);
          absorbed += widths[i]! - newW;
          widths[i] = newW;
          if (newW <= floor) eligible.delete(i);
        }
        if (absorbed < 1e-9) break;
        remaining -= absorbed;
      }
    }

    // 4. Write item widths and positions.
    let cursor = cx + pad;
    for (let i = 0; i < n; i++) {
      const it = items[i]!;
      it.w.value = widths[i]!;
      it.x.value = cursor;
      cursor += widths[i]! + g;
    }
  });
}

/** "hug" mode: item widths drive container width. Simple sum-and-go. */
function flexHHug(opts: FlexHOpts): Propagator {
  const { containerX, containerWidth, items, gap, padding } = opts;
  const reads: Num[] = [containerX, gap, ...items.map(it => it.w)];
  if (padding) reads.push(padding);
  const writes: Num[] = [containerWidth];
  for (const it of items) writes.push(it.x);

  return propagator(reads, writes, () => {
    const pad = padding ? padding.value : 0;
    const g = gap.value;
    let cursor = containerX.value + pad;
    let total = 2 * pad;
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      const w = clamp(it.w.value, it.minW ?? 0, it.maxW ?? Infinity);
      it.x.value = cursor;
      cursor += w + g;
      total += w;
      if (i < items.length - 1) total += g;
    }
    containerWidth.value = total;
  });
}

// ─── stack: vertical/horizontal stack with explicit alignment ────

export interface StackItem {
  /** Position output. */
  pos: Num;
  /** Cross-axis position output (set to alignment value). */
  cross?: Num;
  /** Size on main axis. */
  size: Num;
}

export interface StackOpts {
  /** Container's leading edge on main axis. */
  origin: Num;
  /** Container's cross-axis position (used when items have `cross`). */
  crossOrigin?: Num;
  items: readonly StackItem[];
  gap: Num;
  /** Alignment cross-axis offset (e.g. row-align-top → 0). */
  align?: number;
}

/** Simple stack: place items end-to-end with a gap. Cross-axis
 *  alignment is uniform. */
export function stack(opts: StackOpts): Propagator {
  const { origin, crossOrigin, items, gap, align: alignVal = 0 } = opts;
  const reads: Num[] = [origin, gap, ...items.map(it => it.size)];
  if (crossOrigin) reads.push(crossOrigin);
  const writes: Num[] = [];
  for (const it of items) {
    writes.push(it.pos);
    if (it.cross) writes.push(it.cross);
  }
  return propagator(reads, writes, () => {
    let cursor = origin.value;
    const co = crossOrigin ? crossOrigin.value + alignVal : alignVal;
    for (const it of items) {
      it.pos.value = cursor;
      if (it.cross) it.cross.value = co;
      cursor += it.size.value + gap.value;
    }
  });
}

// ─── Helpers ─────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}
