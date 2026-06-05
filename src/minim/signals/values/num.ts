// num.ts — reactive scalar.
//
// Invertibles return `: this` and ride on `Cell#lens(fwd, bwd)`;
// chained calls compose into a lens chain.

import type { Easing } from "../../core";
import { type Tween, tween } from "../anim";
import {
  Cell,
  type Init,
  lazy,
  reader,
  type Val,
  type Writable,
  type WritableBrand,
} from "../signal";
import type { Linear, Pack, TraitDict } from "../traits";
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

export class Num extends Cell<V> {
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
      v => v + bf(),
      n => n - bf(),
    );
  }
  sub(b: Val<V>): this {
    const bf = reader(b);
    return this.lens(
      v => v - bf(),
      n => n + bf(),
    );
  }
  scale(k: Val<number>): this {
    const kf = reader(k);
    return this.lens(
      v => v * kf(),
      n => n / kf(),
    );
  }
  /** Affine `v ↦ k·v + off`. Invertible iff k ≠ 0; readability alias
   *  for `.scale(k).add(off)`. */
  affine(k: Val<number>, off: Val<number>): this {
    const kf = reader(k);
    const of = reader(off);
    return this.lens(
      v => v * kf() + of(),
      n => (n - of()) / kf(),
    );
  }

  /** Lossy clamping lens to `[lo, hi]`. PutGet only (a write outside
   *  the range reads back clamped, not as written). */
  clamp(lo: Val<V>, hi: Val<V>): this {
    const lf = reader(lo);
    const hf = reader(hi);
    const c = (v: V) => {
      const l = lf(),
        h = hf();
      return v < l ? l : v > h ? h : v;
    };
    // A write whose clamped projection matches the current view leaves
    // the source untouched (off-range source preserved).
    return this.lens(c, (v, s) => {
      const cv = c(v);
      return cv === c(s) ? s : cv;
    });
  }

  /** Lossy lens snapping reads/writes to the nearest multiple of `step`. */
  quantize(step: Val<number>): this {
    const sf = reader(step);
    const q = (v: V) => {
      const s = sf();
      return Math.round(v / s) * s;
    };
    // A write that snaps to the current bucket leaves the source
    // untouched (off-grid remainder preserved).
    return this.lens(q, (v, src) => {
      const qv = q(v);
      return qv === q(src) ? src : qv;
    });
  }

  /** Cyclic-coordinate lens. Reads pass through; writes pick the
   *  representative closest to current modulo `period`, so dragging an
   *  angle never jumps a full revolution. The 2-arg bwd is arity-detected
   *  as stateful, threading the accumulated value through `s`. */
  cyclic(period: Val<number>): this {
    const pf = reader(period);
    return this.lens(
      v => v,
      (v, s) => {
        const p = pf();
        const delta = v - s;
        return s + delta - p * Math.round(delta / p);
      },
    );
  }

  // ── Predicate bridges to Bool ────────────────────────────────────
  //
  // Cross-type quotient lenses projecting Num through a boolean
  // predicate. Conditional return type: writable receiver yields
  // `Writable<Bool>`, RO receiver yields RO `Bool`.

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
      v => v > tf(),
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
      v => v < tf(),
      (target, current) => {
        const th = tf();
        if (target === current < th) return current;
        return target ? th - ef() : th + ef();
      },
    ) as never;
  }

  /** `round(this) ≡ 0 (mod d)` as a Bool; pair with `quantize(1)` for
   *  integer sliders. Bwd: to make divisible, snap to the nearer
   *  multiple of `d`; to make non-divisible, bump by `+1`; no-op when
   *  the class already matches. */
  divisibleBy<T extends Num>(this: T, d: Val<V>): T extends WritableBrand ? Writable<Bool> : Bool {
    const df = reader(d);
    return Bool.lens(
      this,
      v => Math.round(v) % df() === 0,
      (target, current) => {
        const dv = df();
        const r = Math.round(current);
        // ((a % b) + b) % b handles negative `r` cleanly.
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

  /** `divisibleBy(2)` — lazy getter for the common case. */
  get isEven(): this extends WritableBrand ? Writable<Bool> : Bool {
    return lazy(this, "isEven", () => (this as Num).divisibleBy(2)) as never;
  }
  /** `not(divisibleBy(2))` — lazy getter. */
  get isOdd(): this extends WritableBrand ? Writable<Bool> : Bool {
    return lazy(this, "isOdd", () => (this as Num).divisibleBy(2).not()) as never;
  }

  /** Tween-builder; `this: Writable<Num>` gates the call to writable
   *  receivers. */
  to(this: Writable<Num>, target: V, dur: Val<number>, ease?: Easing): Tween<V> {
    return tween(this, target, dur, ease);
  }
}

/** Writable `Num`. Literal seeds a fresh cell; existing `Writable<Num>`
 *  passes through by identity. RO sources are rejected at the type level —
 *  use `Num.derive(...)` for reactive RO tracking, or `Num.from(...)` for
 *  the permissive lift over any `Val<number>`. */
export function num(v: Init<Num> = 0): Writable<Num> {
  if (v instanceof Num) return v as Writable<Num>;
  return new Num(v) as Writable<Num>;
}
