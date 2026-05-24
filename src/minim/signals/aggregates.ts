// aggregates.ts — N→1 aggregate lens primitives, built on
// `Cls.lens([...], ...)` / `Cls.derive([...], ...)`.
//
// All entries route through the engine's N-input lens path
// (per-cell scratch buffer, arity-based bwd dispatch, batched
// writes). Stateless-bwd (`(target) => updates`) skips the peek
// loop on the hot path; stateful-bwd (`(target, vals) => updates`)
// reads the scratch.

import type { Signal } from "./signal";
import { type Linear } from "./traits";
import { Num } from "./values/num";
import { Vec } from "./values/vec";
import type { Writable } from "./writable";

type V = { x: number; y: number };

// ─── Linear-aggregate merges (Num + Vec, etc.) ──────────────────────

/** Equal-weight mean of N Linear-trait values, with delta-even
 *  distribution on writes. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape, mirrors Cls.lens
export function meanLens<T, C extends new (...args: never[]) => Signal<any>>(
  Cls: C,
  parents: readonly Signal<T>[],
): Writable<InstanceType<C>> {
  const lin = ((Cls as unknown as { traits?: { linear?: Linear<T> } }).traits?.linear ??
    (() => {
      throw new Error("meanLens: value class has no 'linear' trait");
    })()) as Linear<T>;
  const n = parents.length;
  const inv = 1 / n;

  // biome-ignore lint/suspicious/noExplicitAny: variance escape on Cls.lens
  return (Cls as any).lens(
    parents as never,
    // biome-ignore lint/suspicious/noExplicitAny: tuple-vs-array variance
    (vals: any) => {
      let acc = vals[0] as T;
      for (let i = 1; i < n; i++) acc = lin.add(acc, vals[i]);
      return lin.scale(acc, inv);
    },
    // biome-ignore lint/suspicious/noExplicitAny: tuple-vs-array variance
    (target: any, vals: any) => {
      let cur = vals[0] as T;
      for (let i = 1; i < n; i++) cur = lin.add(cur, vals[i]);
      cur = lin.scale(cur, inv);
      const delta = lin.sub(target as T, cur);
      const out = new Array<T>(n);
      for (let i = 0; i < n; i++) out[i] = lin.add(vals[i], delta);
      return out as never;
    },
  );
}

/** Weighted sum of N Linear-trait values. RO. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape
export function sumLens<T, C extends new (...args: never[]) => Signal<any>>(
  Cls: C,
  parents: readonly Signal<T>[],
): InstanceType<C> {
  const lin = ((Cls as unknown as { traits?: { linear?: Linear<T> } }).traits?.linear ??
    (() => {
      throw new Error("sumLens: value class has no 'linear' trait");
    })()) as Linear<T>;
  const n = parents.length;
  // biome-ignore lint/suspicious/noExplicitAny: variance escape on Cls.derive
  return (Cls as any).derive(
    parents as never,
    // biome-ignore lint/suspicious/noExplicitAny: tuple variance
    (vals: any) => {
      let acc = vals[0] as T;
      for (let i = 1; i < n; i++) acc = lin.add(acc, vals[i]);
      return acc;
    },
  );
}

// ─── Numeric aggregates (min/max) ────────────────────────────────────

/** Min of N nums. RO. */
export function minLens(parents: readonly Signal<number>[]): Num {
  return Num.derive(parents as never, vals => {
    const arr = vals as readonly number[];
    let m = arr[0]!;
    for (let i = 1; i < arr.length; i++) if (arr[i]! < m) m = arr[i]!;
    return m;
  });
}

/** Max of N nums. RO. */
export function maxLens(parents: readonly Signal<number>[]): Num {
  return Num.derive(parents as never, vals => {
    const arr = vals as readonly number[];
    let m = arr[0]!;
    for (let i = 1; i < arr.length; i++) if (arr[i]! > m) m = arr[i]!;
    return m;
  });
}

// ─── Vec aggregates (geometric helpers) ─────────────────────────────

/** Midpoint of two writable Vecs. Drag-translates both endpoints. */
export function midpointLens(a: Signal<V>, b: Signal<V>): Writable<Vec> {
  return Vec.lens(
    [a, b] as const,
    vals => {
      const [av, bv] = vals;
      return { x: (av.x + bv.x) / 2, y: (av.y + bv.y) / 2 };
    },
    (target, vals) => {
      const [av, bv] = vals;
      const dx = target.x - (av.x + bv.x) / 2;
      const dy = target.y - (av.y + bv.y) / 2;
      return [
        { x: av.x + dx, y: av.y + dy },
        { x: bv.x + dx, y: bv.y + dy },
      ];
    },
  );
}

