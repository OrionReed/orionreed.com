// E18 — Realistic value-class authoring: types + runtime, combining
// every reduction we found.
//
// This is what a real `vec.ts` would look like with everything we
// proved out: E14 Promote, E17 auto-field-derive, class-static
// derive/lens (so global `computed(fn, Cls)`/`lens(get, set, Cls)`
// overloads can go away), and method-table reuse between eager
// methods and the Chain.
//
// Compare to today's vec.ts (128 lines) and num.ts (76 lines).

// ═══════════════════════════════════════════════════════════════════
// IMAGINED LIB API (would live in signals/signal.ts + signals/ops.ts)
// ═══════════════════════════════════════════════════════════════════

declare abstract class ReactiveBase<T> {
  peek(): T;
  abstract get value(): T;
  /** Per-instance memo cache (today's Signal.memo). */
  memo<R>(key: string | symbol, make: () => R): R;
  /** Per-instance field-lens cache (today's Signal.field). */
  field<K extends keyof T>(key: K): Signal<T[K]>;
}

declare class Signal<T> extends ReactiveBase<T> {
  get value(): T;
  set value(v: T);
  set(v: T): this;
  bind(s: T | (() => T)): () => void;
}
declare class Computed<T> extends ReactiveBase<T> { get value(): T }
declare class Lens<T> extends ReactiveBase<T> {
  get value(): T;
  set value(v: T);
  set(v: T): this;
  bind(s: T | (() => T)): () => void;
}

interface Op<V, A extends readonly unknown[]> { fwd: (v: V, ...a: A) => V; bwd: (v: V, ...a: A) => V }
declare class Chain<V> {
  push1<A>(op: Op<V, [A]>, a: A): this;
  push2<A, B>(op: Op<V, [A, B]>, a: A, b: B): this;
  toLens<C extends new (...args: never[]) => ReactiveBase<V>>(src: ReactiveBase<V>, Cls: C): InstanceType<C>;
}
declare function applyOp1<V, A, C extends new (...a: never[]) => ReactiveBase<V>>(
  src: ReactiveBase<V>, op: Op<V, [A]>, a: A, Cls: C,
): InstanceType<C>;
declare function applyOp2<V, A, B, C extends new (...a: never[]) => ReactiveBase<V>>(
  src: ReactiveBase<V>, op: Op<V, [A, B]>, a: A, b: B, Cls: C,
): InstanceType<C>;

// Field-lens auto-derivation table — declared ONCE for the whole lib
type FieldLensType<X> =
    [X] extends [number] ? Num
  : [X] extends [{ x: number; y: number }] ? Vec
  : never;
type FieldLenses<V> = { readonly [K in keyof V]: FieldLensType<V[K]> };

// Trait & Writable plumbing (Promote unchanged from E17)
interface Linear<T> { add(a: T, b: T): T; sub(a: T, b: T): T; scale(a: T, k: number): T }
interface TraitDict<T> { linear?: Linear<T>; lerp?: (a: T, b: T, t: number) => T; metric?: (a: T, b: T) => number; equals?: (a: T, b: T) => boolean }
interface Writers<T> { value: T; set(v: T): unknown; bind(s: T | (() => T)): () => void }
type LensFields<R> = { [K in keyof R]: R[K] extends ReactiveBase<unknown> ? K : never }[keyof R];
type LiftField<X> = X extends Num ? WritableNum : X extends Vec ? WritableVec : X extends ReactiveBase<infer T> ? Signal<T> : X;
type Promote<R extends ReactiveBase<unknown>, Inv extends keyof R> =
  Omit<R, Inv | "value" | LensFields<R>>
  & Writers<R extends ReactiveBase<infer T> ? T : never>
  & { [K in Inv]: R[K] extends (...a: infer A) => R ? (...a: A) => Promote<R, Inv> : R[K] }
  & { [K in LensFields<R>]: LiftField<R[K]> };

// ═══════════════════════════════════════════════════════════════════
// num.ts — TODAY: 76 lines (full file). NOW:
// ═══════════════════════════════════════════════════════════════════

type NumV = number;

const numAdd = (a: NumV, b: NumV) => a + b;
const numSub = (a: NumV, b: NumV) => a - b;
const numScale = (a: NumV, k: number) => a * k;
const numLerp = (a: NumV, b: NumV, t: number) => a + (b - a) * t;
const numMetric = (a: NumV, b: NumV) => Math.abs(a - b);

const NUM_OPS = {
  add:   { fwd: numAdd,   bwd: numSub } as Op<NumV, [NumV]>,
  sub:   { fwd: numSub,   bwd: numAdd } as Op<NumV, [NumV]>,
  scale: { fwd: numScale, bwd: (v, k) => numScale(v, 1 / k) } as Op<NumV, [number]>,
};

