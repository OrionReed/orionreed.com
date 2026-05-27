// wp.ts — writable-parameter lens factories.
//
// All factories built on `Cls.lens([parents], fwd, bwd)` from the
// production engine. No engine changes — just new factory shapes that
// emit bwd intentions for writable parents, exploiting the engine's
// existing `bwd[i] === undefined → skip` semantics.
//
// Naming: methods ending in `W` are the writable-parameter variants
// (peer to existing `.right(n)`, `.scale(k)`, etc., which keep their
// `Val<number>` read-only semantics).

import { batch, Num, type Read, Signal, Vec, type Writable } from "../../index";

type V = { x: number; y: number };

// ─── Vec ────────────────────────────────────────────────────────────

/** `b = a.rightW(n)`. Like `a.right(n)` but `n` is a writable peer.
 *
 *  Forward: `b = (a.x + n, a.y)`.
 *  Backward policy: the x-delta is absorbed entirely by `n`; `a` is
 *  unchanged in x. Drag `b` and `b.x - a.x` becomes `n`. */
export function vecRightW(a: Writable<Vec>, n: Writable<Num>): Writable<Vec> {
  return Vec.lens(
    [a, n] as const,
    ([av, nv]) => ({ x: av.x + nv, y: av.y }),
    (target, [av, _nv]) => {
      const newN = target.x - av.x;
      const newA = { x: av.x, y: target.y };
      return [newA, newN] as const;
    },
  );
}

/** Like `vecRightW` but with explicit absorption weight on `n`.
 *  `weight = 0` → behaves like `.right(n)` (a absorbs). `weight = 1`
 *  → `n` absorbs (above). `weight = 0.5` → 50/50 split. */
export function vecRightWeighted(
  a: Writable<Vec>,
  n: Writable<Num>,
  weight: number,
): Writable<Vec> {
  return Vec.lens(
    [a, n] as const,
    ([av, nv]) => ({ x: av.x + nv, y: av.y }),
    (target, [av, nv]) => {
      const cur = av.x + nv;
      const dx = target.x - cur;
      const dn = dx * weight;
      const da = dx * (1 - weight);
      return [
        { x: av.x + da, y: target.y },
        nv + dn,
      ] as const;
    },
  );
}

// ─── Num ────────────────────────────────────────────────────────────

/** `c = a +ʷ b`. Both writable. Bwd splits 50/50 by default. */
export function numAddW(
  a: Writable<Num>,
  b: Writable<Num>,
  weightA: number = 0.5,
): Writable<Num> {
  const weightB = 1 - weightA;
  return Num.lens(
    [a, b] as const,
    ([av, bv]) => av + bv,
    (target, [av, bv]) => {
      const cur = av + bv;
      const delta = target - cur;
      return [av + delta * weightA, bv + delta * weightB] as const;
    },
  );
}

/** Number with a "slack" companion. Equivalent to `a + slack`, where
 *  dragging the result moves only the slack; `a` is anchored. */
export function numWithSlack(a: Writable<Num>, slack: Writable<Num>): Writable<Num> {
  return numAddW(a, slack, 0); // weight 0 on a = slack absorbs all
}

/** Adaptive clamp: like `t.clamp(lo, hi)`, but if the requested write
 *  falls outside `[lo, hi]`, the BOUND expands to fit (instead of
 *  projecting back). Reads still clamp to `[lo, hi]`.
 *
 *  Bwd policy:
 *    - target inside [lo, hi]  → write target to t.
 *    - target < lo             → write target to t AND lo := target.
 *    - target > hi             → write target to t AND hi := target. */
export function clampStretch(
  t: Writable<Num>,
  lo: Writable<Num>,
  hi: Writable<Num>,
): Writable<Num> {
  return Num.lens(
    [t, lo, hi] as const,
    ([tv, lov, hiv]) => {
      if (tv < lov) return lov;
      if (tv > hiv) return hiv;
      return tv;
    },
    (target, [_tv, lov, hiv]) => {
      if (target < lov) return [target, target, undefined] as const;
      if (target > hiv) return [target, undefined, target] as const;
      return [target, undefined, undefined] as const;
    },
  );
}

/** Symmetric variant of `clampStretch`: if target is outside both bounds,
 *  shifts the WINDOW (lo, hi both move by the same delta) so the window
 *  width stays fixed. */
export function clampSlide(
  t: Writable<Num>,
  lo: Writable<Num>,
  hi: Writable<Num>,
): Writable<Num> {
  return Num.lens(
    [t, lo, hi] as const,
    ([tv, lov, hiv]) => {
      if (tv < lov) return lov;
      if (tv > hiv) return hiv;
      return tv;
    },
    (target, [_tv, lov, hiv]) => {
      if (target < lov) {
        const shift = target - lov;
        return [target, lov + shift, hiv + shift] as const;
      }
      if (target > hiv) {
        const shift = target - hiv;
        return [target, lov + shift, hiv + shift] as const;
      }
      return [target, undefined, undefined] as const;
    },
  );
}

// ─── Generic factory: build a writable-param lens by hand ───────────

/** Thin wrapper that matches the engine's `Cls.lens([parents], fwd, bwd)`
 *  shape but defaults to `Num` as the output class — convenient for
 *  exploration tests. For real usage prefer `Cls.lens(...)` directly. */
export function lensW<P extends readonly Read<unknown>[], T>(
  parents: P,
  fwd: (vals: { [K in keyof P]: P[K] extends Read<infer V> ? V : never }) => T,
  bwd: (
    target: T,
    vals: { [K in keyof P]: P[K] extends Read<infer V> ? V : never },
  ) => { [K in keyof P]?: P[K] extends Read<infer V> ? V : never },
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  Cls: new (...args: any[]) => Signal<T> = Num as never,
): Writable<Signal<T>> {
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  return (Cls as any).lens(parents, fwd, bwd);
}

// ─── Utilities used by tests ────────────────────────────────────────

/** Run a sync write batch and return after flush. */
export function withBatch<R>(fn: () => R): R {
  return batch(fn);
}
