// =====================================================================
// domain-aggregates.ts — closed-form lenses in non-point domains.
//
// The point-cluster catalog has rich structure (centroid, rotation,
// PCA, …). This file pushes the same patterns into:
//
//   (1) Generic aggregates over ANY Linear-trait type — colors, poses,
//       ranges, boxes, all "for free" via the existing `meanLens` /
//       `centroidLens` / `scaleAbout` building blocks once you let
//       the engine dispatch on `traits.linear`.
//
//   (2) Color-specific aggregates: meanColor, palette (mean + spread
//       per channel), hue rotation.
//
//   (3) Curve / Bezier aggregates: gestalt handles on a cubic Bezier
//       ({start, end, startTangent, endTangent}) so you can drag the
//       "shape" of a curve without touching individual control points.
//
//   (4) Time-series aggregates: {mean, trend, span} via bestFitLine
//       on (i, value) pairs — works on any Linear-trait scalar type.
//
// All exports are closed-form: exact, idempotent, cross-channel
// invariant by construction. Same group-action framework as
// `closed-form-policies.ts`, applied beyond points.
// =====================================================================

import {
  type Linear,
  type Metric,
  Num,
  Signal,
  type Traits,
  Vec,
  type Writable,
} from "../index";

// ─── 1. Generic Linear-trait aggregates ────────────────────────────────
//
// `meanLens` and `scaleAbout` already work for ANY Linear-trait type.
// What's missing is an ERGONOMIC entry point: a free function that
// infers the value class from the first input. This lets users write
//
//   const avg = meanOf(colors);
//
// instead of
//
//   const avg = meanLens(Color, colors);
//
// Same engine. Zero new infrastructure.
// =====================================================================

