// vec.ts — reactive 2D point.
//
// Invertibles (`add`, `sub`, `scale`, `offset`, `up`, `down`, `left`,
// `right`) return `: this` and ride on `Signal#through(fwd, bwd)`.
// Chained calls auto-fuse. Field-lens getters use the `field()`
// helper, whose conditional return type propagates writability from
// the receiver; `derived()` wraps RO views.

import { type Easing } from "../../core";
import { type Tween, tween } from "../anim";
import { bind } from "../lateral";
import { batch, Signal, type SignalOptions, type Val, valFn, value } from "../signal";
import { type Linear, traits } from "../traits";
import { derived, field, type Wr, type Writable } from "../writable";
import { Num } from "./num";

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

/** Tangent point on a circle from an external point.
 *
 *  Given a point `p` outside the circle of radius `r` centred at `c`,
 *  returns the point `T` on the circle where the line `pT` touches it.
 *  Two tangents exist — `side: -1` picks the one CCW from `pc`,
 *  `+1` the CW. (In screen coords with y-down, `-1` is the visually
 *  CW side. Pass whichever makes the rope go the way you want.)
 *
 *  If `p` is inside or on the circle, returns `c` (degenerate). */
export function tangentPoint(p: V, c: V, r: number, side: 1 | -1 = -1): V {
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  const d = Math.hypot(dx, dy);
  if (d <= r) return c;
  const baseAngle = Math.atan2(dy, dx);
  const offset = Math.acos(r / d);
  const a = baseAngle + side * offset;
  return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
}

/** Wrap `x` to the half-open interval `(-π, π]`. */
const wrapToPi = (x: number): number => x - 2 * Math.PI * Math.round(x / (2 * Math.PI));

/** Return the representative of `target` (a cyclic angle in `(-π, π]`)
 *  closest to `current`. Used as the shortest-arc inverse for cyclic
 *  coordinates — see `polar`'s circular / rotate policies. */
const nearestAngle = (target: number, current: number): number =>
  current + wrapToPi(target - current);

const linearImpl: Linear<V> = { add, sub, scale };

export class Vec extends Signal<V> {
  static traits = traits<V>()({ linear: linearImpl, lerp, metric, equals });

  /** Phantom registry brand — `Writable<Vec>` resolves to `Wr<Vec>`. */
  declare readonly _writable: Wr<Vec>;

  constructor(v: V = { x: 0, y: 0 }, opts?: SignalOptions<V>) {
    super(v, opts);
  }

