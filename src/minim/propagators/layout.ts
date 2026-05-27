// layout.ts — Box-relational layout combinators.
//
// Every combinator takes a `Box` value-type as the spatial primitive
// (re-exported from `signals/values/box`). Items can be plain
// `Box`es or tagged `{ box, grow?, shrink?, min?, max? }` for
// per-item flex behaviour. Numbers OR Num signals are accepted for
// reactive opts (`gap`, `padding`, …).
//
//   const c = box(0, 0, 300, 200);
//   const items = [box(), box(), box()];
//   p.add(hstack(c, items, { gap: 8, align: "stretch" }));
//
// `hstack` and `vstack` are CSS-flex-shaped: items can grow/shrink
// against min/max bounds, slack absorbed by gap, etc. For more
// rigid edge-to-edge layouts use `attach`, `centerInside`, etc.

import {
  type Box,
  isSignal,
  type Num as NumClass,
  type Read,
  readNow,
  type Writable,
} from "../signals";
import { type Propagator, propagator } from "./propagator";

type Num = NumClass;
const asW = (n: Num): Writable<NumClass> => n as unknown as Writable<NumClass>;
type ValOrSig = number | Read<number>;

function readDeps(...vs: ValOrSig[]): Num[] {
  return vs.filter(isSignal) as Num[];
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

// ─── hstack / vstack ───────────────────────────────────────────────

/** Item in an `hstack` / `vstack` layout. Bare `Box` uses defaults
 *  (grow 1, shrink 1, no min/max). Tag with per-item flex behaviour:
 *
 *    hstack(c, [a, b, { box: c, grow: 2, min: 80 }, ...], opts)
 *
 *  All numbers; reactive per-item opts aren't supported (use
 *  global opts instead). */
export type StackItem =
  | Box
  | {
      box: Box;
      grow?: number;
      shrink?: number;
      min?: number;
      max?: number;
    };

interface StackItemSpec {
  box: Box;
  grow: number;
  shrink: number;
  min: number;
  max: number;
}

function specs(items: readonly StackItem[]): StackItemSpec[] {
  return items.map(it =>
    "box" in it
      ? {
          box: it.box,
          grow: it.grow ?? 1,
          shrink: it.shrink ?? 1,
          min: it.min ?? 0,
          max: it.max ?? Number.POSITIVE_INFINITY,
        }
      : { box: it, grow: 1, shrink: 1, min: 0, max: Number.POSITIVE_INFINITY },
  );
}

export interface StackOpts {
  /** Space between adjacent items. Default 0. */
  gap?: ValOrSig;
  /** Padding inside container on each side. Default 0. */
  padding?: ValOrSig;
  /** Cross-axis alignment. Default "start". */
  align?: "start" | "center" | "end" | "stretch";
  /** "fit" (default): items grow/shrink to fill container.
   *  "hug": items keep their authored size; container resizes. */
  mode?: "fit" | "hug";
}

/** Horizontal stack — distribute items left-to-right inside container.
 *  CSS-flex semantics: per-item `grow` / `shrink` weights, `min` /
 *  `max` clamp. Cross-axis (y, h) handled by `align`. Returns a
 *  single propagator. */
export function hstack(c: Box, items: readonly StackItem[], opts: StackOpts = {}): Propagator {
  return _stack(c, items, opts, "horizontal");
}

/** Vertical stack — top-to-bottom version of `hstack`. */
export function vstack(c: Box, items: readonly StackItem[], opts: StackOpts = {}): Propagator {
  return _stack(c, items, opts, "vertical");
}

function _stack(
  c: Box,
  rawItems: readonly StackItem[],
  opts: StackOpts,
  dir: "horizontal" | "vertical",
): Propagator {
  const items = specs(rawItems);
  const horizontal = dir === "horizontal";
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
    ...items.map(it => mainSize(it.box)),
    ...items.map(it => crossSize(it.box)),
    ...readDeps(opts.gap ?? 0, opts.padding ?? 0),
  ];

  const writes: Writable<NumClass>[] = [];
  for (const it of items) {
    writes.push(asW(mainPos(it.box)));
    if (mode === "fit") writes.push(asW(mainSize(it.box)));
    writes.push(asW(crossPos(it.box)));
    if (alignKind === "stretch") writes.push(asW(crossSize(it.box)));
  }

  return propagator(reads, writes, () => {
    const gap = readNow(opts.gap ?? 0);
    const pad = readNow(opts.padding ?? 0);
    const n = items.length;

    let sizes: number[];
    if (mode === "fit") {
      // Start each item at its hypothetical size (current main-size,
      // clamped to [min, max]).
      sizes = new Array(n);
      let sumW = 0;
      for (let i = 0; i < n; i++) {
        const it = items[i]!;
        const w0 = clamp(mainSize(it.box).value, it.min, it.max);
        sizes[i] = w0;
        sumW += w0;
      }
      const slack = mainSize(c).value - 2 * pad - (n - 1) * gap - sumW;

      if (slack > 1e-9) {
        // Grow.
        let remaining = slack;
        const eligible = new Set<number>();
        for (let i = 0; i < n; i++) {
          if (items[i]!.grow > 0 && sizes[i]! < items[i]!.max) eligible.add(i);
        }
        while (remaining > 1e-9 && eligible.size > 0) {
          let weights = 0;
          for (const i of eligible) weights += items[i]!.grow;
          if (weights === 0) break;
          let absorbed = 0;
          for (const i of [...eligible]) {
            const share = (remaining * items[i]!.grow) / weights;
            const newW = Math.min(sizes[i]! + share, items[i]!.max);
            absorbed += newW - sizes[i]!;
            sizes[i] = newW;
            if (newW >= items[i]!.max) eligible.delete(i);
          }
          if (absorbed < 1e-9) break;
          remaining -= absorbed;
        }
      } else if (slack < -1e-9) {
        // Shrink.
        let remaining = -slack;
        const eligible = new Set<number>();
        for (let i = 0; i < n; i++) {
          if (items[i]!.shrink > 0 && sizes[i]! > items[i]!.min) eligible.add(i);
        }
        while (remaining > 1e-9 && eligible.size > 0) {
          let weights = 0;
          for (const i of eligible) weights += items[i]!.shrink;
          if (weights === 0) break;
          let absorbed = 0;
          for (const i of [...eligible]) {
            const share = (remaining * items[i]!.shrink) / weights;
            const newW = Math.max(sizes[i]! - share, items[i]!.min);
            absorbed += sizes[i]! - newW;
            sizes[i] = newW;
            if (newW <= items[i]!.min) eligible.delete(i);
          }
          if (absorbed < 1e-9) break;
          remaining -= absorbed;
        }
      }
    } else {
      // hug: item sizes drive container.
      sizes = items.map(it => clamp(mainSize(it.box).value, it.min, it.max));
      let total = 2 * pad + (n - 1) * gap;
      for (const s of sizes) total += s;
      mainSize(c).value = total;
    }

    // Place items along main axis.
    let cursor = mainPos(c).value + pad;
    for (let i = 0; i < n; i++) {
      mainPos(items[i]!.box).value = cursor;
      if (mode === "fit") mainSize(items[i]!.box).value = sizes[i]!;
      cursor += sizes[i]! + gap;
    }

    // Cross-axis alignment.
    const cBase = crossPos(c).value + pad;
    const cAvail = crossSize(c).value - 2 * pad;
    for (const it of items) {
      const itSize = crossSize(it.box).value;
      switch (alignKind) {
        case "start":
          crossPos(it.box).value = cBase;
          break;
        case "center":
          crossPos(it.box).value = cBase + (cAvail - itSize) / 2;
          break;
        case "end":
          crossPos(it.box).value = cBase + cAvail - itSize;
          break;
        case "stretch":
          crossPos(it.box).value = cBase;
          crossSize(it.box).value = cAvail;
          break;
      }
    }
  });
}

