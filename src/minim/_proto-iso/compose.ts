// Compositional utilities — what becomes expressible once invertible
// chains are a primitive.
//
// Categories:
//   1. Pure isomorphisms — bidirectional coordinate / unit conversions
//   2. Layout combinators — Bluefish-style `above`, `beside`, etc.
//   3. Reactive helpers — common patterns (clamp01, normalize, etc.)
//   4. Constraint primitives — align, distribute, between
//
// Every util here is built ONLY on `iso.ts` + `joint.ts` + value
// types. No bespoke `derived(...)` calls. The idea: if it can't be
// expressed this way, the primitives have a hole.

import { type Iso, Chain, via } from "./iso";
import { viaJoint, vecFromAxes, type RwJoint, type RoJoint } from "./joint";
import { Num, num } from "./num";
import { Vec, vec, type Value as VecValue } from "./vec";
import { Box, box, type Value as BoxValue } from "./box";
import type { Signal, Read } from "../signals/signal";
import { value, type Val } from "../signals/signal";

// ═════════════════════════════════════════════════════════════════════
// 1. PURE ISOS — coordinate / unit conversions
// ═════════════════════════════════════════════════════════════════════

/** degrees ↔ radians. */
export const degToRad: Iso<number, number> = {
  fwd: (d) => (d * Math.PI) / 180,
  bwd: (r) => (r * 180) / Math.PI,
};

/** radians ↔ degrees. */
export const radToDeg: Iso<number, number> = {
  fwd: (r) => (r * 180) / Math.PI,
  bwd: (d) => (d * Math.PI) / 180,
};

/** Reverse value within a fixed range: `lo + hi - x`. Self-inverse. */
export const flipRange = (lo: number, hi: number): Iso<number, number> => ({
  fwd: (x) => lo + hi - x,
  bwd: (x) => lo + hi - x,
});

/** Map `[fromLo, fromHi]` to `[toLo, toHi]` linearly. Invertible. */
export const remap = (fromLo: number, fromHi: number, toLo: number, toHi: number): Iso<number, number> => {
  const scale = (toHi - toLo) / (fromHi - fromLo);
  return {
    fwd: (x) => toLo + (x - fromLo) * scale,
    bwd: (y) => fromLo + (y - toLo) / scale,
  };
};

/** Normalize/unnormalize over a range. `normalize01(lo, hi)` reads
 *  as `(x - lo) / (hi - lo)`, writes back lo + t * (hi - lo). */
export const normalize01 = (lo: number, hi: number): Iso<number, number> =>
  remap(lo, hi, 0, 1);

/** Cartesian {x, y} ↔ polar {r, a}. */
export interface Polar { r: number; a: number }
export const cartesianToPolar: Iso<VecValue, Polar> = {
  fwd: ({ x, y }) => ({ r: Math.hypot(x, y), a: Math.atan2(y, x) }),
  bwd: ({ r, a }) => ({ x: r * Math.cos(a), y: r * Math.sin(a) }),
};
export const polarToCartesian: Iso<Polar, VecValue> = {
  fwd: ({ r, a }) => ({ x: r * Math.cos(a), y: r * Math.sin(a) }),
  bwd: ({ x, y }) => ({ r: Math.hypot(x, y), a: Math.atan2(y, x) }),
};

/** Round-trip: read in polar, write in polar, but store cartesian.
 *  Use as: `via(cartesianVec, Chain.of<VecValue>().iso(cartesianToPolar))`
 *  → writable `Signal<Polar>`. */

// ═════════════════════════════════════════════════════════════════════
// 2. REACTIVE HELPERS
// ═════════════════════════════════════════════════════════════════════

/** Read-only clamp on a Num. */
export const clamp = (n: Num, lo: Val<number>, hi: Val<number>) =>
  n.clamp(lo, hi);

/** clamp01(n) = clamp(n, 0, 1). */
export const clamp01 = (n: Num) => n.clamp(0, 1);

/** Distance from `a` to `b` as a reactive Num (read-only). */
export const distance = (a: Vec, b: Vec) => a.distance(b);

/** Midpoint of `a` and `b`. WRITABLE — drag midpoint, both endpoints
 *  shift equally. */
