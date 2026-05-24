// _proto-unified-lens/aggregates.ts — re-implementation of the
// existing `signals/aggregates.ts` on the new `lens` / `classLens`
// surface. A/B target: same outputs, same or smaller LOC, same or
// better perf.
//
// What changes vs the current `aggregates.ts`:
//   - `fanin(Cls, parents, fwd, bwd)` → `classLens(Cls, parents, fwd, bwd)`
//   - For RO aggregates (`sumLens`, `minLens`, `maxLens`):
//       `fanin(Cls, parents, fwd)` → `classDerive(Cls, parents, fn)`
//   - The trait-fetch boilerplate (Linear lookup, error-on-missing)
//     is the same.
//
// Net change: a literal name swap. The point of writing it out is
// to confirm the new surface FITS the existing call shapes without
// any awkwardness — same LOC, same arg shape.

import type { Writable } from "../signals";
import { type Linear, Num, type Signal, Vec } from "../signals";
import { classDerive, classLens } from "./core";

type V = { x: number; y: number };

/** Equal-weight mean with delta-even distribution. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape, mirrors classLens
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
  return classLens(
    Cls,
    parents as never,
    // biome-ignore lint/suspicious/noExplicitAny: tuple variance
    (vals: any) => {
      let acc = vals[0] as T;
      for (let i = 1; i < n; i++) acc = lin.add(acc, vals[i]);
      return lin.scale(acc, inv);
    },
    // biome-ignore lint/suspicious/noExplicitAny: tuple variance
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

/** Sum of N Linear values (RO). */
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
  return classDerive(
    Cls,
    parents as never,
    // biome-ignore lint/suspicious/noExplicitAny: tuple variance
    (vals: any) => {
      let acc = vals[0] as T;
      for (let i = 1; i < n; i++) acc = lin.add(acc, vals[i]);
      return acc;
    },
  );
}

/** Min of N nums (RO). */
export function minLens(parents: readonly Signal<number>[]): Num {
  return classDerive(Num, parents as never, vals => {
    const arr = vals as readonly number[];
    let m = arr[0]!;
    for (let i = 1; i < arr.length; i++) if (arr[i]! < m) m = arr[i]!;
    return m;
  });
}

/** Max of N nums (RO). */
export function maxLens(parents: readonly Signal<number>[]): Num {
  return classDerive(Num, parents as never, vals => {
    const arr = vals as readonly number[];
    let m = arr[0]!;
    for (let i = 1; i < arr.length; i++) if (arr[i]! > m) m = arr[i]!;
    return m;
  });
}

/** Midpoint of two writable Vecs. Drag-translates both. */
export function midpointLens(a: Signal<V>, b: Signal<V>): Writable<Vec> {
  return classLens(
    Vec,
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
  return classLens(
    Vec,
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

/** Vec from two writable Num axes. Stateless bwd → fast-path. */
export function axesLens(x: Num, y: Num): Writable<Vec> {
  return classLens(
    Vec,
    [x, y] as const,
    (vals): V => ({ x: vals[0], y: vals[1] }),
    (target: V) => [target.x, target.y] as never,
  );
}

/** Polar Vec under circular policy. Writes update only `a`. */
export function polarCircular(c: Signal<V>, r: Num, a: Num): Writable<Vec> {
  return classLens(
    Vec,
    [c, r, a] as const,
    vals => {
      const [cv, rv, av] = vals;
      return { x: cv.x + rv * Math.cos(av), y: cv.y + rv * Math.sin(av) };
    },
    (target, vals) => {
      const [cv, _rv, av] = vals;
      const targetA = Math.atan2(target.y - cv.y, target.x - cv.x);
      const TAU = 2 * Math.PI;
      const wrapped = targetA - av - TAU * Math.round((targetA - av) / TAU);
      const newA = av + wrapped;
      return [undefined, undefined, newA] as never;
    },
  );
}

/** Scalar argmin via Newton step + weighted distribution. */
export function argminNumLens(
  inputs: readonly Num[],
  forward: (xs: readonly number[]) => number,
  weights: readonly number[],
  eps = 1e-4,
  damping = 1e-6,
): Writable<Num> {
  if (weights.length !== inputs.length) {
    throw new Error("argminNumLens: weights/inputs length mismatch");
  }
  const n = inputs.length;
  const J = new Array<number>(n);
  const out = new Array<number | undefined>(n);
  return classLens(
    Num,
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
