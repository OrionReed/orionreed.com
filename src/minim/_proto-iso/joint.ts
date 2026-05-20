// Multi-source iso. `Joint<Ss, T>` is the N-to-1 analogue of `Iso`:
// merge `Ss` into a `T`, distribute a `T` back into `Ss`. The terminal
// `viaJoint()` returns a writable `Signal<T>` if `bwd` is present,
// `Read<T>` otherwise.
//
// `combine` / `mean` in `signals/values/index.ts` become specializations
// of this primitive — same machinery as single-source isos, just with
// an array `prev` snapshot.

import {
  Signal,
  type Read,
  computed,
  lens,
} from "../signals/signal";
import { derived } from "../signals/derive";
import { requireLinear, classOf } from "../signals/traits";

/** Reads all members of `Ss` as a tuple. */
type Vals<Ss extends readonly Read<unknown>[]> = {
  readonly [K in keyof Ss]: Ss[K] extends Read<infer V> ? V : never;
};

/** Mutable counterpart for the distribute return. */
type MutVals<Ss extends readonly Read<unknown>[]> = {
  -readonly [K in keyof Ss]: Ss[K] extends Read<infer V> ? V : never;
};

/** Merge sources into a view. */
export interface RoJoint<Ss extends readonly Read<unknown>[], T> {
  fwd: (...vs: Vals<Ss>) => T;
}

/** Merge sources into a view; distribute a new view back. */
export interface RwJoint<Ss extends readonly Read<unknown>[], T> extends RoJoint<Ss, T> {
  bwd: (next: T, prev: Vals<Ss>) => MutVals<Ss>;
}

export type Joint<Ss extends readonly Read<unknown>[], T> =
  | RoJoint<Ss, T>
  | RwJoint<Ss, T>;

/** Apply a joint to its sources. Writable iff `bwd` is present.
 *  Optional `Cls` makes the result `instanceof Cls` — important so trait
 *  slots (`[LINEAR]`, `[LERP]`, …) are visible on the joint, enabling
 *  e.g. `mean(mean1, mean2)`, `spring(meanLens, ...)`, etc. */
export function viaJoint<Ss extends readonly Read<unknown>[], T>(
  parts: Ss,
  j: RwJoint<Ss, T>,
): Signal<T>;
export function viaJoint<Ss extends readonly Read<unknown>[], T>(
  parts: Ss,
  j: RoJoint<Ss, T>,
): Read<T>;
export function viaJoint<Ss extends readonly Read<unknown>[], T, C extends Signal<T>>(
  parts: Ss,
  j: RwJoint<Ss, T>,
  Cls: new (...args: never[]) => C,
): C;
export function viaJoint<Ss extends readonly Read<unknown>[], T, C extends Signal<T>>(
  parts: Ss,
  j: RoJoint<Ss, T>,
  Cls: new (...args: never[]) => C,
): Omit<C, "value"> & Read<T>;
export function viaJoint<Ss extends readonly Read<unknown>[], T>(
  parts: Ss,
  j: Joint<Ss, T>,
  Cls?: new (...args: never[]) => Signal<T>,
): Signal<T> | Read<T> {
  const readAll = (): Vals<Ss> => {
    const out = new Array<unknown>(parts.length);
    for (let i = 0; i < parts.length; i++) out[i] = parts[i].value;
    return out as unknown as Vals<Ss>;
  };
  const peekAll = (): Vals<Ss> => {
    const out = new Array<unknown>(parts.length);
    for (let i = 0; i < parts.length; i++) out[i] = parts[i].peek();
    return out as unknown as Vals<Ss>;
  };

  if (!("bwd" in j) || j.bwd === undefined) {
    return Cls
      ? derived(Cls, () => j.fwd(...readAll()))
      : computed(() => j.fwd(...readAll()));
  }

  const bwd = j.bwd;
  const setter = (next: T): void => {
    const prevs = peekAll();
    const updated = bwd(next, prevs);
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p instanceof Signal) (p as Signal<unknown>).value = updated[i];
    }
  };
  return Cls
    ? derived(Cls, () => j.fwd(...readAll()), setter)
    : lens(() => j.fwd(...readAll()), setter);
}

// ─── `mean` as a joint ────────────────────────────────────────────────

/** Vec from two writable axis lenses. Writes distribute per-axis,
 *  reads compose. Different from `vec(numA, numB)` (one-way bind):
 *  this is a true bidirectional joint. */
export function vecFromAxes(
  x: Signal<number>,
  y: Signal<number>,
): Signal<{ x: number; y: number }> {
  type Ss = readonly [Signal<number>, Signal<number>];
  return viaJoint([x, y] as Ss, {
    fwd: (xv, yv) => ({ x: xv, y: yv }),
    bwd: (next) => [next.x, next.y] as MutVals<Ss>,
  });
}

/** Writable arithmetic mean. Writes distribute the delta evenly across
 *  every part. Needs `[LINEAR]` on the parts' value type. The returned
 *  signal is `instanceof parts[0].constructor` (so traits are visible —
 *  `mean(mean1, mean2)` works, `spring(meanLens, …)` works). */
export function mean<T, S extends Read<T>>(...parts: S[]): S {
  if (parts.length === 0) throw new Error("mean: need ≥1 signal");
  const lin = requireLinear(parts[0]);
  const Cls = classOf(parts[0]) as unknown as new (...args: never[]) => Signal<T>;
  const invN = 1 / parts.length;
  type Ss = S[];
  const j: RwJoint<Ss, T> = {
    fwd: (...vs) => {
      let acc = vs[0] as T;
      for (let i = 1; i < vs.length; i++) acc = lin.add(acc, vs[i] as T);
      return lin.scale(acc, invN);
    },
    bwd: (next, prev) => {
      let acc = prev[0] as T;
      for (let i = 1; i < prev.length; i++) acc = lin.add(acc, prev[i] as T);
      const cur = lin.scale(acc, invN);
      const delta = lin.sub(next, cur);
      return prev.map((v) => lin.add(v as T, delta)) as MutVals<Ss>;
    },
  };
  return viaJoint(parts, j, Cls) as unknown as S;
}