  // ── invertibles: return `: this`, propagating writability ──────────
  add(b: Val<V>): this {
    const bf = valFn(b);
    return this.through(
      v => {
        const o = bf();
        return { x: v.x + o.x, y: v.y + o.y };
      },
      n => {
        const o = bf();
        return { x: n.x - o.x, y: n.y - o.y };
      },
    );
  }
  sub(b: Val<V>): this {
    const bf = valFn(b);
    return this.through(
      v => {
        const o = bf();
        return { x: v.x - o.x, y: v.y - o.y };
      },
      n => {
        const o = bf();
        return { x: n.x + o.x, y: n.y + o.y };
      },
    );
  }
  scale(k: Val<number>): this {
    const kf = valFn(k);
    return this.through(
      v => {
        const k = kf();
        return { x: v.x * k, y: v.y * k };
      },
      n => {
        const k = kf();
        return { x: n.x / k, y: n.y / k };
      },
    );
  }
  offset(dx: Val<number>, dy: Val<number>): this {
    const xf = valFn(dx);
    const yf = valFn(dy);
    return this.through(
      v => ({ x: v.x + xf(), y: v.y + yf() }),
      n => ({ x: n.x - xf(), y: n.y - yf() }),
    );
  }
  // Axis-aligned offset sugar — same fwd/bwd shape as offset.
  up(n: Val<number>): this {
    const f = valFn(n);
    return this.through(
      v => ({ x: v.x, y: v.y - f() }),
      o => ({ x: o.x, y: o.y + f() }),
    );
  }
  down(n: Val<number>): this {
    const f = valFn(n);
    return this.through(
      v => ({ x: v.x, y: v.y + f() }),
      o => ({ x: o.x, y: o.y - f() }),
    );
  }
  left(n: Val<number>): this {
    const f = valFn(n);
    return this.through(
      v => ({ x: v.x - f(), y: v.y }),
      o => ({ x: o.x + f(), y: o.y }),
    );
  }
  right(n: Val<number>): this {
    const f = valFn(n);
    return this.through(
      v => ({ x: v.x + f(), y: v.y }),
      o => ({ x: o.x - f(), y: o.y }),
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
    return Vec.derive(() => lerp(this.value, value(b), value(t)));
  }
  distance(other: Val<V>): Num {
    return this.deriveTo(Num, v => metric(v, value(other)));
  }

  // ── field lenses & derived views ───────────────────────────────────
  get x() {
    return field(this, "x", Num);
  }
  get y() {
    return field(this, "y", Num);
  }
  get magnitude() {
    return derived(this, "magnitude", Num, v => Math.hypot(v.x, v.y));
  }

  /** Tween-builder, implied by the lerp trait. `this: Writable<Vec>`
   *  gates the call site to writable receivers — bare RO Vec is
   *  rejected at compile time. */
  to(this: Writable<Vec>, target: V, dur: Val<number>, ease?: Easing): Tween<V> {
    return tween(this, target, dur, ease);
  }
}
export interface Vec {
  readonly constructor: typeof Vec;
  get value(): V;
}

/** Vec from two writable axes. Writes propagate to both source Nums
 *  in a single batch — the bidirectional sibling of `vec(num, num)`. */
export function axes(x: Writable<Num>, y: Writable<Num>): Writable<Vec> {
  return Signal.install(
    Vec,
    () => ({ x: x.value, y: y.value }),
    v => {
      batch(() => {
        x.value = v.x;
        y.value = v.y;
      });
    },
  );
}

/** Writable Vec at `(x, y)`. Smart-dispatches: when both axes are
 *  `Num` instances, returns a bidirectional 2-input lens that writes
 *  back through to the source axes. Literal / function / computed axes
 *  fall back to a forward-only effect (writes stick locally but don't
 *  propagate — there's nowhere to send them). */
export function vec(x: Val<number> = 0, y: Val<number> = 0): Writable<Vec> {
  if (x instanceof Num && y instanceof Num) {
    return axes(x as Writable<Num>, y as Writable<Num>);
  }
  const v = new Vec() as Writable<Vec>;
  bind(v.x, x);
  bind(v.y, y);
  return v;
}

/** Policy for `polar`'s inverse:
 *
 *  - `rotate`   — c fixed, write r and a so the point lands at target.
 *                 The natural "draggable point orbiting a center" mode.
 *  - `translate` — r and a fixed, shift c by Δ. The "drag the orbit
 *                  by its center" mode.
 *  - `radial`   — c and a fixed, project the drag onto the ray.
 *  - `circular` — c and r fixed, project the drag onto the circle. */
export type PolarPolicy = "rotate" | "translate" | "radial" | "circular";

/** Vec at polar offset from `center`: `center + (r·cos a, r·sin a)`.
 *
 *  Bidirectional. Writes propagate back to the input(s) selected by
 *  `policy` — but only when those inputs are themselves writable
 *  signals (Num / Vec instances). Non-writable inputs (literals,
 *  thunks, computed) are silently skipped on writes. */
export function polar(
  center: Val<V>,
  r: Val<number>,
  a: Val<number>,
  policy: PolarPolicy = "rotate",
): Writable<Vec> {
  const C = valFn(center);
  const R = valFn(r);
  const A = valFn(a);
  const cSig = center instanceof Vec ? (center as Writable<Vec>) : undefined;
  const rSig = r instanceof Num ? (r as Writable<Num>) : undefined;
  const aSig = a instanceof Num ? (a as Writable<Num>) : undefined;

  const fwd = (): V => {
    const c = C();
    const rv = R();
    const av = A();
    return { x: c.x + rv * Math.cos(av), y: c.y + rv * Math.sin(av) };
  };

  // Cyclic-coordinate inverse: pick the angle closest to current, not
  // the (-π, π] representative from atan2. Without this, dragging a
  // body whose angle has accumulated many revolutions produces large
  // discontinuous jumps in the angle signal — visually correct
  // (cos/sin are periodic) but breaks downstream lenses that read the
  // angle directly (`time = angle * period / τ`).
  let bwd: (p: V) => void;
  switch (policy) {
    case "rotate":
      bwd = p => {
        const cv = cSig ? cSig.peek() : C();
        const dx = p.x - cv.x;
        const dy = p.y - cv.y;
        const targetA = Math.atan2(dy, dx);
        const currentA = aSig ? aSig.peek() : A();
        batch(() => {
          if (rSig) rSig.value = Math.hypot(dx, dy);
          if (aSig) aSig.value = nearestAngle(targetA, currentA);
        });
      };
      break;
    case "translate":
      bwd = p => {
        const f = fwd();
        if (cSig) {
          const cv = cSig.peek();
          cSig.value = { x: cv.x + (p.x - f.x), y: cv.y + (p.y - f.y) };
        }
      };
      break;
    case "radial":
      bwd = p => {
        const cv = cSig ? cSig.peek() : C();
        const av = aSig ? aSig.peek() : A();
        const dx = p.x - cv.x;
        const dy = p.y - cv.y;
        if (rSig) rSig.value = dx * Math.cos(av) + dy * Math.sin(av);
      };
      break;
    case "circular":
      bwd = p => {
        const cv = cSig ? cSig.peek() : C();
        const targetA = Math.atan2(p.y - cv.y, p.x - cv.x);
        const currentA = aSig ? aSig.peek() : A();
        if (aSig) aSig.value = nearestAngle(targetA, currentA);
      };
      break;
  }
  return Signal.install(Vec, fwd, bwd);
}
