// Spatial composition primitives. Grows as patterns crystallize;
// Manim's `next_to`, `align_to`, `arrange_in_grid`, `move_to` are the
// reference points for what to add next.

import type { Vec } from "../core";
import { transformAABB } from "../scene/matrix";
import type { Shape } from "../scene";

/** Named normalized-Vec constants — points on a unit box. Plain `Vec`
 *  values, pass anywhere a `Vec` is expected (e.g. `Label.align`). */
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
  /** Spacing between adjacent bounding boxes. Default 0. */
  gap?: number;
  /** Cross-axis alignment vs the first shape: `0` top/left,
   *  `0.5` centered, `1` bottom/right. Default 0. */
  align?: number;
}

/** Place `shapes` in a row or column. The first stays put; the rest
 *  bind their `translate` reactively so each box sits `gap` past the
 *  previous on the chosen axis. Reflows when any shape's intrinsic
 *  size animates or the anchor moves. */
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
      // Read prev/anchor bounds in the parent frame (so transforms
      // upstream cascade); cur stays in local frame since we're about
      // to write its own translate.
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
