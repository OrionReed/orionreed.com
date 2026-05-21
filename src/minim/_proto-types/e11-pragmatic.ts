export {};

// E11 — Pragmatic synthesis after the E10 finding.
//
// E10 proved: TS's intersection-type assignability check defeats the
// variance encoding from E7 when we add a trait constraint. This is
// a TS limitation, not fixable by changing brands. So we abandon the
// `Signal<T, RW> & Traits<T, K>` style.
//
// Instead:
//   - Vec / Num / etc. do NOT carry a capability type parameter.
//     The base class is read-only (no setter declared at the type level).
//   - Writable<Vec> = Vec & { value: V; set(v: V): this; bind(...): () => void }
//     — intersection mixin adds the setter surface.
//   - Animators take `Writable<Vec> & Traits<T, K>` — intersection works
//     for THIS because the writable interface adds CONCRETE setter
//     methods that the trait check can't strip away.
//   - Chain writability uses a phantom W on the CHAIN class only; the
//     conditional return type of `derive()` picks Vec or Writable<Vec>.
//
// We give up some elegance (Vec doesn't carry W) but TS will actually
// enforce what we want at all the use sites that matter.

// ═════════════════════════════════════════════════════════════════════
// CORE
// ═════════════════════════════════════════════════════════════════════

declare class Signal<T> {
  get value(): T;
  peek(): T;
}

type Of<R> = R extends Signal<infer T> ? T : never;

/** Add writable surface to a typed Signal. Pure type-level
 *  intersection; runtime is unchanged. */
type Writable<R extends Signal<unknown>> = R & {
  value: Of<R>;
  set(v: Of<R>): R;
  bind(s: Of<R> | (() => Of<R>)): () => void;
};

// ═════════════════════════════════════════════════════════════════════
// TRAITS
// ═════════════════════════════════════════════════════════════════════

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

// ═════════════════════════════════════════════════════════════════════
// VALUE CLASSES (no W on the class itself)
// ═════════════════════════════════════════════════════════════════════

type NumV = number;
type VecV = { x: number; y: number };

declare class Num extends Signal<NumV> {
  static traits: Required<TraitDict<NumV>>;
  // Invertible — return Writable<Num> (callers can write through)
  add(b: NumV): Writable<Num>;
  sub(b: NumV): Writable<Num>;
  scale(k: number): Writable<Num>;
  // Non-invertible — return Num (read-only)
  clamp(lo: NumV, hi: NumV): Num;
}
interface Num { readonly constructor: typeof Num }

declare class Vec extends Signal<VecV> {
  static traits: Required<TraitDict<VecV>>;
  add(b: VecV): Writable<Vec>;
  sub(b: VecV): Writable<Vec>;
  scale(k: number): Writable<Vec>;
  offset(dx: number, dy: number): Writable<Vec>;
  normalize(): Vec;
  perp(): Vec;
  lerp(b: VecV, t: number): Vec;
  distance(other: VecV): Num;
  // Field lenses — always writable when called on a writable Vec.
  // But we can't easily track that without W. Compromise: always
  // return writable; runtime throws if called on a non-invertible
  // upstream (chain handles this; here field lenses on a Vec from
  // computed() can write back via spread-replace, which doesn't
  // throw — it just propagates).
  get x(): Writable<Num>;
  get y(): Writable<Num>;
  get magnitude(): Num;
  // Chain
  derive<W extends boolean>(fn: (c: VecChain<true>) => VecChain<W>): W extends true ? Writable<Vec> : Vec;
}
interface Vec { readonly constructor: typeof Vec }

// Chain class — carries W internally for writability propagation
declare class VecChain<W extends boolean = true> {
  add(b: VecV): VecChain<W>;
  sub(b: VecV): VecChain<W>;
  scale(k: number): VecChain<W>;
  offset(dx: number, dy: number): VecChain<W>;
  normalize(): VecChain<false>;
  perp(): VecChain<false>;
  lerp(b: VecV, t: number): VecChain<false>;
}

// ═════════════════════════════════════════════════════════════════════
// FACTORIES — return Writable<R>
// ═════════════════════════════════════════════════════════════════════

declare const signal: <T>(v: T) => Writable<Signal<T>>;
declare const num: (v?: NumV) => Writable<Num>;
declare const vec: (x?: number, y?: number) => Writable<Vec>;
declare const computed: <R extends Signal<unknown>>(fn: () => Of<R>, Cls?: new () => R) => R;

// ═════════════════════════════════════════════════════════════════════
// ANIMATORS — Writable<R> & Traits<...>
// ═════════════════════════════════════════════════════════════════════

declare function spring<T>(
  sig: Writable<Signal<T>> & Traits<T, "linear" | "metric">,
  target: T,
): void;

declare function tween<T>(
  sig: Writable<Signal<T>> & Traits<T, "lerp">,
  target: T,
  dur: number,
): void;

