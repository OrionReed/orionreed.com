// Shape-flavored aggregates. Wraps the generic vector aggregates
// from `signals/aggregates` with shape-specific helpers (`centroid`
// over translates; `meanRotation`/`meanScale` over those fields).

import type { Signal } from "../core/signal";
import { meanVec, meanNum } from "../signals/aggregates";
import type { Point } from "../signals/vec";
import type { Writable } from "./shape";

export { meanVec, meanNum };

/** Centroid of N shapes' translates as a writable Point. Tween it to
 *  move the group rigidly. */
export function centroid(...shapes: Writable<"translate">[]): Point {
  return meanVec(...shapes.map((s) => s.translate)) as Point;
}

/** Mean rotation as a writable signal; writes rotate every shape by
 *  the same delta. */
export function meanRotation(
  ...shapes: Writable<"rotate">[]
): Signal<number> {
  return meanNum(...shapes.map((s) => s.rotate));
}

/** Mean scale as a writable Point. */
export function meanScale(...shapes: Writable<"scale">[]): Point {
  return meanVec(...shapes.map((s) => s.scale)) as Point;
}
