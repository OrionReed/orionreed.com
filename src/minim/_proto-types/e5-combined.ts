export {};

// E5 — Variance machinery + RO-default naming.
//
// Combines:
//   - E4's `W extends boolean` phantom param for type-tracked writability
//     through chain composition.
//   - E3's defaults: bare type is RO, opt-in `Writable<R>` adds write
//     capability. Factory returns `Writable<R>` explicitly.
//
// The user's local-reasoning argument: with RO default, lazy code is
// safe code. A function that writes to its param trips TS in its own
// body; you widen LOCALLY (in that one function) without bothering
// callers. With writable default, the inverse: callers trip when they
// pass an RO source to a function not declared correctly, forcing a
// non-local fix in the original function's signature.

// ─── Engine surface ─────────────────────────────────────────────────

// Default W = false (RO). Writable signals use `W = true`, exposed
// via the `Writable<R>` alias below.
declare class Signal<T, W extends boolean = false> {
  get value(): T;
  set value(v: W extends true ? T : never);
  peek(): T;
  set(v: W extends true ? T : never): this;
  bind(source: (W extends true ? T : never) | (() => (W extends true ? T : never))): () => void;
}

/** Add write capability to a signal type. Same runtime; type just
 *  flips W → true so setters resolve to T (not never). */
type Writable<R> = R extends Signal<infer T, boolean>
  ? R extends Vec<boolean> ? Vec<true>
  : R extends Num<boolean> ? Num<true>
  : Signal<T, true>
  : never;

type Of<R> = R extends Signal<infer T, boolean> ? T : never;

// ─── Value classes ─────────────────────────────────────────────────

type V = { x: number; y: number };

declare class Vec<W extends boolean = false> extends Signal<V, W> {
  // Invertible — preserves W
  add(b: V): Vec<W>;
  sub(b: V): Vec<W>;
  scale(k: number): Vec<W>;
  // Non-invertible — narrows to false (no-op if already false)
  normalize(): Vec<false>;
  // Field lenses — inherit parent's writability
  get x(): Num<W>;
  get y(): Num<W>;
  // Chain
  derive<W2 extends boolean>(fn: (c: VecChain<true>) => VecChain<W2>): Vec<W extends true ? W2 : false>;
}

declare class Num<W extends boolean = false> extends Signal<number, W> {
  add(b: number): Num<W>;
}

declare class VecChain<W extends boolean = true> {
  add(b: V): VecChain<W>;
  scale(k: number): VecChain<W>;
  normalize(): VecChain<false>;
}

// Factories — return writable form (matches user expectation that
// freshly-created state is writable)
declare const signal: <T>(v: T) => Signal<T, true>;
declare const vec: (x?: number, y?: number) => Writable<Vec>;
declare const num: (v?: number) => Writable<Num>;
// Computed — returns RO by default
declare const computed: <R extends Signal<unknown>>(fn: () => Of<R>, Cls?: new () => R) => R;

// ─── Consumer patterns (the test) ──────────────────────────────────

// PATTERN 1: read-only function — bare `Vec` works, no alias needed
function describe(v: Vec): string {
  return `(${v.value.x}, ${v.value.y})`;
}

// PATTERN 2: write-needed — explicit `Writable<Vec>`
function moveTo(v: Writable<Vec>, target: V): void {
  v.value = target;     // OK — Writable<Vec> = Vec<true>
}

// PATTERN 3: a buggy fn that wrote to its param without declaring
function _buggy(v: Vec) {
  // @ts-expect-error — TS catches this LOCALLY, not at any call site
  v.value = { x: 0, y: 0 };
  // @ts-expect-error — same
  v.set({ x: 0, y: 0 });
}
void _buggy;

// PATTERN 4: usage — both writable and RO Vecs flow through `Vec` params
function _usage() {
  const a = vec(1, 2);                  // Writable<Vec> = Vec<true>
  const sum = a.add({ x: 1, y: 1 });    // Vec<true> — `add` preserves W
  const norm = a.normalize();           // Vec<false>

  // describe accepts both — Vec<true> assignable to Vec<false>
  describe(a); describe(sum); describe(norm);  // all OK

  // moveTo accepts only writable
  moveTo(a, { x: 0, y: 0 });            // OK
  moveTo(sum, { x: 0, y: 0 });          // OK
  // @ts-expect-error — Vec<false> can't satisfy Writable<Vec> = Vec<true>
  moveTo(norm, { x: 0, y: 0 });
}
void _usage;

// PATTERN 5: chain writability flow
function _chainFlow() {
  const a = vec(1, 2);                                          // Vec<true>

  const c1 = a.derive((c) => c.add({ x: 1, y: 1 }));            // Vec<true>
  const c2 = a.derive((c) => c.normalize());                    // Vec<false>
  const c3 = a.derive((c) => c.add({ x: 1, y: 1 }).normalize()); // Vec<false>

  moveTo(c1, { x: 0, y: 0 });  // OK
  // @ts-expect-error
  moveTo(c2, { x: 0, y: 0 });
  // @ts-expect-error
  moveTo(c3, { x: 0, y: 0 });

  // From a non-invertible source, all chains are RO
  const ro = a.normalize();
  const c4 = ro.derive((c) => c.add({ x: 1, y: 1 }));  // Vec<false>
  // @ts-expect-error
  moveTo(c4, { x: 0, y: 0 });
}
void _chainFlow;

// PATTERN 6: field lenses inherit W (correctness propagates through .x)
function _fieldFlow() {
  const a = vec(0, 0);  // Writable<Vec> = Vec<true>
  a.x.value = 5;        // OK — a.x is Num<true>

  const ro = a.normalize();  // Vec<false>
  // @ts-expect-error — ro.x is Num<false>; setter is never
  ro.x.value = 5;
}
void _fieldFlow;

// ─── How this reads in practice ──────────────────────────────────────
//
// Default signatures take `Vec` (RO):
//
//   function distance(a: Vec, b: Vec): Num<false>
//   function midpoint(a: Vec, b: Vec): Vec<false>
//   function describe(v: Vec): string
//
// Functions that genuinely write use `Writable<Vec>`:
//
//   function moveTo(v: Writable<Vec>, target: V): void
//   function bindToPath(handle: Writable<Vec>, path: Path): () => void
//
// Factories return `Writable<R>`:
//
//   const a = vec(0, 0)          // Writable<Vec>
//   const t = signal(0)          // Signal<number, true>
//   const c = computed(() => …)  // Computed — read-only by default
//
// The mental model: **a Vec is a value you can read. A Writable<Vec>
// is the strictly more-capable version that you can also write to.**
//
// LOCAL FAILURE MODE: declare `(v: Vec)`, write to v inside the body,
// TS yells at the body. Fix: widen to `(v: Writable<Vec>)`. One file.
//
// NO non-local cascade: if someone passes a Writable<Vec> to a
// function declared `(v: Vec)`, that's fine (writable IS-A read-only,
// you're under-using the capability). If someone passes a Vec to a
// `Writable<Vec>` param, the error is at the call site and the fix
// belongs there too (the caller has the RO value; they should NOT
// silently get write access to something derived from a non-invertible
// op).