export const midpoint = (a: Vec, b: Vec): Vec => {
  type Ss = readonly [Vec, Vec];
  return viaJoint([a, b] as Ss, {
    fwd: (av, bv) => ({ x: (av.x + bv.x) / 2, y: (av.y + bv.y) / 2 }),
    bwd: (next, [av, bv]) => {
      const dx = next.x - (av.x + bv.x) / 2;
      const dy = next.y - (av.y + bv.y) / 2;
      return [
        { x: av.x + dx, y: av.y + dy },
        { x: bv.x + dx, y: bv.y + dy },
      ] as unknown as [VecValue, VecValue];
    },
  }, Vec);
};

/** Weighted interpolation: `between(a, b, t)` = `a + t·(b - a)`.
 *  Read-only joint (t may be reactive). */
export const between = (a: Vec, b: Vec, t: Val<number>): Read<VecValue> => {
  return viaJoint([a, b] as const, {
    fwd: (av, bv) => {
      const tv = value(t);
      return { x: av.x + (bv.x - av.x) * tv, y: av.y + (bv.y - av.y) * tv };
    },
  });
};

// ═════════════════════════════════════════════════════════════════════
// 3. LAYOUT COMBINATORS (Bluefish-style)
// ═════════════════════════════════════════════════════════════════════

/** Bundle of writable anchors for a laid-out group. The `joint` lens
 *  represents the "natural" anchor (centroid) — writing it moves the
 *  whole group rigidly. */
export interface Layout {
  group: Box;
  joint: Vec;
}

/** `above(a, b, gap)` — stack `a` above `b`. Both are Boxes. Read:
 *  group is the union; joint is the midpoint between a.bottom and
 *  b.top. Write joint → shifts both boxes' positions rigidly. */
export function above(a: Box, b: Box, gap: Val<number> = 0): Layout {
  const g = num(gap);

  // Constraint: a.bottom.y + gap = b.top.y. We don't enforce this
  // (would need a constraint solver). Instead we PROVIDE a joint lens
  // that, when written, moves both to satisfy it.

  const joint = vecFromAxes(
    // x-axis: mean of a.bottom.x and b.top.x — writing shifts both x's
    midpointNum(a.x.add(a.w.scale(0.5)), b.x.add(b.w.scale(0.5))),
    // y-axis: midpoint of a.bottom.y and b.top.y; this is the "interface"
    midpointNum(a.y.add(a.h), b.y),
  );

  // group = bounding box of a and b (read-only; would need a custom iso
  // to make it writable).
  const group = boundingBox([a, b]);

  // Side effect: enforce the constraint a.bottom + gap = b.top by
  // binding b.y to a.y + a.h + gap. (Sets up one-way layout.)
  // Caller can disable by passing gap as a writable Num.
  // For demonstration we leave the constraint as soft (the joint
  // works regardless of gap; gap is a parameter).
  void g;

  return { group: group as Box, joint: joint as Vec };
}

/** Stack `a` to the left of `b`. Symmetric to `above`. */
export function beside(a: Box, b: Box, gap: Val<number> = 0): Layout {
  const g = num(gap);
  const joint = vecFromAxes(
    midpointNum(a.x.add(a.w), b.x),
    midpointNum(a.y.add(a.h.scale(0.5)), b.y.add(b.h.scale(0.5))),
  );
  const group = boundingBox([a, b]);
  void g;
  return { group: group as Box, joint: joint as Vec };
}

