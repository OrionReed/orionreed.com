export {};

// E17 — Auto-derive field lens types from the value shape `V`.
//
// Today every value class enumerates its field lens getters:
//   get x(): Num { return this.field("x", Num); }
//   get y(): Num { return this.field("y", Num); }
//
// And the RUNTIME implementation does the same. The shape `V = {x:
// number, y: number}` could in principle drive both.
//
// At the type level, we can definitely do it via interface merge +
// a mapped type. The runtime side is a Proxy or a one-time
// `defineField()` loop in the constructor.
//
// This explores how it looks at the type level — combined with
// E14's Promote for writability tracking.

declare abstract class ReactiveBase<T> {
  peek(): T;
  abstract get value(): T;
}
declare class Signal<T> extends ReactiveBase<T> {
  get value(): T; set value(v: T);
  set(v: T): this;
  bind(s: T | (() => T)): () => void;
}

// ═══════════════════════════════════════════════════════════════════
// FIELD LENS AUTO-DERIVATION
// ═══════════════════════════════════════════════════════════════════

/** Dispatch table: a plain field of type X gets typed as the
 *  corresponding value class instance. Extensible — add a branch for
 *  each value type. */
type FieldLensType<X> =
    [X] extends [number] ? Num
  : [X] extends [{ x: number; y: number }] ? Vec
  : [X] extends [{ x: number; y: number; w: number; h: number }] ? Box
  : never;

/** Map every key of V to its field-lens type. */
type FieldLenses<V> = {
  readonly [K in keyof V]: FieldLensType<V[K]>;
};

// ═══════════════════════════════════════════════════════════════════
// TRAITS — unchanged
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
// PROMOTE — same as E14, but using FieldLensType for lifting
// ═══════════════════════════════════════════════════════════════════

interface Writers<T> {
  value: T;
  set(v: T): unknown;
  bind(s: T | (() => T)): () => void;
}

type LensFields<R> = { [K in keyof R]: R[K] extends ReactiveBase<unknown> ? K : never }[keyof R];

type LiftField<X> =
    X extends Num ? WritableNum
  : X extends Vec ? WritableVec
  : X extends Box ? WritableBox
  : X extends ReactiveBase<infer T> ? Signal<T>
  : X;

type Promote<R extends ReactiveBase<unknown>, Inv extends keyof R> =
  Omit<R, Inv | "value" | LensFields<R>>
  & Writers<R extends ReactiveBase<infer T> ? T : never>
  & { [K in Inv]: R[K] extends (...a: infer A) => R ? (...a: A) => Promote<R, Inv> : R[K] }
  & { [K in LensFields<R>]: LiftField<R[K]> };

// ═══════════════════════════════════════════════════════════════════
// VALUE CLASSES — no field-lens declarations at all!
// ═══════════════════════════════════════════════════════════════════

type NumV = number;
type VecV = { x: number; y: number };
type BoxV = { x: number; y: number; w: number; h: number };

// Num — leaf type, no fields to lift
declare class Num extends ReactiveBase<NumV> {
  static traits: Required<TraitDict<NumV>>;
  get value(): NumV;
  add(b: NumV): Num;
  sub(b: NumV): Num;
  scale(k: number): Num;
  clamp(lo: NumV, hi: NumV): Num;
}
interface Num { readonly constructor: typeof Num }

// Vec — only declares METHODS, not field-lens getters
declare class Vec extends ReactiveBase<VecV> {
  static traits: Required<TraitDict<VecV>>;
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
}
// Field lenses (x, y) appear via interface merge with the auto-derived shape:
interface Vec extends FieldLenses<VecV> {
  readonly constructor: typeof Vec;
}

declare class Box extends ReactiveBase<BoxV> {
  static traits: TraitDict<BoxV> & { linear: Linear<BoxV>; lerp: Lerp<BoxV>; equals: Equals<BoxV> };
  get value(): BoxV;
  add(b: BoxV): Box;
  scale(k: number): Box;
  expand(n: number): Box;
  lerp(b: BoxV, t: number): Box;
  get center(): Vec;  // non-derived structural field; remains explicit
}
interface Box extends FieldLenses<BoxV> {
  readonly constructor: typeof Box;
}

type WritableNum = Promote<Num, "add" | "sub" | "scale">;
type WritableVec = Promote<Vec, "add" | "sub" | "scale" | "offset">;
type WritableBox = Promote<Box, "add" | "scale" | "expand">;

declare const vec: (x?: number, y?: number) => WritableVec;
declare const num: (v?: NumV) => WritableNum;
declare const box: (x?: number, y?: number, w?: number, h?: number) => WritableBox;

declare function spring<T>(
  sig: ReactiveBase<T> & Writers<T> & Traits<T, "linear" | "metric">,
  target: T,
): void;
declare function tween<T>(
  sig: ReactiveBase<T> & Writers<T> & Traits<T, "lerp">,
  target: T,
  dur: number,
): void;

// ═══════════════════════════════════════════════════════════════════
// VERIFICATION
// ═══════════════════════════════════════════════════════════════════

function _basics() {
  const a = vec();                 // WritableVec
  a.value = { x: 1, y: 2 };
  a.x.value = 5;                   // ★ auto-derived field lens, writable
  a.y.value = 10;

  const ro = a.normalize();
  // @ts-expect-error
  ro.value = { x: 0, y: 0 };
  // @ts-expect-error
  ro.x.value = 5;                  // ★ auto-derived field, RO when source RO
}
void _basics;

function _box() {
  const b = box();
  b.x.value = 5;
  b.y.value = 10;
  b.w.value = 100;
  b.h.value = 200;                 // all 4 auto-derived

  const ro = b.lerp({ x: 0, y: 0, w: 10, h: 10 }, 0.5);
  // @ts-expect-error
  ro.x.value = 5;
  // @ts-expect-error
  ro.center.value = { x: 0, y: 0 };

  tween(b, { x: 0, y: 0, w: 1, h: 1 }, 0.5);  // Box has lerp ✓
  // @ts-expect-error — Box lacks metric, spring rejects
  spring(b, { x: 0, y: 0, w: 1, h: 1 });
}
void _box;

function _animators() {
  const a = vec();
  const ro = a.normalize();

  spring(a, { x: 0, y: 0 });
  spring(a.x, 10);                 // animator over auto-derived field
  // @ts-expect-error
  spring(ro, { x: 0, y: 0 });
  // @ts-expect-error
  spring(ro.x, 10);
}
void _animators;

declare const _frameSym: { translate: WritableVec; rotation: WritableNum };
function _shape() {
  const f = _frameSym;

  f.translate.value = { x: 0, y: 0 };
  f.translate.x.value = 5;         // ★ auto-derived field on writable
  f.rotation.value = 0.5;

  spring(f.translate, { x: 50, y: 50 });
  tween(f.rotation, Math.PI, 0.5);
  spring(f.translate.x, 5);
}
void _shape;

// Buggy fn caught locally
function _buggy(v: Vec) {
  // @ts-expect-error
  v.value = { x: 0, y: 0 };
  // @ts-expect-error
  v.x.value = 5;                   // field lens on RO Vec
}
void _buggy;
