export {};  // make this an isolated module so its declarations don't leak

// E4 — Variance via a phantom `W extends boolean` parameter on Signal.
//
// `Signal<T, W extends boolean = true>` carries writability as a
// type-level tag. `W = true` (default) is writable. `W = false` is
// read-only — the `.value` setter resolves to `never` (rejects all
// inputs at TS), `.set` and `.bind` likewise.
//
// The big win over E2/E3: writability flows through chain composition
// automatically. A chain method that's invertible preserves W; one
// that's non-invertible narrows W to false. The result type of
// `vec.derive(c => …)` reflects the chain's accumulated writability.

// ─── Engine surface ─────────────────────────────────────────────────

declare class Signal<T, W extends boolean = true> {
  get value(): T;
  set value(v: W extends true ? T : never);
  peek(): T;
  set(v: W extends true ? T : never): this;
  bind(source: (W extends true ? T : never) | (() => (W extends true ? T : never))): () => void;
}

type Of<R> = R extends Signal<infer T, boolean> ? T : never;
type WritableOf<R> = R extends Signal<infer _T, infer W> ? W : never;

// ─── Value class (Vec) ─────────────────────────────────────────────

type V = { x: number; y: number };

declare class Vec<W extends boolean = true> extends Signal<V, W> {
  // Invertible — preserves W
  add(b: V): Vec<W>;
  sub(b: V): Vec<W>;
  scale(k: number): Vec<W>;
  // Non-invertible — narrows to false
  normalize(): Vec<false>;
  perp(): Vec<false>;
  // Field lenses inherit parent's W
  get x(): Signal<number, W>;
  get y(): Signal<number, W>;
  // Chain entry — propagates W through
  derive<W2 extends boolean>(fn: (c: VecChain<true>) => VecChain<W2>): Vec<W extends true ? W2 : false>;
}

declare class VecChain<W extends boolean = true> {
  add(b: V): VecChain<W>;
  sub(b: V): VecChain<W>;
  scale(k: number): VecChain<W>;
  normalize(): VecChain<false>;
  perp(): VecChain<false>;
  lerp(b: V, t: number): VecChain<false>;  // multi-inverse → not invertible
}

declare const vec: (x?: number, y?: number) => Vec;  // Vec = Vec<true>

// ─── Consumer patterns ─────────────────────────────────────────────

// Pattern 1: read-only — generic over W to accept either
function describe<W extends boolean>(v: Vec<W>): string {
  return `(${v.value.x}, ${v.value.y})`;
}

// Pattern 2: write-needed — default W=true
function moveTo(v: Vec, target: V): void {
  v.value = target;
}

// Pattern 3: usage with chains
function _consumerUsage() {
  const a = vec(1, 2);             // Vec (= Vec<true>)
  const sum = a.add({ x: 1, y: 1 }); // Vec<true>  — preserved
  const norm = a.normalize();      // Vec<false>

  // Chain examples — writability propagates
  const c1 = a.derive((c) => c.add({ x: 1, y: 1 }));        // Vec<true>
  const c2 = a.derive((c) => c.normalize());                 // Vec<false>
  const c3 = a.derive((c) => c.add({ x: 1, y: 1 }).normalize()); // Vec<false>
  const c4 = a.derive((c) => c.normalize().add({ x: 1, y: 1 })); // Vec<false>
  // ^ order doesn't matter; any non-invertible step poisons writability

  // Chained from a non-invertible source
  const c5 = norm.derive((c) => c.add({ x: 1, y: 1 }));      // Vec<false>
  // ^ source was Vec<false>, so even an all-invertible chain stays false

  describe(a);     // OK
  describe(sum);   // OK
  describe(norm);  // OK — W inferred as false
  describe(c1); describe(c2); describe(c3); describe(c4); describe(c5);

  moveTo(a, { x: 0, y: 0 });    // OK
  moveTo(sum, { x: 0, y: 0 });  // OK
  // @ts-expect-error — Vec<false> can't be passed where Vec<true> is needed
  moveTo(norm, { x: 0, y: 0 });
  // @ts-expect-error
  moveTo(c2, { x: 0, y: 0 });
  // @ts-expect-error
  moveTo(c5, { x: 0, y: 0 });
}
void _consumerUsage;

// Pattern 4: writes-through-chain are blocked at TS level
function _writabilityCheck() {
  const a = vec(0, 0);
  const noLonger = a.derive((c) => c.normalize());

  // @ts-expect-error — derived type is Vec<false>; .value setter is never
  noLonger.value = { x: 1, y: 1 };
}
void _writabilityCheck;

// Pattern 5: nested generic flow
function withDoubled<W extends boolean>(v: Vec<W>): Vec<W> {
  return v.add({ x: 1, y: 1 }).scale(2);  // both invertible; preserves W
}
function _genericFlow() {
  const a = vec(0, 0);             // Vec<true>
  const a2 = withDoubled(a);       // Vec<true>  — W preserved
  const r = a.normalize();         // Vec<false>
  const r2 = withDoubled(r);       // Vec<false> — W preserved
  // @ts-expect-error
  r2.value = { x: 0, y: 0 };
}
void _genericFlow;

// ─── Pros & cons ──────────────────────────────────────────────────
//
// PROS:
//  - **Writability flows through composition automatically.** This is
//    the only encoding where `vec.derive(c => c.add(b).normalize())`
//    type-correctly returns `Vec<false>` without manual annotation.
//  - Single value-class declaration; W is metadata.
//  - Consumer reading the type sees `Vec` for writable, `Vec<false>`
//    for RO, `Vec<W>` or `Vec<boolean>` for either.
//  - One mechanism scales to all value classes uniformly.
//
// CONS:
//  - **`set value(v: W extends true ? T : never)` is unusual.** TS
//    permits this; we should verify it actually rejects writes when
//    W=false at the type level (POC needed).
//  - Consumer signatures wanting to accept both forms need a generic
//    `<W extends boolean>(v: Vec<W>)`. Slightly heavier.
//  - Subclassing a value class with the W param propagated through
//    every method is verbose: `add(b): Vec<W>` not just `add(b): Vec`.
//  - IDE hover shows `Vec<true>` / `Vec<false>` rather than `Vec` /
//    `Readonly<Vec>`. Less readable at a glance unless you hide it.
//
// VERDICT: the only encoding that handles chain-writability-flow
// correctly. The chain story IS the hard problem here; E4 solves it
// directly. The eager-method case is slightly heavier than E2 but
// nothing dramatic.

// ─── Open verification ────────────────────────────────────────────
//
// The crucial thing to test on a real TS engine: does
//   set value(v: W extends true ? T : never)
// actually reject writes when W is concretely false? TS's setter typing
// has historically been inconsistent. If it doesn't reject (i.e. TS
// silently accepts the never-typed input), this whole approach has a
// hole that runtime can't catch.
//
// Run `npx tsc --noEmit` on this file to verify all `@ts-expect-error`
// markers fire (i.e. each line that SHOULD be an error actually is).
