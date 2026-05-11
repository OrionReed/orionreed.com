// Writable aggregates — `lens(read, write)` over N signals. Reads
// query the aggregate; writes distribute the delta back, preserving
// relative offsets. `centroid(...).to(target, sec)` moves the group
// rigidly with no special choreographer.

import { lens, type Signal } from "../core/signal";
import type { Vec } from "../core/vec";
import { toPoint, type Point } from "./point";
import type { Writable } from "./shape";

/** Mean of N writable Vec signals as a writable `Point`. Writes apply
 *  the delta to every input. Primitive `centroid` is sugar over. */
export function meanVec(...sigs: Signal<Vec>[]): Point {
  return toPoint(
    lens<Vec>(
      () => {
        let sx = 0;
        let sy = 0;
        for (const s of sigs) {
          const v = s.value;
          sx += v.x;
          sy += v.y;
        }
        const n = sigs.length || 1;
        return { x: sx / n, y: sy / n };
      },
      (next) => {
        let oldSx = 0;
        let oldSy = 0;
        for (const s of sigs) {
          const v = s.peek();
          oldSx += v.x;
          oldSy += v.y;
        }
        const n = sigs.length || 1;
        const dx = next.x - oldSx / n;
        const dy = next.y - oldSy / n;
        for (const s of sigs) {
          const v = s.peek();
          s.value = { x: v.x + dx, y: v.y + dy };
        }
      },
    ),
  );
}

/** Scalar sibling of `meanVec`. */
export function meanNum(...sigs: Signal<number>[]): Signal<number> {
  return lens<number>(
    () => {
      let sum = 0;
      for (const s of sigs) sum += s.value;
      return sum / (sigs.length || 1);
    },
    (next) => {
      let oldSum = 0;
      for (const s of sigs) oldSum += s.peek();
      const delta = next - oldSum / (sigs.length || 1);
      for (const s of sigs) s.value = s.peek() + delta;
    },
  );
}

/** Centroid of N shapes' translates as a writable `Point`. Tween it to
 *  move the group rigidly. */
export function centroid(...shapes: Writable<"translate">[]): Point {
  return meanVec(...shapes.map((s) => s.translate));
}

/** Mean rotation as a writable `Signal<number>`; writes rotate every
 *  shape by the same delta. */
export function meanRotation(
  ...shapes: Writable<"rotate">[]
): Signal<number> {
  return meanNum(...shapes.map((s) => s.rotate));
}

/** Mean scale as a writable `Point`. */
export function meanScale(...shapes: Writable<"scale">[]): Point {
  return meanVec(...shapes.map((s) => s.scale));
}