/** Centroid of N writable Vecs. Drag-translates all members. */
export function centroidLens(parents: readonly Signal<V>[]): Writable<Vec> {
  const n = parents.length;
  const inv = 1 / n;
  return Vec.lens(
    parents as never,
    vals => {
      const arr = vals as readonly V[];
      let sx = 0,
        sy = 0;
      for (let i = 0; i < n; i++) {
        sx += arr[i]!.x;
        sy += arr[i]!.y;
      }
      return { x: sx * inv, y: sy * inv };
    },
    (target, vals) => {
      const arr = vals as readonly V[];
      let sx = 0,
        sy = 0;
      for (let i = 0; i < n; i++) {
        sx += arr[i]!.x;
        sy += arr[i]!.y;
      }
      const dx = target.x - sx * inv;
      const dy = target.y - sy * inv;
      const out = new Array(n) as V[];
      for (let i = 0; i < n; i++) {
        out[i] = { x: arr[i]!.x + dx, y: arr[i]!.y + dy };
      }
      return out as never;
    },
  );
}

// ─── Geometric: axes + polar (specializations of Vec multi-input) ───

/** Vec from two writable Num axes. Stateless bwd → fast-path. */
export function axesLens(x: Num, y: Num): Writable<Vec> {
  return Vec.lens(
    [x, y] as const,
    (vals): V => ({ x: vals[0], y: vals[1] }),
    (target: V) => [target.x, target.y] as never,
  );
}

/** Polar Vec at `(c.x + r·cos a, c.y + r·sin a)`. Bidirectional under
 *  the `circular` policy: writes update only `a`. */
export function polarCircular(c: Signal<V>, r: Num, a: Num): Writable<Vec> {
  return Vec.lens(
    [c, r, a] as const,
    vals => {
      const [cv, rv, av] = vals;
      return { x: cv.x + rv * Math.cos(av), y: cv.y + rv * Math.sin(av) };
    },
    (target, vals) => {
      const [cv, _rv, av] = vals;
      // Cyclic-coordinate inverse: shortest-arc to current angle.
      const targetA = Math.atan2(target.y - cv.y, target.x - cv.x);
      const TAU = 2 * Math.PI;
      const wrapped = targetA - av - TAU * Math.round((targetA - av) / TAU);
      const newA = av + wrapped;
      return [undefined, undefined, newA] as never;
    },
  );
}

// ─── Argmin via the lens primitive (numerical pseudoinverse) ────────
//
// Generalised N-input lens via weighted least squares. One Newton-
// pseudoinverse step per write. Each input is a writable Num;
// `forward` computes the output from current inputs; `weights`
// controls which inputs absorb the residual (0 = frozen, 1 = uniform,
// larger = absorbs more).
//
// Specialisations:
//   - polar's four policies (rotate / translate / radial / circular)
//     are weight choices on [cx, cy, r, a].
//   - mean's even-distribution is weights [1, …, 1] on summed inputs.
//   - pulley conservation is [1, 1] on `a + b`.
//   - IK is finite-difference Jacobian on N joint angles → 2D tip.
//
// Jacobian is finite-differenced (no autodiff dep). For N inputs the
// per-write cost is N+1 forward evaluations. Damping (Levenberg-
// Marquardt) avoids blow-up near rank-deficient configurations.

export interface ArgminOpts {
  /** Finite-difference epsilon for the Jacobian. Default 1e-4. */
  eps?: number;
  /** Levenberg-Marquardt damping. Default `1e-6` for `argminNum`
   *  (Jacobian is always well-conditioned for linear constraints) and
   *  `1e-3` for `argminVec` (IK chains hit rank-deficient regimes at
   *  full extension). Larger → smaller, more stable updates; smaller
   *  → closer to pure pseudoinverse. */
  damping?: number;
}

/** Optional target-shaping for `argminVec`. Lets callers project an
 *  incoming write into the algorithm's reachable workspace BEFORE the
 *  Jacobian step — sidesteps the rank-deficient regime that causes
 *  unbounded swings at the workspace boundary.
 *
 *  For an N-link chain rooted at `R` with total reach `L`, pass
 *  `clampToDisc(R, L)`. The arm reaches the boundary cleanly and stops
 *  trying to extend further. */
export interface ArgminVecOpts extends ArgminOpts {
  /** Pre-write hook: transform the requested target into one that's
   *  guaranteed solvable. Most useful as a workspace clamp. */
  clampTarget?: (
    target: { x: number; y: number },
    currentInputs: readonly number[],
  ) => { x: number; y: number };
}

