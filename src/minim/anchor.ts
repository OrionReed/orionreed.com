// Named spatial constants — two coordinate spaces, two meanings.
//
//   Anchor — points on the unit box `[0, 1]²`. A registration point
//            *on* a shape. Pair with size: `pos = origin + a · size`.
//            Used by `label.align`, `button` content, transform-origin.
//
//   Dir    — direction vectors in `[-1, 1]²`. A displacement *from*
//            rest. Pair with distance: `offset = dir · dist`. Cardinals
//            are unit vectors. Used by `slideIn` / `slideOut`.
//
// They overlap on the cardinal cross-section (left/right/top/bottom)
// but model different things — keeping them separate keeps each call
// site honest about whether it means a point or a vector.

import type { V } from "./signals/vec";

/** Anchor points on a unit box. `TopLeft` = `{0, 0}`, `Center` =
 *  `{0.5, 0.5}`, `BottomRight` = `{1, 1}`. Pass to anything that takes
 *  a registration point (`label.align`, `button`, etc.) — or any other
 *  `V` in `[0, 1]²` for off-axis anchors. */
export const Anchor = {
  TopLeft:     { x: 0,   y: 0   } as V,
  Top:         { x: 0.5, y: 0   } as V,
  TopRight:    { x: 1,   y: 0   } as V,
  Left:        { x: 0,   y: 0.5 } as V,
  Center:      { x: 0.5, y: 0.5 } as V,
  Right:       { x: 1,   y: 0.5 } as V,
  BottomLeft:  { x: 0,   y: 1   } as V,
  Bottom:      { x: 0.5, y: 1   } as V,
  BottomRight: { x: 1,   y: 1   } as V,
};

/** Unit direction vectors. `Left` = `{-1, 0}`, `Up` = `{0, -1}`
 *  (y-down). Pass to `slideIn` / `slideOut`, or any other `V` for
 *  diagonals (`{ x: 0.7, y: 0.7 }` etc.). */
export const Dir = {
  Left:  { x: -1, y:  0 } as V,
  Right: { x:  1, y:  0 } as V,
  Up:    { x:  0, y: -1 } as V,
  Down:  { x:  0, y:  1 } as V,
};
