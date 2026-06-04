// =====================================================================
// domain-aggregates.ts — closed-form lenses beyond point clouds.
//
// The group-action patterns from `closed-form-policies.ts`, applied to:
//   (1) Generic Linear/Metric-trait aggregates — `meanOf`, `spreadOf`,
//       `paletteLens` work for colors, poses, ranges, boxes for free.
//   (2) Color aggregates — `meanColor`.
//   (3) Bezier gestalt handles ({start, end, startTangent, endTangent}).
//   (4) Time-series ({mean, slope}) over (i, value) samples.
// All exact, idempotent, cross-channel invariant by construction.
// =====================================================================

import {
  type Cell,
  type Linear,
  type Metric,
  Num,
  type Read,
  reader,
  type Traits,
  type Val,
  Vec,
  type Writable,
} from "../index";

// ─── 1. Generic Linear-trait aggregates ────────────────────────────────
//
// Ergonomic entry points over `meanLens` / `scaleAbout` that infer the
// value class from the first input (`meanOf(colors)` vs
// `meanLens(Color, colors)`). Same engine, no new infrastructure.
// =====================================================================

/** Class-inferring mean (writable of `inputs[0]`'s class). Needs `linear`. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape
export function meanOf<S extends Traits<any, "linear">>(
  inputs: readonly Writable<S>[],
): Writable<S> {
  if (inputs.length === 0) throw new Error("meanOf: need ≥ 1 input");
  // biome-ignore lint/suspicious/noExplicitAny: dynamic class lookup
  const Cls = (inputs[0] as any).constructor as new (...args: never[]) => Cell<any>;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic trait lookup
  const lin = (Cls as any).traits?.linear as Linear<any> | undefined;
  if (!lin)
    throw new Error(`meanOf: ${(Cls as { name?: string }).name ?? "?"} has no traits.linear`);
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

/** Rigid-translate aggregate over any Linear type. Alias of `meanOf`,
 *  named for the geometric intent. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape
export function rigidTranslateOf<S extends Traits<any, "linear">>(
  inputs: readonly Writable<S>[],
): Writable<S> {
  return meanOf(inputs);
}

// ─── Weighted blend (the mix simplex) ──────────────────────────────────
//
// `mix` is `meanOf` with the uniform-weight assumption lifted: the read
// is the normalized weighted sum `Σ wᵢ·aᵢ`, the write is the minimum-norm
// delta `daᵢ = wᵢ·δ / Σwⱼ²` (the pseudoinverse of `wᵀ·da = δ`), so a
// zero-weight branch is left untouched. Weights are read-only controls —
// the bwd never writes them, keeping the blend fixed while the delta flows
// into the branches.
//
// The control lives on the K-simplex: a one-hot vertex is `select`
// (the live branch absorbs everything), a `(1−t, t)` edge is `crossfade`,
// uniform weights recover `meanOf`. Reactive weights are dynamically
// tracked (read via `.value` inside fwd), so flipping a Bool or sliding a
// Num re-reads with no extra wiring.

/** Weighted blend of K branches over any `Linear` type. See module note. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape
export function mix<S extends Traits<any, "linear">>(
  weights: readonly Val<number>[],
  branches: readonly Writable<S>[],
): Writable<S> {
  const K = branches.length;
  if (K < 1) throw new Error("mix: need ≥ 1 branch");
  if (weights.length !== K) throw new Error("mix: weights/branches length mismatch");
  // biome-ignore lint/suspicious/noExplicitAny: dynamic class lookup
  const Cls = (branches[0] as any).constructor as new (...args: never[]) => Cell<any>;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic trait lookup
  const lin = (Cls as any).traits?.linear as Linear<any> | undefined;
  if (!lin) throw new Error(`mix: ${(Cls as { name?: string }).name ?? "?"} has no traits.linear`);
  const wf = weights.map(w => reader(w));

  // Normalized weights + Σw². Degenerate (all-zero) weights fall back to
  // uniform so the read stays defined.
  const readW = (): { w: number[]; sumSq: number } => {
    const raw = wf.map(f => f());
    let sum = 0;
    for (const x of raw) sum += x;
    const w = Math.abs(sum) > 1e-12 ? raw.map(x => x / sum) : raw.map(() => 1 / K);
    let sumSq = 0;
    for (const x of w) sumSq += x * x;
    return { w, sumSq };
  };

  // biome-ignore lint/suspicious/noExplicitAny: variance escape on Cls.lens
  const combine = (vals: any[], w: number[]) => {
    let acc = lin.scale(vals[0], w[0]);
    for (let i = 1; i < K; i++) acc = lin.add(acc, lin.scale(vals[i], w[i]));
    return acc;
  };

  // biome-ignore lint/suspicious/noExplicitAny: variance escape on Cls.lens
  return (Cls as any).lens(
    branches as never,
    // biome-ignore lint/suspicious/noExplicitAny: variance escape
    (vals: any) => combine(vals, readW().w),
    // biome-ignore lint/suspicious/noExplicitAny: variance escape
    (target: any, vals: any) => {
      const { w, sumSq } = readW();
      const delta = lin.sub(target, combine(vals, w));
      if (sumSq < 1e-12) return vals.map(() => undefined) as never;
      const inv = 1 / sumSq;
      return vals.map((v: unknown, i: number) =>
        w[i] === 0 ? undefined : lin.add(v, lin.scale(delta, w[i]! * inv)),
      ) as never;
    },
  );
}

/** Two-branch router (mix simplex *vertex*): reads the live branch, writes
 *  flow entirely to it, the other is left put. Flipping `cond` snaps the
 *  output to the other branch's stored value. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape
export function select<S extends Traits<any, "linear">>(
  cond: Read<boolean>,
  whenFalse: Writable<S>,
  whenTrue: Writable<S>,
): Writable<S> {
  return mix(
    [Num.derive(() => (cond.value ? 0 : 1)), Num.derive(() => (cond.value ? 1 : 0))],
    [whenFalse, whenTrue],
  );
}

/** Two-branch crossfade (mix simplex *edge*): `lerp(a, b, t)`. Writing
 *  keeps `t` fixed and splits the delta by influence. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape
export function crossfade<S extends Traits<any, "linear">>(
  t: Read<number>,
  a: Writable<S>,
  b: Writable<S>,
): Writable<S> {
  return mix([Num.derive(() => 1 - t.value), Num.derive(() => t.value)], [a, b]);
}

// ─── 2. Color aggregates ───────────────────────────────────────────────

type ColorV = { r: number; g: number; b: number; a: number };

/** Mean color of a palette; write shifts every color by the delta
 *  (rigid translate in RGBA). Via `meanOf`. */
