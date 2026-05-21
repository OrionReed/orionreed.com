export {};

// E12 — Polymorphic `this` returns + intersection-mixin Writable.
//
// E11's hole was field-lens capability tracking: `vec.normalize().x.value = 5`
// type-checked when it shouldn't. The fix attempt here uses TS's `this`
// type to propagate the receiver's capability through method returns.
//
// Key insight: `add(b): this` returns the receiver's exact type. So
//   - `vec()` is `Writable<Vec>`; `.add(b)` returns `Writable<Vec>`.
//   - `vec().normalize()` is `Vec`; `.add(b)` returns `Vec`.
//
// For field lenses, we override on the Writable intersection so
// `.x` on a Writable<Vec> returns Writable<Num>, while `.x` on a
// plain Vec returns Num.

// ═══════════════════════════════════════════════════════════════════
// CORE
// ═══════════════════════════════════════════════════════════════════

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

// Generic Writable wrapper. The conditional ladder lets us override
// field-lens types per value class.
type Writable<R extends Signal<unknown>> =
  R extends Vec ? Omit<R, "x" | "y" | "magnitude"> & Writers<Of<R>>
    & { readonly x: Writable<Num>; readonly y: Writable<Num>; readonly magnitude: Num }
  : R extends Box ? Omit<R, "x" | "y" | "w" | "h" | "center"> & Writers<Of<R>>
    & { readonly x: Writable<Num>; readonly y: Writable<Num>; readonly w: Writable<Num>; readonly h: Writable<Num>; readonly center: Vec }
  : R extends Num ? R & Writers<Of<R>>
  : R extends Signal<infer T> ? R & Writers<T>
  : never;

// ═══════════════════════════════════════════════════════════════════
// TRAITS
// ═══════════════════════════════════════════════════════════════════

interface Linear<T> { add(a: T, b: T): T; sub(a: T, b: T): T; scale(a: T, k: number): T }
type Lerp<T>   = (a: T, b: T, t: number) => T;
type Metric<T> = (a: T, b: T) => number;
type Equals<T> = (a: T, b: T) => boolean;

interface TraitDict<T> {
  linear?: Linear<T>;
  lerp?: Lerp<T>;
  metric?: Metric<T>;
  equals?: Equals<T>;
}
type TraitKey = keyof TraitDict<unknown>;

type Traits<T, K extends TraitKey> = {
  readonly constructor: {
    readonly traits: { [P in K]-?: NonNullable<TraitDict<T>[P]> } & TraitDict<T>;
  };
};

// ═══════════════════════════════════════════════════════════════════
// VALUE CLASSES — use `this` to propagate receiver capability
// ═══════════════════════════════════════════════════════════════════

type NumV = number;
type VecV = { x: number; y: number };
type BoxV = { x: number; y: number; w: number; h: number };

declare class Num extends Signal<NumV> {
  static traits: Required<TraitDict<NumV>>;
  // `this` return propagates: Writable<Num>.add(b) returns Writable<Num>,
  // plain Num.add(b) returns Num (RO).
  add(b: NumV): this;
  sub(b: NumV): this;
  scale(k: number): this;
  // Non-invertible explicitly downcasts to RO base
  clamp(lo: NumV, hi: NumV): Num;
}
interface Num { readonly constructor: typeof Num }

declare class Vec extends Signal<VecV> {
  static traits: Required<TraitDict<VecV>>;
  add(b: VecV): this;
  sub(b: VecV): this;
  scale(k: number): this;
  offset(dx: number, dy: number): this;
  normalize(): Vec;
  perp(): Vec;
  lerp(b: VecV, t: number): Vec;
  distance(other: VecV): Num;
  // RO defaults — Writable<Vec> overrides these
  get x(): Num;
  get y(): Num;
  get magnitude(): Num;
  derive<W extends boolean>(fn: (c: VecChain<true>) => VecChain<W>): W extends true ? this : Vec;
}
interface Vec { readonly constructor: typeof Vec }

