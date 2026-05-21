export {};

// E9 — Full system mockup.
//
// Test the E7/E8 capability machinery against the patterns we'd
// actually hit in production:
//
//   - Trait constraints (Linear/Lerp/Metric) combined with capability
//   - Animator functions (spring, tween, attract, mean, combine)
//   - "Has writable .translate field" Shape-like patterns
//   - Cross-capability (function accepts either RW or RO and just reads)
//   - Field lenses (parent's capability propagates to .x / .y / etc)
//   - Custom value classes (the md-lerps Text / md-morph Polygon pattern)

// ═════════════════════════════════════════════════════════════════════
// CORE ENGINE
// ═════════════════════════════════════════════════════════════════════

interface RO { readonly __sig: true }
interface RW extends RO { readonly __rw: true }

declare class Signal<T, out C extends RO = RO> {
  get value(): T;
  set value(v: C extends RW ? T : never);
  peek(): T;
  set(v: C extends RW ? T : never): this;
  bind(s: (C extends RW ? T : never) | (() => (C extends RW ? T : never))): () => void;
  // No base traits declaration — subclasses declare their own.
  // (Base would force variance hell with the conditional Required<TraitDict>.)
}

type Of<R> = R extends Signal<infer T, RO> ? T : never;

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

/** Constrain that a Signal's class declares specific traits. */
type Traits<T, K extends TraitKey> = {
  readonly constructor: {
    readonly traits: { [P in K]-?: NonNullable<TraitDict<T>[P]> } & TraitDict<T>;
  };
};

// ═════════════════════════════════════════════════════════════════════
// VALUE CLASSES
// ═════════════════════════════════════════════════════════════════════

type NumV = number;
type VecV = { x: number; y: number };
type BoxV = { x: number; y: number; w: number; h: number };

// ── Num ──────────────────────────────────────────────────────────────
declare class Num<out C extends RO = RO> extends Signal<NumV, C> {
  static traits: Required<TraitDict<NumV>>;
  add(b: NumV): Num<C>;
  sub(b: NumV): Num<C>;
  scale(k: number): Num<C>;
  clamp(lo: NumV, hi: NumV): Num<RO>;   // not invertible
}
interface Num { readonly constructor: typeof Num }

// ── Vec ──────────────────────────────────────────────────────────────
declare class Vec<out C extends RO = RO> extends Signal<VecV, C> {
  static traits: Required<TraitDict<VecV>>;
  add(b: VecV): Vec<C>;
  sub(b: VecV): Vec<C>;
  scale(k: number): Vec<C>;
  offset(dx: number, dy: number): Vec<C>;
  normalize(): Vec<RO>;
  perp(): Vec<RO>;
  lerp(b: VecV, t: number): Vec<RO>;
  distance(other: VecV): Num<RO>;
  get x(): Num<C>;                       // inherits parent's capability
  get y(): Num<C>;
  get magnitude(): Num<RO>;
}
interface Vec { readonly constructor: typeof Vec }

// ── Box ──────────────────────────────────────────────────────────────
declare class Box<out C extends RO = RO> extends Signal<BoxV, C> {
  static traits: TraitDict<BoxV> & { linear: Linear<BoxV>; lerp: Lerp<BoxV>; equals: Equals<BoxV> };
  get x(): Num<C>;
  get y(): Num<C>;
  get w(): Num<C>;
  get h(): Num<C>;
  get center(): Vec<RO>;                 // `at()` isn't bidirectional yet
  add(b: BoxV): Box<C>;
  expand(n: number): Box<C>;
}
interface Box { readonly constructor: typeof Box }

// ═════════════════════════════════════════════════════════════════════
// PUBLIC TYPE ALIASES
// ═════════════════════════════════════════════════════════════════════

/** Writable form of a typed Signal class. */
type Writable<R> =
  R extends Vec<RO> ? Vec<RW>
  : R extends Num<RO> ? Num<RW>
  : R extends Box<RO> ? Box<RW>
  : R extends Signal<infer T, RO> ? Signal<T, RW>
  : never;

// ═════════════════════════════════════════════════════════════════════
// FACTORIES
// ═════════════════════════════════════════════════════════════════════

declare const signal: <T>(v: T) => Signal<T, RW>;
declare const num: (v?: NumV) => Num<RW>;
declare const vec: (x?: number, y?: number) => Vec<RW>;
declare const box: (x?: number, y?: number, w?: number, h?: number) => Box<RW>;
declare const computed: <T, R extends Signal<T, RO>>(fn: () => T, Cls?: new () => R) => R;

// ═════════════════════════════════════════════════════════════════════
// ANIMATORS — trait constraints + writable target
// ═════════════════════════════════════════════════════════════════════

// spring needs: writable target AND class has linear+metric
declare function spring<T>(
  sig: Signal<T, RW> & Traits<T, "linear" | "metric">,
  target: T,
): void;

// tween needs: writable target AND class has lerp
declare function tween<T>(
  sig: Signal<T, RW> & Traits<T, "lerp">,
  target: T,
  dur: number,
): void;

// attract needs: writable target AND class has linear
declare function attract<T>(
  sig: Signal<T, RW> & Traits<T, "linear">,
  target: T,
  k?: number,
): void;

// ═════════════════════════════════════════════════════════════════════
// COMBINATORS
// ═════════════════════════════════════════════════════════════════════

// mean: all parts writable + has linear → returns writable
declare function mean<R extends Signal<unknown, RW> & Traits<Of<R>, "linear">>(
  ...parts: R[]
): R;

// combine: more general; explicit forward+inverse
declare function combine<T, R extends Signal<T, RW>>(
  parts: readonly R[],
  forward: (vs: T[]) => T,
  backward: (next: T, prev: T[]) => T[],
): R;

