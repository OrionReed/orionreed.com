// reactive.ts — reactive-signal integration for the AVBD solver.
//
// What this glues together:
//
//   - The bare `Solver` operates on `Cell` (a `Float64Array` shadow
//     of the cell's value). Hot loop only touches `position`.
//   - The user works with reactive `Signal`s: `Num`, `Vec`, `Box`,
//     `Color`. Writes propagate via the existing `_throughOf` lens
//     chain, subscribers re-render, etc.
//   - To make constraints over signals work, we need: pull signal
//     values into cells before each solve; push solved values back
//     after; and re-solve automatically when any cell signal is
//     written by the user.
//
// We use the three solver-integration hooks added to the signals
// layer: `setPinHook` to detect user writes, `addPreFlushTask` to
// run the solver before regular effects observe new values, and
// `withSolverActive` to suppress pin-firings during the solver's
// own back-writes. None of these mutate signal shape, all are
// no-op for non-constraint signals.
//
// Cluster ↔ signal binding lives in module-local `WeakMap`s:
// signals don't carry solver references, V8 hidden classes stay
// stable across the codebase. When a signal goes out of scope its
// WeakMap entry collects naturally.

import { Box } from "../signals/values/box";
import { Color } from "../signals/values/color";
import { Num } from "../signals/values/num";
import { Vec } from "../signals/values/vec";
import { addPreFlushTask, type Signal, setPinHook, withSolverActive } from "../signals";
import { Cell } from "./cell";
import { Solver } from "./solver";

// ─── Signal ↔ Cell shape adapters ────────────────────────────────────
//
// Each registered "value class" (Num / Vec / Box / Color) describes
// how to read its value into a `Cell.position` and how to write
// the cell's position back into the signal's typed value. Users
// can extend with custom types via `registerBinder`.

interface SignalBinder<T> {
  readonly dim: number;
  read(value: T, into: Float64Array): void;
  write(from: Float64Array): T;
}

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous registry; binder generics are erased at lookup
type SigCtor = new (...args: any[]) => Signal<unknown>;
const binders = new Map<SigCtor, SignalBinder<unknown>>();

/** Register a binder for a custom Signal subclass. The binder is
 *  used at every solve to sync between the signal's typed value
 *  and the underlying `Cell.position`. */
export function registerBinder<T>(
  // biome-ignore lint/suspicious/noExplicitAny: same variance escape as `SigCtor`
  SignalClass: new (...args: any[]) => Signal<T>,
  binder: SignalBinder<T>,
): void {
  binders.set(SignalClass as SigCtor, binder as SignalBinder<unknown>);
}

// ─── Built-in binders ────────────────────────────────────────────────

registerBinder<number>(Num, {
  dim: 1,
  read: (v, into) => {
    into[0]! = v;
  },
  write: (from) => from[0]!,
});

interface V2 { x: number; y: number }
registerBinder<V2>(Vec, {
  dim: 2,
  read: (v, into) => {
    into[0]! = v.x;
    into[1]! = v.y;
  },
  write: (from) => ({ x: from[0]!, y: from[1]! }),
});

interface BoxV { x: number; y: number; w: number; h: number }
registerBinder<BoxV>(Box, {
  dim: 4,
  read: (v, into) => {
    into[0]! = v.x;
    into[1]! = v.y;
    into[2]! = v.w;
    into[3]! = v.h;
  },
  write: (from) => ({ x: from[0]!, y: from[1]!, w: from[2]!, h: from[3]! }),
});

interface ColorV { r: number; g: number; b: number; a: number }
registerBinder<ColorV>(Color, {
  dim: 4,
  read: (v, into) => {
    into[0]! = v.r;
    into[1]! = v.g;
    into[2]! = v.b;
    into[3]! = v.a;
  },
  write: (from) => ({ r: from[0]!, g: from[1]!, b: from[2]!, a: from[3]! }),
});

function binderFor(sig: Signal<unknown>): SignalBinder<unknown> {
  // Walk the prototype chain looking for a registered binder. Direct
  // class match is the common case (Num, Vec, …) and a single
  // lookup; user-subclasses of Vec inherit Vec's binder via the
  // walk.
  let proto = Object.getPrototypeOf(sig)?.constructor;
  while (proto && proto !== Function && proto !== Object) {
    const b = binders.get(proto);
    if (b) return b;
    proto = Object.getPrototypeOf(proto);
  }
  throw new Error(
    `AVBD reactive: no binder registered for ${sig.constructor.name}. ` +
      `Use registerBinder(...) to teach AVBD about custom value classes.`,
  );
}

