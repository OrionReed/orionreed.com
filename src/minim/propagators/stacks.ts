// stacks.ts — terse layout combinators on Box.
//
// What you'd write to express a layout, with no per-field plumbing:
//
//   const c = box({ w: 300 });
//   const items = [box({ w: 80 }), box({ w: 80 }), box({ w: 80 })];
//   p.add(hstack(c, items, { gap: 8 }));
//
// Combinators take a Box container, an array of Box items, and a
// minimal opts object. Numbers OR Num signals are accepted for
// reactive opts (gap, padding, etc.). Per-item bounds are an
// optional sister API; default behavior is "items keep their
// authored widths."

import { type Num as NumClass, type Read, value, type Writable } from "../signals";
import { type Box } from "./box";
import { type Propagator, propagator } from "./propagator";

// Locally we just type Num signals as `NumClass`. Box.x / .y / .w
// / .h getters return plain `Num` at the type level (conservative
// inference); writes through `.value` work at runtime because the
// prototype setter is unconditional. Where the propagator
// machinery requires a `Writable<…>` (the writes array, custom
// callsites), we cast — see `asW`.
type Num = NumClass;
const asW = (n: Num): Writable<NumClass> => n as unknown as Writable<NumClass>;
type ValOrSig = number | Read<number>;

// Signals/numbers we want to subscribe to during propagator
// reads. If it's a plain number, no subscription needed.
function readDeps(...vs: ValOrSig[]): Num[] {
  return vs.filter(v => typeof v !== "number") as Num[];
}

// ─── hstack: horizontal layout ──────────────────────────────────

export interface StackOpts {
  /** Space between adjacent items. Number or Num. Default 0. */
  gap?: ValOrSig;
  /** Padding inside container on each side. Number or Num. Default 0. */
  padding?: ValOrSig;
  /** Minimum size on the main axis (per item). Default 0. */
  minSize?: ValOrSig;
  /** Maximum size on the main axis (per item). Default Infinity. */
  maxSize?: ValOrSig;
  /** "fit" (default) — items grow/shrink to fill container.
   *  "hug" — items keep their authored size; container resizes. */
  mode?: "fit" | "hug";
  /** Cross-axis alignment. "start", "center", "end", "stretch". */
  align?: "start" | "center" | "end" | "stretch";
}

/** Horizontal stack: distribute items left-to-right inside container.
 *  In "fit" mode, items resize to fill; in "hug" mode, container
 *  width follows item widths. Cross-axis (y, h) is laid out by
 *  `align` policy. Returns a single propagator. */
export function hstack(c: Box, items: readonly Box[], opts: StackOpts = {}): Propagator {
  return _stack(c, items, opts, "horizontal");
}

/** Vertical stack: top-to-bottom version of `hstack`. */
export function vstack(c: Box, items: readonly Box[], opts: StackOpts = {}): Propagator {
  return _stack(c, items, opts, "vertical");
}

// Generic implementation — reads the right axes by direction.
function _stack(
  c: Box,
  items: readonly Box[],
  opts: StackOpts,
  dir: "horizontal" | "vertical",
): Propagator {
  const horizontal = dir === "horizontal";
  // Main / cross axis pickers — return Writable<Num> so writes
  // through .value type-check (Box.x and friends infer plain Num).
  const mainPos = (b: Box): Writable<NumClass> => asW(horizontal ? b.x : b.y);
  const mainSize = (b: Box): Writable<NumClass> => asW(horizontal ? b.w : b.h);
  const crossPos = (b: Box): Writable<NumClass> => asW(horizontal ? b.y : b.x);
  const crossSize = (b: Box): Writable<NumClass> => asW(horizontal ? b.h : b.w);

  const mode = opts.mode ?? "fit";
  const alignKind = opts.align ?? "start";

  const reads: Num[] = [
    mainPos(c),
    mainSize(c),
    crossPos(c),
    crossSize(c),
    ...items.map(mainSize),
    ...items.map(crossSize),
    ...readDeps(opts.gap ?? 0, opts.padding ?? 0, opts.minSize ?? 0, opts.maxSize ?? 0),
  ];

  const writes: Writable<NumClass>[] = [];
  for (const it of items) {
    writes.push(asW(mainPos(it)));
    if (mode === "fit") writes.push(asW(mainSize(it)));
    writes.push(asW(crossPos(it)));
    if (alignKind === "stretch") writes.push(asW(crossSize(it)));
  }

  return propagator(reads, writes, () => {
    const gap = value(opts.gap ?? 0);
    const pad = value(opts.padding ?? 0);
    const lo = value(opts.minSize ?? 0);
    const hi = value(opts.maxSize ?? Infinity);

    // 1. Main-axis layout.
    const n = items.length;
    const mainStart = mainPos(c).value + pad;
    const mainAvail = mainSize(c).value - 2 * pad - (n - 1) * gap;

    let sizes: number[];
    if (mode === "fit") {
      // Equal-share distribution clamped to [lo, hi]. Iterative for
      // correctness when bounds bind.
      sizes = new Array(n).fill(0);
      let remaining = mainAvail;
      const eligible = new Set(Array.from({ length: n }, (_, i) => i));
      while (eligible.size > 0 && remaining > 1e-9) {
        const share = remaining / eligible.size;
        let absorbed = 0;
        for (const i of [...eligible]) {
          const newSize = clamp(share, lo, hi);
          if (newSize >= hi - 1e-9) eligible.delete(i);
          if (newSize <= lo + 1e-9 && share < lo) eligible.delete(i);
          sizes[i] = newSize;
          absorbed += newSize;
        }
        if (absorbed >= remaining - 1e-9) break;
        // If clamps prevented full absorption, leftover slack is
        // ignored (overflow). Real flex would have alignment policy.
        if (eligible.size === 0) break;
        remaining = mainAvail - sumExcluding(sizes, eligible);
      }
    } else {
      // hug: keep authored sizes, derive container.
      sizes = items.map(it => clamp(mainSize(it).value, lo, hi));
      let totalMain = 2 * pad + (n - 1) * gap;
      for (const s of sizes) totalMain += s;
      mainSize(c).value = totalMain;
    }

    // 2. Place items along main axis.
    let cursor = mainStart;
    for (let i = 0; i < n; i++) {
      mainPos(items[i]!).value = cursor;
      if (mode === "fit") mainSize(items[i]!).value = sizes[i]!;
      cursor += sizes[i]! + gap;
    }

    // 3. Cross-axis: align each item.
    const cBase = crossPos(c).value + pad;
    const cAvail = crossSize(c).value - 2 * pad;
    for (const it of items) {
      const itSize = crossSize(it).value;
      switch (alignKind) {
        case "start":
          crossPos(it).value = cBase;
          break;
        case "center":
          crossPos(it).value = cBase + (cAvail - itSize) / 2;
          break;
        case "end":
          crossPos(it).value = cBase + cAvail - itSize;
          break;
        case "stretch":
          crossPos(it).value = cBase;
          crossSize(it).value = cAvail;
          break;
      }
    }
  });
}

