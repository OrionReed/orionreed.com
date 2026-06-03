// vec.ts — reactive 2D point (symmetric-engine port).
//
// Invertibles return `: this` and ride `Signal#iso` (put reconstructs the
// source from the view alone). Field getters use `field()` (writability-
// propagating); `derived()` wraps RO views. `axes()` / `polar()` are
// multi-parent lenses — backward splits into N parents. `axes` is an `iso`
// (split ignores the parents); `polar` is a `lens` (its policy reads the
// current parents). These replace the old closure-setter `install` footgun.
//
// NOTE: the consumer-layer `to()` tween-builder is omitted in this port.

import type { Linear, Pack, Pivotal, TraitDict } from "../../../traits";
import { type Init, type Val, type Writable, readNow, reader } from "../signal";
import { derived, field } from "./writable";
import { Num, num } from "./num";
import { Signal } from "../signal";

type V = { x: number; y: number };

export const add = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: V, k: number): V => ({ x: a.x * k, y: a.y * k });
export const lerp = (a: V, b: V, t: number): V => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});
export const metric = (a: V, b: V) => Math.hypot(a.x - b.x, a.y - b.y);
export const equals = (a: V, b: V) => a === b || (a.x === b.x && a.y === b.y);
export const normalize = (v: V): V => {
  const m = Math.hypot(v.x, v.y);
  return m === 0 ? { x: 0, y: 0 } : { x: v.x / m, y: v.y / m };
};
export const perp = (v: V): V => ({ x: v.y, y: -v.x });

/** Wrap `x` to `(-π, π]`. */
const wrapToPi = (x: number): number => x - 2 * Math.PI * Math.round(x / (2 * Math.PI));
/** Representative of `target` closest to `current` (shortest-arc). */
const nearestAngle = (target: number, current: number): number =>
  current + wrapToPi(target - current);

const linearImpl: Linear<V> = { add, sub, scale };
const packImpl: Pack<V> = {
  dim: 2,
  read: (v, a, o) => {
    a[o] = v.x;
    a[o + 1] = v.y;
  },
  write: (a, o) => ({ x: a[o]!, y: a[o + 1]! }),
};
const pivotalImpl: Pivotal<V> = {
  rotateAbout: (v, p, dθ) => {
    const cos = Math.cos(dθ);
    const sin = Math.sin(dθ);
    const dx = v.x - p.x;
    const dy = v.y - p.y;
    return { x: p.x + cos * dx - sin * dy, y: p.y + sin * dx + cos * dy };
  },
  scaleAbout: (v, p, k) => ({ x: p.x + k * (v.x - p.x), y: p.y + k * (v.y - p.y) }),
};

export class Vec extends Signal<V> {
  static traits = {
    linear: linearImpl,
    lerp,
    metric,
    equals,
    pack: packImpl,
    pivotal: pivotalImpl,
  } satisfies TraitDict<V>;
  declare readonly _t: typeof Vec.traits;

  constructor(v: V = { x: 0, y: 0 }) {
    super(v, { equals });
  }

  // ── invertibles: return `: this`, propagating writability ──────────
  add(b: Val<V>): this {
    const bf = reader(b);
    return this.iso(
      (v) => {
        const o = bf();
        return { x: v.x + o.x, y: v.y + o.y };
      },
      (n) => {
        const o = bf();
        return { x: n.x - o.x, y: n.y - o.y };
      },
    );
  }
  sub(b: Val<V>): this {
    const bf = reader(b);
    return this.iso(
      (v) => {
        const o = bf();
        return { x: v.x - o.x, y: v.y - o.y };
      },
      (n) => {
        const o = bf();
        return { x: n.x + o.x, y: n.y + o.y };
      },
    );
  }
  scale(k: Val<number>): this {
    const kf = reader(k);
    return this.iso(
      (v) => {
        const s = kf();
        return { x: v.x * s, y: v.y * s };
      },
      (n) => {
        const s = kf();
        return { x: n.x / s, y: n.y / s };
      },
    );
  }
  offset(dx: Val<number>, dy: Val<number>): this {
    const xf = reader(dx);
    const yf = reader(dy);
    return this.iso(
      (v) => ({ x: v.x + xf(), y: v.y + yf() }),
      (n) => ({ x: n.x - xf(), y: n.y - yf() }),
    );
  }

