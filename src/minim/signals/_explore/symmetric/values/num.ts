// num.ts — reactive scalar (symmetric-engine port).
//
// All invertible methods ride the base `Signal#lens(fwd, bwd)` and
// return `: this`, so chains preserve receiver writability. (No fusion
// in this engine — chains are plain lens cells, short-circuited by
// value-equality like any forward computed.)
//
// NOTE: the consumer-layer `to()` tween-builder is omitted in this
// port — it is animation glue, orthogonal to engine capability.

import type { Linear, Pack, TraitDict } from "../../../traits";
import {
  type Init,
  Signal,
  type Val,
  type Writable,
  type WritableBrand,
  lazy,
  reader,
} from "../signal";
import { Bool } from "./bool";

type V = number;

export const add = (a: V, b: V) => a + b;
export const sub = (a: V, b: V) => a - b;
export const scale = (a: V, k: number) => a * k;
export const lerp = (a: V, b: V, t: number) => a + (b - a) * t;
export const metric = (a: V, b: V) => Math.abs(a - b);
export const equals = (a: V, b: V) => a === b;

const linearImpl: Linear<V> = { add, sub, scale };
const packImpl: Pack<V> = {
  dim: 1,
  read: (v, a, o) => {
    a[o] = v;
  },
  write: (a, o) => a[o]!,
};

export class Num extends Signal<V> {
  static traits = {
    linear: linearImpl,
    lerp,
    metric,
    equals,
    pack: packImpl,
  } satisfies TraitDict<V>;
  declare readonly _t: typeof Num.traits;

  constructor(v: V = 0) {
    super(v, { equals });
  }

  add(b: Val<V>): this {
    const bf = reader(b);
    return this.lens(
      (v) => v + bf(),
      (n) => n - bf(),
    );
  }
  sub(b: Val<V>): this {
    const bf = reader(b);
    return this.lens(
      (v) => v - bf(),
      (n) => n + bf(),
    );
  }
  scale(k: Val<number>): this {
    const kf = reader(k);
    return this.lens(
      (v) => v * kf(),
      (n) => n / kf(),
    );
  }
  /** Affine: `v ↦ k·v + off`. Invertible iff k ≠ 0. */
  affine(k: Val<number>, off: Val<number>): this {
    const kf = reader(k);
    const of = reader(off);
    return this.lens(
      (v) => v * kf() + of(),
      (n) => (n - of()) / kf(),
    );
  }

  /** Clamp reads + writes to `[lo, hi]` (PutGet-only lens). */
  clamp(lo: Val<V>, hi: Val<V>): this {
    const lf = reader(lo);
    const hf = reader(hi);
    const c = (v: V) => {
      const l = lf();
      const h = hf();
      return v < l ? l : v > h ? h : v;
    };
    return this.lens(c, c);
  }

  /** Snap reads + writes to the nearest multiple of `step`. */
  quantize(step: Val<number>): this {
    const sf = reader(step);
    const q = (v: V) => {
      const s = sf();
      return Math.round(v / s) * s;
    };
    return this.lens(q, q);
  }

  /** Cyclic-coordinate lens: reads pass through; writes pick the
   *  representative closest to the current value modulo `period`. The
   *  2-arg bwd is arity-detected as stateful — the engine threads the
   *  current source value through `s`. */
  cyclic(period: Val<number>): this {
    const pf = reader(period);
    return this.lens(
      (v) => v,
      (v, s) => {
        const p = pf();
        const delta = v - s;
        return s + delta - p * Math.round(delta / p);
      },
    );
  }

  // ── Predicate bridges to Bool (writability-propagating) ──────────

  /** `this > t` as a Bool. Flipping the view bumps the source across
   *  the threshold by `eps`. */
  greaterThan<T extends Num>(
    this: T,
    t: Val<V>,
    eps: Val<V> = 1e-6,
  ): T extends WritableBrand ? Writable<Bool> : Bool {
    const tf = reader(t);
    const ef = reader(eps);
    return Bool.lens(
      this,
      (v) => v > tf(),
      (target, current) => {
        const th = tf();
        if (target === current > th) return current;
        return target ? th + ef() : th - ef();
      },
    ) as never;
  }

  /** `this < t`. Dual of `greaterThan`. */
  lessThan<T extends Num>(
    this: T,
    t: Val<V>,
    eps: Val<V> = 1e-6,
  ): T extends WritableBrand ? Writable<Bool> : Bool {
    const tf = reader(t);
    const ef = reader(eps);
    return Bool.lens(
      this,
      (v) => v < tf(),
      (target, current) => {
        const th = tf();
        if (target === current < th) return current;
        return target ? th - ef() : th + ef();
      },
    ) as never;
  }

  /** `round(this) ≡ 0 (mod d)`. */
  divisibleBy<T extends Num>(
    this: T,
    d: Val<V>,
  ): T extends WritableBrand ? Writable<Bool> : Bool {
    const df = reader(d);
    return Bool.lens(
      this,
      (v) => Math.round(v) % df() === 0,
      (target, current) => {
        const dv = df();
        const r = Math.round(current);
        const mod = ((r % dv) + dv) % dv;
        const isDiv = mod === 0;
        if (target === isDiv) return current;
        if (target) {
          const down = r - mod;
          const up = r + (dv - mod);
          return Math.abs(current - down) <= Math.abs(current - up) ? down : up;
        }
        return r + 1;
      },
    ) as never;
  }

  get isEven(): this extends WritableBrand ? Writable<Bool> : Bool {
    return lazy(this, "isEven", () => (this as Num).divisibleBy(2)) as never;
  }
  get isOdd(): this extends WritableBrand ? Writable<Bool> : Bool {
    return lazy(this, "isOdd", () => (this as Num).divisibleBy(2).not()) as never;
  }
}

/** Writable `Num`. Literal seeds a fresh cell; `Writable<Num>` passes
 *  through by identity. */
export function num(v: Init<Num> = 0): Writable<Num> {
  if (v instanceof Num) return v as Writable<Num>;
  return new Num(v) as Writable<Num>;
}
