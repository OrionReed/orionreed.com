// Aggregates declared via `combine` from the lens module. Replaces
// the 82-line scene/aggregates.ts. Each function is a 4-6 line factory
// declaring (merge, distribute) for one shape.

import { combine } from "./lens";
import { Vec, type V } from "./vec";
import type { Signal } from "../core/signal";

/** Mean of N writable Vec signals as a writable Reactive<Vec>. Writes
 *  apply the delta to every input — moves the group rigidly. */
export function meanVec(...sigs: Signal<V>[]) {
  const merged = combine<V>(
    sigs,
    (vs) => {
      let sx = 0,
        sy = 0;
      for (const v of vs) {
        sx += v.x;
        sy += v.y;
      }
      const n = vs.length || 1;
      return { x: sx / n, y: sy / n };
    },
    (next, prev) => {
      let sumX = 0,
        sumY = 0;
      for (const v of prev) {
        sumX += v.x;
        sumY += v.y;
      }
      const n = prev.length || 1;
      const dx = next.x - sumX / n;
      const dy = next.y - sumY / n;
      return prev.map((v) => ({ x: v.x + dx, y: v.y + dy }));
    },
  );
  // Wrap as Reactive<Vec> so callers get the Vec method surface
  // (.add, .x, .scale, .in, …) on the aggregate.
  return Vec.lens(
    () => merged.value,
    (v) => {
      merged.value = v;
    },
  );
}

/** Mean of N writable scalar signals. */
export function meanNum(...sigs: Signal<number>[]) {
  return combine<number>(
    sigs,
    (vs) => {
      let s = 0;
      for (const v of vs) s += v;
      return s / (vs.length || 1);
    },
    (next, prev) => {
      let oldSum = 0;
      for (const v of prev) oldSum += v;
      const delta = next - oldSum / (prev.length || 1);
      return prev.map((v) => v + delta);
    },
  );
}
