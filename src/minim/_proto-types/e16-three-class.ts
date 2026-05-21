export {};

// E16 — Three-class primitive split: Signal / Computed / Lens.
//
// Today's `Signal<T>` is one class with three modes (signal,
// computed, lens) gated by `if (this.getter !== undefined)`
// branches and 5-ish unused slots per instance. This explores
// splitting it.
//
// Goals for this prototype:
//   1. Show that primitive-level writability is free (Signal/Lens
//      have setters; Computed doesn't).
//   2. Show how a value class (Vec) layers on top without forcing
//      a per-flavour subclass explosion.
//   3. Compare the trait-intersection variance behaviour (E10 broke
//      `Signal<T,W>`; do the three concrete classes still play
//      nicely with intersected trait constraints?)

// ═══════════════════════════════════════════════════════════════════
// SHARED REACTIVE BASE — just the engine plumbing
// ═══════════════════════════════════════════════════════════════════

declare abstract class ReactiveBase<T> {
  /** Untracked read; common to all 3 primitives. */
  peek(): T;
  abstract get value(): T;
}

// ═══════════════════════════════════════════════════════════════════
// THREE PRIMITIVES
// ═══════════════════════════════════════════════════════════════════

/** Writable source — direct value, no getter/setter callbacks. */
declare class Signal<T> extends ReactiveBase<T> {
  get value(): T;
  set value(v: T);
  set(v: T): this;
  bind(s: T | (() => T)): () => void;
}

/** Read-only derived — getter only, lazily evaluated, cached. */
declare class Computed<T> extends ReactiveBase<T> {
  get value(): T;
  // NO setter, NO .set, NO .bind at the type level
}

/** Writable derived — getter + setter; chain of get/set callbacks. */
declare class Lens<T> extends ReactiveBase<T> {
  get value(): T;
  set value(v: T);
  set(v: T): this;
  bind(s: T | (() => T)): () => void;
}

// Type alias for "anything with writable surface" — used by animators.
type Writable<T> = Signal<T> | Lens<T>;

// Type alias for "anything readable" — used by Val<T>.
type Readable<T> = Signal<T> | Computed<T> | Lens<T>;

// ═══════════════════════════════════════════════════════════════════
// TRAITS — unchanged from previous explorations
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
// VALUE CLASS — Vec, in the "extends Signal" world
// ═══════════════════════════════════════════════════════════════════
//
// The question: with 3 primitives, can `Vec` extend just ONE of
// them and have derived Vecs (from .normalize, .add) still be
// "Vec"-shaped?
//
// Approach A — Vec extends Signal<V> only. Derived Vecs are bare
// Computed<V> / Lens<V> (no methods). User would call
// `Vec.add(vec.normalize(), b)` instead of `vec.normalize().add(b)`.
// → Loses chaining.
//
// Approach B — Vec is a TRAIT/MIXIN that can ride on any of the 3
// primitives. Three concrete classes (VecOnSignal / VecOnComputed
// / VecOnLens), methods defined once via mixin.
// → Engine simpler, value-class authoring HEAVIER.
//
// Approach C — Vec extends a shared ReactiveBase<V> that gives it
// .value/.peek (no writability). Writable surface is added
// orthogonally for the writable flavours.
// → This is essentially today's "Vec extends Signal" but with
//   Signal split into 3 concrete classes underneath.
//
// Let's try Approach C — it minimises value-class change.

type VecV = { x: number; y: number };
type NumV = number;

// Vec is RO-by-default and lives over a Readable<VecV>. The
// concrete primitive determines write capability via overload at
// the FACTORY level, not via subclass explosion.
declare class Vec extends ReactiveBase<VecV> {
  static traits: Required<TraitDict<VecV>>;
  get value(): VecV;
  add(b: VecV): Vec;
  sub(b: VecV): Vec;
  scale(k: number): Vec;
  normalize(): Vec;
  perp(): Vec;
  distance(other: VecV): Num;
  get x(): Num;
  get y(): Num;
  get magnitude(): Num;
}
interface Vec { readonly constructor: typeof Vec }

declare class Num extends ReactiveBase<NumV> {
  static traits: Required<TraitDict<NumV>>;
  get value(): NumV;
  add(b: NumV): Num;
  sub(b: NumV): Num;
  scale(k: number): Num;
  clamp(lo: NumV, hi: NumV): Num;
}
interface Num { readonly constructor: typeof Num }

// Writable forms via Promote (still needed for receiver-aware methods + field lens lifting)

interface Writers<T> {
  value: T;
  set(v: T): unknown;
  bind(s: T | (() => T)): () => void;
}

type LensFields<R> = { [K in keyof R]: R[K] extends ReactiveBase<unknown> ? K : never }[keyof R];

