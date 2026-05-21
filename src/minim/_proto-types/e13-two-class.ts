export {};

// E13 — Two-class hierarchy per value type.
//
// The `this`-type approach (E12) failed: `this` collapses to the
// declared class type, not the receiver's actual intersection type.
// To get true capability propagation through methods we need real
// subclasses where overridden methods narrow their return types.
//
// Cost: each value type declares both classes (Vec + WritableVec,
// Num + WritableNum, Box + WritableBox, etc). Each writable subclass
// overrides invertible methods to return the writable form, and
// overrides field-lens getters to return writable inner types.
//
// Pay-off: TS knows the EXACT runtime truth at every step. Field
// lens capability propagates. Animators can be cleanly typed.

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
// VALUE TYPES — each has two classes
// ═══════════════════════════════════════════════════════════════════

type NumV = number;
type VecV = { x: number; y: number };
type BoxV = { x: number; y: number; w: number; h: number };

// ── Num ─────────────────────────────────────────────────────────────

declare class Num extends Signal<NumV> {
  static traits: Required<TraitDict<NumV>>;
  add(b: NumV): Num;        // RO base — returns RO
  sub(b: NumV): Num;
  scale(k: number): Num;
  clamp(lo: NumV, hi: NumV): Num;
}
interface Num { readonly constructor: typeof Num }

declare class WritableNum extends Num {
  // Override value with both getter and setter (base only had getter)
  override get value(): NumV;
  set value(v: NumV);
  set(v: NumV): unknown;
  bind(s: NumV | (() => NumV)): () => void;
  override add(b: NumV): WritableNum;
  override sub(b: NumV): WritableNum;
  override scale(k: number): WritableNum;
}

// ── Vec ─────────────────────────────────────────────────────────────

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
  derive<W extends boolean>(fn: (c: VecChain<true>) => VecChain<W>): W extends true ? Vec : Vec;
  // ^ On a base Vec (RO), derive always returns Vec (RO). Even invertible
  //   chains can't recover writability if source was RO.
}
interface Vec { readonly constructor: typeof Vec }

declare class WritableVec extends Vec {
  override get value(): VecV;
  set value(v: VecV);
  set(v: VecV): unknown;
  bind(s: VecV | (() => VecV)): () => void;
  override add(b: VecV): WritableVec;
  override sub(b: VecV): WritableVec;
  override scale(k: number): WritableVec;
  override offset(dx: number, dy: number): WritableVec;
  override get x(): WritableNum;
  override get y(): WritableNum;
  override derive<W extends boolean>(fn: (c: VecChain<true>) => VecChain<W>): W extends true ? WritableVec : Vec;
}

declare class VecChain<W extends boolean = true> {
  add(b: VecV): VecChain<W>;
  scale(k: number): VecChain<W>;
  normalize(): VecChain<false>;
}

// ── Box (smaller for brevity) ──────────────────────────────────────

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

declare class WritableBox extends Box {
  override get value(): BoxV;
  set value(v: BoxV);
  set(v: BoxV): unknown;
  bind(s: BoxV | (() => BoxV)): () => void;
  override add(b: BoxV): WritableBox;
  override scale(k: number): WritableBox;
  override expand(n: number): WritableBox;
  override get x(): WritableNum;
  override get y(): WritableNum;
  override get w(): WritableNum;
  override get h(): WritableNum;
}

// ═══════════════════════════════════════════════════════════════════
// PUBLIC TYPE ALIAS
// ═══════════════════════════════════════════════════════════════════

/** Get the writable form of any value class. */
type Writable<R extends Signal<unknown>> =
  R extends WritableVec ? WritableVec
  : R extends Vec ? WritableVec
  : R extends WritableNum ? WritableNum
  : R extends Num ? WritableNum
  : R extends WritableBox ? WritableBox
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
// VERIFICATION
// ═══════════════════════════════════════════════════════════════════

// Eager method capability
function _eagerFlow() {
  const a = vec();                       // WritableVec
  const sum = a.add({ x: 1, y: 1 });     // WritableVec (overridden return)
  const chained = a.add({ x: 1, y: 1 }).scale(2).offset(5, 0);  // WritableVec

  sum.value = { x: 0, y: 0 };            // OK
  chained.value = { x: 0, y: 0 };

  const norm = a.normalize();            // Vec (inherited from base — doesn't return WritableVec)
  // @ts-expect-error
  norm.value = { x: 0, y: 0 };

  // From RO source, invertible methods still return Vec (base method)
  const fromRO = norm.add({ x: 1, y: 1 }); // Vec
  // @ts-expect-error
  fromRO.value = { x: 0, y: 0 };
}
void _eagerFlow;

// ★ THE KILLER TEST — field lens capability ★
function _fieldFlow() {
  const a = vec();                       // WritableVec
  a.x.value = 5;                         // OK — a.x is WritableNum
  spring(a.x, 10);                       // OK

  const ro = a.normalize();              // Vec
  // @ts-expect-error — ro.x is Num (base RO)
  ro.x.value = 5;
  // @ts-expect-error
  spring(ro.x, 10);
}
void _fieldFlow;

// Animator on RO
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

// Chain writability
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

// Buggy fn
function _buggy(v: Vec) {
  // @ts-expect-error
  v.value = { x: 0, y: 0 };
}
void _buggy;

// Generic read-only sig
function describe(v: Vec): string {
  return `${v.value.x},${v.value.y}`;
}
function _describeFlow() {
  describe(vec());              // WritableVec ⊆ Vec (subclass)
  describe(vec().normalize());  // Vec
}
void _describeFlow;

