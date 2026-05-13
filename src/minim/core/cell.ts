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

export type RW = "rw" | "ro";

/** Reactive cell carrying a `T`. Writable by default; `"ro"` for the
 *  read-only flavor (returned by `cell.derived`). */
export type Cell<T, W extends RW = "rw"> = W extends "rw"
  ? Signal<T>
  : ReadonlySignal<T>;

export type ReadonlyCell<T> = Cell<T, "ro">;

/** Options accepted by `cell(value, opts)`. `equals` suppresses no-op writes. */
export type CellOptions<T> = SignalOptions<T>;

interface CellFactory {
  <T>(value: T, opts?: CellOptions<T>): Cell<T>;
  <T = undefined>(): Cell<T | undefined>;
  /** Read-only cell from a function of dependencies. */
  derived<T>(fn: () => T): Cell<T, "ro">;
  /** Writable lens — reads via `read`, writes via `write`. */
  lens<T>(read: () => T, write: (v: T) => void): Cell<T>;
}

export const cell: CellFactory = Object.assign(signal, {
  derived: computed,
  lens,
}) as CellFactory;
