// Vec as a callable: `vec(x, y)` returns a function. `v()` reads,
// `v({x, y})` writes. `v.x` and `v.y` are sub-signals. `v.add(b)` and
// friends return new Vec callables. Trait slots are own-properties.

import { signal, computed, attach, brand, value, type Val, type Reactive } from "./signal";
import { LINEAR, LERP, METRIC, EQUALS, type Linear } from "../signals/traits";

export interface VecValue { x: number; y: number }

const vAdd = (a: VecValue, b: VecValue): VecValue => ({ x: a.x + b.x, y: a.y + b.y });
const vSub = (a: VecValue, b: VecValue): VecValue => ({ x: a.x - b.x, y: a.y - b.y });
const vScale = (a: VecValue, k: number): VecValue => ({ x: a.x * k, y: a.y * k });
const vLerp = (a: VecValue, b: VecValue, t: number): VecValue =>
  ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const vMetric = (a: VecValue, b: VecValue) => Math.hypot(a.x - b.x, a.y - b.y);
const vEquals = (a: VecValue, b: VecValue) => a === b || (a.x === b.x && a.y === b.y);

const vLinear: Linear<VecValue> = { add: vAdd, sub: vSub, scale: vScale };

// ─── Vec method bag ──────────────────────────────────────────────────

/** The shape of a Vec's methods + traits. */
export interface VecMethods {
  add(b: Val<VecValue>): Vec;
  sub(b: Val<VecValue>): Vec;
  scale(k: Val<number>): Vec;
  perp(): Vec;
  distance(other: Val<VecValue>): ComputedNum;
  x: Num;   // sub-signal
  y: Num;
  [LINEAR]: Linear<VecValue>;
  [LERP]: typeof vLerp;
  [METRIC]: typeof vMetric;
  [EQUALS]: typeof vEquals;
}

export type Vec = Reactive<VecValue, VecMethods>;
export type ComputedNum = (() => number) & NumMethods;
export type Num = Reactive<number, NumMethods>;

export interface NumMethods {
  add(b: Val<number>): Num;
  sub(b: Val<number>): Num;
  scale(k: Val<number>): Num;
  [LINEAR]: Linear<number>;
}

// ─── Vec method bag (functions only — module-level shared references) ──

function vAddMethod(this: Vec, b: Val<VecValue>): Vec {
  return computedVec(() => vAdd(this(), value(b)));
}
function vSubMethod(this: Vec, b: Val<VecValue>): Vec {
  return computedVec(() => vSub(this(), value(b)));
}
function vScaleMethod(this: Vec, k: Val<number>): Vec {
  return computedVec(() => vScale(this(), value(k)));
}
function vPerpMethod(this: Vec): Vec {
  return computedVec(() => ({ x: this().y, y: -this().x }));
}
function vDistanceMethod(this: Vec, other: Val<VecValue>): ComputedNum {
  return attachNumComputedMethods(computed(() => vMetric(this(), value(other))));
}

// x/y axis lens factories — return a callable that reads/writes the field.
function vGetX(this: Vec): Num {
  const self = this;
  const fn = function (this: void, ...args: unknown[]): number | void {
    if (args.length === 0) return self().x;
    self({ x: args[0] as number, y: self().y });
  };
  return brand(attachNumMethods(fn as unknown as Num));
}
function vGetY(this: Vec): Num {
  const self = this;
  const fn = function (this: void, ...args: unknown[]): number | void {
    if (args.length === 0) return self().y;
    self({ x: self().x, y: args[0] as number });
  };
  return brand(attachNumMethods(fn as unknown as Num));
}

// Accessor descriptors built once (for x/y getters and symbol trait slots).
const X_DESC: PropertyDescriptor = { get: vGetX, configurable: false, enumerable: false };
const Y_DESC: PropertyDescriptor = { get: vGetY, configurable: false, enumerable: false };

// ─── Vec factory ─────────────────────────────────────────────────────

/** Create a writable Vec backed by an alien-signals callable.
 *  Uses direct assignment for value methods (faster than defineProperty)
 *  and defineProperty only for the x/y accessors + symbol trait slots. */
export function vec(x = 0, y = 0): Vec {
  const sig = signal({ x, y }) as unknown as Vec;
  // Direct assignment — much faster than defineProperty for value props.
  sig.add = vAddMethod;
  sig.sub = vSubMethod;
  sig.scale = vScaleMethod;
  sig.perp = vPerpMethod;
  sig.distance = vDistanceMethod;
  sig[LINEAR] = vLinear;
  sig[LERP] = vLerp;
  sig[METRIC] = vMetric;
  sig[EQUALS] = vEquals;
  // Accessors require defineProperty.
  Object.defineProperty(sig, "x", X_DESC);
  Object.defineProperty(sig, "y", Y_DESC);
  return brand(sig);
}

/** Create a read-only Vec view from a getter. */
export function computedVec(getter: () => VecValue): Vec {
  const c = computed(getter) as unknown as Vec;
  c.add = vAddMethod;
  c.sub = vSubMethod;
  c.scale = vScaleMethod;
  c.perp = vPerpMethod;
  c.distance = vDistanceMethod;
  c[LINEAR] = vLinear;
  c[LERP] = vLerp;
  c[METRIC] = vMetric;
  c[EQUALS] = vEquals;
  Object.defineProperty(c, "x", X_DESC);
  Object.defineProperty(c, "y", Y_DESC);
  return brand(c);
}

// ─── Num ─────────────────────────────────────────────────────────────

const numLinear: Linear<number> = {
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  scale: (a, k) => a * k,
};

function nAddMethod(this: Num, b: Val<number>): Num {
  return attachNumComputedMethods(computed(() => this() + value(b))) as unknown as Num;
}
function nSubMethod(this: Num, b: Val<number>): Num {
  return attachNumComputedMethods(computed(() => this() - value(b))) as unknown as Num;
}
function nScaleMethod(this: Num, k: Val<number>): Num {
  return attachNumComputedMethods(computed(() => this() * value(k))) as unknown as Num;
}

export function num(v: number): Num {
  const sig = signal(v) as unknown as Num;
  sig.add = nAddMethod;
  sig.sub = nSubMethod;
  sig.scale = nScaleMethod;
  sig[LINEAR] = numLinear;
  return brand(sig);
}

function attachNumMethods(sig: Num): Num {
  sig.add = nAddMethod;
  sig.sub = nSubMethod;
  sig.scale = nScaleMethod;
  sig[LINEAR] = numLinear;
  return sig;
}

function attachNumComputedMethods(c: () => number): ComputedNum {
  const cn = c as unknown as ComputedNum;
  cn.add = nAddMethod as unknown as ComputedNum["add"];
  cn.sub = nSubMethod as unknown as ComputedNum["sub"];
  cn.scale = nScaleMethod as unknown as ComputedNum["scale"];
  cn[LINEAR] = numLinear;
  return brand(cn) as unknown as ComputedNum;
}
