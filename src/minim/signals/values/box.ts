// box.ts — reactive axis-aligned rectangle.
//
// Invertibles (`add`, `sub`, `scale`, `expand`) return `: this` and ride
// on `Signal#lens(fwd, bwd)`. Chained calls auto-fuse.

import type { Easing } from "../../core";
import { type Tween, tween } from "../anim";
import {
  batch,
  type Init,
  type Inner,
  lazy,
  network,
  reader,
  readNow,
  Signal,
  type Val,
  type Writable,
  type WritableBrand,
  withinOwner,
} from "../signal";
import {
  claim,
  isOwn,
  isShare,
  type Own,
  type Param,
  type Share,
} from "../lens-params";
import type { Linear, Pack, TraitDict } from "../traits";
import { derived, field } from "../writable";
import { Bool } from "./bool";
import { Num, num } from "./num";
import { Vec } from "./vec";

type V = { x: number; y: number; w: number; h: number };

export const add = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y, w: a.w + b.w, h: a.h + b.h });
export const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y, w: a.w - b.w, h: a.h - b.h });
export const scale = (a: V, k: number): V => ({ x: a.x * k, y: a.y * k, w: a.w * k, h: a.h * k });
export const lerp = (a: V, b: V, t: number): V => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  w: a.w + (b.w - a.w) * t,
  h: a.h + (b.h - a.h) * t,
});
export const equals = (a: V, b: V) =>
  a === b || (a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);
/** L2 distance over the flat (x, y, w, h) representation. */
export const metric = (a: V, b: V) => Math.hypot(a.x - b.x, a.y - b.y, a.w - b.w, a.h - b.h);
export const expand = (b: V, n: number): V => ({
  x: b.x - n,
  y: b.y - n,
  w: b.w + 2 * n,
  h: b.h + 2 * n,
});
export const contains = (b: V, p: Inner<Vec>): boolean =>
  p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;

/** Closest point inside `b` to `p`. Already-inside is identity; outside
 *  snaps to the nearest box-boundary point (which is inside under our
 *  inclusive `contains`). Used by `Box#contains` as the bwd's true-side
 *  policy and reusable on its own as an idempotent projection helper. */
export const clampToBox = (p: Inner<Vec>, b: V): Inner<Vec> => ({
  x: Math.max(b.x, Math.min(b.x + b.w, p.x)),
  y: Math.max(b.y, Math.min(b.y + b.h, p.y)),
});

/** Closest point STRICTLY outside `b` to `p`, displaced past the nearest
 *  edge by `eps`. Already-outside is identity; inside maps to whichever
 *  of the four edges is nearest. The bwd's false-side policy for
 *  `Box#contains`. */
export const ejectFromBox = (p: Inner<Vec>, b: V, eps = 1e-6): Inner<Vec> => {
  if (!contains(b, p)) return p;
  const dLeft = p.x - b.x;
  const dRight = b.x + b.w - p.x;
  const dTop = p.y - b.y;
  const dBot = b.y + b.h - p.y;
  const min = Math.min(dLeft, dRight, dTop, dBot);
  if (min === dLeft) return { x: b.x - eps, y: p.y };
  if (min === dRight) return { x: b.x + b.w + eps, y: p.y };
  if (min === dTop) return { x: p.x, y: b.y - eps };
  return { x: p.x, y: b.y + b.h + eps };
};

