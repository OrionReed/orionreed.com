// _proto-cell4/num4.ts — composition value-class on top of Src/Der.
//
// Premise: keep authoring as straightforward as today (single class
// per value type, methods defined once, `instanceof Num` works), but
// have the engine underneath be the 2-class (Source/Derived) split
// that won the perf bench.
//
// The wrapper indirection: every `num.value` is `num._cell.value`,
// one extra field read + method call. V8 should inline the trivial
// accessor; the bench will tell.

import { Source, Derived } from "../_proto-cell2/cell2";
import { type Val, valFn } from "../signal";

type V = number;

const add = (a: V, b: V) => a + b;
const sub = (a: V, b: V) => a - b;
const scale = (a: V, k: number) => a * k;

/** Composition value-class: holds a Source<V> | Derived<V> internally.
 *  Single class definition, all methods declared once, instanceof works
 *  on the wrapper. */
interface ThroughTag<T> {
  parent: Num4;
  fwd: (v: T) => T;
  bwd: (v: T) => T;
}

export class Num4 {
  static is(v: unknown): v is Num4 { return v instanceof Num4 }

  _cell: Source<V> | Derived<V>;
  /** Fusion tag, like Signal._throughOf — set when this Num4 was
   *  produced by .through(). */
  _throughOf?: ThroughTag<V>;

  constructor(initial: V | Source<V> | Derived<V> = 0) {
    if (initial instanceof Source || initial instanceof Derived) {
      this._cell = initial;
    } else {
      this._cell = new Source(initial as V);
    }
  }

  static derive(fn: () => V): Num4 {
    return new Num4(new Derived(fn));
  }

  static lens(g: () => V, s: (v: V) => void): Num4 {
    return new Num4(new Derived(g, s));
  }

  get value(): V { return this._cell.value }
  set value(v: V) { this._cell.value = v }
  peek(): V { return this._cell.peek() }

  add(b: Val<V>): Num4 {
    const bf = valFn(b);
    return this.through(v => v + bf(), n => n - bf());
  }
  sub(b: Val<V>): Num4 {
    const bf = valFn(b);
    return this.through(v => v - bf(), n => n + bf());
  }
  scale(k: Val<V>): Num4 {
    const kf = valFn(k);
    return this.through(v => v * kf(), n => n / kf());
  }
  affine(k: Val<V>, off: Val<V>): Num4 {
    const kf = valFn(k); const of = valFn(off);
    return this.through(v => v * kf() + of(), n => (n - of()) / kf());
  }

  /** Endo-lens. Returns a new Num4 wrapping a Derived that reads/writes
   *  through `this`. Auto-fuses with prior .through() like Signal. */
  through(fwd: (v: V) => V, bwd: (v: V) => V): Num4 {
    const prior = this._throughOf;
    const parent = prior ? prior.parent : this;
    const composedFwd = prior ? (v: V) => fwd(prior.fwd(v)) : fwd;
    const composedBwd = prior ? (v: V) => prior.bwd(bwd(v)) : bwd;
    const inst = new Num4(new Derived(
      () => composedFwd(parent.value),
      v => { parent.value = composedBwd(v) },
    ));
    inst._throughOf = { parent, fwd: composedFwd, bwd: composedBwd };
    return inst;
  }
}

// Reference functions, not Op constants — invertible math lives in the
// methods themselves, mirroring the post-`.through` refactor.
export { add, sub, scale };

export function num4(v: V = 0): Num4 {
  return new Num4(v);
}
