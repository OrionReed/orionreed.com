export {};

// E14 — Generate WritableXxx from Vec via mapped type. ZERO subclass
// declarations; one `type WritableVec = Promote<Vec, ...>` per value
// class.
//
// The key insight: TS mapped types CAN distinguish method return
// types by structural match against R (the receiver type). So we can
// auto-lift invertible methods to return the Writable form, and
// auto-lift field lenses to return Writable inner types, all from a
// single base class declaration. The author specifies WHICH method
// names are invertible and WHICH properties are field lenses.

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

// ═══════════════════════════════════════════════════════════════════
// TRAITS (unchanged)
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
// PROMOTE — the heart of E14
// ═══════════════════════════════════════════════════════════════════

/**
 * Lift a read-only value class to its writable form.
 *
 * - `Inv` lists method names whose return type should be lifted to the
 *   writable form (i.e., the method is bidirectional/a lens).
 * - Field-lens properties (anything typed as a Signal subclass) are
 *   auto-detected and lifted via the LiftField table — no need to
 *   enumerate them.
 */
type Promote<R extends Signal<unknown>, Inv extends keyof R> =
  Omit<R, Inv | "value" | LensFields<R>>
  & Writers<Of<R>>
  & {
      [K in Inv]: R[K] extends (...a: infer A) => R
        ? (...a: A) => Promote<R, Inv>
        : R[K];
    }
  & {
      [K in LensFields<R>]: LiftField<R[K]>;
    };

/** Auto-detect properties that are Signal subclasses (= field lenses). */
type LensFields<R> = { [K in keyof R]: R[K] extends Signal<unknown> ? K : never }[keyof R];

/** Dispatch table: map each base value type to its writable form. */
type LiftField<X> =
    X extends Num ? WritableNum
  : X extends Vec ? WritableVec
  : X extends Box ? WritableBox
  : X extends Signal<infer T> ? Signal<T> & Writers<T>
  : X;

// ═══════════════════════════════════════════════════════════════════
// VALUE CLASSES — only the read-only base, period
// ═══════════════════════════════════════════════════════════════════

type NumV = number;
type VecV = { x: number; y: number };
type BoxV = { x: number; y: number; w: number; h: number };

declare class Num extends Signal<NumV> {
  static traits: Required<TraitDict<NumV>>;
  add(b: NumV): Num;
  sub(b: NumV): Num;
  scale(k: number): Num;
  clamp(lo: NumV, hi: NumV): Num;
}
interface Num { readonly constructor: typeof Num }

declare class Vec extends Signal<VecV> {
  static traits: Required<TraitDict<VecV>>;
  add(b: VecV): Vec;
  sub(b: VecV): Vec;
  scale(k: number): Vec;
  offset(dx: number, dy: number): Vec;
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
  add(b: BoxV): Box;
  scale(k: number): Box;
  expand(n: number): Box;
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
// WRITABLE TYPES — one line per value class!
// ═══════════════════════════════════════════════════════════════════

type WritableNum = Promote<Num, "add" | "sub" | "scale">;

type WritableVec =
  & Omit<Promote<Vec, "add" | "sub" | "scale" | "offset">, "derive">
  & { derive<W extends boolean>(fn: (c: VecChain<true>) => VecChain<W>): W extends true ? WritableVec : Vec };

type WritableBox = Promote<Box, "add" | "scale" | "expand">;

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

// ═══════════════════════════════════════════════════════════════════
// ANIMATORS
// ═══════════════════════════════════════════════════════════════════

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
// VERIFICATION — same battery as E13
// ═══════════════════════════════════════════════════════════════════

function _eagerFlow() {
  const a = vec();                       // WritableVec
  const sum = a.add({ x: 1, y: 1 });     // Promote re-emits add → WritableVec
  const chained = a.add({ x: 1, y: 1 }).scale(2).offset(5, 0);

  sum.value = { x: 0, y: 0 };
  chained.value = { x: 0, y: 0 };

  const norm = a.normalize();            // Vec — `normalize` not in Inv list
  // @ts-expect-error
  norm.value = { x: 0, y: 0 };

  const fromRO = norm.add({ x: 1, y: 1 }); // Vec (base method, not promoted)
  // @ts-expect-error
  fromRO.value = { x: 0, y: 0 };
}
void _eagerFlow;

function _fieldFlow() {
  const a = vec();
  a.x.value = 5;                         // WritableVec.x → WritableNum
  spring(a.x, 10);

  const ro = a.normalize();              // Vec
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
  const c1 = a.derive((c) => c.add({ x: 1, y: 1 }));            // WritableVec
  const c2 = a.derive((c) => c.normalize());                    // Vec
  const c3 = a.derive((c) => c.add({ x: 1, y: 1 }).normalize()); // Vec

  c1.value = { x: 0, y: 0 };
  // @ts-expect-error
  c2.value = { x: 0, y: 0 };
  // @ts-expect-error
  c3.value = { x: 0, y: 0 };

  const ro = a.normalize();
  const c4 = ro.derive((c) => c.add({ x: 1, y: 1 }));  // Vec (base derive)
  // @ts-expect-error
  c4.value = { x: 0, y: 0 };
}
void _chainFlow;

function _buggy(v: Vec) {
  // @ts-expect-error
  v.value = { x: 0, y: 0 };
}
void _buggy;

function describe(v: Vec): string {
  return `${v.value.x},${v.value.y}`;
}
function _describeFlow() {
  describe(vec());
  describe(vec().normalize());
}
void _describeFlow;

interface ShapeLike { readonly translate: WritableVec }
declare const shape: () => ShapeLike;

function moveLeft<S extends ShapeLike>(s: S, dx: number): void {
  s.translate.value = { x: s.translate.value.x - dx, y: s.translate.value.y };
}

interface ROShape { readonly translate: Vec }
declare const ros: ROShape;

function _shapeFlow() {
  moveLeft(shape(), 10);
  // @ts-expect-error
  moveLeft(ros, 5);
}
void _shapeFlow;

function _deepField() {
  const s = shape();
  s.translate.value = { x: 0, y: 0 };
  s.translate.x.value = 5;             // ★ field-of-field capability
  spring(s.translate, { x: 0, y: 0 });
  spring(s.translate.x, 5);
}
void _deepField;

// Utility — generic over container with writable field
function dragHandle<S extends { readonly pos: WritableVec }>(s: S, delta: VecV): void {
  s.pos.value = { x: s.pos.value.x + delta.x, y: s.pos.value.y + delta.y };
}

function _dragFlow() {
  dragHandle({ pos: vec() }, { x: 5, y: 0 });
  // @ts-expect-error
  dragHandle({ pos: vec().normalize() }, { x: 5, y: 0 });
}
void _dragFlow;

// Type predicate
function isWritable<T>(s: Signal<T>): s is Signal<T> & Writers<T> {
  return "set" in s && typeof (s as Record<string, unknown>).set === "function";
}

function _refinementFlow(vs: Vec[]): void {
  for (const v of vs) {
    if (isWritable(v)) {
      v.value = { x: 0, y: 0 };
    }
    // @ts-expect-error
    v.value = { x: 0, y: 0 };
  }
}
void _refinementFlow;
