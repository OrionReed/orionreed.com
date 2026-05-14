// Value-type definitions for the unified prototype. Each is a plain
// TypeConfig — no Builder, no defineStruct. Transform notably omits
// algebra/lerp/metric; the framework derives them from nested.

import { computed } from "@minim/signals";
import type { TypeConfig } from "./unified";

type V = { x: number; y: number };

export const NumT: TypeConfig<number> = {
  name: "Num",
  defaults: 0,
  lerp: (a, b, t) => a + (b - a) * t,
  algebra: { add: (a, b) => a + b, sub: (a, b) => a - b, scale: (a, k) => a * k },
  metric: (a, b) => Math.abs(a - b),
};

export const VecT: TypeConfig<V> = {
  name: "Vec",
  defaults: { x: 0, y: 0 },
  equals: (a, b) => a.x === b.x && a.y === b.y,
  lerp: (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }),
  algebra: {
    add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
    sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
    scale: (a, k) => ({ x: a.x * k, y: a.y * k }),
  },
  metric: (a, b) => Math.hypot(a.x - b.x, a.y - b.y),
  // No `nested` — AoS storage. Axes use lazy lenses.
  ops: {
    perp: (a) => ({ x: -a.y, y: a.x }),
  },
  getters: {
    length(this) {
      const self = this;
      return computed(() => Math.hypot(self.value.x, self.value.y));
    },
  },
};

type Tr = {
  translate: V;
  rotate: number;
  scale: V;
  origin: V;
  opacity: number;
};

// NOTE: NO algebra / lerp / metric here. They're synthesized
// mechanically by typeFor() from the nested map. This is the ~70 LOC
// that current values/transform.ts pays for.
export const TransformT: TypeConfig<Tr> = {
  name: "Transform",
  defaults: {
    translate: { x: 0, y: 0 },
    rotate: 0,
    scale: { x: 1, y: 1 },
    origin: { x: 0, y: 0 },
    opacity: 1,
  },
  nested: {
    translate: VecT,
    scale: VecT,
    origin: VecT,
    rotate: NumT,
    opacity: NumT,
  },
  soa: true,
};