// ─── Cluster machinery ───────────────────────────────────────────────
//
// `bindings`: per-Solver, the signals it manages and their bound cells.
// `sigToSolver`: reverse lookup so the pin-hook can dispatch quickly.
// Both WeakMap-keyed where the keys are GC-collectable.

const bindings = new WeakMap<Solver, Map<Signal<unknown>, Binding>>();
const sigToSolver = new WeakMap<Signal<unknown>, Solver>();
// User-pinned signals per solver, accumulated by pin-hook between
// drains. Cleared when the solver runs.
const userPinned = new WeakMap<Solver, Set<Signal<unknown>>>();
// Lens-trigger map per solver: writing an ancestor signal pins
// all bound descendants. Filled when bindSignal walks `_throughOf`
// upward from the bound signal to its root.
const triggerMap = new WeakMap<Solver, Map<Signal<unknown>, Set<Signal<unknown>>>>();

interface FusedOf { parent: Signal<unknown> }
/** Walk one step up the lens chain. The signals layer fuses
 *  `.through() / .lensTo() / .deriveTo()` chains into a single
 *  cell tagged with `_fusedOf.parent` pointing at the root. */
function lensParent(sig: Signal<unknown>): Signal<unknown> | undefined {
  return (sig as Signal<unknown> & { _fusedOf?: FusedOf })._fusedOf?.parent;
}

function addTrigger(solver: Solver, ancestor: Signal<unknown>, derived: Signal<unknown>): void {
  let m = triggerMap.get(solver);
  if (!m) {
    m = new Map();
    triggerMap.set(solver, m);
  }
  let set = m.get(ancestor);
  if (!set) {
    set = new Set();
    m.set(ancestor, set);
  }
  set.add(derived);
}

interface Binding {
  readonly cell: Cell;
  readonly binder: SignalBinder<unknown>;
}

const queued = new Set<Solver>();
let preFlushScheduled = false;
let pinHookInstalled = false;

function ensurePinHook(): void {
  if (pinHookInstalled) return;
  pinHookInstalled = true;
  setPinHook((sig: Signal<unknown>) => {
    const solver = sigToSolver.get(sig);
    if (solver === undefined) return;
    let set = userPinned.get(solver);
    if (!set) {
      set = new Set();
      userPinned.set(solver, set);
    }
    set.add(sig);
    queueSolver(solver);
  });
}

function queueSolver(s: Solver): void {
  if (queued.has(s)) return;
  queued.add(s);
  if (!preFlushScheduled) {
    preFlushScheduled = true;
    addPreFlushTask(drainQueue);
  }
}

function drainQueue(): void {
  preFlushScheduled = false;
  // Snapshot to avoid feedback if a solver run somehow re-queues.
  // (`withSolverActive` should prevent that, but defence in depth.)
  const list = Array.from(queued);
  queued.clear();
  for (const s of list) runReactiveStep(s);
}

function runReactiveStep(s: Solver): void {
  const map = bindings.get(s);
  if (!map) return;

  // 1. Pinned-cell expansion: a user write to a signal pins every
  //    bound cell whose `_throughOf` chain passes through it. Writing
  //    a root vec pins all bound lens-derived `vec.x`/`vec.y` etc.
  //    Direct writes (signal == bound signal) pin the cell itself.
  const pinned = userPinned.get(s);
  userPinned.delete(s);
  const triggers = triggerMap.get(s);
  const pinnedCells = new Set<Cell>();
  if (pinned) {
    for (const sig of pinned) {
      const direct = map.get(sig);
      if (direct) pinnedCells.add(direct.cell);
      const triggered = triggers?.get(sig);
      if (triggered) {
        for (const dsig of triggered) {
          const b = map.get(dsig);
          if (b) pinnedCells.add(b.cell);
        }
      }
    }
  }

  // 2. Snapshot signal → cell.position (peek so we don't subscribe).
  //    Lens-derived signals reflect upstream writes via the existing
  //    `_throughOf` fwd; we read whatever the layer reports.
  for (const [sig, { cell, binder }] of map) {
    binder.read(sig.peek(), cell.position);
  }

  // 3. Pin those cells with mass=0 for the duration of the solve.
  //    Skip cells that are already mass=0 (user-pinned permanently).
  const restore: Cell[] = [];
  const restoreMass: number[] = [];
  for (const cell of pinnedCells) {
    if (cell.mass !== 0) {
      restore.push(cell);
      restoreMass.push(cell.mass);
      cell.mass = 0;
    }
  }

  // 4. Solve. Restore masses on the way out.
  try {
    s.step();
  } finally {
    for (let i = 0; i < restore.length; i++) restore[i]!.mass = restoreMass[i]!;
  }

  // 5. Push cell.position → signal.value, suppressing pin firings
  //    so these writes don't re-queue the solver.
  withSolverActive(() => {
    for (const [sig, { cell, binder }] of map) {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic value typing across binders
      (sig as Signal<any>).value = binder.write(cell.position);
    }
  });
}