declare class Num extends ReactiveBase<NumV> {
  static traits: Required<TraitDict<NumV>>;
  static derive(fn: () => NumV): Num;
  static lens(get: () => NumV, set: (v: NumV) => void): WritableNum;
  get value(): NumV;
  add(b: NumV): Num;
  sub(b: NumV): Num;
  scale(k: number): Num;
  clamp(lo: NumV, hi: NumV): Num;
  derive(fn: (c: NumChain) => NumChain): Num;
}
interface Num { readonly constructor: typeof Num }

declare class NumChain extends Chain<NumV> {
  add(b: NumV): this;
  sub(b: NumV): this;
  scale(k: number): this;
}

type WritableNum = Promote<Num, "add" | "sub" | "scale" | "derive">;
declare const num: (v?: NumV) => WritableNum;

// ═══════════════════════════════════════════════════════════════════
// vec.ts — TODAY: 128 lines. NOW:
// ═══════════════════════════════════════════════════════════════════

type VecV = { x: number; y: number };

const vAdd = (a: VecV, b: VecV): VecV => ({ x: a.x + b.x, y: a.y + b.y });
const vSub = (a: VecV, b: VecV): VecV => ({ x: a.x - b.x, y: a.y - b.y });
const vScale = (a: VecV, k: number): VecV => ({ x: a.x * k, y: a.y * k });
const vLerp = (a: VecV, b: VecV, t: number): VecV => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const vMetric = (a: VecV, b: VecV) => Math.hypot(a.x - b.x, a.y - b.y);
const vNormalize = (v: VecV): VecV => {
  const m = Math.hypot(v.x, v.y);
  return m === 0 ? { x: 0, y: 0 } : { x: v.x / m, y: v.y / m };
};
const vPerp = (v: VecV): VecV => ({ x: v.y, y: -v.x });

const VEC_OPS = {
  add:    { fwd: vAdd, bwd: vSub } as Op<VecV, [VecV]>,
  sub:    { fwd: vSub, bwd: vAdd } as Op<VecV, [VecV]>,
  scale:  { fwd: vScale, bwd: (v, k) => vScale(v, 1 / k) } as Op<VecV, [number]>,
  offset: { fwd: (v, dx, dy) => ({ x: v.x + dx, y: v.y + dy }),
            bwd: (n, dx, dy) => ({ x: n.x - dx, y: n.y - dy }) } as Op<VecV, [number, number]>,
};

declare class Vec extends ReactiveBase<VecV> {
  static traits: Required<TraitDict<VecV>>;
  static derive(fn: () => VecV): Vec;
  static lens(get: () => VecV, set: (v: VecV) => void): WritableVec;
  get value(): VecV;
  add(b: VecV): Vec;
  sub(b: VecV): Vec;
  scale(k: number): Vec;
  offset(dx: number, dy: number): Vec;
  normalize(): Vec;
  perp(): Vec;
  lerp(b: VecV, t: number): Vec;
  distance(other: VecV): Num;
  get magnitude(): Num;
  derive(fn: (c: VecChain) => VecChain): Vec;
}
interface Vec extends FieldLenses<VecV> { readonly constructor: typeof Vec }

declare class VecChain extends Chain<VecV> {
  add(b: VecV): this;
  sub(b: VecV): this;
  scale(k: number): this;
  offset(dx: number, dy: number): this;
}

type WritableVec = Promote<Vec, "add" | "sub" | "scale" | "offset" | "derive">;
declare const vec: (x?: number, y?: number) => WritableVec;

// ═══════════════════════════════════════════════════════════════════
// VERIFICATION (smoke-only — full battery covered by e14/e17)
// ═══════════════════════════════════════════════════════════════════

function _smoke() {
  const v = vec();
  v.value = { x: 0, y: 0 };
  v.x.value = 5;                                  // auto-derived field

  const c = Vec.derive(() => v.value);            // class-static — RO
  // @ts-expect-error
  c.value = { x: 1, y: 1 };

  const l = Vec.lens(() => v.value, (n) => { v.value = n });  // class-static — RW
  l.value = { x: 1, y: 1 };

  const norm = v.normalize();
  // @ts-expect-error
  norm.value = { x: 0, y: 0 };
  // @ts-expect-error
  norm.x.value = 5;                               // field on RO

  // Eager chain — Promote recurses correctly
  const chain = v.add({ x: 1, y: 0 }).scale(2).offset(5, 0);
  chain.value = { x: 0, y: 0 };
  chain.x.value = 7;                              // field on chained writable

  // Derive chain (fused)
  const fused = v.derive((c) => c.add({ x: 1, y: 0 }).scale(2).offset(5, 0));
  fused.value = { x: 0, y: 0 };
}
void _smoke;
