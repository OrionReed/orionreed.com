// `cell` — the unified user-facing primitive for reactive state.
//
// One name, three constructors:
//
//   cell(v)                    — writable cell (was `signal(v)`)
//   cell.derived(fn)           — read-only cell (was `computed(fn)`)
//   cell.lens(read, write)     — writable lens cell (was `lens(read, write)`)
//
// All three return `Cell<T, W>`, parameterized by writability. The
// underlying classes (Signal / Computed / Lens from the vendored
// preact fork) stay in place — `cell` is the unified entry point and
// vocabulary on top.
//
// Why: today users juggle `signal` / `computed` / `lens` as three
// distinct things, when they're really three constructors for the
// same primitive (a reactive cell). Collapsing the vocabulary makes
// the mental model — "everything reactive is a cell" — surface in
// the API itself. The existing `signal` / `computed` / `lens` names
// remain as aliases for back-compat.

import {
  signal as makeSignal,
  computed as makeComputed,
  lens as makeLens,
  type Signal,
  type ReadonlySignal,
} from "./signal";

/** Writability tag — same shape the struct framework uses. */
export type RW = "rw" | "ro";

/** A reactive cell carrying a `T`. Writable by default; pass
 *  `"ro"` for the read-only flavor (returned by `cell.derived`). */
export type Cell<T, W extends RW = "rw"> = W extends "rw"
  ? Signal<T>
  : ReadonlySignal<T>;

/** Read-only cell — alias for `Cell<T, "ro">`. */
export type ReadonlyCell<T> = Cell<T, "ro">;

interface CellFactory {
  /** Construct a writable cell. */
  <T>(value: T): Cell<T>;
  <T = undefined>(): Cell<T | undefined>;
  /** Construct a read-only cell from a function of dependencies. */
  derived<T>(fn: () => T): Cell<T, "ro">;
  /** Construct a writable lens cell — reads via `read`, writes via
   *  `write`. The classic bidirectional view. */
  lens<T>(read: () => T, write: (v: T) => void): Cell<T>;
}

const cellFn = (<T>(v?: T) => makeSignal<T>(v as T)) as CellFactory;
cellFn.derived = <T>(fn: () => T): Cell<T, "ro"> => makeComputed(fn);
cellFn.lens = <T>(read: () => T, write: (v: T) => void): Cell<T> =>
  makeLens(read, write);

/** Construct a writable cell. Same as `signal(v)`. */
export const cell: CellFactory = cellFn;