// ─── grid ──────────────────────────────────────────────────────────

export interface GridOpts {
  /** Cells per row. */
  cols: number;
  /** Gap between cells (both axes). Use `gapX` / `gapY` to differ. */
  gap?: ValOrSig;
  gapX?: ValOrSig;
  gapY?: ValOrSig;
  padding?: ValOrSig;
}

/** Regular grid: items placed in a `cols`-wide grid. Cells equal-size,
 *  computed from container minus padding and gaps. */
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
  for (const it of items) writes.push(asW(it.x), asW(it.y), asW(it.w), asW(it.h));
  return propagator(reads, writes, () => {
    const pad = readNow(opts.padding ?? 0);
    const gap = readNow(opts.gap ?? 0);
    const gx = readNow(opts.gapX ?? gap);
    const gy = readNow(opts.gapY ?? gap);
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

// ─── inset ─────────────────────────────────────────────────────────

/** `inner` fills `outer` minus padding on all sides. Drag outer →
 *  inner follows. Default padding is 0 (inner == outer). */
export function inset(outer: Box, inner: Box, opts: { padding?: ValOrSig } = {}): Propagator {
  const reads: Num[] = [outer.x, outer.y, outer.w, outer.h, ...readDeps(opts.padding ?? 0)];
  const writes: Writable<NumClass>[] = [asW(inner.x), asW(inner.y), asW(inner.w), asW(inner.h)];
  return propagator(reads, writes, () => {
    const pad = readNow(opts.padding ?? 0);
    asW(inner.x).value = outer.x.value + pad;
    asW(inner.y).value = outer.y.value + pad;
    asW(inner.w).value = outer.w.value - 2 * pad;
    asW(inner.h).value = outer.h.value - 2 * pad;
  });
}

// ─── attach ────────────────────────────────────────────────────────

export type Side = "left" | "right" | "top" | "bottom";

/** Anchor `b`'s `bSide` to `a`'s `aSide` with optional gap.
 *
 *    attach(panel, sidebar, "right", "left", { gap: 8 })
 *      // sidebar.left = panel.right + 8
 *
 *  Bidirectional: drag a → b follows; drag b → a follows. */
export function attach(
  a: Box,
  b: Box,
  aSide: Side,
  bSide: Side,
  opts: { gap?: ValOrSig } = {},
): Propagator[] {
  const gapDeps = readDeps(opts.gap ?? 0);
  const gap = (): number => readNow(opts.gap ?? 0);

  const sideValue = (box: Box, side: Side): number => {
    switch (side) {
      case "left":
        return box.x.value;
      case "right":
        return box.x.value + box.w.value;
      case "top":
        return box.y.value;
      case "bottom":
        return box.y.value + box.h.value;
    }
  };
  const writeSide = (box: Box, side: Side, v: number): void => {
    switch (side) {
      case "left":
        asW(box.x).value = v;
        break;
      case "right":
        asW(box.x).value = v - box.w.value;
        break;
      case "top":
        asW(box.y).value = v;
        break;
      case "bottom":
        asW(box.y).value = v - box.h.value;
        break;
    }
  };

  return [
    propagator([a.x, a.y, a.w, a.h, b.w, b.h, ...gapDeps], [asW(b.x), asW(b.y)], () =>
      writeSide(b, bSide, sideValue(a, aSide) + gap()),
    ),
    propagator([b.x, b.y, b.w, b.h, a.w, a.h, ...gapDeps], [asW(a.x), asW(a.y)], () =>
      writeSide(a, aSide, sideValue(b, bSide) - gap()),
    ),
  ];
}

// ─── centerInside ──────────────────────────────────────────────────

/** Center `inner` inside `outer`. `inner.w/h` are preserved.
 *  Bidirectional: drag outer → inner re-centers; drag inner → outer
 *  shifts to keep inner centered. */
export function centerInside(outer: Box, inner: Box): Propagator[] {
  return [
    propagator(
      [outer.x, outer.y, outer.w, outer.h, inner.w, inner.h],
      [asW(inner.x), asW(inner.y)],
      () => {
        asW(inner.x).value = outer.x.value + (outer.w.value - inner.w.value) / 2;
        asW(inner.y).value = outer.y.value + (outer.h.value - inner.h.value) / 2;
      },
    ),
    propagator([inner.x, inner.y], [asW(outer.x), asW(outer.y)], () => {
      const targetX = inner.x.value - (outer.w.value - inner.w.value) / 2;
      const targetY = inner.y.value - (outer.h.value - inner.h.value) / 2;
      if (Math.abs(targetX - outer.x.value) > 1e-9) asW(outer.x).value = targetX;
      if (Math.abs(targetY - outer.y.value) > 1e-9) asW(outer.y).value = targetY;
    }),
  ];
}

// ─── pinEdge ───────────────────────────────────────────────────────

/** Pin one edge of a box to a fixed coordinate. The OPPOSITE edge
 *  stays put; size adjusts. */
export function pinEdge(b: Box, side: Side, target: ValOrSig): Propagator {
  const targetDeps = readDeps(target);
  const t = () => readNow(target);
  return propagator(
    [b.x, b.y, b.w, b.h, ...targetDeps],
    [asW(b.x), asW(b.y), asW(b.w), asW(b.h)],
    () => {
      const tv = t();
      switch (side) {
        case "left": {
          const right = b.x.value + b.w.value;
          asW(b.x).value = tv;
          asW(b.w).value = right - tv;
          break;
        }
        case "right":
          asW(b.w).value = tv - b.x.value;
          break;
        case "top": {
          const bot = b.y.value + b.h.value;
          asW(b.y).value = tv;
          asW(b.h).value = bot - tv;
          break;
        }
        case "bottom":
          asW(b.h).value = tv - b.y.value;
          break;
      }
    },
  );
}

// ─── lockSize ──────────────────────────────────────────────────────

/** Lock a box's width or height to a fixed value (or signal). */
export function lockSize(b: Box, axis: "w" | "h", target: ValOrSig): Propagator {
  const deps = readDeps(target);
  const cell = axis === "w" ? asW(b.w) : asW(b.h);
  return propagator([cell, ...deps], [cell], () => {
    const v = readNow(target);
    if (cell.value !== v) cell.value = v;
  });
}

// ─── follow ────────────────────────────────────────────────────────

/** One-way mirror: `follower` tracks `leader` exactly. */
export function follow(leader: Box, follower: Box): Propagator {
  return propagator(
    [leader.x, leader.y, leader.w, leader.h],
    [asW(follower.x), asW(follower.y), asW(follower.w), asW(follower.h)],
    () => {
      asW(follower.x).value = leader.x.value;
      asW(follower.y).value = leader.y.value;
      asW(follower.w).value = leader.w.value;
      asW(follower.h).value = leader.h.value;
    },
  );
}