declare class Box extends Signal<BoxV> {
  static traits: TraitDict<BoxV> & { linear: Linear<BoxV>; lerp: Lerp<BoxV>; equals: Equals<BoxV> };
  add(b: BoxV): this;
  scale(k: number): this;
  expand(n: number): this;
  lerp(b: BoxV, t: number): Box;
  get x(): Num;
  get y(): Num;
  get w(): Num;
  get h(): Num;
  get center(): Vec;
}
interface Box { readonly constructor: typeof Box }

// Chain
declare class VecChain<W extends boolean = true> {
  add(b: VecV): VecChain<W>;
  scale(k: number): VecChain<W>;
  normalize(): VecChain<false>;
}

// ═══════════════════════════════════════════════════════════════════
// FACTORIES
// ═══════════════════════════════════════════════════════════════════

declare const num: (v?: NumV) => Writable<Num>;
declare const vec: (x?: number, y?: number) => Writable<Vec>;
declare const box: (x?: number, y?: number, w?: number, h?: number) => Writable<Box>;

// ═══════════════════════════════════════════════════════════════════
// ANIMATORS
// ═══════════════════════════════════════════════════════════════════

declare function spring<T>(
  sig: Writable<Signal<T>> & Traits<T, "linear" | "metric">,
  target: T,
): void;

declare function tween<T>(
  sig: Writable<Signal<T>> & Traits<T, "lerp">,
  target: T,
  dur: number,
): void;

// ═══════════════════════════════════════════════════════════════════
// CHECKS
// ═══════════════════════════════════════════════════════════════════

// DEBUG: What does TS infer for `this` when called on Writable<Vec>?
function _debugThis() {
  const a = vec();                       // Writable<Vec>
  const sum = a.add({ x: 1, y: 1 });

  // Hover assertion — does sum carry Writers<VecV>?
  // If `this` propagated the intersection: sum = Writable<Vec>
  // If `this` is just the class: sum = Vec
  type _check = typeof sum extends { set: (v: VecV) => unknown } ? "has-set" : "no-set";

  // Try the write — if `this` works correctly, this should be allowed
  sum.value = { x: 0, y: 0 };  // line 161
}
void _debugThis;

// FIELD LENSES — the hole we're trying to close
function _fieldFlow() {
  const a = vec();                       // Writable<Vec>
  a.x.value = 5;                         // OK — a.x is Writable<Num>
  spring(a.x, 10);                       // OK

  const ro = a.normalize();              // Vec
  // @ts-expect-error — ro.x is plain Num (RO)
  ro.x.value = 5;
  // @ts-expect-error
  spring(ro.x, 10);
}
void _fieldFlow;

// Animators reject RO
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

// Chain
function _chainFlow() {
  const a = vec();
  const c1 = a.derive((c) => c.add({ x: 1, y: 1 }));            // this → Writable<Vec>
  const c2 = a.derive((c) => c.normalize());                    // Vec (RO base)
  const c3 = a.derive((c) => c.add({ x: 1, y: 1 }).normalize()); // Vec

  c1.value = { x: 0, y: 0 };
  // @ts-expect-error
  c2.value = { x: 0, y: 0 };
  // @ts-expect-error
  c3.value = { x: 0, y: 0 };

  // From RO source
  const ro = a.normalize();
  const c4 = ro.derive((c) => c.add({ x: 1, y: 1 }));  // this → Vec
  // @ts-expect-error
  c4.value = { x: 0, y: 0 };
}
void _chainFlow;

// Buggy fn caught locally
function _buggy(v: Vec) {
  // @ts-expect-error
  v.value = { x: 0, y: 0 };
}
void _buggy;

// Generic read-only signature accepts both
function describe(v: Vec): string {
  return `${v.value.x},${v.value.y}`;
}
function _describeFlow() {
  describe(vec());              // Writable<Vec> ⊆ Vec ✓
  describe(vec().normalize());  // Vec ✓
}
void _describeFlow;

// Deep field-of-field
interface ShapeLike {
  readonly translate: Writable<Vec>;
}
declare const shape: () => ShapeLike;

function _deepField() {
  const s = shape();
  s.translate.value = { x: 0, y: 0 };  // OK
  s.translate.x.value = 5;             // OK — translate is Writable<Vec>, .x is Writable<Num>
  spring(s.translate, { x: 0, y: 0 });
  spring(s.translate.x, 5);
}
void _deepField;