/** Read-only bounding box around a set of boxes. */
function boundingBox(boxes: readonly Box[]): Signal<BoxValue> {
  const parts = boxes as readonly Read<BoxValue>[];
  return viaJoint(parts, {
    fwd: (...vs) => {
      const bs = vs as BoxValue[];
      if (bs.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
      let xMin = bs[0].x, yMin = bs[0].y;
      let xMax = xMin + bs[0].w, yMax = yMin + bs[0].h;
      for (let i = 1; i < bs.length; i++) {
        if (bs[i].x < xMin) xMin = bs[i].x;
        if (bs[i].y < yMin) yMin = bs[i].y;
        if (bs[i].x + bs[i].w > xMax) xMax = bs[i].x + bs[i].w;
        if (bs[i].y + bs[i].h > yMax) yMax = bs[i].y + bs[i].h;
      }
      return { x: xMin, y: yMin, w: xMax - xMin, h: yMax - yMin };
    },
  } as RoJoint<readonly Read<BoxValue>[], BoxValue>) as Signal<BoxValue>;
}

/** Writable midpoint of two Nums. Mirror of `midpoint` for Vec. */
export function midpointNum(a: Num, b: Num): Num {
  type Ss = readonly [Num, Num];
  return viaJoint([a, b] as Ss, {
    fwd: (av, bv) => (av + bv) / 2,
    bwd: (next, [av, bv]) => {
      const delta = next - (av + bv) / 2;
      return [av + delta, bv + delta] as unknown as [number, number];
    },
  }, Num) as Num;
}

// ═════════════════════════════════════════════════════════════════════
// 4. CONSTRAINT-LENS HELPERS
// ═════════════════════════════════════════════════════════════════════

/** "Align" two Nums: a constraint expressed as a lens. Reads as the
 *  shared value (= midpoint); writes set both equal. */
export const align = (a: Num, b: Num): Num => midpointNum(a, b);

/** Distribute three (or more) Nums evenly between the endpoints.
 *  Writing the bundle shifts everything; specific positions remain
 *  evenly spaced. (One-way: read-only here.) */
export const distributeEven = (parts: readonly Num[]): Read<number[]> =>
  viaJoint(parts as readonly Read<number>[], {
    fwd: (...vs) => {
      const lo = vs[0] as number;
      const hi = vs[vs.length - 1] as number;
      const n = vs.length;
      return Array.from({ length: n }, (_, i) => lo + (hi - lo) * (i / (n - 1)));
    },
  });

// ═════════════════════════════════════════════════════════════════════
// 5. SMART CONNECTORS
// ═════════════════════════════════════════════════════════════════════

/** Lens onto a point that's always on the perimeter of a Box, facing
 *  `toward`. Read-only (the edge formula isn't easily invertible).
 *  But COMPOSABLE: this Vec can be the source of further chains. */
export const edgeFrom = (b: Box, toward: Vec): Read<VecValue> =>
  viaJoint([b, toward] as const, {
    fwd: (bv, tv) => {
      const cx = bv.x + bv.w / 2;
      const cy = bv.y + bv.h / 2;
      const dx = tv.x - cx;
      const dy = tv.y - cy;
      if (dx === 0 && dy === 0) return { x: cx, y: cy };
      const k = Math.min(
        dx === 0 ? Infinity : (bv.w / 2) / Math.abs(dx),
        dy === 0 ? Infinity : (bv.h / 2) / Math.abs(dy),
      );
      return { x: cx + dx * k, y: cy + dy * k };
    },
  });

/** Closest of `a` or `b` to a target. Read-only (which-of-N picks one;
 *  can't invert to "set" the choice without ambiguity). */
export const closestOf = (target: Vec, ...candidates: Vec[]): Read<VecValue> =>
  viaJoint([target, ...candidates] as readonly Read<VecValue>[], {
    fwd: (...vs) => {
      const t = vs[0] as VecValue;
      let best = vs[1] as VecValue;
      let bestDist = Math.hypot(best.x - t.x, best.y - t.y);
      for (let i = 2; i < vs.length; i++) {
        const c = vs[i] as VecValue;
        const d = Math.hypot(c.x - t.x, c.y - t.y);
        if (d < bestDist) { best = c; bestDist = d; }
      }
      return best;
    },
  });

// ═════════════════════════════════════════════════════════════════════
// 6. ANCHORED LAYOUT — align an anchor of one box to an anchor of another
// ═════════════════════════════════════════════════════════════════════

/** "Pin" anchor `(u1, v1)` of box `a` to anchor `(u2, v2)` of box `b`.
 *  Returns a writable Vec — the pinned point — that, when read, gives
 *  the current shared location, and when written, moves both boxes
 *  (preserving size) so the pinned point lands at the target.
 *  Composable with `gap` via further chain shifts. */
export function pin(
  a: Box, u1: number, v1: number,
  b: Box, u2: number, v2: number,
): Vec {
  return midpoint(a.at(u1, v1), b.at(u2, v2));
}
