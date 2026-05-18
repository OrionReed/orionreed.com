// Spatial composition primitives. Reference points for growth:
// Manim's `next_to`, `align_to`, `arrange_in_grid`, `move_to`.

import {
  num, derived, transformBox, Box, BoxMath,
  type Boxed, type Val,
} from "@minim/signals";
import type { Shape } from "./shape";

export interface ArrangeOpts {
  /** Spacing between adjacent bounding boxes. Default 0. */
  gap?: number;
  /** Cross-axis align vs the first shape: 0 top/left, 0.5 center,
   *  1 bottom/right. Default 0. */
  align?: number;
}

/** Lay out `shapes` in a row/column. First stays put; the rest bind
 *  their `translate` reactively to sit `gap` past the previous.
 *  Reflows on size or anchor change. */
export function arrange(
  shapes: readonly Shape[],
  axis: "row" | "column",
  opts: ArrangeOpts = {},
): void {
  const gap = opts.gap ?? 0;
  const cross = opts.align ?? 0;
  if (shapes.length < 2) return;
  const anchor = shapes[0];
  for (let i = 1; i < shapes.length; i++) {
    const prev = shapes[i - 1];
    const cur = shapes[i];
    cur.effect(() => {
      // prev/anchor in the parent frame so upstream transforms
      // cascade; cur stays local since we're writing its own translate.
      const pBox = transformBox(prev.localFrame.value, prev.box.value);
      const aBox = transformBox(anchor.localFrame.value, anchor.box.value);
      const cb = cur.box.value;
      if (axis === "row") {
        const targetX = pBox.x + pBox.w + gap;
        const targetY = aBox.y + cross * aBox.h - cross * cb.h;
        cur.translate.value = {
          x: targetX - cb.x,
          y: targetY - cb.y,
        };
      } else {
        const targetY = pBox.y + pBox.h + gap;
        const targetX = aBox.x + cross * aBox.w - cross * cb.w;
        cur.translate.value = {
          x: targetX - cb.x,
          y: targetY - cb.y,
        };
      }
    });
  }
}

// ── Box operations ──────────────────────────────────────────────────
// Functions over `Boxed` ({ box: Box }). Inputs: any reactive
// rectangle (Shape, view, another split result). Outputs: derived
// Box cells that update reactively as the source changes.

/** Inflate a Box on each side by `by`. */
export function expand(b: Boxed, by: Val<number>): Box {
  const bys = num(by);
  return derived(Box, () => BoxMath.expand(b.box.value, bys.value));
}

/** Split a Box along an axis into N reactive sub-Boxes.
 *
 *   split(b, "x", 3)              — 3 equal columns
 *   split(b, "x", [3, 2, 2])      — weighted 3:2:2
 *   split(b, "x", 3, { gap: 4 })  — 4px between
 */
export function split(
  source: Boxed,
  axis: "x" | "y",
  parts: number | number[],
  opts: { gap?: Val<number> } = {},
): Box[] {
  const ratios = typeof parts === "number" ? new Array(parts).fill(1) : parts;
  const total = ratios.reduce((a, b) => a + b, 0);
  const cumBefore = ratios.map((_, i) =>
    ratios.slice(0, i).reduce((a, b) => a + b, 0),
  );
  const gapSig = num(opts.gap ?? 0);
  return ratios.map((r, i) =>
    derived(Box, () => {
      const b = source.box.value;
      const gap = gapSig.value;
      const gapTotal = gap * (ratios.length - 1);
      if (axis === "x") {
        const free = b.w - gapTotal;
        const offset = (cumBefore[i] / total) * free + gap * i;
        return { x: b.x + offset, y: b.y, w: (r / total) * free, h: b.h };
      }
      const free = b.h - gapTotal;
      const offset = (cumBefore[i] / total) * free + gap * i;
      return { x: b.x, y: b.y + offset, w: b.w, h: (r / total) * free };
    }),
  );
}

/** Two-axis split into a `rows × cols` grid (sugar over `split`).
 *  Returns `[row][col]`. */
export function grid(
  source: Boxed,
  rows: number,
  cols: number,
  opts: { gap?: Val<number> } = {},
): Box[][] {
  return split(source, "y", rows, opts).map((row) =>
    split(row, "x", cols, opts),
  );
}
