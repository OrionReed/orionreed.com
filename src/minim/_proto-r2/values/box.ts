// box.ts — reactive axis-aligned rectangle (r2 v2).

import { Signal, computed, type Computed, value, type Val, type SignalOptions } from "../signal";
import { type Linear, type TraitDict } from "../traits";
import { field } from "../field";
import { Num } from "./num";
import { Vec, type VecValue } from "./vec";

export interface BoxValue { x: number; y: number; w: number; h: number }

export const add = (a: BoxValue, b: BoxValue): BoxValue =>
  ({ x: a.x + b.x, y: a.y + b.y, w: a.w + b.w, h: a.h + b.h });
export const sub = (a: BoxValue, b: BoxValue): BoxValue =>
  ({ x: a.x - b.x, y: a.y - b.y, w: a.w - b.w, h: a.h - b.h });
export const scale = (a: BoxValue, k: number): BoxValue =>
  ({ x: a.x * k, y: a.y * k, w: a.w * k, h: a.h * k });
export const lerp = (a: BoxValue, b: BoxValue, t: number): BoxValue => ({
  x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
  w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t,
});
export const equals = (a: BoxValue, b: BoxValue) =>
  a === b || (a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

export const expand = (b: BoxValue, n: number): BoxValue =>
  ({ x: b.x - n, y: b.y - n, w: b.w + 2 * n, h: b.h + 2 * n });

export const contains = (b: BoxValue, p: VecValue): boolean =>
  p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;

export class Box extends Signal<BoxValue> {
  static traits: TraitDict<BoxValue> & { linear: Linear<BoxValue>; lerp: typeof lerp; equals: typeof equals } = {
    linear: { add, sub, scale },
    lerp,
    equals,
  };

  constructor(v: BoxValue = { x: 0, y: 0, w: 0, h: 0 }, opts?: SignalOptions<BoxValue>) { super(v, opts); }

  get x(): Num { return this.memo("x", () => field(this, "x", Num)); }
  get y(): Num { return this.memo("y", () => field(this, "y", Num)); }
  get w(): Num { return this.memo("w", () => field(this, "w", Num)); }
  get h(): Num { return this.memo("h", () => field(this, "h", Num)); }

  get area(): Num {
    return this.memo("area", () => computed(() => this.value.w * this.value.h, Num));
  }

  at(u: number, v: number): Vec {
    return this.memo(`at:${u},${v}`, () => computed(() => {
      const b = this.value;
      return { x: b.x + u * b.w, y: b.y + v * b.h };
    }, Vec));
  }
  get center() { return this.at(0.5, 0.5); }
  get top()    { return this.at(0.5, 0); }
  get bottom() { return this.at(0.5, 1); }
  get left()   { return this.at(0,   0.5); }
  get right()  { return this.at(1,   0.5); }

  add(b: Val<BoxValue>) { return computed(() => add(this.value, value(b)), Box); }
  sub(b: Val<BoxValue>) { return computed(() => sub(this.value, value(b)), Box); }
  scale(k: Val<number>) { return computed(() => scale(this.value, value(k)), Box); }
  lerp(b: Val<BoxValue>, t: Val<number>) {
    return computed(() => lerp(this.value, value(b), value(t)), Box);
  }
  expand(n: Val<number>) {
    return computed(() => expand(this.value, value(n)), Box);
  }
  contains(p: Val<VecValue>): Computed<boolean> {
    return computed(() => contains(this.value, value(p))) as Computed<boolean>;
  }

  derive(fn: (c: BoxChain) => BoxChain) {
    return computed(() => fn(new BoxChain(this.value)).value, Box);
  }
}

export interface Box { readonly constructor: typeof Box }

export class BoxChain {
  value: BoxValue;
  constructor(v: BoxValue) { this.value = v; }
  add(b: Val<BoxValue>) { this.value = add(this.value, value(b)); return this; }
  sub(b: Val<BoxValue>) { this.value = sub(this.value, value(b)); return this; }
  scale(k: Val<number>) { this.value = scale(this.value, value(k)); return this; }
  lerp(b: Val<BoxValue>, t: Val<number>) {
    this.value = lerp(this.value, value(b), value(t)); return this;
  }
  expand(n: Val<number>) {
    this.value = expand(this.value, value(n)); return this;
  }
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
