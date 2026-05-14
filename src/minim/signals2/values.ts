// Value types — plain configs through `struct({...})`.
//
// Compare to current `values/transform.ts` (130 LOC, ~70 of which is
// hand-written algebra/lerp/metric/equals): Transform here is ~15 LOC.
// The capabilities compose mechanically from `nested:`.

import { struct, computed, type Cell } from "./cell";

// ── Num ─────────────────────────────────────────────────────────────

export const Num = struct({
  name: "Num",
  defaults: 0 as number,
  lerp: (a, b, t) => a + (b - a) * t,
  linear: { add: (a, b) => a + b, sub: (a, b) => a - b, scale: (a, k) => a * k },
  metric: (a, b) => Math.abs(a - b),
  methods: {
    clamp: (a, lo: number, hi: number) => (a < lo ? lo : a > hi ? hi : a),
    abs: (a) => Math.abs(a),
  },
});

// ── Vec ─────────────────────────────────────────────────────────────

export interface V { x: number; y: number; }

export const Vec = struct({
  name: "Vec",
  defaults: { x: 0, y: 0 } as V,
  equals: (a, b) => a.x === b.x && a.y === b.y,
  lerp: (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }),
  linear: {
    add:   (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
    sub:   (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
    scale: (a, k) => ({ x: a.x * k, y: a.y * k }),
  },
  metric: (a, b) => Math.hypot(a.x - b.x, a.y - b.y),
  // AoS storage (default) — lazy lens-style field projections.
  methods: {
    perp: (a): V => ({ x: -a.y, y: a.x }),
    normalize: (a): V => {
      const len = Math.hypot(a.x, a.y) || 1;
      return { x: a.x / len, y: a.y / len };
    },
  },
  getters: {
    // `length` is reserved (Function.prototype.length). RESERVED_NAMES
    // throws at struct() time if you try to use it.
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

// NO linear/lerp/metric/equals here — composed from nested:Vec/Num.
// SoA storage so per-field writes don't fire whole-Transform readers.
export const Transform = struct({
  name: "Transform",
  defaults: {
    translate: { x: 0, y: 0 }, rotate: 0,
    scale: { x: 1, y: 1 }, origin: { x: 0, y: 0 }, opacity: 1,
  } as Tr,
  // No `as any` casts — preserving the literal Type values is what
  // makes EffectivelyHas walk through to discover Vec/Num capabilities
  // at the type level. Without preservation, Transform.lerp/add/distance
  // wouldn't surface on the cell type.
  nested: {
    translate: Vec, scale: Vec, origin: Vec,
    rotate: Num, opacity: Num,
  },
  storage: "soa",
});