/** Class-inferring mean: returns a writable of the same class as
 *  `inputs[0]`. Requires the class to declare the `linear` trait. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape
export function meanOf<S extends Traits<any, "linear">>(
  inputs: readonly Writable<S>[],
): Writable<S> {
  if (inputs.length === 0) throw new Error("meanOf: need ≥ 1 input");
  // biome-ignore lint/suspicious/noExplicitAny: dynamic class lookup
  const Cls = (inputs[0] as any).constructor as new (...args: never[]) => Signal<any>;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic trait lookup
  const lin = (Cls as any).traits?.linear as Linear<any> | undefined;
  if (!lin) throw new Error(`meanOf: ${(Cls as { name?: string }).name ?? "?"} has no traits.linear`);
  const n = inputs.length;
  const inv = 1 / n;
  // biome-ignore lint/suspicious/noExplicitAny: variance escape on Cls.lens
  return (Cls as any).lens(
    inputs as never,
    // biome-ignore lint/suspicious/noExplicitAny: variance escape
    (vals: any) => {
      let acc = vals[0];
      for (let i = 1; i < n; i++) acc = lin.add(acc, vals[i]);
      return lin.scale(acc, inv);
    },
    // biome-ignore lint/suspicious/noExplicitAny: variance escape
    (target: any, vals: any) => {
      let cur = vals[0];
      for (let i = 1; i < n; i++) cur = lin.add(cur, vals[i]);
      cur = lin.scale(cur, inv);
      const delta = lin.sub(target, cur);
      const out: unknown[] = new Array(n);
      for (let i = 0; i < n; i++) out[i] = lin.add(vals[i], delta);
      return out as never;
    },
  );
}

/** Generic rigid-translate aggregate over any Linear type. Identical
 *  semantics to `meanOf` (writes shift all inputs by the same delta),
 *  but named for the geometric intent. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape
export function rigidTranslateOf<S extends Traits<any, "linear">>(
  inputs: readonly Writable<S>[],
): Writable<S> {
  return meanOf(inputs);
}

// ─── 2. Color aggregates ───────────────────────────────────────────────

type ColorV = { r: number; g: number; b: number; a: number };

/** Mean (average) color of a palette. Read = mean RGBA; write =
 *  shift every color by the delta to target (rigid translate in RGBA
 *  space). Inherits cross-channel invariance from Linear-trait
 *  `meanOf` via the established framework. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape
export function meanColor(colors: readonly Writable<Traits<ColorV, "linear">>[]): Writable<Traits<ColorV, "linear">> {
  return meanOf(colors);
}

/** Generic "spread" lens: scalar that scales every input's deviation
 *  from the centroid. Writing spread = T sets every input to
 *  `centroid + unit_i * T` where `unit_i` is its unit deviation
 *  direction.
 *
 *  Trait-driven via `Linear` (add/sub/scale on deviations) AND
 *  `Metric` (L2 distance from centroid). Works for any value class
 *  declaring both — Vec, Color, Pose, Box, Range, custom.
 *
 *  Symmetric implementation: the complement carries the per-input
 *  unit deviation directions. When the current cluster is degenerate
 *  (spread < eps) the stored units survive, so spread → 0 → T fully
 *  recovers the original geometry. No epsilon clamping; `spread = 0`
 *  is truly 0; composition does not amplify a floor.
 *
 *  Cross-channel invariance with `meanOf`: writing mean translates the
 *  cluster (spread unchanged); writing spread scales about the current
 *  centroid (mean unchanged). The centroid is recomputed from the
 *  current source on every read & write, so an intervening mean
 *  translate works correctly without staleness. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape
export function spreadOf<T extends NonNullable<unknown>, S extends Signal<T> & Traits<T, "linear" | "metric">>(
  inputs: readonly Writable<S>[],
): Writable<Num> {
  const K = inputs.length;
  if (K < 1) throw new Error("spreadOf: need ≥ 1 input");
  // biome-ignore lint/suspicious/noExplicitAny: dynamic class lookup
  const Cls = (inputs[0] as any).constructor as { traits?: { linear?: Linear<T>; metric?: Metric<T> } };
  const lin = Cls.traits?.linear;
  const met = Cls.traits?.metric;
  if (!lin || !met) {
    throw new Error(`spreadOf: ${(Cls as { name?: string }).name ?? "?"} needs Linear + Metric`);
  }
  const inv = 1 / K;

  const centroid = (vals: readonly T[]): T => {
    let acc = vals[0]!;
    for (let i = 1; i < K; i++) acc = lin.add(acc, vals[i]!);
    return lin.scale(acc, inv);
  };

  // Initial complement: capture unit deviations from peek()ed sources.
  // If any are degenerate, store the additive zero (`lin.scale(v0, 0)`)
  // as a "no direction info yet" marker. Those inputs will not move
  // when spread is written — until they're moved manually and the
  // lens re-reads (which refreshes the unit).
  const initVals = inputs.map(s => s.peek() as T);
  const initCtr = centroid(initVals);
  const zero = lin.scale(initVals[0]!, 0);
  const initUnits = initVals.map(v => {
    const r = met(v, initCtr);
    return r > 1e-9 ? lin.scale(lin.sub(v, initCtr), 1 / r) : zero;
  });

  return Num.symmetricLens<T, { units: T[] }>(inputs as never, {
    missing: { units: initUnits },
    putr: (vals, c) => {
      const ctr = centroid(vals);
      let total = 0;
      const units = c.units;
      for (let i = 0; i < K; i++) {
        const r = met(vals[i]!, ctr);
        total += r;
        if (r > 1e-9) {
          units[i] = lin.scale(lin.sub(vals[i]!, ctr), 1 / r);
        }
      }
      return total * inv;
    },
    putl: (target, vals, c) => {
      const ctr = centroid(vals);
      const units = c.units;
      for (let i = 0; i < K; i++) {
        const r = met(vals[i]!, ctr);
        if (r > 1e-9) {
          units[i] = lin.scale(lin.sub(vals[i]!, ctr), 1 / r);
        }
      }
      const out: T[] = new Array(K);
      for (let i = 0; i < K; i++) {
        out[i] = lin.add(ctr, lin.scale(units[i]!, target));
      }
      return out;
    },
  });
}

/** Palette decomposition: K colors → {mean: Color, spread: Num}.
 *
 *  Composition of `meanOf` (Linear-trait aggregate) and `spreadOf`
 *  (Linear + Metric-trait spread). Now fully trait-driven: works for
 *  any value class that declares Linear + Metric — Vec, Pose, Box,
 *  Range, Color, user-defined types — without code changes.
 *
 *  This is the "centroid + uniform scale about centroid" decomposition,
 *  generalised across domains via the trait system. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape on value class
export function paletteLens<T extends NonNullable<unknown>, S extends Signal<T> & Traits<T, "linear" | "metric">>(
  colors: readonly Writable<S>[],
): { mean: Writable<S>; spread: Writable<Num> } {
  return {
    mean: meanOf(colors as never) as Writable<S>,
    spread: spreadOf(colors as never),
  };
}

// ─── 3. Bezier curve gestalt ───────────────────────────────────────────
//
// A cubic Bezier curve has 4 control points (p0, p1, p2, p3). The
// "gestalt" view exposes 4 derived handles that match the user's
// mental model of curve shape:
//
//   start         = p0
//   end           = p3
//   startTangent  = p1 - p0   (vector from p0 in the direction of p1)
//   endTangent    = p3 - p2   (vector from p3 in the direction OPPOSITE to p2)
//
// Writes:
//
//   write start:        translate p0 to target; p1 moves with it
//                       (preserving startTangent vector).
//   write end:          translate p3 to target; p2 moves with it
//                       (preserving endTangent vector).
//   write startTangent: p1 := p0 + target (target relative to p0).
//                       p0, p2, p3 unchanged.
//   write endTangent:   p2 := p3 - target (since tangent points away from p2).
//                       p0, p1, p3 unchanged.
//
// Cross-channel invariance is exact for all six pairs (each write
// touches only the inputs needed to realise the target; others are
// genuinely untouched). The forward map is linear in (p0, p1, p2, p3),
// so this is a square iso lens: M = N (each control point contributes
// 2 scalars, total 8; each handle contributes 2 scalars, total 8).
// =====================================================================

type V = { x: number; y: number };

export function bezierGestaltLens(
  p0: Writable<Vec>,
  p1: Writable<Vec>,
  p2: Writable<Vec>,
  p3: Writable<Vec>,
): {
  start: Writable<Vec>;
  end: Writable<Vec>;
  startTangent: Writable<Vec>;
  endTangent: Writable<Vec>;
} {
  const start = Vec.lens(
    [p0, p1] as const,
    (vals: readonly V[]) => vals[0]!,
    (target: V, vals: readonly V[]) => {
      const dx = target.x - vals[0]!.x;
      const dy = target.y - vals[0]!.y;
      return [target, { x: vals[1]!.x + dx, y: vals[1]!.y + dy }] as never;
    },
  );

  const end = Vec.lens(
    [p2, p3] as const,
    (vals: readonly V[]) => vals[1]!,
    (target: V, vals: readonly V[]) => {
      const dx = target.x - vals[1]!.x;
      const dy = target.y - vals[1]!.y;
      return [{ x: vals[0]!.x + dx, y: vals[0]!.y + dy }, target] as never;
    },
  );

  const startTangent = Vec.lens(
    [p0, p1] as const,
    (vals: readonly V[]) => ({ x: vals[1]!.x - vals[0]!.x, y: vals[1]!.y - vals[0]!.y }),
    (target: V, vals: readonly V[]) =>
      [undefined, { x: vals[0]!.x + target.x, y: vals[0]!.y + target.y }] as never,
  );

  const endTangent = Vec.lens(
    [p2, p3] as const,
    (vals: readonly V[]) => ({ x: vals[1]!.x - vals[0]!.x, y: vals[1]!.y - vals[0]!.y }),
    (target: V, vals: readonly V[]) =>
      [{ x: vals[1]!.x - target.x, y: vals[1]!.y - target.y }, undefined] as never,
  );

  return { start, end, startTangent, endTangent };
}

// ─── 4. Time-series aggregates ─────────────────────────────────────────
//
// A sequence of scalar values, indexed by position. Closed-form
// decomposition into {mean, slope, span}:
//
//   mean  := average value (= rigid-translate; writes shift all values
//            by the delta).
//   slope := least-squares slope of (i, value_i). Writes tilt the
//            whole series about its mean to achieve the new slope.
//   span  := max(value) - min(value). Writes scale-about-mean to
//            match the new spread.
//
// Cross-channel invariance:
//   mean ↔ slope: rigid translate preserves slope (line through mean
//                 has the same slope before and after a y-shift).
//   mean ↔ span:  rigid translate preserves the (max - min) span.
//   slope ↔ span: rotation-about-mean changes the y-extent (span)
//                 unless slope is small. Only approximately invariant
//                 — documented in tests.
// =====================================================================

/** Time-series scalar aggregate. Returns 3 writable views over a
 *  sequence of Num values, treating them as (i, value_i) samples. */
