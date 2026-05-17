// Named spatial constants — two coordinate spaces, two meanings.
//
//   Anchor — points on the unit box `[0, 1]²`. A registration point
//            *on* a shape. Pair with size: `pos = origin + a · size`.
//
//   Dir    — direction vectors in `[-1, 1]²`. A displacement *from*
//            rest. Pair with distance: `offset = dir · dist`. Cardinals
//            are unit vectors.
//
// They overlap on the cardinal cross-section (left/right/top/bottom)
// but model different things — keeping them separate keeps each call
// site honest about whether it means a point or a vector.

import type { Value as VecValue } from "./vec";

/** Anchor points on a unit box. `TopLeft` = `{0, 0}`, `Center` =
 *  `{0.5, 0.5}`, `BottomRight` = `{1, 1}`. */
export const Anchor = {
  TopLeft:     { x: 0,   y: 0   } as VecValue,
  Top:         { x: 0.5, y: 0   } as VecValue,
  TopRight:    { x: 1,   y: 0   } as VecValue,
  Left:        { x: 0,   y: 0.5 } as VecValue,
  Center:      { x: 0.5, y: 0.5 } as VecValue,
  Right:       { x: 1,   y: 0.5 } as VecValue,
  BottomLeft:  { x: 0,   y: 1   } as VecValue,
  Bottom:      { x: 0.5, y: 1   } as VecValue,
  BottomRight: { x: 1,   y: 1   } as VecValue,
};

/** Unit direction vectors. `Left` = `{-1, 0}`, `Up` = `{0, -1}` (y-down). */
export const Dir = {
  Left:  { x: -1, y:  0 } as VecValue,
  Right: { x:  1, y:  0 } as VecValue,
  Up:    { x:  0, y: -1 } as VecValue,
  Down:  { x:  0, y:  1 } as VecValue,
};