type LiftField<X> =
    X extends Num ? WritableNum
  : X extends Vec ? WritableVec
  : X extends ReactiveBase<infer T> ? Writable<T>
  : X;

type Promote<R extends ReactiveBase<unknown>, Inv extends keyof R> =
  Omit<R, Inv | "value" | LensFields<R>>
  & Writers<R extends ReactiveBase<infer T> ? T : never>
  & { [K in Inv]: R[K] extends (...a: infer A) => R ? (...a: A) => Promote<R, Inv> : R[K] }
  & { [K in LensFields<R>]: LiftField<R[K]> };

type WritableNum = Promote<Num, "add" | "sub" | "scale">;
type WritableVec = Promote<Vec, "add" | "sub" | "scale">;

// ═══════════════════════════════════════════════════════════════════
// FACTORIES
// ═══════════════════════════════════════════════════════════════════
//
// Now factories are explicit about which primitive backs the Vec.
// `vec()` returns a Vec backed by a Signal (writable source).
// `Vec.derive(fn)` returns a Vec backed by a Computed (RO).
// `Vec.lens(get, set)` returns a Vec backed by a Lens (writable derived).

declare const vec: (x?: number, y?: number) => WritableVec;
declare const num: (v?: NumV) => WritableNum;

// Class-static derive/lens — eliminates the global computed(fn, Cls?) overload
declare namespace Vec {
  function derive(fn: () => VecV): Vec;
  function lens(get: () => VecV, set: (v: VecV) => void): WritableVec;
}
declare namespace Num {
  function derive(fn: () => NumV): Num;
  function lens(get: () => NumV, set: (v: NumV) => void): WritableNum;
}

// ═══════════════════════════════════════════════════════════════════
// ANIMATORS — type sigs become NICER at the primitive level
// ═══════════════════════════════════════════════════════════════════
//
// Today: `sig: Writable<Signal<T>> & Traits<T, "linear" | "metric">`
// Three-class: `sig: Writable<T> & Traits<T, "linear" | "metric">`
//
// Same constraint, less ceremony — Writable<T> is already a union
// of Signal | Lens. The trait constraint intersects cleanly because
// we're NOT carrying a phantom W parameter on the value-class type
// (that's what blew up in E10).

// Constraint is "any reactive thing with writable surface" — works for
// raw Signal/Lens AND for any value class that happens to have Writers.
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
// VERIFICATION — full battery
// ═══════════════════════════════════════════════════════════════════

function _basics() {
  const a = vec();                            // WritableVec
  a.value = { x: 1, y: 2 };
  a.set({ x: 0, y: 0 });
  a.x.value = 5;                              // field lens flows

  const ro = a.normalize();                   // Vec (returned by base method)
  // @ts-expect-error
  ro.value = { x: 0, y: 0 };
  // @ts-expect-error
  ro.x.value = 5;                             // ★ field-lens capability tracked
}
void _basics;

function _animators() {
  const a = vec();
  const ro = a.normalize();

  spring(a, { x: 0, y: 0 });                  // WritableVec ⊆ Signal | Lens? Need to verify
  tween(a, { x: 0, y: 0 }, 1);

  // @ts-expect-error
  spring(ro, { x: 0, y: 0 });
  // @ts-expect-error
  tween(ro, { x: 0, y: 0 }, 1);
}
void _animators;

function _classDerive() {
  // Class-static derive returns RO Vec
  const c = Vec.derive(() => ({ x: 0, y: 0 }));
  // @ts-expect-error
  c.value = { x: 1, y: 1 };

  // Class-static lens returns Writable Vec
  let backing = { x: 0, y: 0 };
  const l = Vec.lens(() => backing, (v) => { backing = v });
  l.value = { x: 1, y: 1 };                   // OK
  l.x.value = 5;                              // OK — field of writable
}
void _classDerive;

function _refinement(arr: Vec[]) {
  for (const v of arr) {
    // @ts-expect-error
    v.value = { x: 0, y: 0 };                 // bare Vec is RO-default
  }
}
void _refinement;

// Verify raw primitives also satisfy animator constraint
declare function rawSignal<T>(v: T): Signal<T>;
declare function rawComputed<T>(fn: () => T): Computed<T>;

interface SimpleLinearNum extends Signal<number> {
  readonly constructor: { readonly traits: { linear: Linear<number>; metric: Metric<number> } & TraitDict<number> };
}
declare const rawN: SimpleLinearNum;

function _rawAnimators() {
  spring(rawN, 5);                            // Signal with traits
  const c = rawComputed<number>(() => 0);
  // @ts-expect-error — Computed has no Writers
  spring(c as Computed<number> & Traits<number, "linear" | "metric">, 5);
}
void _rawAnimators;
