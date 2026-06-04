// new-primitives.ts — building blocks over the N-input `Cls.lens` /
// `Cls.derive` forms. All are a few lines on top of the engine.

import type { Cell, Writable } from "./signal";
import { Num } from "./values/num";
import { Vec } from "./values/vec";

type V = { x: number; y: number };

// ─── Geometric primitives ────────────────────────────────────────────

/** Distance between two Vecs. RO — the inverse isn't unique. For a
 *  writable variant see `radialLens`. */
export function distanceLens(a: Cell<V>, b: Cell<V>): Num {
  return Num.derive([a, b] as const, vals =>
    Math.hypot(vals[0].x - vals[1].x, vals[0].y - vals[1].y),
  );
}

/** Angle from `a` to `b`, in radians. RO. */
export function angleLens(a: Cell<V>, b: Cell<V>): Num {
  return Num.derive([a, b] as const, vals =>
    Math.atan2(vals[1].y - vals[0].y, vals[1].x - vals[0].x),
  );
}

/** Reflect `point` across the line through `axisStart`/`axisEnd`. Writes
 *  the reflected position back to `point` (axis unchanged); reflection is
 *  involutive, so the same formula reads and writes. */
export function reflectionLens(
  point: Cell<V>,
  axisStart: Cell<V>,
  axisEnd: Cell<V>,
): Writable<Vec> {
  const reflect = (p: V, a: V, b: V): V => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return p;
    const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    const projX = a.x + t * dx;
    const projY = a.y + t * dy;
    return { x: 2 * projX - p.x, y: 2 * projY - p.y };
  };
  return Vec.lens(
    [point, axisStart, axisEnd] as const,
    vals => reflect(vals[0], vals[1], vals[2]),
    (target, vals) => [reflect(target, vals[1], vals[2]), undefined, undefined] as never,
  );
}

/** Lerp between two Vecs at parameter `t`. Writing the interpolated point
 *  shifts both endpoints rigidly (preserving t). */
export function vecLerp(a: Cell<V>, b: Cell<V>, t: Cell<number>): Writable<Vec> {
  return Vec.lens(
    [a, b, t] as const,
    vals => {
      const [av, bv, tv] = vals;
      return { x: av.x + (bv.x - av.x) * tv, y: av.y + (bv.y - av.y) * tv };
    },
    (target, vals) => {
      const [av, bv, tv] = vals;
      const dx = target.x - (av.x + (bv.x - av.x) * tv);
      const dy = target.y - (av.y + (bv.y - av.y) * tv);
      return [
        { x: av.x + dx, y: av.y + dy },
        { x: bv.x + dx, y: bv.y + dy },
        undefined, // t unchanged
      ];
    },
  );
}

// ─── Conservation laws (fan-in with constant-sum bwd) ──────────────

/** Sum of two nums; writing the sum splits the delta equally between
 *  a and b (the "pulley" conservation pattern). */
export function pulleySum(a: Num, b: Num): Writable<Num> {
  return Num.lens(
    [a, b] as const,
    vals => vals[0] + vals[1],
    (target, vals) => {
      const [av, bv] = vals;
      const cur = av + bv;
      const delta = target - cur;
      return [av + delta / 2, bv + delta / 2];
    },
  );
}

/** Difference of two nums: `a - b`. Writing the difference shifts
 *  both inputs symmetrically by ±half-delta. */
export function diffLens(a: Num, b: Num): Writable<Num> {
  return Num.lens(
    [a, b] as const,
    vals => vals[0] - vals[1],
    (target, vals) => {
      const [av, bv] = vals;
      const cur = av - bv;
      const delta = target - cur;
      return [av + delta / 2, bv - delta / 2];
    },
  );
}

// ─── Constrained / clamped aggregates ───────────────────────────────

/** Mean of N nums, clamped to `[lo, hi]` on read and write (writes are
 *  clamped before the delta is distributed). */
export function clampedMean(parents: readonly Num[], lo: number, hi: number): Writable<Num> {
  const n = parents.length;
  const inv = 1 / n;
  return Num.lens(
    parents as never,
    vals => {
      const arr = vals as readonly number[];
      let s = 0;
      for (let i = 0; i < n; i++) s += arr[i]!;
      const m = s * inv;
      return m < lo ? lo : m > hi ? hi : m;
    },
    (target, vals) => {
      const arr = vals as readonly number[];
      const clamped = target < lo ? lo : target > hi ? hi : target;
      let s = 0;
      for (let i = 0; i < n; i++) s += arr[i]!;
      const cur = s * inv;
      const delta = clamped - cur;
      const out = new Array<number>(n);
      for (let i = 0; i < n; i++) out[i] = arr[i]! + delta;
      return out as never;
    },
  );
}

// ─── Curve primitives (RO) ──────────────────────────────────────────

/** Quadratic Bézier point at parameter `t`. RO. */
export function bezier2(p0: Cell<V>, p1: Cell<V>, p2: Cell<V>, t: Cell<number>): Vec {
  return Vec.derive([p0, p1, p2, t] as const, vals => {
    const [a, b, c, tv] = vals;
    const u = 1 - tv;
    return {
      x: u * u * a.x + 2 * u * tv * b.x + tv * tv * c.x,
      y: u * u * a.y + 2 * u * tv * b.y + tv * tv * c.y,
    };
  });
}

/** Cubic Bézier point at parameter `t`. RO. */
export function bezier3(p0: Cell<V>, p1: Cell<V>, p2: Cell<V>, p3: Cell<V>, t: Cell<number>): Vec {
  return Vec.derive([p0, p1, p2, p3, t] as const, vals => {
    const [a, b, c, d, tv] = vals;
    const u = 1 - tv;
    const u2 = u * u;
    const t2 = tv * tv;
    return {
      x: u2 * u * a.x + 3 * u2 * tv * b.x + 3 * u * t2 * c.x + t2 * tv * d.x,
      y: u2 * u * a.y + 3 * u2 * tv * b.y + 3 * u * t2 * c.y + t2 * tv * d.y,
    };
  });
}
