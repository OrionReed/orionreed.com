// Vec on the new struct Builder. Surface-equivalent to current
// signals/vec.ts. Same fluent style as today; underneath it's
// ~⅓ the framework code.

import { computed, effect, type ReadonlySignal } from "../../core/signal";
import { struct } from "./struct";

export type V = { x: number; y: number };

export const Vec = struct<V>("Vec", { x: 0, y: 0 })
  .construct((x: number, y: number): V => ({ x, y }))
  .equals((a, b) => a.x === b.x && a.y === b.y)
  .ops({
    add: (a, b: V): V => ({ x: a.x + b.x, y: a.y + b.y }),
    sub: (a, b: V): V => ({ x: a.x - b.x, y: a.y - b.y }),
    scale: (a, k: number): V => ({ x: a.x * k, y: a.y * k }),
    perp: (a): V => ({ x: -a.y, y: a.x }),
    normalize: (a): V => {
      const len = Math.hypot(a.x, a.y) || 1;
      return { x: a.x / len, y: a.y / len };
    },
    lerp: (a, b: V, t: number): V => ({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
    }),
    offset: (a, dx: number, dy: number): V => ({
      x: a.x + dx,
      y: a.y + dy,
    }),
    up: (a, n: number): V => ({ x: a.x, y: a.y - n }),
    down: (a, n: number): V => ({ x: a.x, y: a.y + n }),
    left: (a, n: number): V => ({ x: a.x - n, y: a.y }),
    right: (a, n: number): V => ({ x: a.x + n, y: a.y }),
  })
  .scalars({
    distance: (a, b: V): number => Math.hypot(a.x - b.x, a.y - b.y),
  })
  .getters({
    length(this: { value: V }): ReadonlySignal<number> {
      const self = this;
      return computed(() => Math.hypot(self.value.x, self.value.y));
    },
  })
  .methods({
    set(this: { value: V }, target: { value: V }) {
      this.value = target.value;
      return this;
    },
    bind(this: { value: V }, target: { value: V }) {
      const self = this;
      return effect(() => {
        self.value = target.value;
      });
    },
  })
  .build();