// ─── Public: bind a signal to a solver ───────────────────────────────

/** Register `sig` with `solver` and return its bound `Cell`. Repeat
 *  calls return the same cell. Throws if `sig` is already bound to
 *  a *different* solver — multi-solver membership is not (yet)
 *  supported.
 *
 *  Constraint factories (`distance`, `eq`, …) call this internally
 *  for each Signal argument; users typically don't need to invoke
 *  it directly. */
export function bindSignal(solver: Solver, sig: Signal<unknown>): Cell {
  ensurePinHook();

  let map = bindings.get(solver);
  if (!map) {
    map = new Map<Signal<unknown>, Binding>();
    bindings.set(solver, map);
  }

  const existing = map.get(sig);
  if (existing) return existing.cell;

  const otherSolver = sigToSolver.get(sig);
  if (otherSolver !== undefined && otherSolver !== solver) {
    throw new Error(
      "AVBD reactive: signal is already bound to a different solver. " +
        "Multi-solver binding is not yet implemented; use one solver per cluster.",
    );
  }

  // Walk `_throughOf` upward, registering every ancestor as a
  // pin-trigger for `sig`. Writing the root signal (or any link in
  // the lens chain) thus pins the bound derived cell. Each ancestor
  // also gets `sigToSolver` registered so the pinHook dispatches
  // even when the ancestor isn't itself a bound cell.
  let cur: Signal<unknown> | undefined = sig;
  while (cur !== undefined) {
    const exist = sigToSolver.get(cur);
    if (exist !== undefined && exist !== solver) {
      throw new Error(
        "AVBD reactive: lens ancestor already bound to a different solver. " +
          "Multi-solver binding is not yet implemented.",
      );
    }
    sigToSolver.set(cur, solver);
    addTrigger(solver, cur, sig);
    cur = lensParent(cur);
  }

  const binder = binderFor(sig);
  const cell = new Cell(binder.dim);
  binder.read(sig.peek(), cell.position);
  // Mirror the initial value into `initial` and `inertial` too so
  // `solver.prepare()`'s first call sees a coherent state.
  for (let i = 0; i < binder.dim; i++) {
    cell.initial[i]! = cell.position[i]!;
    cell.inertial[i]! = cell.position[i]!;
  }

  solver.addCell(cell);
  map.set(sig, { cell, binder });
  return cell;
}

/** Convenience: a `Cell` that's already a `Cell` is returned as-is;
 *  a `Signal` is bound and its cell returned. Used by constraint
 *  factories that accept either. */
export function asCell(solver: Solver, x: Cell | Signal<unknown>): Cell {
  return x instanceof Cell ? x : bindSignal(solver, x);
}

/** Drop all bindings between `solver` and signals. After this, the
 *  solver is back to a static-editing scene; its cells and forces
 *  remain. Useful for tearing down a constraint set without
 *  rebuilding the solver. */
export function unbindSolver(solver: Solver): void {
  const map = bindings.get(solver);
  if (!map) return;
  // Drop sigToSolver entries for both bound signals and lens
  // ancestors registered as pin triggers.
  for (const sig of map.keys()) sigToSolver.delete(sig);
  const triggers = triggerMap.get(solver);
  if (triggers) {
    for (const ancestor of triggers.keys()) sigToSolver.delete(ancestor);
  }
  triggerMap.delete(solver);
  userPinned.delete(solver);
  bindings.delete(solver);
}
