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
import {
  isShare,
  type LensAlgebra,
  lensWithParam,
  type Param,
  paramReader,
  type Share,
} from "../lens-params";
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
  add(b: Param<V>): this {
    return lensWithParam(this as unknown as Writable<Vec>, b, VEC_ADD_ALG) as unknown as this;
  }
  sub(b: Param<V>): this {
    return lensWithParam(this as unknown as Writable<Vec>, b, VEC_SUB_ALG) as unknown as this;
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
  offset(dx: Param<number>, dy: Param<number>): this {
    if (isShare(dx) || isShare(dy))
      return _vecOffsetShare(this, dx, dy) as unknown as this;
    const xf = reader(dx as Val<number>);
    const yf = reader(dy as Val<number>);
    return this.lens(
      v => ({ x: v.x + xf(), y: v.y + yf() }),
      n => ({ x: n.x - xf(), y: n.y - yf() }),
    );
  }
  // Axis-aligned offset sugar — same fwd/bwd shape as offset.
  up(n: Param<number>): this {
    return lensWithParam(this as unknown as Writable<Vec>, n, VEC_UP_ALG) as unknown as this;
  }
  down(n: Param<number>): this {
    return lensWithParam(this as unknown as Writable<Vec>, n, VEC_DOWN_ALG) as unknown as this;
  }
  left(n: Param<number>): this {
    return lensWithParam(this as unknown as Writable<Vec>, n, VEC_LEFT_ALG) as unknown as this;
  }
  right(n: Param<number>): this {
    return lensWithParam(this as unknown as Writable<Vec>, n, VEC_RIGHT_ALG) as unknown as this;
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

// ─── @experimental — algebras for `lensWithParam` ───────────────────
//
// Each entry is the 3-closure algebra (fwd + solveA + solveP) the
// generic `lensWithParam` helper consumes to emit RO / share() / own()
// behaviors uniformly. Vec params: blendP is the component-wise lerp
// (the default numeric blend would mis-handle Vec).

const vecBlend = (p: V, q: V, w: number): V => ({
  x: p.x + (q.x - p.x) * w,
  y: p.y + (q.y - p.y) * w,
});

const VEC_ADD_ALG: LensAlgebra<V, V> = {
  fwd: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
  solveA: (v, b) => ({ x: v.x - b.x, y: v.y - b.y }),
  solveP: (v, a) => ({ x: v.x - a.x, y: v.y - a.y }),
  blendP: vecBlend,
};

const VEC_SUB_ALG: LensAlgebra<V, V> = {
  fwd: (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
  solveA: (v, b) => ({ x: v.x + b.x, y: v.y + b.y }),
  solveP: (v, a) => ({ x: a.x - v.x, y: a.y - v.y }),
  blendP: vecBlend,
};

// Axis-aligned offsets: view.axis = a.axis + sign * scalar. The other
// axis passes through (receiver absorbs y-changes for x-axis methods).

const VEC_UP_ALG: LensAlgebra<V, number> = {
  fwd: (a, n) => ({ x: a.x, y: a.y - n }),
  solveA: (v, n) => ({ x: v.x, y: v.y + n }),
  solveP: (v, a) => a.y - v.y,
};

const VEC_DOWN_ALG: LensAlgebra<V, number> = {
  fwd: (a, n) => ({ x: a.x, y: a.y + n }),
  solveA: (v, n) => ({ x: v.x, y: v.y - n }),
  solveP: (v, a) => v.y - a.y,
};

const VEC_LEFT_ALG: LensAlgebra<V, number> = {
  fwd: (a, n) => ({ x: a.x - n, y: a.y }),
  solveA: (v, n) => ({ x: v.x + n, y: v.y }),
  solveP: (v, a) => a.x - v.x,
};

const VEC_RIGHT_ALG: LensAlgebra<V, number> = {
  fwd: (a, n) => ({ x: a.x + n, y: a.y }),
  solveA: (v, n) => ({ x: v.x - n, y: v.y }),
  solveP: (v, a) => v.x - a.x,
};

// `offset` still uses the bespoke multi-input helper below — two
// writable params don't map cleanly onto the 2-input `lensWithParam`
// shape yet.

function _vecOffsetShare(self: Vec, dxP: Param<number>, dyP: Param<number>): Writable<Vec> {
  const selfRW = self as Writable<Vec>;
  const xWrap = isShare(dxP) ? (dxP as Share<number>) : undefined;
  const yWrap = isShare(dyP) ? (dyP as Share<number>) : undefined;
  const xRead = paramReader(dxP);
  const yRead = paramReader(dyP);
  const xWeight = xWrap ? reader(xWrap.weight) : () => 0;
  const yWeight = yWrap ? reader(yWrap.weight) : () => 0;

  return Vec.lens(
    () => {
      const nv = self.value;
      return {
        x: nv.x + (xWrap ? xWrap.sig.value : xRead()),
        y: nv.y + (yWrap ? yWrap.sig.value : yRead()),
      };
    },
    (target: V) => {
      batch(() => {
        const nv = self.peek();
        const xv = xWrap ? xWrap.sig.peek() : xRead();
        const yv = yWrap ? yWrap.sig.peek() : yRead();
        const dx = target.x - (nv.x + xv);
        const dy = target.y - (nv.y + yv);
        const wx = xWeight();
        const wy = yWeight();

        let residX = 0;
        let residY = 0;
        if (xWrap) {
          const desired = xv + dx * wx;
          xWrap.sig.value = desired;
          residX = desired - xWrap.sig.peek();
        }
        if (yWrap) {
          const desired = yv + dy * wy;
          yWrap.sig.value = desired;
          residY = desired - yWrap.sig.peek();
        }

        const rxx = dx * (1 - wx) + residX;
        const ryy = dy * (1 - wy) + residY;
        if (rxx !== 0 || ryy !== 0) selfRW.value = { x: nv.x + rxx, y: nv.y + ryy };
      });
    },
  );
}

