// Value types in v2 style — plain configs through `defineType`.
//
// Compare to current `values/transform.ts` (130 LOC, ~70 of which is
// cut-and-paste algebra/lerp/metric): Transform here is ~15 LOC. The
// capabilities are derived from `nested` mechanically.

import { defineType, computed, type Cell } from "./cell";

// ── Num ─────────────────────────────────────────────────────────────

export const Num = defineType({
  name: "Num",
  defaults: 0 as number,
  lerp: (a, b, t) => a + (b - a) * t,
  algebra: { add: (a, b) => a + b, sub: (a, b) => a - b, scale: (a, k) => a * k },
  metric: (a, b) => Math.abs(a - b),
  methods: {
    clamp: (a, lo: number, hi: number) => (a < lo ? lo : a > hi ? hi : a),
    abs: (a) => Math.abs(a),
  },
});

// ── Vec ─────────────────────────────────────────────────────────────

export interface V { x: number; y: number; }

export const Vec = defineType({
  name: "Vec",
  defaults: { x: 0, y: 0 } as V,
  equals: (a, b) => a.x === b.x && a.y === b.y,
  lerp: (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }),
  algebra: {
    add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
    sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
    scale: (a, k) => ({ x: a.x * k, y: a.y * k }),
  },
  metric: (a, b) => Math.hypot(a.x - b.x, a.y - b.y),
  // AoS storage — lazy lens axes (no `soa: true`)
  methods: {
    perp: (a): V => ({ x: -a.y, y: a.x }),
    normalize: (a): V => {
      const len = Math.hypot(a.x, a.y) || 1;
      return { x: a.x / len, y: a.y / len };
    },
  },
  getters: {
    // NOTE: avoid `length` here — Function.prototype.length is read-only.
    // The framework's RESERVED_NAMES check would throw at construction.
    magnitude(this: Cell<V>) {
      const self = this;
      return computed(() => {
        const v = self() as V;
        return Math.hypot(v.x, v.y);
      });
    },
  },
});

// ── Transform ───────────────────────────────────────────────────────

export interface Tr {
  translate: V; rotate: number; scale: V; origin: V; opacity: number;
}

// NOTE: NO algebra/lerp/metric/equals here. Derived from `nested`.
export const Transform = defineType({
  name: "Transform",
  defaults: {
    translate: { x: 0, y: 0 }, rotate: 0,
    scale: { x: 1, y: 1 }, origin: { x: 0, y: 0 }, opacity: 1,
  } as Tr,
  nested: {
    translate: Vec as any, scale: Vec as any, origin: Vec as any,
    rotate: Num as any, opacity: Num as any,
  },
  soa: true as const,
});
