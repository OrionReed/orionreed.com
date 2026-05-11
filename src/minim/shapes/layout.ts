// Spatial composition primitives. Reference points for growth:
// Manim's `next_to`, `align_to`, `arrange_in_grid`, `move_to`.

import { transformAABB } from "../scene/matrix";
import type { Shape } from "../scene";

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