// ─── inset: pad a box inside another ─────────────────────────────

/** `inner` fills `outer` minus padding on all sides. Reactive: drag
 *  outer, inner follows. Default padding is 0 (inner == outer).
 *
 *  Convenience for the very common "this box is the inside of that
 *  box minus padding" relationship that recurs in app shells. */
export function inset(
  outer: Box,
  inner: Box,
  opts: { padding?: ValOrSig } = {},
): Propagator {
  const reads: Num[] = [outer.x, outer.y, outer.w, outer.h, ...readDeps(opts.padding ?? 0)];
  const writes: Writable<NumClass>[] = [asW(inner.x), asW(inner.y), asW(inner.w), asW(inner.h)];
  return propagator(reads, writes, () => {
    const pad = value(opts.padding ?? 0);
    asW(inner.x).value = outer.x.value + pad;
    asW(inner.y).value = outer.y.value + pad;
    asW(inner.w).value = outer.w.value - 2 * pad;
    asW(inner.h).value = outer.h.value - 2 * pad;
  });
}

// ─── grid: 2D regular layout ─────────────────────────────────────

export interface GridOpts {
  /** Cells per row. */
  cols: number;
  /** Gap between cells (both axes; pass `gapX`/`gapY` to differ). */
  gap?: ValOrSig;
  gapX?: ValOrSig;
  gapY?: ValOrSig;
  padding?: ValOrSig;
}

/** Regular grid: items placed in a `cols`-wide grid inside container.
 *  Cells are equally-sized, computed from container minus padding
 *  and gaps. */
export function grid(c: Box, items: readonly Box[], opts: GridOpts): Propagator {
  const cols = opts.cols;
  const reads: Num[] = [
    c.x,
    c.y,
    c.w,
    c.h,
    ...readDeps(opts.gap ?? 0, opts.gapX ?? 0, opts.gapY ?? 0, opts.padding ?? 0),
  ];
  const writes: Writable<NumClass>[] = [];
  for (const it of items) {
    writes.push(asW(it.x), asW(it.y), asW(it.w), asW(it.h));
  }
  return propagator(reads, writes, () => {
    const pad = value(opts.padding ?? 0);
    const gap = value(opts.gap ?? 0);
    const gx = value(opts.gapX ?? gap);
    const gy = value(opts.gapY ?? gap);
    const rows = Math.ceil(items.length / cols);
    const cellW = (c.w.value - 2 * pad - (cols - 1) * gx) / cols;
    const cellH = (c.h.value - 2 * pad - (rows - 1) * gy) / rows;
    for (let i = 0; i < items.length; i++) {
      const row = Math.floor(i / cols);
      const col = i % cols;
      const it = items[i]!;
      asW(it.x).value = c.x.value + pad + col * (cellW + gx);
      asW(it.y).value = c.y.value + pad + row * (cellH + gy);
      asW(it.w).value = cellW;
      asW(it.h).value = cellH;
    }
  });
}

// ─── helpers ────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function sumExcluding(arr: number[], excluded: ReadonlySet<number>): number {
  let s = 0;
  for (let i = 0; i < arr.length; i++) {
    if (!excluded.has(i)) s += arr[i]!;
  }
  return s;
}
