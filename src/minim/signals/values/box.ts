// box.ts — reactive axis-aligned rectangle. Also defines `BoxLike` —
// the structural surface every box-shaped thing (reactive Box cells,
// Shape, Part, splits, ...) implements: `.box`, `.x/y/w/h`, cardinals,
// `.at(u, v)`. Consumers take `BoxLike` and don't care which.

import { Signal, computed, type Computed, value, type Val } from "../signal";
import { LINEAR, LERP, EQUALS } from "../traits";
import { BaseChain, derived, field, bindFields } from "../derive";
import { defineTrait, type LerpMethods } from "../lerp";
import { Num } from "./num";
import { Vec, type Value as VecValue } from "./vec";

export interface Value { x: number; y: number; w: number; h: number }

// ── Pure math ──────────────────────────────────────────────────────

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

// ── Reactive class ─────────────────────────────────────────────────

export class Box extends Signal<Value> {
  constructor(v: Value = { x: 0, y: 0, w: 0, h: 0 }) { super(v); }

  // ── Field lenses ─────────────────────────────────────────────────
  get x() { return field(this, "x", Num); }
  get y() { return field(this, "y", Num); }
  get w() { return field(this, "w", Num); }
  get h() { return field(this, "h", Num); }

  // ── BoxLike: self-reference, scalars, cardinals, `.at(u, v)` ────

  /** Self-reference so reactive Box cells satisfy `BoxLike` (`b.box === b`). */
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

  // ── Reactive ops ────────────────────────────────────────────────
  expand(n: Val<number>) {
    return derived(Box, () => expand(this.value, value(n)));
  }
  add(b: Val<Value>) { return derived(Box, () => add(this.value, value(b))); }
  sub(b: Val<Value>) { return derived(Box, () => sub(this.value, value(b))); }
  scale(k: Val<number>) { return derived(Box, () => scale(this.value, value(k))); }
  union(...others: Val<Value>[]) {
    return derived(Box, () => union(this.value, ...others.map(value)));
  }
  contains(p: Val<VecValue>): Computed<boolean> {
    return computed(() => contains(this.value, value(p)));
  }

  derive(fn: (c: Chain) => Chain) {
    return derived(Box, () => fn(new Chain(this.value)).value);
  }
}
export interface Box extends LerpMethods<Value> {}

class Chain extends BaseChain<Value> {
  add(b: Val<Value>) { this.value = add(this.value, value(b)); return this; }
  sub(b: Val<Value>) { this.value = sub(this.value, value(b)); return this; }
  scale(k: Val<number>) { this.value = scale(this.value, value(k)); return this; }
  lerp(b: Val<Value>, t: Val<number>) {
    this.value = lerp(this.value, value(b), value(t)); return this;
  }
  expand(n: Val<number>) {
    this.value = expand(this.value, value(n)); return this;
  }
}

defineTrait(Box, LINEAR, { add, sub, scale });
defineTrait(Box, LERP,   lerp);
defineTrait(Box, EQUALS, equals);

/** Construct a Box; reactive per-component args bind the field lens. */
export function box(x?: Val<number>, y?: Val<number>, w?: Val<number>, h?: Val<number>): Box;
/** Construct a Box from a `BoxLike` source. */
export function box(src: BoxLike): Box;
export function box(
  a: Val<number> | BoxLike = 0,
  y: Val<number> = 0,
  w: Val<number> = 0,
  h: Val<number> = 0,
): Box {
  if (isBoxLike(a)) {
    const out = new Box();
    out.bind(() => ({ ...a.box.value }));
    return out;
  }
  const out = new Box();
  bindFields(out, { x: a, y, w, h });
  return out;
}

/** Reactive parametric anchor — `boxAt(b, u, v) === b.at(u, v)`. */
export const boxAt = (b: BoxLike, u: number, v: number): Vec => b.at(u, v);

// ── BoxLike — structural surface ───────────────────────────────────

/** Reactive rectangular region with cardinals + `at(u, v)`. Implemented
 *  by `Shape`, `Part`, and any reactive `Box` cell. The typed surface
 *  uses the rich `Vec`/`Num` cells so chainable methods (`.up(n)`,
 *  `.add(b)`, `.scale(k)`, `.to(target, dur)`) work all the way
 *  through. */
export interface BoxLike {
  readonly box: Signal<Value>;
  readonly x: import("./num").Num;
  readonly y: import("./num").Num;
  readonly w: import("./num").Num;
  readonly h: import("./num").Num;
  readonly center: Vec;
  readonly top: Vec;
  readonly bottom: Vec;
  readonly left: Vec;
  readonly right: Vec;
  at(u: number, v: number): Vec;
}

/** Detect a `BoxLike` value structurally — anything with `box` and `at`. */
export function isBoxLike(v: unknown): v is BoxLike {
  return (
    typeof v === "object" &&
    v !== null &&
    "box" in v &&
    typeof (v as { at?: unknown }).at === "function"
  );
}

// ── delegateBoxLike(hostProto, key) ────────────────────────────────
//
// Install forwarding getters on `hostProto` so `host.x / .y / .center
// / .at(u, v) / ...` resolve to `host[key].x / .center / .at(...)`.
// Used by Part/TexShape etc. that hold a Box internally and want to
// expose its surface without hand-writing each forwarder.

const BOX_AXES = ["x", "y", "w", "h"] as const;
const BOX_ANCHORS = ["center", "top", "bottom", "left", "right", "area"] as const;

/** Install the `BoxLike` surface (`x`/`y`/`w`/`h` axes + cardinals +
 *  `at(u,v)`) on `hostProto`, forwarding to `host[key]`. First read on
 *  an instance caches the inner reference as an own-property so
 *  subsequent reads skip the proto getter. */
export function delegateBoxLike(hostProto: object, key: string): void {
  for (const name of [...BOX_AXES, ...BOX_ANCHORS]) {
    Object.defineProperty(hostProto, name, {
      configurable: true,
      get(this: Record<string, unknown>) {
        const v = (this[key] as Record<string, unknown>)[name];
        Object.defineProperty(this, name, { value: v, configurable: true });
        return v;
      },
    });
  }
  Object.defineProperty(hostProto, "at", {
    configurable: true,
    value(this: Record<string, BoxLike>, u: number, v: number) {
      return this[key].at(u, v);
    },
  });
}
