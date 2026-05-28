// vec.ts — reactive 2D point.
//
// Invertibles (`add`, `sub`, `scale`, `offset`, `up`, `down`, `left`,
// `right`) return `: this` and ride on `Signal#lens(fwd, bwd)`. Chained
// calls auto-fuse. Field-lens getters use the `field()` helper, whose
// conditional return type propagates writability from the receiver;
// `derived()` wraps RO views.

import type { Easing } from "../../core";
import { type Tween, tween } from "../anim";
import { batch, type Init, reader, readNow, Signal, type Val, type Writable } from "../signal";
import type { Linear, Pack, Pivotal, TraitDict } from "../traits";
import { derived, field } from "../writable";
import { Num, num } from "./num";

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
  scaleAbout: (v, p, k) => ({
    x: p.x + k * (v.x - p.x),
    y: p.y + k * (v.y - p.y),
  }),
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
    return this.lens(
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
    const bf = reader(b);
    return this.lens(
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
    const kf = reader(k);
    return this.lens(
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
    const xf = reader(dx);
    const yf = reader(dy);
    return this.lens(
      v => ({ x: v.x + xf(), y: v.y + yf() }),
      n => ({ x: n.x - xf(), y: n.y - yf() }),
    );
  }
  // Axis-aligned offset sugar — same fwd/bwd shape as offset.
  up(n: Val<number>): this {
    const f = reader(n);
    return this.lens(
      v => ({ x: v.x, y: v.y - f() }),
      o => ({ x: o.x, y: o.y + f() }),
    );
  }
  down(n: Val<number>): this {
    const f = reader(n);
    return this.lens(
      v => ({ x: v.x, y: v.y + f() }),
      o => ({ x: o.x, y: o.y - f() }),
    );
  }
  left(n: Val<number>): this {
    const f = reader(n);
    return this.lens(
      v => ({ x: v.x - f(), y: v.y }),
      o => ({ x: o.x + f(), y: o.y }),
    );
  }
  right(n: Val<number>): this {
    const f = reader(n);
    return this.lens(
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
    return Vec.derive(() => lerp(this.value, readNow(b), readNow(t)));
  }
  distance(other: Val<V>): Num {
    return Num.derive(this, v => metric(v, readNow(other)));
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

/** @internal — bidirectional 2-input lens over two writable `Num`s.
 *  `vec()` delegates here after lifting literals. Not part of the
 *  public surface; users always go through `vec()`. */
function axes(x: Writable<Num>, y: Writable<Num>): Writable<Vec> {
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

/** Writable `Vec` at `(x, y)`. Each axis is either a literal `number`
 *  (lifted to a fresh `Writable<Num>` seed) or an existing
 *  `Writable<Num>` (passed through by identity, writes propagate).
 *
 *  RO sources (computed views, RO field lenses, thunks) are rejected
 *  at the type level. Reach for `Vec.derive(...)` to track an RO source
 *  reactively, or pass `signal.value` to snapshot the current value.
 *
 *  To lock a single axis to a constant inside a writable Vec, pair the
 *  literal axis with the constant-projection primitive:
 *
 *      vec(slider, Num.pin(100))   // x writable, y locked at 100 */
export function vec(x: Init<Num> = 0, y: Init<Num> = 0): Writable<Vec> {
  if (typeof x === "number" && typeof y === "number") {
    return new Vec({ x, y }) as Writable<Vec>;
  }
  return axes(num(x), num(y));
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
 *  Bidirectional. Each input is either a literal (lifted to a fresh
 *  writable seed) or an existing writable signal (`Writable<Vec>` for
 *  `center`, `Writable<Num>` for `r` / `a`). RO inputs are rejected at
 *  the type level — use `Vec.derive(...)` for reactive RO tracking.
 *
 *  `policy` selects which inputs absorb writes. To make an input
 *  structurally inert under writes (lock-axis), wrap it in the
 *  constant-projection primitive: `polar(c, Num.pin(100), a)`. */
export function polar(
  center: Init<Vec>,
  r: Init<Num>,
  a: Init<Num>,
  policy: PolarPolicy = "rotate",
): Writable<Vec> {
  // Lift literals — all three inputs become unified `Writable<...>`.
  // Identity passthrough for already-writable inputs.
  const cSig: Writable<Vec> = center instanceof Vec ? center : vec(center.x, center.y);
  const rSig: Writable<Num> = num(r);
  const aSig: Writable<Num> = num(a);

  const fwd = (): V => {
    const c = cSig.value;
    const rv = rSig.value;
    const av = aSig.value;
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
        const cv = cSig.peek();
        const dx = p.x - cv.x;
        const dy = p.y - cv.y;
        const targetA = Math.atan2(dy, dx);
        const currentA = aSig.peek();
        batch(() => {
          rSig.value = Math.hypot(dx, dy);
          aSig.value = nearestAngle(targetA, currentA);
        });
      };
      break;
    case "translate":
      bwd = p => {
        const f = fwd();
        const cv = cSig.peek();
        cSig.value = { x: cv.x + (p.x - f.x), y: cv.y + (p.y - f.y) };
      };
      break;
    case "radial":
      bwd = p => {
        const cv = cSig.peek();
        const av = aSig.peek();
        const dx = p.x - cv.x;
        const dy = p.y - cv.y;
        rSig.value = dx * Math.cos(av) + dy * Math.sin(av);
      };
      break;
    case "circular":
      bwd = p => {
        const cv = cSig.peek();
        const targetA = Math.atan2(p.y - cv.y, p.x - cv.x);
        const currentA = aSig.peek();
        aSig.value = nearestAngle(targetA, currentA);
      };
      break;
  }
  return Signal.install(Vec, fwd, bwd);
}
