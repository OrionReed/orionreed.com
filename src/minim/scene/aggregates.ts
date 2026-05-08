// Aggregate views over collections of shapes. Variadic in, signal out
// — built on the generic `lens(read, write)` primitive so the result
// is a writable `Point`. Reading queries the aggregate; writing
// distributes the change back to the underlying shapes.
//
// `centroid(a, b, c).to(target, sec)` moves the group rigidly: the
// tween writes the centroid each frame; the lens converts each write
// into a per-shape translate delta. No separate "choreographer" API
// — animation falls out of `Point.to` for free.

import { lens } from "../core/signal";
import type { Vec } from "../core/vec";
import { Point } from "./point";
import type { Writable } from "./shape";

/** Centroid of N shapes' translates as a writable `Point`. Reads
 *  return the average of `s.translate.value` across `shapes`; writes
 *  apply the delta from the current centroid to every shape's
 *  translate, preserving relative offsets. Tweening (`.to(target,
 *  sec)`) animates the group rigidly.
 *
 *  Shapes are constrained to `Writable<"translate">` — derived-
 *  translate shapes (`group({ translate: computed(...) })`) can't be
 *  the target of a centroid write and are rejected at the type level. */
export function centroid(...shapes: Writable<"translate">[]): Point {
  return Point.from(
    lens<Vec>(
      () => {
        let sx = 0;
        let sy = 0;
        for (const s of shapes) {
          const t = s.translate.value;
          sx += t.x;
          sy += t.y;
        }
        const n = shapes.length || 1;
        return { x: sx / n, y: sy / n };
      },
      (next) => {
        let oldSx = 0;
        let oldSy = 0;
        for (const s of shapes) {
          const t = s.translate.peek();
          oldSx += t.x;
          oldSy += t.y;
        }
        const n = shapes.length || 1;
        const dx = next.x - oldSx / n;
        const dy = next.y - oldSy / n;
        for (const s of shapes) {
          const t = s.translate.peek();
          s.translate.value = { x: t.x + dx, y: t.y + dy };
        }
      },
    ),
  );
}
