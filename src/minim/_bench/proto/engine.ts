// ── Engine — common surface over preact + alien reactivity ─────────
//
// A reactivity engine exposes 6 primitives:
//
//   signal(v, opts?)   → a writable reference
//   computed(fn)       → a read-only derived reference (lazy + cached)
//   effect(fn)         → register a side-effect; returns a disposer
//   batch(fn)          → coalesce notifications until fn returns
//   read(ref)          → tracked read
//   write(ref, v)      → write (no-op on computed refs)
//   peek(ref)          → untracked read
//
// "Reference" is an opaque handle whose concrete shape depends on the
// engine (preact: a Signal class instance; alien: a bound function).
// The unified Cell layer goes through this surface, so swapping
// engines is a 3-line change.

/** Opaque reference produced by an engine. Treat as transparent only
 *  inside the engine module itself. */
export type Ref<T> = {
  /** Engine-private. Don't read in user code. */
  readonly __r: unknown;
  /** Type-only phantom — never set at runtime. */
  readonly __t?: T;
};

export interface Engine {
  readonly name: string;
  signal<T>(initial: T, opts?: { equals?: (a: T, b: T) => boolean }): Ref<T>;
  computed<T>(fn: () => T): Ref<T>;
  /** Writable lens: read via `r`, write via `w`. The write callback is
   *  responsible for any propagation back to the source signal it
   *  derives from. */
  lens<T>(r: () => T, w: (v: T) => void): Ref<T>;
  effect(fn: () => void | (() => void)): () => void;
  batch<T>(fn: () => T): T;
  read<T>(ref: Ref<T>): T;
  write<T>(ref: Ref<T>, v: T): void;
  peek<T>(ref: Ref<T>): T;
  /** Detect if a ref is writable (signal/lens) vs read-only (computed). */
  isWritable<T>(ref: Ref<T>): boolean;
}