// Shape-like w/ writable field
interface ShapeLike {
  readonly translate: WritableVec;
}
declare const shape: () => ShapeLike;

function moveLeft<S extends ShapeLike>(s: S, dx: number): void {
  s.translate.value = { x: s.translate.value.x - dx, y: s.translate.value.y };
}

interface ROShape { readonly translate: Vec }
declare const ros: ROShape;

function _shapeFlow() {
  moveLeft(shape(), 10);
  // @ts-expect-error — ros.translate is Vec not WritableVec
  moveLeft(ros, 5);
}
void _shapeFlow;

// ★ Deep field — translate.x on a writable shape ★
function _deepField() {
  const s = shape();
  s.translate.value = { x: 0, y: 0 };
  s.translate.x.value = 5;             // OK — translate is WritableVec, .x is WritableNum
  spring(s.translate, { x: 0, y: 0 });
  spring(s.translate.x, 5);
}
void _deepField;

// ═══════════════════════════════════════════════════════════════════
// STRESS — utility patterns from the broader codebase
// ═══════════════════════════════════════════════════════════════════

// "accepts anything with a writable .pos field" — generic over container
function dragHandle<S extends { readonly pos: WritableVec }>(s: S, delta: VecV): void {
  s.pos.value = { x: s.pos.value.x + delta.x, y: s.pos.value.y + delta.y };
}

interface Draggable { pos: WritableVec }
interface ReadOnlyPlaceholder { pos: Vec }

function _dragFlow() {
  const d: Draggable = { pos: vec() };
  dragHandle(d, { x: 5, y: 0 });

  const ro: ReadOnlyPlaceholder = { pos: vec().normalize() };
  // @ts-expect-error
  dragHandle(ro, { x: 5, y: 0 });
}
void _dragFlow;

// "setIfWritable" — write only when capability is present at compile time
function setIfWritable<T>(sig: Signal<T> & Writers<T>, v: T): void {
  sig.set(v);
}

function _setIfWritableFlow() {
  setIfWritable(vec(), { x: 0, y: 0 });
  setIfWritable(num(), 5);
  // @ts-expect-error
  setIfWritable(vec().normalize(), { x: 0, y: 0 });
}
void _setIfWritableFlow;

// "binding" — connect two signals where SOURCE must be writable
function bindOneWay<T>(target: Signal<T> & Writers<T>, source: Signal<T>): () => void {
  return target.bind(() => source.value);
}

function _bindFlow() {
  bindOneWay(vec(), vec().normalize());
  // @ts-expect-error
  bindOneWay(vec().normalize(), vec());
}
void _bindFlow;

// Object of multiple writable fields
interface Frame {
  position: WritableVec;
  rotation: WritableNum;
  bounds: WritableBox;
}
declare const frame: () => Frame;

function _frameFlow() {
  const f = frame();
  f.position.value = { x: 0, y: 0 };
  f.position.x.value = 10;             // field of field
  f.rotation.value = 0;
  f.bounds.value = { x: 0, y: 0, w: 100, h: 100 };
  f.bounds.w.value = 200;              // field of field

  spring(f.position, { x: 50, y: 50 });
  tween(f.rotation, Math.PI, 0.5);
  // Box has lerp but not metric — must use tween, not spring
  tween(f.bounds, { x: 0, y: 0, w: 100, h: 100 }, 0.5);
  // @ts-expect-error — Box lacks metric, so spring rejects
  spring(f.bounds, { x: 0, y: 0, w: 100, h: 100 });
}
void _frameFlow;

// Type predicates / refinement
function isWritable<T>(s: Signal<T>): s is Signal<T> & Writers<T> {
  return "set" in s && typeof (s as Record<string, unknown>).set === "function";
}

function _refinementFlow(vs: Vec[]): void {
  for (const v of vs) {
    if (isWritable(v)) {
      v.value = { x: 0, y: 0 };  // OK — narrowed to writable
    }
    // @ts-expect-error — outside the guard, plain Vec
    v.value = { x: 0, y: 0 };
  }
}
void _refinementFlow;

// Variadic combinators — mean of writable Vecs is writable
declare function mean<R extends Vec | WritableVec>(
  ...parts: R[]
): R extends WritableVec ? WritableVec : Vec;

function _meanFlow() {
  const a = vec();
  const b = vec();
  const c = vec();
  const m = mean(a, b, c);        // WritableVec
  m.value = { x: 0, y: 0 };       // OK

  const ro = a.normalize();
  const ro2 = mean(ro, b.normalize());  // Vec
  // @ts-expect-error
  ro2.value = { x: 0, y: 0 };
}
void _meanFlow;

// Higher-order — function that wraps a writable signal
function delayedSet<T>(sig: Signal<T> & Writers<T>, v: T, ms: number): () => void {
  const id = setTimeout(() => sig.set(v), ms);
  return () => clearTimeout(id);
}

function _delayFlow() {
  delayedSet(vec(), { x: 1, y: 1 }, 1000);
  // @ts-expect-error
  delayedSet(vec().normalize(), { x: 1, y: 1 }, 1000);
}
void _delayFlow;

// ─── Author-facing aliases (sugar) ────────────────────────────────
// Verify the public Writable<R> alias works the same as direct subclass names

function _aliasFlow() {
  const a = vec();                     // WritableVec
  const b: Writable<Vec> = a;          // assignable via alias

  function takesWritable(_w: Writable<Vec>): void {}
  takesWritable(a);
  // @ts-expect-error
  takesWritable(a.normalize());
}
void _aliasFlow;
