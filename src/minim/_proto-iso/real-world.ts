// Real-world conversions. Two existing call sites in
// `src/elements/optical-centering/*` that hand-roll `derived(Cls, get, set)`,
// rewritten using the chain primitives. Side-by-side comparisons.
//
// Not executed as a real diagram — just demonstrates the patterns and
// verifies they typecheck + behave correctly under tests.

import { Chain, via } from "./iso";
import { vecFromAxes } from "./joint";
import { num, type Num } from "./num";
import { vec, Vec, type Value as VecValue } from "./vec";

// ─────────────────────────────────────────────────────────────────────
// CONVERSION 1: md-layout-demo.ts:48
//
// Original (11 lines of bespoke lens):
//
//   const pos = derived(
//     Vec,
//     () => ({
//       x: card.translate.value.x + w.value,
//       y: card.translate.value.y + h / 2,
//     }),
//     (p) => {
//       w.value = Math.max(MIN_W, p.x - card.translate.value.x);
//     },
//   );
//
// Insight: the original lens has asymmetric write semantics — reading
// uses BOTH `card.x` and `w`; writing ONLY updates `w` (clamped). It's
// a "partial" lens. The chain decomposition makes the asymmetry
// explicit by rooting at `w`.
// ─────────────────────────────────────────────────────────────────────

export function handleLens_original(
  card: Vec,
  w: Num,
  h: number,
  MIN_W: number,
) {
  // What the new spelling looks like.
  //
  // X-axis is rooted at `w`: read = w + card.x; write back → w
  // (clamped on the WRITE side, so reads pass through unchanged).
  const xAxis = w.derive((c) =>
    c.add(card.x).clampWrite(MIN_W + card.x.value, Infinity),
  );
  // Y-axis is rooted at card.y: read = card.y + h/2; writes update card.y.
  // (In the original code, y wasn't writable; here it could be.)
  const yAxis = card.y.add(h / 2);

  // Compose into a Vec. Writing handlePos.value = {x, y} distributes:
  //   x → w (clamped via xAxis chain)
  //   y → card.y (via yAxis chain)
  // For drag, the demo only writes x; y is just along for the ride.
  const handlePos = vecFromAxes(xAxis, yAxis);
  return handlePos;
}

// ─────────────────────────────────────────────────────────────────────
// CONVERSION 2: md-mirror.ts:27
//
// Original (7 lines of bespoke lens):
//
//   const mirrorOf = (src: Vec): Vec =>
//     derived(Vec,
//       () => reflect(src.value, mA.value, mB.value),
//       (target) => {
//         src.value = reflect(target, mA.value, mB.value);
//       },
//     );
//
// Insight: `reflect` is an INVOLUTION — `reflect(reflect(p)) = p`.
// So fwd === bwd. This is the canonical "lens whose inverse is itself"
// case. Chain expression makes this single-fact-encoded.
// ─────────────────────────────────────────────────────────────────────

function reflect(p: VecValue, a: VecValue, b: VecValue): VecValue {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return p;
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  const fx = a.x + t * dx;
  const fy = a.y + t * dy;
  return { x: 2 * fx - p.x, y: 2 * fy - p.y };
}

export function mirrorOf(src: Vec, mA: Vec, mB: Vec): Vec {
  // reflect is its own inverse → fwd === bwd. Express once.
  const reflectIso = {
    fwd: (p: VecValue) => reflect(p, mA.value, mB.value),
    bwd: (p: VecValue) => reflect(p, mA.value, mB.value),
  };
  return via(src, Chain.of<VecValue>().iso(reflectIso), Vec);
}

// ─────────────────────────────────────────────────────────────────────
// CONVERSION 3: Shape.#makeAnchor (signals/shapes/shape.ts:184)
//
// The existing implementation is 22 lines of bespoke lens that:
//   - Reads: transformPoint(localFrame, {x: b.x + u*b.w, y: b.y + v*b.h})
//   - Writes: solves for translate that puts the anchor at the target
//
// Under chains: it's `box.at(u,v)` (Box → Vec via anchor iso, writable)
// composed with `localFrame` as another iso (Vec → Vec via transform).
// The `box.at(u,v)` part already exists in `box.ts`; we just need an
// invertible-transform iso for the localFrame composition.
//
// Sketch (not wired up to the actual Shape class):
// ─────────────────────────────────────────────────────────────────────

import type { Value as MatrixValue } from "../signals/values/matrix";
import { invert, transformPoint } from "../signals/values/matrix";

/** Iso: local-frame point ↔ world-frame point via the matrix `M`.
 *  Reads apply M; writes apply M⁻¹. Fully bidirectional. */
export function localToWorld(M: { value: MatrixValue }) {
  return {
    fwd: (p: VecValue): VecValue => transformPoint(M.value, p),
    bwd: (p: VecValue): VecValue => transformPoint(invert(M.value), p),
  };
}

// Anchor of a Shape with localFrame matrix:
//   shape.box.at(u, v)   ←  Box → Vec, writable (in box.ts)
//   .through(localToWorld)  ←  Vec → Vec, writable
// The existing `#makeAnchor` (22 lines) collapses to chain composition.

// ─────────────────────────────────────────────────────────────────────
// CONVERSION 4: polar() — make it bidirectional
//
// Original (signals/values/vec.ts:112) is one-way: binds a Vec from
// (center, r, a). You can't write to it.
//
// Under chains: polar is an ISO if center is fixed. (center, r, a) ↔
// (x, y) is bidirectional. The bwd computes r = |p - center| and
// a = atan2(p - center).
// ─────────────────────────────────────────────────────────────────────

import { viaJoint } from "./joint";

/** Bidirectional polar: writes solve back for `r` and `a` (keeping
 *  `center` fixed). All three operands may be signals — reactive.
 *  Returns a writable Vec. The original `polar()` in `signals/values/vec.ts`
 *  is one-way; this is the natural bidirectional formulation. */
export function polarLens(center: Vec, r: Num, a: Num): Vec {
  type Ss = readonly [Num, Num, Vec];
  return viaJoint([r, a, center] as Ss, {
    fwd: (rv, av, cv) => ({
      x: cv.x + rv * Math.cos(av),
      y: cv.y + rv * Math.sin(av),
    }),
    bwd: (next, [_r, _a, cv]) => {
      const dx = next.x - cv.x;
      const dy = next.y - cv.y;
      return [Math.hypot(dx, dy), Math.atan2(dy, dx), cv] as unknown as [number, number, VecValue];
    },
  }, Vec);
}
