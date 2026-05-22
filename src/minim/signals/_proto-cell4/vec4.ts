// _proto-cell4/vec4.ts — Vec as a composition wrapper.
//
// Validates that the composition pattern scales beyond Num4 to a
// value class with field lenses to other value classes (Vec → Num).
// This is the hardest authoring path because it requires cross-class
// glue without leaning on inheritance.
//
// Two helpers extracted: `field()` (one cross-class lens), `memo()`
// (per-instance lazy cache). They're tiny and used identically in
// every value class — zero stamping, no mixins.

import { Source, Derived } from "../_proto-cell2/cell2";
import { type Val, valFn } from "../signal";
import { Num4 } from "./num4";

type V = { x: number; y: number };

const add = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
const scale = (a: V, k: number): V => ({ x: a.x * k, y: a.y * k });

/** Cross-class lens onto a field of an object-typed cell. Single
 *  module-level helper — every value class with object value types
 *  calls it from its field getters. No prototype stamping, no mixin. */
function field<T, K extends keyof T, W>(
  parent: { value: T; peek(): T },
  key: K,
  Wrap: new (cell: Derived<T[K]>) => W,
): W {
  return new Wrap(new Derived(
    () => parent.value[key],
    (v) => { parent.value = { ...parent.peek(), [key]: v } as T },
  ));
}

/** Per-instance lazy cache. Used for stable identity of derived views
 *  like `.x` (so `effect(() => vec.x.value)` sees the same Num4
 *  instance on each pass). */
function memo<R>(host: { _memos?: Record<string, unknown> }, key: string, make: () => R): R {
  const cache = (host._memos ??= {});
  return (cache[key] ?? (cache[key] = make())) as R;
}

interface ThroughTag<T> {
  parent: Vec4;
  fwd: (v: T) => T;
  bwd: (v: T) => T;
}

export class Vec4 {
  static is(v: unknown): v is Vec4 { return v instanceof Vec4 }

  _cell: Source<V> | Derived<V>;
  _throughOf?: ThroughTag<V>;
  _memos?: Record<string, unknown>;

  constructor(initial: V | Source<V> | Derived<V> = { x: 0, y: 0 }) {
    if (initial instanceof Source || initial instanceof Derived) {
      this._cell = initial;
    } else {
      this._cell = new Source(initial as V);
    }
  }

  static derive(fn: () => V): Vec4 { return new Vec4(new Derived(fn)); }
  static lens(g: () => V, s: (v: V) => void): Vec4 { return new Vec4(new Derived(g, s)); }

  get value(): V { return this._cell.value }
  set value(v: V) { this._cell.value = v }
  peek(): V { return this._cell.peek() }

  // ── Invertibles via .through (same pattern as Num4) ────────────
  add(b: Val<V>): Vec4 {
    const bf = valFn(b);
    return this.through(
      v => { const o = bf(); return { x: v.x + o.x, y: v.y + o.y } },
      n => { const o = bf(); return { x: n.x - o.x, y: n.y - o.y } },
    );
  }
  scale(k: Val<number>): Vec4 {
    const kf = valFn(k);
    return this.through(
      v => { const k = kf(); return { x: v.x * k, y: v.y * k } },
      n => { const k = kf(); return { x: n.x / k, y: n.y / k } },
    );
  }

  // ── Field lenses to Num4 (cross-class) ────────────────────────
  get x(): Num4 { return memo(this, "x", () => field(this, "x", Num4)) }
  get y(): Num4 { return memo(this, "y", () => field(this, "y", Num4)) }

  // ── Endo-lens with fusion ─────────────────────────────────────
  through(fwd: (v: V) => V, bwd: (v: V) => V): Vec4 {
    const prior = this._throughOf;
    const parent = prior ? prior.parent : this;
    const composedFwd = prior ? (v: V) => fwd(prior.fwd(v)) : fwd;
    const composedBwd = prior ? (v: V) => prior.bwd(bwd(v)) : bwd;
    const inst = new Vec4(new Derived(
      () => composedFwd(parent.value),
      v => { parent.value = composedBwd(v) },
    ));
    inst._throughOf = { parent, fwd: composedFwd, bwd: composedBwd };
    return inst;
  }
}

export { add, sub, scale, field, memo };

export function vec4(x: number = 0, y: number = 0): Vec4 {
  return new Vec4({ x, y });
}
