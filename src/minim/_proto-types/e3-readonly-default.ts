export {};  // make this an isolated module so its declarations don't leak

// E3 — Read-only by default; opt-in `Writable<R>` adds setter surface.
//
// Inverts the polarity of E2. The bare typed class (`Vec`) is the
// READ-only interface — it has all the methods you'd expect except the
// `value` setter, `.set()`, and `.bind()`. `Writable<Vec>` is an
// intersection that adds those back.
//
// Symmetric to E2 in terms of structural typing, but with opposite
// defaults.

// ─── Engine surface ─────────────────────────────────────────────────

// Read-only base — the structural shape every Signal has.
declare class Signal<T> {
  readonly value: T;       // no setter declared on the base
  peek(): T;
}

// Writable extension — added back via intersection at sites that need it.
type Writable<R extends Signal<unknown>> = R & {
  value: R extends Signal<infer T> ? T : never;
  set(v: R extends Signal<infer T> ? T : never): R;
  bind(source: (R extends Signal<infer T> ? T : never) | (() => (R extends Signal<infer T> ? T : never))): () => void;
};

type Of<R> = R extends Signal<infer T> ? T : never;

// ─── Value class (Vec) ─────────────────────────────────────────────

type V = { x: number; y: number };

declare class Vec extends Signal<V> {
  // Invertible methods return Writable<Vec> (caller can write through)
  add(b: V): Writable<Vec>;
  sub(b: V): Writable<Vec>;
  scale(k: number): Writable<Vec>;
  // Non-invertible methods return Vec (the read-only base)
  normalize(): Vec;
  perp(): Vec;
  // Field lenses are writable (invertible)
  get x(): Writable<Signal<number>>;
  get y(): Writable<Signal<number>>;
}
// `vec()` factory returns the writable form
declare const vec: (x?: number, y?: number) => Writable<Vec>;

// ─── Consumer patterns ─────────────────────────────────────────────

// Pattern 1: read-only function — default Vec
function describe(v: Vec): string {
  return `(${v.value.x}, ${v.value.y})`;
}

// Pattern 2: write-needed function — Writable<Vec>
function moveTo(v: Writable<Vec>, target: V): void {
  v.value = target;
}

// Pattern 3: passes
function _consumerUsage() {
  const a = vec(1, 2);             // Writable<Vec>
  const sum = a.add({ x: 1, y: 1 }); // Writable<Vec>
  const norm = a.normalize();      // Vec

  describe(a);     // OK — Writable<Vec> extends Vec
  describe(sum);   // OK
  describe(norm);  // OK

  moveTo(a, { x: 0, y: 0 });    // OK
  moveTo(sum, { x: 0, y: 0 });  // OK
  // @ts-expect-error — Vec (read-only) can't be passed where Writable<Vec> is required
  moveTo(norm, { x: 0, y: 0 });
}
void _consumerUsage;

// Pattern 4: generic — default Vec accepts both
function dist<R extends Vec>(a: R, b: R): number {
  return Math.hypot(a.value.x - b.value.x, a.value.y - b.value.y);
}
function _genericUsage() {
  const a = vec(0, 0);   // Writable<Vec>
  const b = vec(1, 1);
  const _r = dist(a, b); // works; R inferred as Writable<Vec>
}
void _genericUsage;

// ─── Pros & cons ──────────────────────────────────────────────────
//
// PROS:
//  - Consumer signature for read-only is just `Vec`. No alias needed
//    in the common case. "Default = safe / minimal capability."
//  - `Writable<Vec>` reads as an explicit declaration of intent
//    ("I'm going to write to this"). Self-documenting.
//  - Method authors marking a method writable do `Writable<Vec>`;
//    marking it read-only just returns `Vec`. The "less special" case
//    is the simpler return type.
//
// CONS:
//  - **`vec(0,0)` factory return type is `Writable<Vec>`, which is
//    longer than just `Vec`.** Inverts the asymmetry: the common case
//    (creating a writable signal) has the noisy type.
//  - Internal class hierarchy is weird: `Vec` extends `Signal<V>` but
//    `Signal<V>` doesn't have a `value` setter in the base. So calling
//    `new Vec()` produces a `Vec` (read-only)?! No — runtime always
//    has a setter; the type just doesn't expose it. Constructors return
//    `Writable<Vec>` explicitly to expose the setter at the type level.
//    This split between "runtime class" and "type-system class" is
//    confusing.
//  - Subclass authoring: every value class declares the writable
//    surface itself, OR the base does and subclasses inherit. The
//    intersection-based `Writable<R>` doesn't compose nicely if R has
//    overridden methods (intersection means duplicate-method-name
//    resolution may go wonky).
//  - **`Writable<R extends Signal<unknown>>` constraint trips on
//    Signal's invariance.** `Vec extends Signal<V>` is fine; calling
//    `Writable<Vec>` infers correctly. But for primitive types
//    (`Signal<number>` where T is invariant), variance issues bite.
//
// VERDICT: cleaner consumer surface (`describe(v: Vec)` no alias),
// noisier factory/lens surface (`Writable<Vec>` everywhere). Trade-off
// reasonable. The intersection-based Writable can hit subtle TS edge
// cases with method overrides that need testing.
