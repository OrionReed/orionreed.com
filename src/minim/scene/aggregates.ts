// Aggregate views over collections of signals/shapes. Variadic in,
// signal out — built on the generic `lens(read, write)` primitive so
// the result is writable. Reading queries the aggregate; writing
// distributes the change back to the underlying inputs.
//
// `centroid(a, b, c).to(target, sec)` moves the group rigidly: the
// tween writes the centroid each frame; the lens converts each write
// into a per-shape translate delta. Animation falls out of `.to(...)`
// for free; there's no separate "choreographer" needed for rigid
// translation.

import { lens, type Signal } from "../core/signal";
import type { Vec } from "../core/vec";
import { Point } from "./point";
import type { Writable } from "./shape";

/** Average of N writable Vec signals as a writable `Point`. Reads
 *  return the component-wise mean; writes apply the delta from the
 *  current mean to every input, preserving relative offsets. The
 *  primitive that `centroid(...shapes)` is sugar over. */
export function meanVec(...sigs: Signal<Vec>[]): Point {
  return Point.from(
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

/** Scalar sibling of `meanVec`. Reads the average of N writable number
 *  signals; writes distribute the delta from the current mean. */
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

/** Centroid of N shapes' translates as a writable `Point`. Sugar over
 *  `meanVec` applied to `s.translate` for each shape. Tweening
 *  (`centroid(...).to(target, sec)`) moves the group rigidly.
 *
 *  Shapes are constrained to `Writable<"translate">` — derived-
 *  translate shapes (`group({ translate: computed(...) })`) can't be
 *  the target of a centroid write and are rejected at the type level. */
export function centroid(...shapes: Writable<"translate">[]): Point {
  return meanVec(...shapes.map((s) => s.translate));
}

/** Mean rotation of N shapes as a writable `Signal<number>`. Writes
 *  apply the delta rigidly — every shape rotates by the same amount,
 *  preserving relative orientations. */
export function meanRotation(
  ...shapes: Writable<"rotate">[]
): Signal<number> {
  return meanNum(...shapes.map((s) => s.rotate));
}

/** Mean scale of N shapes as a writable `Point`. Writes distribute
 *  the delta to each shape's scale, preserving relative size offsets. */
export function meanScale(...shapes: Writable<"scale">[]): Point {
  return meanVec(...shapes.map((s) => s.scale));
}