export function meanColor(
  colors: readonly Writable<Traits<ColorV, "linear">>[],
): Writable<Traits<ColorV, "linear">> {
  return meanOf(colors);
}

/** Mean radial distance from the centroid; write scales the cluster's
 *  deviations so the new mean matches the target. Trait-driven via
 *  `Linear` + `Metric`, so it works for any class declaring both (Vec,
 *  Color, Pose, Box, Range, custom).
 *
 *  Complement carries per-input deviations normalized by the current mean
 *  radius, so `spread = T` places each input at `centroid + normDev_i * T`
 *  and a collapse (spread → 0) reinflates the original SHAPE. Centroid is
 *  recomputed every read/write, so an intervening mean translate is not
 *  stale. */
export function spreadOf<
  T extends NonNullable<unknown>,
  S extends Cell<T> & Traits<T, "linear" | "metric">,
>(inputs: readonly Writable<S>[]): Writable<Num> {
  const K = inputs.length;
  if (K < 1) throw new Error("spreadOf: need ≥ 1 input");
  // biome-ignore lint/suspicious/noExplicitAny: dynamic class lookup
  const Cls = (inputs[0] as any).constructor as {
    traits?: { linear?: Linear<T>; metric?: Metric<T> };
  };
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

  // Complement: normalized deviations (dev / mean) from the centroid.
  // `bwd` scales the live deviations (fast path) or reinflates from the
  // stored norms when the cluster has collapsed.
  type C = { norms: T[] };
  const meanSpread = (vals: readonly T[], ctr: T): number => {
    let total = 0;
    for (let i = 0; i < K; i++) total += met(vals[i]!, ctr);
    return total * inv;
  };

  // biome-ignore lint/suspicious/noExplicitAny: variance escape — spec is checked structurally
  return (Num as any).lens(inputs as unknown as readonly Writable<Cell<T>>[], {
    init: (vals: readonly T[]): C => {
      const ctr = centroid(vals);
      const mean = meanSpread(vals, ctr);
      const zero = lin.scale(vals[0]!, 0);
      return {
        norms: vals.map(v => (mean > 1e-9 ? lin.scale(lin.sub(v, ctr), 1 / mean) : zero)),
      };
    },
    step: (vals: readonly T[], c: C): C => {
      const ctr = centroid(vals);
      const mean = meanSpread(vals, ctr);
      if (mean <= 1e-9) return c;
      const invMean = 1 / mean;
      return { norms: vals.map(v => lin.scale(lin.sub(v, ctr), invMean)) };
    },
    fwd: (vals: readonly T[]): number => meanSpread(vals, centroid(vals)),
    bwd: (target: number, vals: readonly T[], c: C) => {
      const ctr = centroid(vals);
      const mean = meanSpread(vals, ctr);
      if (mean > 1e-9) {
        const k = target / mean;
        return {
          updates: vals.map(v => lin.add(ctr, lin.scale(lin.sub(v, ctr), k))),
          complement: c,
        };
      }
      return { updates: c.norms.map(nrm => lin.add(ctr, lin.scale(nrm, target))), complement: c };
    },
  }) as Writable<Num>;
}

