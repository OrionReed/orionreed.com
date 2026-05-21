export {};

// E15 — Promote auto-detects invertible methods via a phantom Lens<R>
// marker on the return type. Per value class: ZERO arguments to
// Promote, one-line writable type, all method-level invertibility
// expressed inline.
//
//   class Vec extends Signal<V> {
//     add(b: V): Lens<Vec>;     // marked invertible
//     normalize(): Vec;          // not invertible
//     get x(): Num;              // field lens — auto-detected
//   }
//   type WritableVec = Promote<Vec>;   // done
//
// `Lens<R> = R & { readonly __lens?: never }` is transparent at the
// call site (intersection with an optional never property) but
// detectable by mapped types.

declare class Signal<T> {
  get value(): T;
  peek(): T;
}

type Of<R> = R extends Signal<infer T> ? T : never;

interface Writers<T> {
  value: T;
  set(v: T): unknown;
  bind(s: T | (() => T)): () => void;
}

/** Marker for an invertible method return. */
interface LensMark { readonly __lens: true }
type Lens<R> = R & LensMark;

// ═══════════════════════════════════════════════════════════════════
// TRAITS
// ═══════════════════════════════════════════════════════════════════

interface Linear<T> { add(a: T, b: T): T; sub(a: T, b: T): T; scale(a: T, k: number): T }
type Lerp<T>   = (a: T, b: T, t: number) => T;
type Metric<T> = (a: T, b: T) => number;
type Equals<T> = (a: T, b: T) => boolean;

interface TraitDict<T> {
  linear?: Linear<T>; lerp?: Lerp<T>; metric?: Metric<T>; equals?: Equals<T>;
}
type TraitKey = keyof TraitDict<unknown>;
type Traits<T, K extends TraitKey> = {
  readonly constructor: {
    readonly traits: { [P in K]-?: NonNullable<TraitDict<T>[P]> } & TraitDict<T>;
  };
};

// ═══════════════════════════════════════════════════════════════════
// PROMOTE — no manual lists
// ═══════════════════════════════════════════════════════════════════

/** Pick keys whose value is `Lens<R>`-returning (i.e. invertible). */
type LensMethods<R> = {
  [K in keyof R]: R[K] extends (...a: never[]) => Lens<R> ? K : never;
}[keyof R];

/** Pick keys whose value is a Signal subclass (i.e. field lens). */
type LensFields<R> = {
  [K in keyof R]: R[K] extends Signal<unknown> ? K : never;
}[keyof R];

/** Lift a base value type to its writable form. */
type LiftField<X> =
    X extends Num ? WritableNum
  : X extends Vec ? WritableVec
  : X extends Box ? WritableBox
  : X extends Signal<infer T> ? Signal<T> & Writers<T>
  : X;

type Promote<R extends Signal<unknown>> =
  Omit<R, "value" | LensMethods<R> | LensFields<R>>
  & Writers<Of<R>>
  & {
      [K in LensMethods<R>]: R[K] extends (...a: infer A) => Lens<R>
        ? (...a: A) => Promote<R>
        : never;
    }
  & {
      [K in LensFields<R>]: LiftField<R[K]>;
    };

// ═══════════════════════════════════════════════════════════════════
// VALUE CLASSES — invertibility is inline in the signature
// ═══════════════════════════════════════════════════════════════════

type NumV = number;
type VecV = { x: number; y: number };
type BoxV = { x: number; y: number; w: number; h: number };

declare class Num extends Signal<NumV> {
  static traits: Required<TraitDict<NumV>>;
  add(b: NumV): Lens<Num>;       // invertible
  sub(b: NumV): Lens<Num>;
  scale(k: number): Lens<Num>;
  clamp(lo: NumV, hi: NumV): Num; // not invertible
}
interface Num { readonly constructor: typeof Num }

declare class Vec extends Signal<VecV> {
  static traits: Required<TraitDict<VecV>>;
  add(b: VecV): Lens<Vec>;
  sub(b: VecV): Lens<Vec>;
  scale(k: number): Lens<Vec>;
  offset(dx: number, dy: number): Lens<Vec>;
  normalize(): Vec;
  perp(): Vec;
  lerp(b: VecV, t: number): Vec;
  distance(other: VecV): Num;
  get x(): Num;
  get y(): Num;
  get magnitude(): Num;
  derive<W extends boolean>(fn: (c: VecChain<true>) => VecChain<W>): Vec;
}
interface Vec { readonly constructor: typeof Vec }

declare class Box extends Signal<BoxV> {
  static traits: TraitDict<BoxV> & { linear: Linear<BoxV>; lerp: Lerp<BoxV>; equals: Equals<BoxV> };
  add(b: BoxV): Lens<Box>;
  scale(k: number): Lens<Box>;
  expand(n: number): Lens<Box>;
  lerp(b: BoxV, t: number): Box;
  get x(): Num;
  get y(): Num;
  get w(): Num;
  get h(): Num;
  get center(): Vec;
}
interface Box { readonly constructor: typeof Box }

