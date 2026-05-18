// Anchor: points on the unit box `[0,1]²` (registration on a shape).
// Dir: unit direction vectors in `[-1,1]²` (displacement from rest).

import type { Value as VecValue } from "./vec";

/** Anchor points on the unit box (`Center = {0.5, 0.5}`). */
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

/** Unit direction vectors (y-down: `Up = {0,-1}`). */
export const Dir = {
  Left:  { x: -1, y:  0 } as VecValue,
  Right: { x:  1, y:  0 } as VecValue,
  Up:    { x:  0, y: -1 } as VecValue,
  Down:  { x:  0, y:  1 } as VecValue,
};
