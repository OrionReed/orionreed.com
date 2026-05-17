// values/index.ts — re-exports the public surface of each value type.
//
// The cell class + factory + plain-shape type are exported with
// type-prefixed names so they don't collide. Pure math fns live inside
// each per-type file and can be deep-imported when needed:
//
//   import * as VecMath from "@minim/signals2/values/vec";
//   VecMath.add(a, b);

export { Num, num, type Value as NumValue } from "./num";
export { Vec, vec, type Value as VecValue } from "./vec";
export { Color, rgb, rgba, type Value as ColorValue } from "./color";
export { Box, box, type Value as BoxValue } from "./box";
export {
  Transform, transform,
  type Value as TransformValue,
  type Init as TransformInit,
} from "./transform";

// ════════════════════════════════════════════════════════════════════
// mean<T> — generic via [LINEAR]
// ════════════════════════════════════════════════════════════════════

import { Signal, computed, type Computed } from "../signal";
import { requireLinear } from "../traits";

/** Reactive arithmetic mean. Requires `[LINEAR]` on the first cell. */
export function mean<T>(...cells: Signal<T>[]): Computed<T> {
  if (cells.length === 0) throw new Error("mean: need ≥1 cell");
  const linear = requireLinear(cells[0]);
  const n = cells.length;
  const invN = 1 / n;
  return computed(() => {
    let acc = cells[0].value;
    for (let i = 1; i < n; i++) acc = linear.add(acc, cells[i].value);
    return linear.scale(acc, invN);
  });
}