declare class VecChain<W extends boolean = true> {
  add(b: VecV): VecChain<W>;
  scale(k: number): VecChain<W>;
  normalize(): VecChain<false>;
}

// ═══════════════════════════════════════════════════════════════════
// WRITABLE TYPES — true one-liners (+ derive override for Vec)
// ═══════════════════════════════════════════════════════════════════

type WritableNum = Promote<Num>;

type WritableVec =
  & Omit<Promote<Vec>, "derive">
  & { derive<W extends boolean>(fn: (c: VecChain<true>) => VecChain<W>): W extends true ? WritableVec : Vec };

type WritableBox = Promote<Box>;

// ═══════════════════════════════════════════════════════════════════
// PUBLIC ALIAS
// ═══════════════════════════════════════════════════════════════════

type Writable<R extends Signal<unknown>> =
    R extends Num ? WritableNum
  : R extends Vec ? WritableVec
  : R extends Box ? WritableBox
  : R extends Signal<infer T> ? Signal<T> & Writers<T>
  : never;

// ═══════════════════════════════════════════════════════════════════
// FACTORIES
// ═══════════════════════════════════════════════════════════════════

declare const num: (v?: NumV) => WritableNum;
declare const vec: (x?: number, y?: number) => WritableVec;
declare const box: (x?: number, y?: number, w?: number, h?: number) => WritableBox;

declare function spring<T>(
  sig: (Signal<T> & Writers<T>) & Traits<T, "linear" | "metric">,
  target: T,
): void;
declare function tween<T>(
  sig: (Signal<T> & Writers<T>) & Traits<T, "lerp">,
  target: T,
  dur: number,
): void;

// ═══════════════════════════════════════════════════════════════════
// VERIFICATION — full battery
// ═══════════════════════════════════════════════════════════════════

function _eagerFlow() {
  const a = vec();
  const sum = a.add({ x: 1, y: 1 });
  const chained = a.add({ x: 1, y: 1 }).scale(2).offset(5, 0);

  sum.value = { x: 0, y: 0 };
  chained.value = { x: 0, y: 0 };

  const norm = a.normalize();
  // @ts-expect-error
  norm.value = { x: 0, y: 0 };

  const fromRO = norm.add({ x: 1, y: 1 });  // Lens<Vec> = Vec (Lens is transparent)
  // @ts-expect-error
  fromRO.value = { x: 0, y: 0 };
}
void _eagerFlow;

function _fieldFlow() {
  const a = vec();
  a.x.value = 5;
  spring(a.x, 10);

  const ro = a.normalize();
  // @ts-expect-error
  ro.x.value = 5;
  // @ts-expect-error
  spring(ro.x, 10);
}
void _fieldFlow;

function _animFlow() {
  const a = vec();
  const ro = a.normalize();
  spring(a, { x: 0, y: 0 });
  tween(a, { x: 0, y: 0 }, 1);
  // @ts-expect-error
  spring(ro, { x: 0, y: 0 });
  // @ts-expect-error
  tween(ro, { x: 0, y: 0 }, 1);
}
void _animFlow;

function _chainFlow() {
  const a = vec();
  const c1 = a.derive((c) => c.add({ x: 1, y: 1 }));
  const c2 = a.derive((c) => c.normalize());
  const c3 = a.derive((c) => c.add({ x: 1, y: 1 }).normalize());
  c1.value = { x: 0, y: 0 };
  // @ts-expect-error
  c2.value = { x: 0, y: 0 };
  // @ts-expect-error
  c3.value = { x: 0, y: 0 };

  const ro = a.normalize();
  const c4 = ro.derive((c) => c.add({ x: 1, y: 1 }));
  // @ts-expect-error
  c4.value = { x: 0, y: 0 };
}
void _chainFlow;

function _buggy(v: Vec) {
  // @ts-expect-error
  v.value = { x: 0, y: 0 };
}
void _buggy;

interface ShapeLike { readonly translate: WritableVec }
declare const shape: () => ShapeLike;
interface ROShape { readonly translate: Vec }
declare const ros: ROShape;

function moveLeft<S extends ShapeLike>(s: S, dx: number): void {
  s.translate.value = { x: s.translate.value.x - dx, y: s.translate.value.y };
}

function _shapeFlow() {
  moveLeft(shape(), 10);
  // @ts-expect-error
  moveLeft(ros, 5);
}
void _shapeFlow;

function _deepField() {
  const s = shape();
  s.translate.value = { x: 0, y: 0 };
  s.translate.x.value = 5;
  spring(s.translate, { x: 0, y: 0 });
  spring(s.translate.x, 5);
}
void _deepField;

function dragHandle<S extends { readonly pos: WritableVec }>(s: S, delta: VecV): void {
  s.pos.value = { x: s.pos.value.x + delta.x, y: s.pos.value.y + delta.y };
}
function _dragFlow() {
  dragHandle({ pos: vec() }, { x: 5, y: 0 });
  // @ts-expect-error
  dragHandle({ pos: vec().normalize() }, { x: 5, y: 0 });
}
void _dragFlow;