/** Palette decomposition: K values → {mean, spread}, i.e. centroid +
 *  uniform scale about it. `meanOf` ∘ `spreadOf`; works for any
 *  Linear + Metric class. */
export function paletteLens<
  T extends NonNullable<unknown>,
  S extends Cell<T> & Traits<T, "linear" | "metric">,
>(colors: readonly Writable<S>[]): { mean: Writable<S>; spread: Writable<Num> } {
  return {
    mean: meanOf(colors as never) as Writable<S>,
    spread: spreadOf(colors as never),
  };
}

// ─── 3. Bezier curve gestalt ───────────────────────────────────────────
//
// Cubic Bezier (p0..p3) → 4 shape handles:
//   start = p0, end = p3, startTangent = p1−p0, endTangent = p3−p2.
// Writes:
//   start        → translate p0 to target; p1 follows (tangent preserved)
//   end          → translate p3 to target; p2 follows (tangent preserved)
//   startTangent → p1 := p0 + target
//   endTangent   → p2 := p3 − target  (tangent points away from p2)
// Linear forward, square iso lens (8 = 8); exact cross-channel
// invariance for all pairs (each write touches only the needed inputs).
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
// Scalar values indexed by position → {mean, slope}:
//   mean  := average; writes shift all values by the delta.
//   slope := least-squares slope of (i, value_i); writes tilt about mean.
// mean and slope are invariant under each other (a y-shift preserves
// slope; tilting about the mean preserves the mean).
// =====================================================================

/** Time-series scalar aggregate over Num values as (i, value_i) samples. */
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

  // Least-squares slope = Σ (i − idxMean)(v − mean) / Σ (i − idxMean)²,
  // idxMean = (N−1)/2 constant. Write tilts about the mean:
  // value_i = mean + (i − idxMean)·s.
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
      return vals.map((_, i) => valMean + (i - idxMean) * target) as never;
    },
  );

  return { mean, slope };
}

// `meanOf` / `rigidTranslateOf` / `spreadOf` are fully trait-driven
// (Linear, Metric); `bezierGestalt` and `timeSeries` stay value-specific
// (Vec / Num) since their operations don't benefit from the trait layer.
// =====================================================================
