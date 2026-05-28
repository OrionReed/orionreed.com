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
  claim,
  isOwn,
  isShare,
  type Own,
  type Param,
  paramReader,
  type Share,
  withinOwner,
} from "../lens-params";
import { network, type Signal as _Signal } from "../signal";
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
    if (isOwn(b)) return _vecAddOwn(this as unknown as Writable<Vec>, b as Own<V>) as unknown as this;
    if (isShare(b)) return _vecAddShare(this, b as Share<V>) as unknown as this;
    const bf = reader(b as Val<V>);
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
  sub(b: Param<V>): this {
    if (isShare(b)) return _vecSubShare(this, b as Share<V>) as unknown as this;
    const bf = reader(b as Val<V>);
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
    if (isOwn(n))
      return _vecAxisOwn(this as unknown as Writable<Vec>, n as Own<number>, "y", -1) as unknown as this;
    if (isShare(n))
      return _vecAxisShare(this, n as Share<number>, "y", -1) as unknown as this;
    const f = reader(n as Val<number>);
    return this.lens(
      v => ({ x: v.x, y: v.y - f() }),
      o => ({ x: o.x, y: o.y + f() }),
    );
  }
  down(n: Param<number>): this {
    if (isOwn(n))
      return _vecAxisOwn(this as unknown as Writable<Vec>, n as Own<number>, "y", +1) as unknown as this;
    if (isShare(n))
      return _vecAxisShare(this, n as Share<number>, "y", +1) as unknown as this;
    const f = reader(n as Val<number>);
    return this.lens(
      v => ({ x: v.x, y: v.y + f() }),
      o => ({ x: o.x, y: o.y - f() }),
    );
  }
  left(n: Param<number>): this {
    if (isOwn(n))
      return _vecAxisOwn(this as unknown as Writable<Vec>, n as Own<number>, "x", -1) as unknown as this;
    if (isShare(n))
      return _vecAxisShare(this, n as Share<number>, "x", -1) as unknown as this;
    const f = reader(n as Val<number>);
    return this.lens(
      v => ({ x: v.x - f(), y: v.y }),
      o => ({ x: o.x + f(), y: o.y }),
    );
  }
  right(n: Param<number>): this {
    if (isOwn(n))
      return _vecAxisOwn(this as unknown as Writable<Vec>, n as Own<number>, "x", +1) as unknown as this;
    if (isShare(n))
      return _vecAxisShare(this, n as Share<number>, "x", +1) as unknown as this;
    const f = reader(n as Val<number>);
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

// ─── Writable-parameter bwd helpers ─────────────────────────────────
//
// Residual-aware: each helper writes its wrapped param(s) first, peeks
// to observe what actually landed, and routes any unabsorbed residual
// to the receiver. For primitive params this collapses to the
// weight-only behaviour (residual = 0). For saturating-lens params
// (e.g., `slack.clamp(min, max)`) the residual flows naturally,
// producing the soft-spring-hard-stop pattern.

function _vecAddShare(self: Vec, b: Share<V>): Writable<Vec> {
  const selfRW = self as Writable<Vec>;
  const wf = reader(b.weight);
  return Vec.lens(
    () => {
      const nv = self.value;
      const bv = b.sig.value;
      return { x: nv.x + bv.x, y: nv.y + bv.y };
    },
    (target: V) => {
      batch(() => {
        const nv = self.peek();
        const bv = b.sig.peek();
        const w = wf();
        const dx = target.x - (nv.x + bv.x);
        const dy = target.y - (nv.y + bv.y);
        const desired = { x: bv.x + dx * w, y: bv.y + dy * w };
        b.sig.value = desired;
        const after = b.sig.peek();
        const residualX = desired.x - after.x;
        const residualY = desired.y - after.y;
        const rxx = dx * (1 - w) + residualX;
        const ryy = dy * (1 - w) + residualY;
        if (rxx !== 0 || ryy !== 0) selfRW.value = { x: nv.x + rxx, y: nv.y + ryy };
      });
    },
  );
}

function _vecSubShare(self: Vec, b: Share<V>): Writable<Vec> {
  const selfRW = self as Writable<Vec>;
  const wf = reader(b.weight);
  return Vec.lens(
    () => {
      const nv = self.value;
      const bv = b.sig.value;
      return { x: nv.x - bv.x, y: nv.y - bv.y };
    },
    (target: V) => {
      batch(() => {
        const nv = self.peek();
        const bv = b.sig.peek();
        const w = wf();
        const dx = target.x - (nv.x - bv.x);
        const dy = target.y - (nv.y - bv.y);
        // b absorbs negated delta.
        const desired = { x: bv.x - dx * w, y: bv.y - dy * w };
        b.sig.value = desired;
        const after = b.sig.peek();
        const residualXNeg = desired.x - after.x;
        const residualYNeg = desired.y - after.y;
        const rxx = dx * (1 - w) - residualXNeg;
        const ryy = dy * (1 - w) - residualYNeg;
        if (rxx !== 0 || ryy !== 0) selfRW.value = { x: nv.x + rxx, y: nv.y + ryy };
      });
    },
  );
}

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

function _vecAxisShare(
  self: Vec,
  n: Share<number>,
  axis: "x" | "y",
  sign: 1 | -1,
): Writable<Vec> {
  const selfRW = self as Writable<Vec>;
  const wf = reader(n.weight);
  const other = axis === "x" ? "y" : "x";
  return Vec.lens(
    () => {
      const nv = self.value;
      const kv = n.sig.value;
      const out = { x: nv.x, y: nv.y } as V;
      out[axis] = nv[axis] + sign * kv;
      return out;
    },
    (target: V) => {
      batch(() => {
        const nv = self.peek();
        const kv = n.sig.peek();
        const w = wf();
        const cur = nv[axis] + sign * kv;
        const d = target[axis] - cur;
        // n absorbs along its axis with sign.
        const desired_k = kv + sign * d * w;
        n.sig.value = desired_k;
        const actual_k_change = n.sig.peek() - kv;
        // residual along axis (in receiver-relative direction)
        const residual_axis = sign * (sign * d * w - actual_k_change);
        const axisChange = d * (1 - w) + residual_axis;
        const newReceiver = { x: nv.x, y: nv.y } as V;
        newReceiver[axis] = nv[axis] + axisChange;
        newReceiver[other] = target[other];
        selfRW.value = newReceiver;
      });
    },
  );
}

// ─── @experimental — Owned-parameter bwd helpers ────────────────────
//
// Each `_vec*Own` helper claims its sink, installs the same residual
// flow as the `_vec*Share` sibling (forced weight=1, threaded through
// `withinOwner(token)`), and additionally installs a `network()`
// reaction subscribed to the non-sink parents — when `self` is edited,
// the reaction writes the sink to maintain `bIntended` (set by the bwd
// on view-writes). Saturation residual lands on the view via natural
// fwd re-derivation.

function _vecAddOwn(self: Writable<Vec>, o: Own<V>): Writable<Vec> {
  const sig = o.sig as Writable<Vec>;
  const initSelf = self.peek();
  const initSig = sig.peek();
  const bIntended = {
    value: { x: initSelf.x + initSig.x, y: initSelf.y + initSig.y } as V,
  };
  const lens = Vec.lens(
    () => {
      const nv = self.value;
      const bv = sig.value;
      return { x: nv.x + bv.x, y: nv.y + bv.y };
    },
    (target: V) => {
      withinOwner(token, () => {
        batch(() => {
          bIntended.value = target;
          const nv = self.peek();
          const bv = sig.peek();
          const dx = target.x - (nv.x + bv.x);
          const dy = target.y - (nv.y + bv.y);
          sig.value = { x: bv.x + dx, y: bv.y + dy };
          const after = sig.peek();
          const rx = dx - (after.x - bv.x);
          const ry = dy - (after.y - bv.y);
          if (rx !== 0 || ry !== 0) self.value = { x: nv.x + rx, y: nv.y + ry };
        });
      });
    },
  );
  (lens as { _ownName?: string })._ownName = "Vec.add(own)";
  const token = claim(o, lens as object);
  network([self], dirty => {
    if (dirty.size === 0) return;
    if (!dirty.has(self as unknown as _Signal<unknown>)) return;
    withinOwner(token, () => {
      const nv = self.peek();
      const desired = { x: bIntended.value.x - nv.x, y: bIntended.value.y - nv.y };
      sig.value = desired;
      const actual = sig.peek();
      // Saturation drift: accept the new settled state when sig couldn't
      // absorb fully, so back-drags don't get "stuck" trying to undo.
      if (actual.x !== desired.x || actual.y !== desired.y) {
        bIntended.value = { x: nv.x + actual.x, y: nv.y + actual.y };
      }
    });
  });
  return lens;
}

function _vecAxisOwn(
  self: Writable<Vec>,
  o: Own<number>,
  axis: "x" | "y",
  sign: 1 | -1,
): Writable<Vec> {
  const sig = o.sig as Writable<Num>;
  const initSelf = self.peek();
  const initSig = sig.peek();
  const other = axis === "x" ? "y" : "x";
  const initView = { x: initSelf.x, y: initSelf.y } as V;
  initView[axis] = initSelf[axis] + sign * initSig;
  const bIntended = { value: initView };

  const lens = Vec.lens(
    () => {
      const nv = self.value;
      const kv = sig.value;
      const out = { x: nv.x, y: nv.y } as V;
      out[axis] = nv[axis] + sign * kv;
      return out;
    },
    (target: V) => {
      withinOwner(token, () => {
        batch(() => {
          bIntended.value = target;
          const nv = self.peek();
          const kv = sig.peek();
          const d = target[axis] - (nv[axis] + sign * kv);
          // sig absorbs along its axis with sign.
          sig.value = kv + sign * d;
          const actualK = sig.peek() - kv;
          const residual = sign * (sign * d - actualK);
          const newSelf = { x: nv.x, y: nv.y } as V;
          newSelf[axis] = nv[axis] + residual;
          newSelf[other] = target[other];
          self.value = newSelf;
        });
      });
    },
  );
  (lens as { _ownName?: string })._ownName = `Vec.${axis === "y" && sign === -1 ? "up" : axis === "y" ? "down" : axis === "x" && sign === -1 ? "left" : "right"}(own)`;
  const token = claim(o, lens as object);
  network([self], dirty => {
    if (dirty.size === 0) return;
    if (!dirty.has(self as unknown as _Signal<unknown>)) return;
    withinOwner(token, () => {
      const nv = self.peek();
      // sig represents the axis-aligned offset under sign;
      // want b_intended.axis = nv.axis + sign * sig → sig = (b_intended.axis - nv.axis) / sign
      const desired = sign * (bIntended.value[axis] - nv[axis]);
      sig.value = desired;
      const actual = sig.peek();
      // Saturation drift: accept the new settled state on the slack axis.
      if (actual !== desired) {
        const next = { x: bIntended.value.x, y: bIntended.value.y };
        next[axis] = nv[axis] + sign * actual;
        bIntended.value = next;
      }
    });
  });
  return lens;
}
