// =====================================================================
// memory.ts — path-dependent (stateful-complement) lens combinators.
//
// Two backward directions are not functions of the current source alone;
// they depend on where the value has BEEN. Both were hand-rolled per site
// across the closed-form-policy and aggregate lenses, each with its own
// degeneracy threshold. They factor into two combinators:
//
//   remember   — a magnitude/total view of a cluster: sources live at
//                `anchorᵢ + shapeᵢ · scale`, `scale` is the writable
//                scalar. The complement holds the normalized shape so a
//                collapse to the anchor (scale → 0) reinflates it. Covers
//                scaleAbout, bestFitCircle.radius, spreadOf, totalLens.
//   continuous — a cyclic (mod-`period`) view lifted to its universal
//                cover: the complement tracks the last emitted value and
//                unwraps the raw reading to the nearest sheet, so the
//                view never tears at a branch cut. Covers the eigenvector
//                angle of bestFitLine; the primitive behind winding.
// =====================================================================

import { type Cell, type Linear, Num, type Traits, type Writable } from "../index";

// ─── remember: magnitude/total shape-memory ────────────────────────────

/** Options for {@link remember}. `anchor` is the fixed point sources scale
 *  about (a pivot, or the live centroid); `feature` is the writable scalar
 *  (a radius, mean distance, or sum). */
export interface RememberOpts<T> {
  /** Point sources scale about — a constant pivot or a derived centroid. */
  anchor: (vals: readonly T[]) => T;
  /** The scalar view (the forward): radius, mean radius, spread, sum, … */
  feature: (vals: readonly T[], anchor: T) => number;
  /** Feature is non-negative ⇒ a same-magnitude write (e.g. `-r`) is a
   *  no-op (PutGet on a magnitude). Default `true`; set `false` for a
   *  signed total. */
  magnitude?: boolean;
  /** Degeneracy threshold; below it the cluster is "collapsed" and the
   *  stored shape drives reinflation. Default `1e-9`. */
  eps?: number;
  /** Normalized shape to seed when the feature is degenerate at init and
   *  no prior good shape exists. Default: zero deviations (stays
   *  collapsed). `totalLens` passes uniform `1/K` for an even split. */
  seed?: (vals: readonly T[]) => T[];
}

/** Scalar shape-memory lens. Reads `feature(sources)`; writing it scales
 *  the cluster about `anchor` so the new feature matches, reinflating the
 *  remembered shape when the cluster has collapsed onto the anchor. The
 *  complement is the per-source deviation normalized by the feature. */
export function remember<T, S extends Cell<T> & Traits<T, "linear">>(
  sources: readonly Writable<S>[],
  opts: RememberOpts<T>,
): Writable<Num> {
  const K = sources.length;
  if (K < 1) throw new Error("remember: need ≥ 1 source");
  // biome-ignore lint/suspicious/noExplicitAny: dynamic class/trait lookup
  const Cls = (sources[0] as any).constructor as {
    name?: string;
    traits?: { linear?: Linear<T> };
  };
  const lin = Cls.traits?.linear;
  if (!lin) throw new Error(`remember: ${Cls.name ?? "?"} has no traits.linear`);
  const { anchor, feature, seed } = opts;
  const magnitude = opts.magnitude ?? true;
  const eps = opts.eps ?? 1e-9;
  const zero = (vals: readonly T[], a: T): T[] => vals.map(v => lin.scale(lin.sub(v, a), 0));

  // Normalized deviations `(vᵢ − anchor) / feature`, refreshed whole while
  // the feature is non-degenerate; below `eps` the prior shape (or the
  // seed) is held so a collapse reinflates it.
  const shapeOf = (vals: readonly T[], a: T, f: number, prev: T[] | null): T[] => {
    if (f <= eps) return prev ?? seed?.(vals) ?? zero(vals, a);
    const inv = 1 / f;
    return vals.map(v => lin.scale(lin.sub(v, a), inv));
  };

  type C = { shape: T[] };
  // biome-ignore lint/suspicious/noExplicitAny: spec is checked structurally
  return (Num as any).lens(sources as unknown as readonly Writable<Cell<T>>[], {
    init: (vals: readonly T[]): C => {
      const a = anchor(vals);
      return { shape: shapeOf(vals, a, feature(vals, a), null) };
    },
    step: (vals: readonly T[], c: C): C => {
      const a = anchor(vals);
      return { shape: shapeOf(vals, a, feature(vals, a), c.shape) };
    },
    fwd: (vals: readonly T[]): number => feature(vals, anchor(vals)),
    bwd: (target: number, vals: readonly T[], c: C) => {
      const a = anchor(vals);
      const f = feature(vals, a);
      // Magnitude is lossy (|−f| = f): a same-magnitude target re-projects
      // to the current feature, so the cluster is left put.
      if (magnitude && Math.abs(target) === f) {
        return { updates: vals.map(() => undefined), complement: c };
      }
      if (f > eps) {
        const k = target / f;
        return { updates: vals.map(v => lin.add(a, lin.scale(lin.sub(v, a), k))), complement: c };
      }
      return { updates: c.shape.map(s => lin.add(a, lin.scale(s, target))), complement: c };
    },
  }) as Writable<Num>;
}

// ─── continuous: cyclic view lifted to its universal cover ─────────────

/** Options for {@link continuous}. `raw` reads the cyclic value (mod
 *  `period`) and whether it's defined; `apply` realizes an unwrapped
 *  target back onto the sources given the current unwrapped reading. */
export interface ContinuousOpts<T> {
  /** Cycle length: `2π` for a full angle, `π` for an axis (sign-free). */
  period: number;
  /** Raw cyclic reading. `defined: false` (e.g. a collapsed cloud has no
   *  axis) holds the last emitted value and freezes the sources. */
  raw: (vals: readonly T[]) => { value: number; defined: boolean };
  /** Realize `target` (already unwrapped, absolute) onto the sources,
   *  given the `current` unwrapped reading (for a delta). */
  apply: (target: number, vals: readonly T[], current: number) => readonly (T | undefined)[];
}

/** Continuous (winding-aware) lens over a cyclic reading. The complement
 *  tracks the last emitted value and unwraps each raw reading to the
 *  nearest representative modulo `period`, so the view follows the source
 *  across branch cuts instead of jumping a full period. */
export function continuous<T>(
  sources: readonly Writable<Cell<T>>[],
  opts: ContinuousOpts<T>,
): Writable<Num> {
  const { period, raw, apply } = opts;
  const wrap = (x: number): number => x - period * Math.round(x / period);
  const unwrap = (rawv: number, prev: number): number => prev + wrap(rawv - prev);

  type C = { prev: number };
  // biome-ignore lint/suspicious/noExplicitAny: spec is checked structurally
  return (Num as any).lens(sources as never, {
    init: (vals: readonly T[]): C => {
      const r = raw(vals);
      return { prev: r.defined ? r.value : 0 };
    },
    step: (vals: readonly T[], c: C): C => {
      const r = raw(vals);
      return r.defined ? { prev: unwrap(r.value, c.prev) } : c;
    },
    fwd: (vals: readonly T[], c: C): number => {
      const r = raw(vals);
      return r.defined ? unwrap(r.value, c.prev) : c.prev;
    },
    bwd: (target: number, vals: readonly T[], c: C) => {
      const r = raw(vals);
      if (!r.defined) return { updates: vals.map(() => undefined), complement: { prev: target } };
      const current = unwrap(r.value, c.prev);
      return { updates: apply(target, vals, current), complement: { prev: target } };
    },
  }) as Writable<Num>;
}
