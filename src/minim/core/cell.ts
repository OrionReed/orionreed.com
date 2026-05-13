// `cell` — the unified user-facing reactive primitive.
//
//   cell(v)                — writable cell
//   cell.derived(fn)       — read-only cell
//   cell.lens(read, write) — writable lens cell
//
// `cell` IS the underlying `signal` factory at runtime (via Object.assign);
// `cell.derived` IS `computed`; `cell.lens` IS `lens`. Zero indirection,
// zero perf penalty. The vendored preact factories stay internal.

import {
  signal,
  computed,
  lens,
  type Signal,
  type ReadonlySignal,
  type SignalOptions,
} from "./signal";

/** Reactive cell carrying a `T`. Writable. */
export type Cell<T> = Signal<T>;

/** Read-only reactive cell carrying a `T`. */
export type ReadonlyCell<T> = ReadonlySignal<T>;

/** Options accepted by `cell(value, opts)`. `equals` suppresses no-op writes. */
export type CellOptions<T> = SignalOptions<T>;

interface CellFactory {
  <T>(value: T, opts?: CellOptions<T>): Cell<T>;
  <T = undefined>(): Cell<T | undefined>;
  /** Read-only cell from a function of dependencies. */
  derived<T>(fn: () => T): ReadonlyCell<T>;
  /** Writable lens — reads via `read`, writes via `write`. */
  lens<T>(read: () => T, write: (v: T) => void): Cell<T>;
}

export const cell: CellFactory = Object.assign(signal, {
  derived: computed,
  lens,
}) as CellFactory;

/** Derive a read-only cell by mapping a single source cell's value.
 *
 *      derive(hovered, (h) => h ? 0.08 : 0)
 *      // ≡ cell.derived(() => (hovered.value ? 0.08 : 0))
 *
 *  Replaces the deprecated `sig.derive(fn)` method. */
export function derive<T, U>(
  sig: ReadonlyCell<T>,
  fn: (v: T) => U,
): ReadonlyCell<U> {
  return computed(() => fn(sig.value));
}