// ═════════════════════════════════════════════════════════════════════
// USAGE PATTERNS
// ═════════════════════════════════════════════════════════════════════

// PATTERN A: animators reject non-writable signals
function _animatorChecks() {
  const a = vec();
  const ro = a.normalize();

  spring(a, { x: 0, y: 0 });        // OK
  tween(a, { x: 0, y: 0 }, 1);      // OK
  attract(a, { x: 0, y: 0 });       // OK

  // DEBUG: why doesn't this fail?
  spring(ro, { x: 0, y: 0 });
  tween(ro, { x: 0, y: 0 }, 1);
  attract(ro, { x: 0, y: 0 });

  // Verify the underlying check IS still tight for plain Signal<T, RW>
  const _justWrite: (s: Signal<VecV, RW>) => void = (s) => { s.value = { x: 0, y: 0 }; };
  _justWrite(a);
  // @ts-expect-error — confirm: bare Signal<T, RW> rejects ro
  _justWrite(ro);
}
void _animatorChecks;

// PATTERN B: animators reject types without the required trait
function _traitChecks() {
  const b = box();  // has linear+lerp+equals, NO metric

  tween(b, { x: 0, y: 0, w: 1, h: 1 }, 1);  // OK — Box has lerp
  attract(b, { x: 0, y: 0, w: 1, h: 1 });   // OK — Box has linear

  // @ts-expect-error — Box has no metric trait
  spring(b, { x: 0, y: 0, w: 1, h: 1 });
}
void _traitChecks;

// PATTERN C: mean accepts writable + linear; returns writable
function _meanFlow() {
  const a = vec(); const b = vec(); const c = vec();
  const m = mean(a, b, c);          // Vec<RW>
  m.value = { x: 10, y: 10 };       // OK — writable

  // @ts-expect-error — RO source can't go in
  mean(a.normalize(), b);
}
void _meanFlow;

// PATTERN D: "Anything with a writable .translate" — shape-like
interface ShapeLike {
  readonly translate: Vec<RW>;
  readonly rotate: Num<RW>;
}

declare const shape: () => ShapeLike;

function moveLeft<S extends ShapeLike>(s: S, dx: number): void {
  s.translate.value = { x: s.translate.value.x - dx, y: s.translate.value.y };
  s.rotate.value = 0;
}

function _shapeFlow() {
  const s = shape();
  moveLeft(s, 10);  // OK

  // Read-only shape — would fail at translate.value assignment
  interface ROShape { readonly translate: Vec<RO> }
  const ros: ROShape = { translate: shape().translate.normalize() } as ROShape;
  // @ts-expect-error
  moveLeft(ros, 5);
}
void _shapeFlow;

// PATTERN E: function that takes EITHER RO or RW — generic over C
function describe<C extends RO>(v: Vec<C>): string {
  return `${v.value.x},${v.value.y}`;
}

function _describeFlow() {
  describe(vec());                     // OK — RW
  describe(vec().normalize());         // OK — RO
  describe(vec().add({ x: 1, y: 1 })); // OK — RW (add preserves)
}
void _describeFlow;

// PATTERN F: field lens inherits parent's capability
function _fieldFlow() {
  const a = vec();              // Vec<RW>
  a.x.value = 5;                // OK
  spring(a.x, 10);              // OK — a.x is Num<RW>, Num has linear+metric

  const ro = a.normalize();
  // @ts-expect-error
  ro.x.value = 5;
  // @ts-expect-error
  spring(ro.x, 10);
}
void _fieldFlow;

// PATTERN G: custom user value class with traits
declare class Color<out C extends RO = RO> extends Signal<{ r: number; g: number; b: number; a: number }, C> {
  static traits: { linear: Linear<{ r: number; g: number; b: number; a: number }>; lerp: Lerp<{ r: number; g: number; b: number; a: number }>; equals: Equals<{ r: number; g: number; b: number; a: number }> };
  add(b: { r: number; g: number; b: number; a: number }): Color<C>;
  lerp(b: { r: number; g: number; b: number; a: number }, t: number): Color<RO>;
}
interface Color { readonly constructor: typeof Color }

declare const rgb: (r: number, g: number, b: number) => Color<RW>;

function _customClass() {
  const c = rgb(0.5, 0.5, 0.5);
  tween(c, { r: 1, g: 0, b: 0, a: 1 }, 1);  // OK — Color has lerp
  attract(c, { r: 1, g: 0, b: 0, a: 1 });   // OK — Color has linear
  // @ts-expect-error — Color has no metric
  spring(c, { r: 1, g: 0, b: 0, a: 1 });
}
void _customClass;

// PATTERN H: "accepts anything writable of type T" — generic w/o specific class
function setValue<T>(s: Signal<T, RW>, v: T): void {
  s.value = v;
}
function _setValueFlow() {
  setValue(vec(), { x: 0, y: 0 });
  setValue(num(), 5);
  // @ts-expect-error
  setValue(vec().normalize(), { x: 0, y: 0 });
}
void _setValueFlow;

// PATTERN I: deeply-nested capability — composition
function _composition() {
  const a = vec();              // Vec<RW>
  const b = a.add({ x: 1, y: 1 }).scale(2).offset(5, 0);  // Vec<RW>

  spring(b, { x: 0, y: 0 });   // OK
  describe(b);                  // OK

  const r = a.normalize().add({ x: 1, y: 1 });  // Vec<RO>
  describe(r);                  // OK — read
  // @ts-expect-error
  spring(r, { x: 0, y: 0 });
}
void _composition;
