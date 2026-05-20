// box.ts — reactive axis-aligned rectangle.

import { Signal, computed, type Computed, value, type Val } from "../signal";
import { LINEAR, LERP, EQUALS, type Linear } from "../traits";
import { derived, field } from "../derive";
import { tween, type Tween } from "../lerp";
import { type Easing } from "../../core";
import { Num } from "./num";
import { Vec, type Value as VecValue } from "./vec";

export interface Value { x: number; y: number; w: number; h: number }

export const add = (a: Value, b: Value): Value =>
  ({ x: a.x + b.x, y: a.y + b.y, w: a.w + b.w, h: a.h + b.h });
export const sub = (a: Value, b: Value): Value =>
  ({ x: a.x - b.x, y: a.y - b.y, w: a.w - b.w, h: a.h - b.h });
export const scale = (a: Value, k: number): Value =>
  ({ x: a.x * k, y: a.y * k, w: a.w * k, h: a.h * k });
export const lerp = (a: Value, b: Value, t: number): Value => ({
  x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
  w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t,
});
export const equals = (a: Value, b: Value) =>
  a === b || (a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

export const expand = (b: Value, n: number): Value =>
  ({ x: b.x - n, y: b.y - n, w: b.w + 2 * n, h: b.h + 2 * n });

export function union(...bs: Value[]): Value {
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
export function edgeFrom(b: Value, toward: VecValue): VecValue {
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

export const contains = (b: Value, p: VecValue): boolean =>
  p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;

const linearImpl: Linear<Value> = { add, sub, scale };

export class Box extends Signal<Value> {
  constructor(v: Value = { x: 0, y: 0, w: 0, h: 0 }) { super(v); }

  get x() { return field(this, "x", Num); }
  get y() { return field(this, "y", Num); }
  get w() { return field(this, "w", Num); }
  get h() { return field(this, "h", Num); }

  /** Self-reference so any Box is uniformly `{ box: Box }` — the same
   *  field path works on Box, Shape, Part, split results, etc.
   *  (`b.box === b`). */
  get box(): Box { return this; }

  get area() { return this._area ??= derived(Num, () => this.value.w * this.value.h); }
  private _area?: Num;

  /** Reactive Vec at normalized fraction `(0, 0)` (top-left) to `(1, 1)` (bottom-right). */
  at(u: number, v: number): Vec {
    return derived(Vec, () => {
      const b = this.value;
      return { x: b.x + u * b.w, y: b.y + v * b.h };
    });
  }
  /** Cardinals — sugar over `.at(...)`, lazily memoized. */
  get center() { return this._center ??= this.at(0.5, 0.5); }
  get top()    { return this._top    ??= this.at(0.5, 0); }
  get bottom() { return this._bottom ??= this.at(0.5, 1); }
  get left()   { return this._left   ??= this.at(0, 0.5); }
  get right()  { return this._right  ??= this.at(1, 0.5); }
  private _center?: Vec;
  private _top?: Vec;
  private _bottom?: Vec;
  private _left?: Vec;
  private _right?: Vec;

  add(b: Val<Value>) { return derived(Box, () => add(this.value, value(b))); }
  sub(b: Val<Value>) { return derived(Box, () => sub(this.value, value(b))); }
  scale(k: Val<number>) { return derived(Box, () => scale(this.value, value(k))); }
  lerp(b: Val<Value>, t: Val<number>) {
    return derived(Box, () => lerp(this.value, value(b), value(t)));
  }
  expand(n: Val<number>) {
    return derived(Box, () => expand(this.value, value(n)));
  }
  union(...others: Val<Value>[]) {
    return derived(Box, () => union(this.value, ...others.map(value)));
  }
  /** Reactive boolean: is `p` inside this box? */
  contains(p: Val<VecValue>): Computed<boolean> {
    return computed(() => contains(this.value, value(p)));
  }

  // Trait slots — on prototype.
  get [LINEAR](): Linear<Value> { return linearImpl; }
  [LERP](a: Value, b: Value, t: number) { return lerp(a, b, t); }
  [EQUALS](a: Value, b: Value) { return equals(a, b); }

  to(target: Value, dur: Val<number>, ease?: Easing): Tween<Value> {
    return tween(this, target, dur, ease);
  }

  derive(fn: (c: BoxChain) => BoxChain) {
    return derived(Box, () => fn(new BoxChain(this.value)).value);
  }
}

export class BoxChain {
  value: Value;
  constructor(v: Value) { this.value = v; }
  add(b: Val<Value>) { this.value = add(this.value, value(b)); return this; }
  sub(b: Val<Value>) { this.value = sub(this.value, value(b)); return this; }
  scale(k: Val<number>) { this.value = scale(this.value, value(k)); return this; }
  lerp(b: Val<Value>, t: Val<number>) {
    this.value = lerp(this.value, value(b), value(t)); return this;
  }
  expand(n: Val<number>) {
    this.value = expand(this.value, value(n)); return this;
  }
  union(...others: Val<Value>[]) {
    this.value = union(this.value, ...others.map(value)); return this;
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
