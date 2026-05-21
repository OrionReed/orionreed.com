export {};

// E6 — Branded capability type instead of boolean W.
//
// The boolean variant of E4/E5 hit the variance ceiling: TS treats
// `Vec<true>` and `Vec<false>` as invariant in W (neither assignable
// to the other), which breaks the "writable IS-A read-only" relation
// we want. Boolean's `true` and `false` aren't structurally related
// as types — they're disjoint literals.
//
// Fix: use branded types where `RW` EXTENDS `RO` structurally. Then
// `Vec<RW>` is a structural subtype of `Vec<RO>` via the standard
// TS subtyping rules.

// ─── Capability brands ──────────────────────────────────────────────

// REQUIRED brand fields (not optional) so TS structurally enforces
// the RW vs RO distinction. RW has both __ro and __rw; RO has only
// __ro. So `Cap extends RW` is true only for RW; false (= never) for
// RO. And Vec<RW> structurally satisfies Vec<RO>'s constraints, so
// writable IS-A read-only naturally.
//
// Runtime never sets these fields — purely type-level brands.

declare const __ROBrand: unique symbol;
declare const __RWBrand: unique symbol;
interface RO { readonly [__ROBrand]: true }
interface RW extends RO { readonly [__RWBrand]: true }
type Cap = RO;

// ─── Engine surface ─────────────────────────────────────────────────

declare class Signal<T, C extends Cap = RO> {
  get value(): T;
  // Setter resolves to `never` (rejects writes) unless C extends RW.
  set value(v: C extends RW ? T : never);
  peek(): T;
  set(v: C extends RW ? T : never): this;
  bind(source: (C extends RW ? T : never) | (() => (C extends RW ? T : never))): () => void;
}

type Of<R> = R extends Signal<infer T, Cap> ? T : never;
type Writable<R extends Signal<unknown, Cap>> =
  R extends Vec<Cap> ? Vec<RW>
  : R extends Num<Cap> ? Num<RW>
  : R extends Signal<infer T, Cap> ? Signal<T, RW>
  : never;

// ─── Value classes ─────────────────────────────────────────────────

type V = { x: number; y: number };

declare class Vec<C extends Cap = RO> extends Signal<V, C> {
  add(b: V): Vec<C>;
  sub(b: V): Vec<C>;
  scale(k: number): Vec<C>;
  normalize(): Vec<RO>;     // narrows to RO
  get x(): Num<C>;
  get y(): Num<C>;
  derive<C2 extends Cap>(fn: (c: VecChain<RW>) => VecChain<C2>): Vec<C extends RW ? C2 : RO>;
}

declare class Num<C extends Cap = RO> extends Signal<number, C> {
  add(b: number): Num<C>;
}

declare class VecChain<C extends Cap = RW> {
  add(b: V): VecChain<C>;
  scale(k: number): VecChain<C>;
  normalize(): VecChain<RO>;
}

// ─── Factories ─────────────────────────────────────────────────────

declare const signal: <T>(v: T) => Signal<T, RW>;
declare const vec: (x?: number, y?: number) => Writable<Vec>;
declare const num: (v?: number) => Writable<Num>;
declare const computed: <T, R extends Signal<T, RO> = Signal<T, RO>>(fn: () => T, Cls?: new () => R) => R;

// ─── Consumer patterns ─────────────────────────────────────────────

// PATTERN 1: bare Vec accepts both writable and RO
function describe(v: Vec): string {
  return `(${v.value.x}, ${v.value.y})`;
}

// PATTERN 2: Writable<Vec> for writes
function moveTo(v: Writable<Vec>, target: V): void {
  v.value = target;
}

// PATTERN 3: buggy fn — TS catches LOCALLY
function _buggy(v: Vec) {
  // @ts-expect-error
  v.value = { x: 0, y: 0 };
  // @ts-expect-error
  v.set({ x: 0, y: 0 });
}
void _buggy;

// PATTERN 4: usage
function _usage() {
  const a = vec(1, 2);                  // Writable<Vec> = Vec<RW>
  const sum = a.add({ x: 1, y: 1 });    // Vec<RW>
  const norm = a.normalize();           // Vec<RO>

  describe(a); describe(sum); describe(norm);  // all OK

  moveTo(a, { x: 0, y: 0 });
  moveTo(sum, { x: 0, y: 0 });
  // @ts-expect-error
  moveTo(norm, { x: 0, y: 0 });
}
void _usage;

// PATTERN 5: chain writability propagation
function _chainFlow() {
  const a = vec(1, 2);                                          // Vec<RW>

  const c1 = a.derive((c) => c.add({ x: 1, y: 1 }));            // Vec<RW>
  const c2 = a.derive((c) => c.normalize());                    // Vec<RO>
  const c3 = a.derive((c) => c.add({ x: 1, y: 1 }).normalize()); // Vec<RO>

  moveTo(c1, { x: 0, y: 0 });
  // @ts-expect-error
  moveTo(c2, { x: 0, y: 0 });
  // @ts-expect-error
  moveTo(c3, { x: 0, y: 0 });

  // From an RO source, all chains are RO
  const ro = a.normalize();
  const c4 = ro.derive((c) => c.add({ x: 1, y: 1 }));  // Vec<RO>
  // @ts-expect-error
  moveTo(c4, { x: 0, y: 0 });
}
void _chainFlow;

// PATTERN 6: field lenses inherit capability
function _fieldFlow() {
  const a = vec(0, 0);
  a.x.value = 5;             // OK

  const ro = a.normalize();
  // @ts-expect-error
  ro.x.value = 5;
}
void _fieldFlow;

// PATTERN 7: generic helper — accepts both via default Vec
function distance(a: Vec, b: Vec): number {
  return Math.hypot(a.value.x - b.value.x, a.value.y - b.value.y);
}
function _generic() {
  const w = vec(0, 0);  const r = vec(1, 1).normalize();
  distance(w, r);  // OK — both flow through Vec
}
void _generic;
