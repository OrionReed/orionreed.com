// Shape-flavored aggregates over the generic `mean<T>`. Each is a
// writable view: tween it to move the group rigidly (translate),
// rotate every shape by the same delta (rotate), or scale them in
// lockstep (scale).

import type { Signal } from "../core/signal";
import { mean } from "../signals/aggregates";
import type { Point } from "../signals/vec";
import type { Writable } from "./shape";

/** Centroid of N shapes' translates, as a writable Point. */
export function centroid(...shapes: Writable<"translate">[]): Point {
  return mean(...shapes.map((s) => s.translate)) as Point;
}

/** Mean rotation as a writable signal. */
export function meanRotation(
  ...shapes: Writable<"rotate">[]
): Signal<number> {
  return mean(...shapes.map((s) => s.rotate));
}

/** Mean scale as a writable Point. */
export function meanScale(...shapes: Writable<"scale">[]): Point {
  return mean(...shapes.map((s) => s.scale)) as Point;
}
