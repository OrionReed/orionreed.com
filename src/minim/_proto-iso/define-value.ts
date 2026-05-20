// Prototype: declarative value-type builder.
//
// Goal: collapse the per-value-type boilerplate (class declaration,
// trait slot installation, eager-method forwarders, chain class,
// factory function, field accessors) into a SINGLE declarative call.
//
// The author writes:
//   - the shape (default value + field names)
//   - the trait implementations (linear / lerp / metric / equals)
//   - a Chain class with the math (fwd + bwd in one place)
//
// The library generates:
//   - the value class (extends Signal<T>)
//   - eager methods (forwarders to chain)
//   - field accessors (from `fields: [...]`)
//   - trait slot installation (from `traits`)
//   - factory function
//   - viewClassFor wiring (kept; lives once)
//
// Compare authoring before/after:
//   - signals/values/vec.ts:  125 lines, math declared 2× (eager + chain)
//   - _proto-iso/vec.ts:      195 lines (chain methods + eager forwarders + class)
//   - this file's `defineVec`: 60 lines (math ONCE, all else generated)
//
// Status: prototype. Demonstrates the pattern on Num + Vec. Type
// inference goes most of the way; explicit return-type annotations
// help in a few spots.

import {
  Signal,
  value as readVal,
  type Val,
} from "../signals/signal";
import {
  LINEAR, LERP, METRIC, EQUALS,
  type Linear, type Lerp, type Metric, type Equals,
} from "../signals/traits";
import { derived } from "../signals/derive";
import { Chain, via, type Iso } from "./iso";
import { field } from "./field";

// ─── Spec ─────────────────────────────────────────────────────────────

/** Per-value-type spec. The library uses this to generate the class.
 *  `ChainCls` is the user-authored Chain<S, T, W> subclass that carries
 *  the math (fwd + bwd, in one place). */
export interface ValueSpec<T, F extends readonly (keyof T & string)[]> {
  /** Default constructor value. */
  default: T;
  /** Field names (for auto-generated axis lenses). Must match T's keys. */
  fields?: F;
  /** Trait implementations (installed on prototype as `[LINEAR]`, etc.). */
  traits?: {
    linear?: Linear<T>;
    lerp?: Lerp<T>;
    metric?: Metric<T>;
    equals?: Equals<T>;
  };
}

// ─── The generated value-class type ──────────────────────────────────

/** A value class is `Signal<T>` + auto-generated field accessors + the
 *  user's domain methods (defined on the prototype after `defineValue`).
 *
 *  We carry the field accessors at the type level so authors can do
 *  `Vec.add(b)`-style work without a manual class declaration. */
export type ValueClass<T, F extends readonly (keyof T)[]> = {
  new (initial?: T): Signal<T> & {
    [K in F[number]]: Signal<T[K]>;
  };
  readonly prototype: Signal<T>;
};

// ─── defineValue ─────────────────────────────────────────────────────

/** Build a value class from a spec. Returns a constructor; the
 *  prototype is hot-patched with trait slots and field accessors.
 *
 *  Use as:
 *    const Vec = defineValue<VecValue, ['x','y']>({...});
 *    const v = new Vec({x:3, y:4});
 *    v.x.value = 5;  // field lens (auto-generated)
 *
 *  Then attach the domain methods (`add`, `scale`, `perp`, …) by
 *  declaring them on `Vec.prototype` — or, more typically, by
 *  extending the class. See `defineNum` / `defineVec` below for the
 *  recommended pattern. */
export function defineValue<
  T,
  F extends readonly (keyof T & string)[] = readonly (keyof T & string)[],
>(spec: ValueSpec<T, F>): ValueClass<T, F> {
  const defaultValue = spec.default;
  class V extends Signal<T> {
    constructor(initial: T = defaultValue) { super(initial); }
  }

  // Install trait slots.
  const proto = V.prototype as unknown as Record<symbol, unknown>;
  if (spec.traits?.linear) proto[LINEAR] = spec.traits.linear;
  if (spec.traits?.lerp) proto[LERP] = spec.traits.lerp;
  if (spec.traits?.metric) proto[METRIC] = spec.traits.metric;
  if (spec.traits?.equals) proto[EQUALS] = spec.traits.equals;

  // Install field accessors. For the prototype, all fields are assumed
  // to produce Num lenses (true for VecValue, BoxValue, MatrixValue).
  // A fully-general version would take a per-field Cls in the spec
  // (e.g. `fields: { x: Num, y: Num, translate: Vec, ... }`).
  if (spec.fields) {
    for (const k of spec.fields) {
      Object.defineProperty(V.prototype, k, {
        get(this: Signal<T>) {
          const fieldIso = field<T, keyof T>(k as keyof T);
          return via(
            this,
            Chain.of<T>().iso(fieldIso as Iso<T, unknown> as Iso<T, T[keyof T]>),
            Num as unknown as new () => Signal<T[keyof T]>,
          );
        },
        configurable: true,
        enumerable: false,
      });
    }
  }

  return V as unknown as ValueClass<T, F>;
}

// ─── Demonstrating the pattern: Num ──────────────────────────────────

const numLinear: Linear<number> = {
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  scale: (a, k) => a * k,
};
const numLerp: Lerp<number> = (a, b, t) => a + (b - a) * t;