export function timeSeriesLens(values: readonly Writable<Num>[]): {
  mean: Writable<Num>;
  slope: Writable<Num>;
} {
  const N = values.length;
  if (N < 2) throw new Error("timeSeries: need ≥ 2 values");

  const mean = Num.lens(
    values as never,
    (vals: readonly number[]) => {
      let s = 0;
      for (let i = 0; i < N; i++) s += vals[i]!;
      return s / N;
    },
    (target: number, vals: readonly number[]) => {
      let s = 0;
      for (let i = 0; i < N; i++) s += vals[i]!;
      const cur = s / N;
      const delta = target - cur;
      return vals.map(v => v + delta) as never;
    },
  );

  // For slope, use the least-squares formula:
  //   slope = Σ (i - īndex) * (v - mean) / Σ (i - īndex)²
  // (xMean of indices = (N-1)/2; constant)
  //
  // Writes: tilt about the mean. For new slope = s, new value_i = mean +
  // (i - īndex) * s (preserving mean). All other points get the
  // implied new positions.
  const idxMean = (N - 1) / 2;
  let denomSlope = 0;
  for (let i = 0; i < N; i++) {
    const di = i - idxMean;
    denomSlope += di * di;
  }

  const slope = Num.lens(
    values as never,
    (vals: readonly number[]) => {
      let valMean = 0;
      for (let i = 0; i < N; i++) valMean += vals[i]!;
      valMean /= N;
      let num = 0;
      for (let i = 0; i < N; i++) num += (i - idxMean) * (vals[i]! - valMean);
      return num / denomSlope;
    },
    (target: number, vals: readonly number[]) => {
      let valMean = 0;
      for (let i = 0; i < N; i++) valMean += vals[i]!;
      valMean /= N;
      // New value_i = valMean + (i - īndex) * target. Preserves mean,
      // changes slope to target.
      return vals.map((_, i) => valMean + (i - idxMean) * target) as never;
    },
  );

  return { mean, slope };
}

