export {};  // make this an isolated module so its declarations don't leak

// E2 — Writable by default; opt-in `Readonly<R>` narrowing.
//
// Pattern: the typed class (`Vec`) is fully writable. A type alias
// `Readonly<R>` produces a narrowed view that Omits the setter, .set,
// .bind. Non-invertible methods return `Readonly<R>`; invertible ones
// return the typed class.
//
// Consumer convention: parameter types use `Readonly<Vec>` when they
// only read; `Vec` when they need to write.
//
// This is the encoding we had as `RO<R>` in the production rollout
// but didn't fully adopt at consumer sites. Here we follow it through
// to see what consumer code looks like.

// ─── Engine surface (sketch) ────────────────────────────────────────

declare class Signal<T> {
  value: T;
  peek(): T;
  set(v: T): this;
  bind(source: T | (() => T)): () => void;
}

type Of<R> = R extends Signal<infer T> ? T : never;

/** Read-only narrowing of a typed Signal subclass. Omits write surface
 *  and re-declares `.value` as readonly. */
type Readonly_<R> = Omit<R, "value" | "set" | "bind"> & { readonly value: Of<R> };

// ─── Value class (Vec) ─────────────────────────────────────────────

type V = { x: number; y: number };

declare class Vec extends Signal<V> {
  // Invertible — return Vec (writable)
  add(b: V): Vec;
  sub(b: V): Vec;
  scale(k: number): Vec;
  // Non-invertible — return Readonly<Vec>
  normalize(): Readonly_<Vec>;
  perp(): Readonly_<Vec>;
  // Lazy field lenses
  get x(): Signal<number>;
  get y(): Signal<number>;
}
declare const vec: (x?: number, y?: number) => Vec;

// ─── Consumer patterns ─────────────────────────────────────────────

// Pattern 1: function that only READS
//   Consumer convention: use Readonly<Vec>
function describe(v: Readonly_<Vec>): string {
  return `(${v.value.x}, ${v.value.y})`;
}

// Pattern 2: function that needs to WRITE
function moveTo(v: Vec, target: V): void {
  v.value = target;
}

// Pattern 3: passes both writable and read-only results
function _consumerUsage() {
  const a = vec(1, 2);          // Vec (writable)
  const sum = a.add({ x: 1, y: 1 }); // Vec — add is invertible
  const norm = a.normalize();   // Readonly<Vec>

  describe(a);     // OK — Vec assignable to Readonly<Vec>?
  describe(sum);   // OK
  describe(norm);  // OK

  moveTo(a, { x: 0, y: 0 });    // OK
  moveTo(sum, { x: 0, y: 0 });  // OK — sum is Vec (writable lens)
  // @ts-expect-error — Readonly<Vec> can't be passed where Vec is expected
  moveTo(norm, { x: 0, y: 0 });
}
void _consumerUsage;

// Pattern 4: generic helper that doesn't care about writability
function dist<R extends Readonly_<Vec>>(a: R, b: R): number {
  return Math.hypot(a.value.x - b.value.x, a.value.y - b.value.y);
}
function _genericUsage() {
  const a = vec(0, 0);
  const b = vec(1, 1);
  const _r = dist(a, b);  // both Vec; R inferred as Vec
  const c = a.normalize();
  const _r2 = dist(c, c); // both Readonly<Vec>; R inferred as Readonly<Vec>
}
void _genericUsage;

// ─── Pros & cons ──────────────────────────────────────────────────
//
// PROS:
//  - Authors declare per-method: `add(): Vec` or `normalize(): Readonly<Vec>`. Simple.
//  - Vec stays the "default" / common type — most consumer code keeps
//    typing as `Vec` until they want to narrow.
//  - `Readonly<Vec>` reads naturally at consumer sites.
//  - Subtype direction is intuitive: writable ⊆ read-only (writable IS-A read-only).
//
// CONS:
//  - **Subtype direction may surprise:** a function asking for
//    `Readonly<Vec>` accepts a `Vec`. That's TS structural typing
//    doing the right thing, but it means an author writing
//    `describe(v: Readonly<Vec>)` can be called with a writable Vec
//    and accidentally not realize they have write access.
//  - **Cascade for "only read" consumer code is one-way.** Old code
//    typed `(v: Vec)` for read-only contexts; rewriting to `Readonly<Vec>`
//    is the correct change but the codebase has ~30 sites.
//  - Name `Readonly` shadows TS global. Workarounds: rename to `View`,
//    `RO`, etc. — see e3 for an alternative naming.
//
// VERDICT: simple and works well for eager-method return types.
// Doesn't, on its own, propagate writability through chain composition
// — for that, see E4. Likely the right shape for the eager surface
// IF combined with E4 for the chain machinery.