  // ── non-invertibles: explicit RO return ────────────────────────────
  normalize(): Vec {
    return Vec.derive(() => normalize(this.value));
  }
  perp(): Vec {
    return Vec.derive(() => perp(this.value));
  }
  lerp(b: Val<V>, t: Val<number>): Vec {
    return Vec.derive(() => lerp(this.value, readNow(b), readNow(t)));
  }
  distance(other: Val<V>): Num {
    return Num.derive(this, (v) => metric(v, readNow(other)));
  }

  // ── field lenses & derived views ───────────────────────────────────
  get x() {
    return field(this, "x", Num);
  }
  get y() {
    return field(this, "y", Num);
  }
  get magnitude() {
    return derived(this, "magnitude", Num, (v) => Math.hypot(v.x, v.y));
  }
}

/** @internal — bidirectional 2-input lens over two writable `Num`s.
 *  An `iso`: forward reads both axes, backward splits the target into a
 *  per-parent `[x, y]` update array (the split ignores the parents). */
function axes(x: Writable<Num>, y: Writable<Num>): Writable<Vec> {
  return Vec.iso(
    [x, y],
    (vals) => ({ x: vals[0] as number, y: vals[1] as number }),
    (target) => [(target as V).x, (target as V).y],
  ) as unknown as Writable<Vec>;
}

/** Writable `Vec` at `(x, y)`. */
export function vec(x: Init<Num> = 0, y: Init<Num> = 0): Writable<Vec> {
  if (typeof x === "number" && typeof y === "number") {
    return new Vec({ x, y }) as Writable<Vec>;
  }
  return axes(num(x), num(y));
}

export type PolarPolicy = "rotate" | "translate" | "radial" | "circular";

/** Vec at polar offset from `center`: `center + (r·cos a, r·sin a)`.
 *  A source-reading multi-parent `lens` over `[center, r, a]`; `policy`
 *  selects which parents absorb writes (others get `undefined` ⇒
 *  untouched), reading the current parent values to do so. */
export function polar(
  center: Init<Vec>,
  r: Init<Num>,
  a: Init<Num>,
  policy: PolarPolicy = "rotate",
): Writable<Vec> {
  const cSig: Writable<Vec> = center instanceof Vec ? center : vec(center.x, center.y);
  const rSig: Writable<Num> = num(r);
  const aSig: Writable<Num> = num(a);

  const fwd = (vals: readonly unknown[]): V => {
    const c = vals[0] as V;
    const rv = vals[1] as number;
    const av = vals[2] as number;
    return { x: c.x + rv * Math.cos(av), y: c.y + rv * Math.sin(av) };
  };

  // Source-reading backward: `vals` are the current parent values.
  // Returns [centerUpdate?, rUpdate?, aUpdate?] — `undefined` leaves a
  // parent untouched.
  const bwd = (target: V, vals?: readonly unknown[]): ReadonlyArray<unknown> => {
    const cv = vals![0] as V;
    const rv = vals![1] as number;
    const av = vals![2] as number;
    switch (policy) {
      case "rotate": {
        const dx = target.x - cv.x;
        const dy = target.y - cv.y;
        return [undefined, Math.hypot(dx, dy), nearestAngle(Math.atan2(dy, dx), av)];
      }
      case "translate": {
        const f = { x: cv.x + rv * Math.cos(av), y: cv.y + rv * Math.sin(av) };
        return [{ x: cv.x + (target.x - f.x), y: cv.y + (target.y - f.y) }, undefined, undefined];
      }
      case "radial": {
        const dx = target.x - cv.x;
        const dy = target.y - cv.y;
        return [undefined, dx * Math.cos(av) + dy * Math.sin(av), undefined];
      }
      case "circular": {
        const targetA = Math.atan2(target.y - cv.y, target.x - cv.x);
        return [undefined, undefined, nearestAngle(targetA, av)];
      }
    }
  };

  return Vec.lens([cSig, rSig, aSig], fwd, bwd) as unknown as Writable<Vec>;
}
