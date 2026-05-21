// box.ts — reactive axis-aligned rectangle.

import { Signal, computed, value, type Val, type SignalOptions, type Of } from "../signal";
import { type Linear, type TraitDict } from "../traits";
import { type Op, applyOp1, Chain } from "../ops";
import { tween, type Tween } from "../anim";
import { type Easing } from "../../core";
import { Num } from "./num";
import { Vec } from "./vec";

type V = { x: number; y: number; w: number; h: number };

export const add = (a: V, b: V): V =>
  ({ x: a.x + b.x, y: a.y + b.y, w: a.w + b.w, h: a.h + b.h });
export const sub = (a: V, b: V): V =>
  ({ x: a.x - b.x, y: a.y - b.y, w: a.w - b.w, h: a.h - b.h });
export const scale = (a: V, k: number): V =>
  ({ x: a.x * k, y: a.y * k, w: a.w * k, h: a.h * k });
export const lerp = (a: V, b: V, t: number): V => ({
  x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
  w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t,
});
export const equals = (a: V, b: V) =>
  a === b || (a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

export const expand = (b: V, n: number): V =>
  ({ x: b.x - n, y: b.y - n, w: b.w + 2 * n, h: b.h + 2 * n });

export function union(...bs: V[]): V {
  if (bs.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let xMin = bs[0].x, yMin = bs[0].y;
  let xMax = xMin + bs[0].w, yMax = yMin + bs[0].h;
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
export function edgeFrom(b: V, toward: Of<Vec>): Of<Vec> {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const k = Math.min(
    dx === 0 ? Infinity : (b.w / 2) / Math.abs(dx),
    dy === 0 ? Infinity : (b.h / 2) / Math.abs(dy),
  );
  return { x: cx + dx * k, y: cy + dy * k };
}

export const contains = (b: V, p: Of<Vec>): boolean =>
  p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;

// ─── Invertible ops ────────────────────────────────────────────────

const addOp: Op<V, [V]> = { fwd: add, bwd: sub };
const subOp: Op<V, [V]> = { fwd: sub, bwd: add };
const scaleOp: Op<V, [number]> = { fwd: scale, bwd: (v, k) => scale(v, 1 / k) };
const expandOp: Op<V, [number]> = {
  fwd: expand,
  bwd: (v, n) => expand(v, -n),
};

const linearImpl: Linear<V> = { add, sub, scale };

export class Box extends Signal<V> {
  static traits: TraitDict<V> & { linear: Linear<V>; lerp: typeof lerp; equals: typeof equals } = {
    linear: linearImpl, lerp, equals,
  };

  constructor(v: V = { x: 0, y: 0, w: 0, h: 0 }, opts?: SignalOptions<V>) { super(v, opts); }

  get x(): Num { return this.field("x", Num); }
  get y(): Num { return this.field("y", Num); }
  get w(): Num { return this.field("w", Num); }
  get h(): Num { return this.field("h", Num); }

  get area(): Num {
    return this.memo("area", () => computed(() => this.value.w * this.value.h, Num));
  }

  at(u: number, v: number): Vec {
    return this.memo(`at:${u},${v}`, () => computed(() => {
      const b = this.value;
      return { x: b.x + u * b.w, y: b.y + v * b.h };
    }, Vec));
  }
  get center(): Vec { return this.at(0.5, 0.5); }
  get top(): Vec    { return this.at(0.5, 0); }
  get bottom(): Vec { return this.at(0.5, 1); }
  get left(): Vec   { return this.at(0,   0.5); }
  get right(): Vec  { return this.at(1,   0.5); }

  // ── Invertible (Lens-returning) ──
  add(b: Val<V>): Box { return applyOp1(this, addOp, b, Box); }
  sub(b: Val<V>): Box { return applyOp1(this, subOp, b, Box); }
  scale(k: Val<number>): Box { return applyOp1(this, scaleOp, k, Box); }
  expand(n: Val<number>): Box { return applyOp1(this, expandOp, n, Box); }

  // ── Non-invertible ──
  lerp(b: Val<V>, t: Val<number>): Box {
    return computed(() => lerp(this.value, value(b), value(t)), Box);
  }
  contains(p: Val<Of<Vec>>) {
    return computed(() => contains(this.value, value(p)));
  }

  /** Tween-builder, implied by lerp trait. */
  to(target: V, dur: Val<number>, ease?: Easing): Tween<V> {
    return tween(this, target, dur, ease);
  }

  derive(fn: (c: BoxChain) => BoxChain): Box {
    return fn(new BoxChain()).toLens(this, Box);
  }
}

export interface Box { readonly constructor: typeof Box }

export class BoxChain extends Chain<V> {
  add(b: Val<V>): this { return this.push1(addOp, b); }
  sub(b: Val<V>): this { return this.push1(subOp, b); }
  scale(k: Val<number>): this { return this.push1(scaleOp, k); }
  expand(n: Val<number>): this { return this.push1(expandOp, n); }
}

/** Construct a Box; reactive per-component args bind the field lens. */
export const box = (
  x: Val<number> = 0,
  y: Val<number> = 0,
  w: Val<number> = 0,
  h: Val<number> = 0,
): Box => {
  const out = new Box();
  out.x.bind(x);
  out.y.bind(y);
  out.w.bind(w);
  out.h.bind(h);
  return out;
};