/** Bounding box around a set of boxes. */
export function union(...bs: V[]): V {
  if (bs.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let xMin = bs[0].x,
    yMin = bs[0].y;
  let xMax = xMin + bs[0].w,
    yMax = yMin + bs[0].h;
  for (let i = 1; i < bs.length; i++) {
    const o = bs[i];
    if (o.x < xMin) xMin = o.x;
    if (o.y < yMin) yMin = o.y;
    if (o.x + o.w > xMax) xMax = o.x + o.w;
    if (o.y + o.h > yMax) yMax = o.y + o.h;
  }
  return { x: xMin, y: yMin, w: xMax - xMin, h: yMax - yMin };
}

/** Perimeter point on a Box facing `toward`. Used by default
 *  `Shape.boundary`. */
export function edgeFrom(b: V, toward: Inner<Vec>): Inner<Vec> {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const k = Math.min(
    dx === 0 ? Number.POSITIVE_INFINITY : b.w / 2 / Math.abs(dx),
    dy === 0 ? Number.POSITIVE_INFINITY : b.h / 2 / Math.abs(dy),
  );
  return { x: cx + dx * k, y: cy + dy * k };
}

const linearImpl: Linear<V> = { add, sub, scale };
const packImpl: Pack<V> = {
  dim: 4,
  read: (v, a, o) => {
    a[o] = v.x;
    a[o + 1] = v.y;
    a[o + 2] = v.w;
    a[o + 3] = v.h;
  },
  write: (a, o) => ({ x: a[o]!, y: a[o + 1]!, w: a[o + 2]!, h: a[o + 3]! }),
};

export class Box extends Signal<V> {
  static traits = {
    linear: linearImpl,
    lerp,
    metric,
    equals,
    pack: packImpl,
  } satisfies TraitDict<V>;
  declare readonly _t: typeof Box.traits;

  constructor(v: V = { x: 0, y: 0, w: 0, h: 0 }) {
    super(v, { equals });
  }

  add(b: Val<V>): this {
    const bf = reader(b);
    return this.lens(
      v => add(v, bf()),
      n => sub(n, bf()),
    );
  }
  sub(b: Val<V>): this {
    const bf = reader(b);
    return this.lens(
      v => sub(v, bf()),
      n => add(n, bf()),
    );
  }
  /** Receiver × multiplier. With a bare `k` (literal or RO signal) the
   *  receiver absorbs writes to the result. With `share(k)` @experimental,
   *  `k` absorbs (with optional weight). With `own(k)` @experimental,
   *  `k` is owned and parent-edits route through `k` symmetrically. */
  scale(k: Param<number>): this {
    if (isOwn(k)) return _boxScaleOwn(this as unknown as Writable<Box>, k as Own<number>) as unknown as this;
    if (isShare(k)) return _boxScaleShare(this, k as Share<number>) as unknown as this;
    const kf = reader(k as Val<number>);
    return this.lens(
      v => scale(v, kf()),
      n => scale(n, 1 / kf()),
    );
  }
  /** Symmetric expansion. `share(n)` @experimental makes `n` absorb the
   *  signed expansion delta; `own(n)` @experimental adds symmetric
   *  parent-edit routing through `n`. */
  expand(n: Param<number>): this {
    if (isOwn(n)) return _boxExpandOwn(this as unknown as Writable<Box>, n as Own<number>) as unknown as this;
    if (isShare(n)) return _boxExpandShare(this, n as Share<number>) as unknown as this;
    const nf = reader(n as Val<number>);
    return this.lens(
      v => expand(v, nf()),
      o => expand(o, -nf()),
    );
  }

  lerp(b: Val<V>, t: Val<number>): Box {
    return Box.derive(() => lerp(this.value, readNow(b), readNow(t)));
  }
  /** Membership predicate. Conditional return type: when `p` is a
   *  writable `Vec`, the result is `Writable<Bool>` and clicks on the
   *  view flip the source — `true` clamps to the nearest in-box point,
   *  `false` ejects past the nearest edge by `eps`. For literal or RO
   *  inputs, the result is a bare (RO) `Bool` since there's no source
   *  to write back to. Both branches are O(1) box geometry — no policy
   *  beyond "closest point where the predicate becomes target."
   *
   *  GetPut, PutGet, PutPut all hold within the view's domain (boolean
   *  ≈_V = strict; source ≈_S = "same in/out class"). */
  contains<P extends Val<Inner<Vec>>>(
    p: P,
  ): P extends WritableBrand ? Writable<Bool> : Bool {
    if (p instanceof Vec) {
      // Detect fused-RO chains: a Vec produced by `derive(...)` or a
      // computed parent has no bwd path. Fall through to the RO branch.
      const fused = (p as { _fusedOf?: { bwd?: unknown } })._fusedOf;
      const isRO = fused !== undefined && fused.bwd === undefined;
      if (!isRO) {
        return Bool.lens(
          [this, p] as never,
          (vals: readonly [V, Inner<Vec>]) => contains(vals[0], vals[1]),
          (target, vals) => {
            const [b, v] = vals as readonly [V, Inner<Vec>];
            if (contains(b, v) === target) return [undefined, undefined] as never;
            return [undefined, target ? clampToBox(v, b) : ejectFromBox(v, b)] as never;
          },
        ) as never;
      }
    }
    return Bool.derive(() => contains(this.value, readNow(p))) as never;
  }

  // ── field lenses & derived views ──────────────────────────────────
  get x() {
    return field(this, "x", Num);
  }
  get y() {
    return field(this, "y", Num);
  }
  get w() {
    return field(this, "w", Num);
  }
  get h() {
    return field(this, "h", Num);
  }
  get area() {
    return derived(this, "area", Num, b => b.w * b.h);
  }

  /** Vec at parametric (u, v) within `[0,1]²`. Not memoised — arbitrary
   *  (u, v) calls otherwise leak a cache entry per pair. Use the named
   *  edge getters (`.center`, `.top`, …) when you want stable identity. */
  at(u: number, v: number): Vec {
    return Vec.derive(this, b => ({ x: b.x + u * b.w, y: b.y + v * b.h }));
  }
  // Named edges — derived RO views over `at(u, v)`. Memoised under
  // stable keys for identity (effects subscribing to `b.center` should
  // always see the same Vec). `lazy()` directly because `at()` already
  // returns a Vec — no need to `derived(this, …, Vec, fn)` again.
  get center(): Vec {
    return lazy(this, "center", () => this.at(0.5, 0.5));
  }
  get top(): Vec {
    return lazy(this, "top", () => this.at(0.5, 0));
  }
  get bottom(): Vec {
    return lazy(this, "bottom", () => this.at(0.5, 1));
  }
  get left(): Vec {
    return lazy(this, "left", () => this.at(0, 0.5));
  }
  get right(): Vec {
    return lazy(this, "right", () => this.at(1, 0.5));
  }

  /** Tween-builder, implied by the lerp trait. */
  to(this: Writable<Box>, target: V, dur: Val<number>, ease?: Easing): Tween<V> {
    return tween(this, target, dur, ease);
  }
}

/** Writable `Box` at `(x, y, w, h)`. Each component is either a literal
 *  `number` (lifted to a fresh `Writable<Num>` seed) or an existing
 *  `Writable<Num>` (passed through by identity, writes propagate).
 *
 *  RO sources are rejected at the type level — use `Box.derive(...)`
 *  for reactive RO tracking, or `signal.value` to snapshot. Lock a
 *  component with `Num.pin(c)`. */
// ─── @experimental — share()-parameter bwd helpers ──────────────────
//
// Box.scale: receiver × multiplier. share(k) makes k the writable
//   handle (the receiver anchored when current_value !== zero).
// Box.expand: receiver expanded by n. share(n) makes n absorb the
//   expansion delta; the box's interior anchor (top-left) stays.

function _boxScaleShare(self: Box, k: Share<number>): Writable<Box> {
  const wf = reader(k.weight);
  return Box.lens(
    [self, k.sig] as const,
    ([bv, kv]) => scale(bv, kv),
    (target, [bv, kv]) => {
      const w = wf();
      const curS = kv === 0 ? 1 : kv; // avoid div by 0
      const wantK = (target.x !== 0 ? target.x / (bv.x || 1) :
                     target.w !== 0 ? target.w / (bv.w || 1) :
                     curS);
      const newK = kv + (wantK - kv) * w;
      // Receiver absorbs the residual via inverse scale.
      const newB = scale(target, 1 / (newK === 0 ? 1 : newK));
      return [newB, newK] as const;
    },
  );
}

function _boxExpandShare(self: Box, n: Share<number>): Writable<Box> {
  const selfRW = self as Writable<Box>;
  const wf = reader(n.weight);
  return Box.lens(
    () => expand(self.value, n.sig.value),
    (target: V) => {
      batch(() => {
        const bv = self.peek();
        const nv = n.sig.peek();
        const w = wf();
        // Recover the implied n from target: target = expand(receiver, ?n).
        // expand: x -= n, y -= n, w += 2n, h += 2n. So
        //   n_implied = (bv.x - target.x + bv.y - target.y) / 2
        // or equivalently from w/h growth. Use w-growth: 2*Δn = target.w - bv.w.
        const wantN = nv + (target.w - (bv.w + 2 * nv)) / 2;
        const desiredNChange = (wantN - nv) * w;
        n.sig.value = nv + desiredNChange;
        const actualN = n.sig.peek();
        const residualN = wantN - actualN;
        // The receiver absorbs the residual portion of expansion.
        if (residualN !== 0) {
          selfRW.value = expand(target, -actualN);
        }
      });
    },
  );
}

// ─── @experimental — own()-parameter bwd helpers ────────────────────

function _boxScaleOwn(self: Writable<Box>, o: Own<number>): Writable<Box> {
  const sig = o.sig as Writable<Num>;
  const bIntended = { value: scale(self.peek(), sig.peek()) };
  const lens = Box.lens(
    () => scale(self.value, sig.value),
    (target: V) => {
      withinOwner(token, () => {
        batch(() => {
          bIntended.value = target;
          const bv = self.peek();
          // Solve k from one of the coords; prefer w (avoids x=0 collisions).
          const wantK = bv.w !== 0 ? target.w / bv.w :
                        bv.h !== 0 ? target.h / bv.h :
                        bv.x !== 0 ? target.x / bv.x :
                        bv.y !== 0 ? target.y / bv.y : sig.peek();
          sig.value = wantK;
          const actualK = sig.peek();
          if (actualK !== 0) self.value = scale(target, 1 / actualK);
        });
      });
    },
  );
  (lens as { _ownName?: string })._ownName = "Box.scale(own)";
  const token = claim(o, lens as object);
  network([self], dirty => {
    if (dirty.size === 0) return;
    if (!dirty.has(self as unknown as Signal<unknown>)) return;
    withinOwner(token, () => {
      const bv = self.peek();
      const wantK = bv.w !== 0 ? bIntended.value.w / bv.w :
                    bv.h !== 0 ? bIntended.value.h / bv.h : sig.peek();
      sig.value = wantK;
      const actual = sig.peek();
      if (actual !== wantK) bIntended.value = scale(bv, actual);
    });
  });
  return lens;
}

function _boxExpandOwn(self: Writable<Box>, o: Own<number>): Writable<Box> {
  const sig = o.sig as Writable<Num>;
  const bIntended = { value: expand(self.peek(), sig.peek()) };
  const lens = Box.lens(
    () => expand(self.value, sig.value),
    (target: V) => {
      withinOwner(token, () => {
        batch(() => {
          bIntended.value = target;
          const bv = self.peek();
          const nv = sig.peek();
          const wantN = nv + (target.w - (bv.w + 2 * nv)) / 2;
          sig.value = wantN;
          const actualN = sig.peek();
          const residualN = wantN - actualN;
          if (residualN !== 0) self.value = expand(target, -actualN);
        });
      });
    },
  );
  (lens as { _ownName?: string })._ownName = "Box.expand(own)";
  const token = claim(o, lens as object);
  network([self], dirty => {
    if (dirty.size === 0) return;
    if (!dirty.has(self as unknown as Signal<unknown>)) return;
    withinOwner(token, () => {
      const bv = self.peek();
      const wantN = (bIntended.value.w - bv.w) / 2;
      sig.value = wantN;
      const actual = sig.peek();
      if (actual !== wantN) bIntended.value = expand(bv, actual);
    });
  });
  return lens;
}

export function box(
  x: Init<Num> = 0,
  y: Init<Num> = 0,
  w: Init<Num> = 0,
  h: Init<Num> = 0,
): Writable<Box> {
  if (
    typeof x === "number" &&
    typeof y === "number" &&
    typeof w === "number" &&
    typeof h === "number"
  ) {
    return new Box({ x, y, w, h }) as Writable<Box>;
  }
  const xN = num(x);
  const yN = num(y);
  const wN = num(w);
  const hN = num(h);
  return Signal.install(
    Box,
    () => ({ x: xN.value, y: yN.value, w: wN.value, h: hN.value }),
    v => {
      batch(() => {
        xN.value = v.x;
        yN.value = v.y;
        wN.value = v.w;
        hN.value = v.h;
      });
    },
  );
}