declare function attract<T>(
  sig: Writable<Signal<T>> & Traits<T, "linear">,
  target: T,
  k?: number,
): void;

// ═════════════════════════════════════════════════════════════════════
// COMBINATORS
// ═════════════════════════════════════════════════════════════════════

// `mean` infers via R-anchoring: anchor R to the input class, derive T
// via Of<R>. Apply the writable+linear constraint to each parameter.
declare function mean<R extends Signal<unknown>>(
  ...parts: (R & Writable<R> & Traits<Of<R>, "linear">)[]
): R & Writable<R>;

// ═════════════════════════════════════════════════════════════════════
// CONSUMER PATTERNS — verify each
// ═════════════════════════════════════════════════════════════════════

// PATTERN A: Animator rejects RO source
function _A() {
  const a = vec();           // Writable<Vec>
  const ro = a.normalize();  // Vec (no writable surface)

  spring(a, { x: 0, y: 0 });
  tween(a, { x: 0, y: 0 }, 1);
  attract(a, { x: 0, y: 0 });

  // @ts-expect-error — Vec lacks the writable surface; intersection fails
  spring(ro, { x: 0, y: 0 });
  // @ts-expect-error
  tween(ro, { x: 0, y: 0 }, 1);
  // @ts-expect-error
  attract(ro, { x: 0, y: 0 });
}
void _A;

// PATTERN B: read-only function signature — accepts both
function describe(v: Vec): string {
  return `${v.value.x},${v.value.y}`;
}
function _B() {
  describe(vec());                       // Writable<Vec> ⊆ Vec
  describe(vec().normalize());           // Vec
  describe(vec().add({ x: 1, y: 1 }));   // Writable<Vec>
}
void _B;

// PATTERN C: buggy function writing without declaring write capability
function _buggy(v: Vec) {
  // @ts-expect-error — Vec has no setter at the type level
  v.value = { x: 0, y: 0 };
  // @ts-expect-error — Vec has no .set method
  v.set({ x: 0, y: 0 });
}
void _buggy;

// PATTERN D: chain writability propagation
function _D() {
  const a = vec();

  const c1 = a.derive((c) => c.add({ x: 1, y: 1 }));            // Writable<Vec>
  const c2 = a.derive((c) => c.normalize());                    // Vec
  const c3 = a.derive((c) => c.add({ x: 1, y: 1 }).normalize()); // Vec

  c1.value = { x: 0, y: 0 };                // OK
  // @ts-expect-error
  c2.value = { x: 0, y: 0 };
  // @ts-expect-error
  c3.value = { x: 0, y: 0 };

  spring(c1, { x: 0, y: 0 });
  // @ts-expect-error
  spring(c2, { x: 0, y: 0 });
}
void _D;

// PATTERN E: mean — writable inputs, writable output
function _E() {
  const a = vec(); const b = vec();
  const m = mean(a, b);                    // Writable<Vec>
  m.value = { x: 0, y: 0 };                // OK

  // @ts-expect-error — RO arg fails
  mean(a.normalize(), b);
}
void _E;

// PATTERN F: "has writable .translate field" shape-like
interface ShapeLike {
  readonly translate: Writable<Vec>;
  readonly rotate: Writable<Num>;
}
declare const shape: () => ShapeLike;

function moveLeft<S extends ShapeLike>(s: S, dx: number): void {
  s.translate.value = { x: s.translate.value.x - dx, y: s.translate.value.y };
}

interface ROShape { readonly translate: Vec; readonly rotate: Num }
declare const ros: ROShape;

function _F() {
  moveLeft(shape(), 10);                   // OK
  // @ts-expect-error — ros.translate is Vec not Writable<Vec>
  moveLeft(ros, 5);
}
void _F;

// PATTERN G: animators on chain results
function _G() {
  const a = vec();
  const c1 = a.derive((c) => c.add({ x: 1, y: 1 }));   // Writable<Vec>
  const c2 = a.derive((c) => c.normalize());           // Vec

  spring(c1, { x: 0, y: 0 });   // OK — c1 is Writable<Vec> with traits
  tween(c1, { x: 0, y: 0 }, 1); // OK
  // @ts-expect-error — c2 is Vec (RO), no setter
  spring(c2, { x: 0, y: 0 });
  // @ts-expect-error
  tween(c2, { x: 0, y: 0 }, 1);
}
void _G;

// PATTERN H: nested generic + capability
function setIfWritable<R extends Signal<unknown>>(s: R & Writable<R>, v: Of<R>): void {
  s.value = v;
}
function _H() {
  setIfWritable(vec(), { x: 0, y: 0 });
  setIfWritable(num(), 5);
  // @ts-expect-error — Vec lacks setter surface
  setIfWritable(vec().normalize(), { x: 0, y: 0 });
}
void _H;