/** Project `p` into the closed disc of radius `r` centred on `c`. If
 *  inside, returned unchanged; outside, returned at the boundary. Pass
 *  to `argminVec`'s `clampTarget` as the principled fix for IK
 *  explosion at maximum reach. */
export function clampToDisc(
  c: { x: number; y: number },
  r: number,
): (p: { x: number; y: number }) => { x: number; y: number } {
  return p => {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const d = Math.hypot(dx, dy);
    if (d <= r) return p;
    const k = r / d;
    return { x: c.x + dx * k, y: c.y + dy * k };
  };
}

/** Scalar-output argmin lens. Reads `forward(inputs)`; writes do one
 *  Newton step against the finite-difference Jacobian, distributing
 *  the residual into inputs by `weights`. */
export function argminNum(
  inputs: readonly Num[],
  forward: (xs: readonly number[]) => number,
  weights: readonly number[],
  opts: ArgminOpts = {},
): Writable<Num> {
  if (weights.length !== inputs.length) {
    throw new Error("argminNum: weights/inputs length mismatch");
  }
  const eps = opts.eps ?? 1e-4;
  const damping = opts.damping ?? 1e-6;
  const n = inputs.length;
  // Pre-allocate J + out to avoid per-write allocations.
  const J = new Array<number>(n);
  const out = new Array<number | undefined>(n);
  return Num.lens(
    inputs as never,
    vals => forward(vals as readonly number[]),
    (target, vals) => {
      const xs = vals as number[];
      const y0 = forward(xs);
      const dy = target - y0;
      for (let i = 0; i < n; i++) {
        const saved = xs[i]!;
        xs[i] = saved + eps;
        J[i] = (forward(xs) - y0) / eps;
        xs[i] = saved;
      }
      let denom = damping;
      for (let i = 0; i < n; i++) denom += weights[i]! * J[i]! * J[i]!;
      const k = dy / denom;
      for (let i = 0; i < n; i++) {
        if (weights[i] === 0) {
          out[i] = undefined;
        } else {
          out[i] = xs[i]! + weights[i]! * J[i]! * k;
        }
      }
      return out as never;
    },
  );
}

/** 2D-output argmin lens. Inputs are scalar Nums; forward returns
 *  `{x, y}`. Suitable for IK arms, multi-input draggable points,
 *  parametric handle projection, etc. */
export function argminVec(
  inputs: readonly Num[],
  forward: (xs: readonly number[]) => { x: number; y: number },
  weights: readonly number[],
  opts: ArgminVecOpts = {},
): Writable<Vec> {
  if (weights.length !== inputs.length) {
    throw new Error("argminVec: weights/inputs length mismatch");
  }
  const eps = opts.eps ?? 1e-4;
  const damping = opts.damping ?? 1e-3;
  const clamp = opts.clampTarget;
  const n = inputs.length;
  // Pre-allocate Jx, Jy, out to avoid per-write allocations.
  const Jx = new Array<number>(n);
  const Jy = new Array<number>(n);
  const out = new Array<number | undefined>(n);
  return Vec.lens(
    inputs as never,
    vals => forward(vals as readonly number[]),
    (rawTarget, vals) => {
      const xs = vals as number[];
      const target = clamp ? clamp(rawTarget, xs) : rawTarget;
      const y0 = forward(xs);
      const dx = target.x - y0.x;
      const dy = target.y - y0.y;
      for (let i = 0; i < n; i++) {
        const saved = xs[i]!;
        xs[i] = saved + eps;
        const ye = forward(xs);
        xs[i] = saved;
        Jx[i] = (ye.x - y0.x) / eps;
        Jy[i] = (ye.y - y0.y) / eps;
      }
      // J·W·Jᵀ is the 2×2 [a b; b c]. Add damping to the diagonal, invert.
      let a = damping;
      let b = 0;
      let c = damping;
      for (let i = 0; i < n; i++) {
        const w = weights[i]!;
        a += w * Jx[i]! * Jx[i]!;
        b += w * Jx[i]! * Jy[i]!;
        c += w * Jy[i]! * Jy[i]!;
      }
      const det = a * c - b * b;
      if (Math.abs(det) < 1e-14) {
        // Singular; leave inputs unchanged.
        for (let i = 0; i < n; i++) out[i] = undefined;
        return out as never;
      }
      const invA = c / det;
      const invB = -b / det;
      const invC = a / det;
      const kx = invA * dx + invB * dy;
      const ky = invB * dx + invC * dy;
      for (let i = 0; i < n; i++) {
        const w = weights[i]!;
        if (w === 0) {
          out[i] = undefined;
        } else {
          out[i] = xs[i]! + w * (Jx[i]! * kx + Jy[i]! * ky);
        }
      }
      return out as never;
    },
  );
}