// ─── 5. Aside: trait-level surface inventory ───────────────────────────
//
// Looking at what we've built:
//
//   - `meanOf` / `rigidTranslateOf` work for ANY Linear trait —
//     numbers, vectors, colors, poses, boxes, ranges. The trait
//     system already abstracts "addition" cleanly.
//
//   - `palette.spread` uses Linear (the centroid via meanOf) AND
//     hand-rolled L2 norm on RGBA. The norm step is the bit that
//     doesn't generalise via a current trait — would benefit from
//     a `Metric<T>` trait usage (Color doesn't currently declare one).
//
//   - `bezierGestalt` is point-specific (Vec). No trait benefit:
//     the operation is "translate Vec / replace Vec component" which
//     is the trivial Vec.lens / spread-replace path.
//
//   - `timeSeries` is Num-specific (scalar). Could generalise to any
//     Linear type with an index-induced ordering, but the slope
//     formula is scalar-natural.
//
// Missing traits that would unlock more generality:
//
//   1. `Metric<T>` is declared but only `Vec` and `Num` use it.
//      Adding it to Color would make `palette.spread` trait-driven
//      (compute "average distance from centroid" generically).
//
//   2. `Pivotal<T>` — declares the type supports "act about a pivot
//      point" (translation / rotation / scale). For 2D types this is
//      a group action of SE(2) × R+; the building blocks like
//      `rotateAbout`/`scaleAbout` are currently Vec-specific but could
//      generalise to any Pivotal class (e.g., Pose, which extends Vec
//      with a rotation component).
//
//   3. `Differentiable<T>` — declares an analytical Jacobian for the
//      forward map. Would let factor() skip FD for trait-using
//      compositions.
//
// These are sketches; concrete trait-extension proposals deferred to
// a separate exploration.
// =====================================================================
