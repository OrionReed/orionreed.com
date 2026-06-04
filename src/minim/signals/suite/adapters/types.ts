// Framework-agnostic reactive adapter surface.
//
// The suite is written against these interfaces, never against minim
// directly, so the same laws/benches run on any implementation. Two
// tiers, expressed by the type hierarchy (no runtime capability flags):
//
//   ForwardReactive  — the universal forward core every signals library
//                      has (signal / computed / effect / batch /
//                      untracked). This is RFTS's surface, restated.
//   Reactive         — adds bidirectional views: a 1→1 lens and an N→M
//                      lens. A library that only does forward implements
//                      `ForwardReactive`; a bireactive one implements
//                      `Reactive`. Forward benches accept the former,
//                      bireactive laws the latter.
//
// Reads/writes are methods (`read()` / `write()`) rather than property
// accessors so the surface is portable across libraries that model
// signals as functions, objects, or accessor pairs.

/** Read-only reactive value. */
export interface Readable<T> {
  read(): T;
}

/** Read-write reactive value (a source or a write-through view). */
export interface Source<T> extends Readable<T> {
  write(v: T): void;
}

/** A write-through view. Identical surface to `Source`; the distinct
 *  name documents intent at construction sites and lets a chain feed a
 *  view back into another lens. */
export type View<T> = Source<T>;

export interface ForwardReactive {
  readonly name: string;
  signal<T>(initial: T): Source<T>;
  computed<T>(fn: () => T): Readable<T>;
  effect(fn: () => void | (() => void)): () => void;
  batch(fn: () => void): void;
  untracked<T>(fn: () => T): T;
}

/** Per-source backward update; `undefined` leaves a source untouched. */
export type Update<T> = T | undefined;

export interface Reactive extends ForwardReactive {
  /** 1→1 write-through: `fwd` maps source→view, `bwd` maps a view write
   *  back to the new source value (given the current source). */
  lens<S, V>(source: Source<S>, fwd: (s: S) => V, bwd: (v: V, s: S) => S): View<V>;

  /** N→M write-through: `fwd` folds N parents into the view, `bwd`
   *  distributes a view write across them (per-parent `undefined` skips). */
  lensN<V>(
    sources: readonly Source<unknown>[],
    fwd: (vals: readonly unknown[]) => V,
    bwd: (v: V, vals: readonly unknown[]) => readonly Update<unknown>[],
  ): View<V>;
}
