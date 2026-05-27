// anchor.ts — points on the unit box `[0,1]²` (registration on a shape).
// dir.ts — unit direction vectors in `[-1,1]²` (displacement from rest).
//
// Plain constants — no reactive wrapping. Use as defaults / arguments.

import type { Inner } from "../signal";
import type { Vec } from "./vec";

type V = Inner<Vec>;

/** Anchor points on the unit box (`Center = {0.5, 0.5}`). */
export const Anchor = {
  TopLeft: { x: 0, y: 0 } as V,
  Top: { x: 0.5, y: 0 } as V,
  TopRight: { x: 1, y: 0 } as V,
  Left: { x: 0, y: 0.5 } as V,
  Center: { x: 0.5, y: 0.5 } as V,
  Right: { x: 1, y: 0.5 } as V,
  BottomLeft: { x: 0, y: 1 } as V,
  Bottom: { x: 0.5, y: 1 } as V,
  BottomRight: { x: 1, y: 1 } as V,
};

/** Unit direction vectors (y-down: `Up = {0,-1}`). */
export const Dir = {
  Left: { x: -1, y: 0 } as V,
  Right: { x: 1, y: 0 } as V,
  Up: { x: 0, y: -1 } as V,
  Down: { x: 0, y: 1 } as V,
};