/** Chain class with the math — fwd + bwd in one place. */
export class NumChainV2<W extends boolean> {
  constructor(readonly _chain: Chain<unknown, number, W>) {}
  static start(): NumChainV2<true> {
    return new NumChainV2(Chain.of<number>() as unknown as Chain<unknown, number, true>);
  }
  add(b: Val<number>): NumChainV2<W> {
    return new NumChainV2(this._chain.iso({
      fwd: (v) => v + readVal(b), bwd: (v) => v - readVal(b),
    }));
  }
  sub(b: Val<number>): NumChainV2<W> {
    return new NumChainV2(this._chain.iso({
      fwd: (v) => v - readVal(b), bwd: (v) => v + readVal(b),
    }));
  }
  scale(k: Val<number>): NumChainV2<W> {
    return new NumChainV2(this._chain.iso({
      fwd: (v) => v * readVal(k), bwd: (v) => v / readVal(k),
    }));
  }
}

// Generate the Num class.
const NumBase = defineValue<number, []>({
  default: 0,
  traits: {
    linear: numLinear,
    lerp: numLerp,
    metric: (a, b) => Math.abs(a - b),
    equals: (a, b) => a === b,
  },
});

// Extend with domain methods (one-line forwarders).
export class Num extends NumBase {
  add(b: Val<number>): Num { return this.derive((c) => c.add(b)); }
  sub(b: Val<number>): Num { return this.derive((c) => c.sub(b)); }
  scale(k: Val<number>): Num { return this.derive((c) => c.scale(k)); }

  derive<W extends boolean>(fn: (c: NumChainV2<true>) => NumChainV2<W>): Num {
    const chain = fn(NumChainV2.start());
    return via(this as Signal<number>, chain._chain as Chain<number, number, W>, Num) as Num;
  }
}

export const num = (v: Val<number> = 0): Num => {
  const n = new Num();
  n.bind(v);
  return n;
};

// ─── Demonstrating the pattern: Vec ──────────────────────────────────

export interface VecValue { x: number; y: number }

const vAdd = (a: VecValue, b: VecValue): VecValue => ({ x: a.x + b.x, y: a.y + b.y });
const vSub = (a: VecValue, b: VecValue): VecValue => ({ x: a.x - b.x, y: a.y - b.y });
const vScale = (a: VecValue, k: number): VecValue => ({ x: a.x * k, y: a.y * k });
const vLerp = (a: VecValue, b: VecValue, t: number): VecValue =>
  ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const vMetric = (a: VecValue, b: VecValue) => Math.hypot(a.x - b.x, a.y - b.y);
const vEquals = (a: VecValue, b: VecValue) =>
  a === b || (a.x === b.x && a.y === b.y);

const vecLinear: Linear<VecValue> = { add: vAdd, sub: vSub, scale: vScale };

export class VecChainV2<W extends boolean> {
  constructor(readonly _chain: Chain<unknown, VecValue, W>) {}
  static start(): VecChainV2<true> {
    return new VecChainV2(Chain.of<VecValue>() as unknown as Chain<unknown, VecValue, true>);
  }
  add(b: Val<VecValue>): VecChainV2<W> {
    return new VecChainV2(this._chain.iso({
      fwd: (v) => vAdd(v, readVal(b)), bwd: (v) => vSub(v, readVal(b)),
    }));
  }
  scale(k: Val<number>): VecChainV2<W> {
    return new VecChainV2(this._chain.iso({
      fwd: (v) => vScale(v, readVal(k)), bwd: (v) => vScale(v, 1 / readVal(k)),
    }));
  }
  perp(): VecChainV2<W> {
    return new VecChainV2(this._chain.iso({
      fwd: (v) => ({ x: v.y, y: -v.x }),
      bwd: (v) => ({ x: -v.y, y: v.x }),
    }));
  }
  // Read-only ops would use .ro(...) and return a VecChainV2<false>
  normalize(): VecChainV2<false> {
    return new VecChainV2<false>(this._chain.ro({
      fwd: (v) => {
        const m = Math.hypot(v.x, v.y);
        return m === 0 ? { x: 0, y: 0 } : { x: v.x / m, y: v.y / m };
      },
    }));
  }
}

const VecBase = defineValue<VecValue, readonly ["x", "y"]>({
  default: { x: 0, y: 0 },
  fields: ["x", "y"] as const,
  traits: {
    linear: vecLinear,
    lerp: vLerp,
    metric: vMetric,
    equals: vEquals,
  },
});

export class Vec extends VecBase {
  add(b: Val<VecValue>): Vec { return this.derive((c) => c.add(b)); }
  scale(k: Val<number>): Vec { return this.derive((c) => c.scale(k)); }
  perp(): Vec { return this.derive((c) => c.perp()); }

  derive<W extends boolean>(fn: (c: VecChainV2<true>) => VecChainV2<W>): Vec {
    const chain = fn(VecChainV2.start());
    return via(this as Signal<VecValue>, chain._chain as Chain<VecValue, VecValue, W>, Vec) as Vec;
  }
}

export const vec = (x: Val<number> = 0, y: Val<number> = 0): Vec => {
  const v = new Vec();
  v.x.bind(x);
  v.y.bind(y);
  return v;
};
