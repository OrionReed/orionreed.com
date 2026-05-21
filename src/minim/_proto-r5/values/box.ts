// box.ts — reactive axis-aligned rectangle.

import {
  Signal, computed, lens as lensFactory, value,
  type Val, type SignalOptions, type Of,
} from "../signal";
import { type Linear, type TraitDict } from "../traits";
import { applyOp1, type Op } from "../ops";
import { type Writable } from "../writable";
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
export const contains = (b: V, p: Of<Vec>): boolean =>
  p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;

const linearImpl: Linear<V> = { add, sub, scale };

const addOp:    Op<V, [V]>      = { fwd: add, bwd: sub };
const subOp:    Op<V, [V]>      = { fwd: sub, bwd: add };
const scaleOp:  Op<V, [number]> = { fwd: scale, bwd: (v, k) => scale(v, 1 / k) };
const expandOp: Op<V, [number]> = { fwd: expand, bwd: (v, n) => expand(v, -n) };

export class Box extends Signal<V> {
  static traits: TraitDict<V> & { linear: Linear<V>; lerp: typeof lerp; equals: typeof equals } = {
    linear: linearImpl, lerp, equals,
  };
  static invertibles = ["add", "sub", "scale", "expand"] as const;
  constructor(v: V = { x: 0, y: 0, w: 0, h: 0 }, opts?: SignalOptions<V>) { super(v, opts) }

  add(b: Val<V>): Box        { return applyOp1(this, addOp,    b, Box) }
  sub(b: Val<V>): Box        { return applyOp1(this, subOp,    b, Box) }
  scale(k: Val<number>): Box { return applyOp1(this, scaleOp,  k, Box) }
  expand(n: Val<number>): Box { return applyOp1(this, expandOp, n, Box) }

  lerp(b: Val<V>, t: Val<number>): Box {
    return computed(() => lerp(this.value, value(b), value(t)), Box);
  }
  contains(p: Val<Of<Vec>>): Signal<boolean> {
    return computed(() => contains(this.value, value(p)));
  }

  get x(): Num { return this.field("x", Num) }
  get y(): Num { return this.field("y", Num) }
  get w(): Num { return this.field("w", Num) }
  get h(): Num { return this.field("h", Num) }
  get area(): Num {
    return this.memo("area", () => computed(() => this.value.w * this.value.h, Num));
  }
  at(u: number, v: number): Vec {
    return this.memo(`at:${u},${v}`, () => computed(() => {
      const b = this.value;
      return { x: b.x + u * b.w, y: b.y + v * b.h };
    }, Vec));
  }
  get center(): Vec { return this.at(0.5, 0.5) }
  get top(): Vec    { return this.at(0.5, 0) }
  get bottom(): Vec { return this.at(0.5, 1) }
  get left(): Vec   { return this.at(0,   0.5) }
  get right(): Vec  { return this.at(1,   0.5) }

  static derive(fn: () => V): Box { return computed(fn, Box) }
  static lens(get: () => V, set: (v: V) => void): Writable<Box> {
    return lensFactory(get, set, Box) as unknown as Writable<Box>;
  }
  static is(v: unknown): v is Box { return v instanceof Box }
}
export interface Box {
  readonly constructor: typeof Box;
  get value(): V;
}

export function box(
  x: Val<number> = 0, y: Val<number> = 0,
  w: Val<number> = 0, h: Val<number> = 0,
): Writable<Box> {
  const b = new Box() as Writable<Box>;
  b.x.bind(x); b.y.bind(y); b.w.bind(w); b.h.bind(h);
  return b;
}
