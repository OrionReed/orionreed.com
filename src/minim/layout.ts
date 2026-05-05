// Spatial composition primitives — sit on top of the reactive Vec /
// Point / Bounds machinery. Two flavors:
//
//   `align`   — named normalized-Vec constants. Used wherever an API
//               wants "where on a box" semantics: `Label.align`,
//               `bounds.at(...)` callsites, `arrange`'s alignment opt.
//   `arrange` — set translates so a row/column of shapes sits
//               edge-to-edge with a gap. Reactive on each shape's
//               local-frame `bounds`, so animating widths reflows.
//
// Designed to grow as patterns crystallize. Manim's verb set
// (`next_to`, `align_to`, `arrange_in_grid`, `move_to`) is the
// reference for what to crystallize next.

import type { Vec } from "./bounds";
import { transformAABB } from "./matrix";
import type { Shape } from "./shape";

/** Named normalized Vec constants — points on a unit box.
 *
 *  `align.center` = `{x: 0.5, y: 0.5}`. `align.bottomLeft` = `{x: 0, y: 1}`.
 *  Etc. Plain Vec values, no separate type — pass anywhere a `Vec` is
 *  expected (e.g. `Label.align`, `bounds.at(u, v)` you can substitute
 *  `at(...align.tr)` if you like the named look). */
export const align = {
  topLeft:     { x: 0, y: 0 } as Vec,
  topRight:    { x: 1, y: 0 } as Vec,
  bottomLeft:  { x: 0, y: 1 } as Vec,
  bottomRight: { x: 1, y: 1 } as Vec,
  top:         { x: 0.5, y: 0 } as Vec,
  bottom:      { x: 0.5, y: 1 } as Vec,
  left:        { x: 0, y: 0.5 } as Vec,
  right:       { x: 1, y: 0.5 } as Vec,
  center:      { x: 0.5, y: 0.5 } as Vec,
};

export interface ArrangeOpts {
  /** Spacing between adjacent shapes' bounding boxes. Default 0. */
  gap?: number;
  /** Cross-axis alignment of each shape relative to the first shape's
   *  bounds along the cross axis. `0` = top/left, `0.5` = centered,
   *  `1` = bottom/right. Default 0 (no cross-axis alignment). */
  align?: number;
}

/** Place `shapes` in a row or column with optional gap. The first
 *  shape stays where it is; each subsequent shape's `translate` is
 *  reactively bound so its bounding box sits `gap` past the previous
 *  shape's bounding box on the chosen axis.
 *
 *  Reactive: animating any shape's intrinsic size or repositioning
 *  the anchor reflows the remainder. Each binding is tracked on the
 *  moved shape so it tears down with the shape.
 *
 *  Implementation note: prev's and anchor's bounds are taken in the
 *  *parent's* frame (via their full transform), so translates on the
 *  anchor or rotations elsewhere cascade correctly. We then write to
 *  cur's translate to position cur's local bounds at the target. */
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
      // Bounds in the parent frame for prev and anchor — accounts for
      // their translate/rotate/scale. Local bounds for cur (we're
      // about to write its translate, so we don't compose it in).
      const pAABB = transformAABB(prev.transform.value, prev.bounds.value);
      const aAABB = transformAABB(anchor.transform.value, anchor.bounds.value);
      const cb = cur.bounds.value;
      if (axis === "row") {
        const targetX = pAABB.x + pAABB.w + gap;
        const targetY = aAABB.y + cross * aAABB.h - cross * cb.h;
        cur.translate.value = {
          x: targetX - cb.x,
          y: targetY - cb.y,
        };
      } else {
        const targetY = pAABB.y + pAABB.h + gap;
        const targetX = aAABB.x + cross * aAABB.w - cross * cb.w;
        cur.translate.value = {
          x: targetX - cb.x,
          y: targetY - cb.y,
        };
      }
    });
  }
}
