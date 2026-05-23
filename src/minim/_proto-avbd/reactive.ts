// reactive.ts — reactive-signal integration for the AVBD solver.
//
// Glues `Signal`s (carrying the `pack` trait) to the solver's SOA
// cell buffers via a single `preEffect`. Lifecycle:
//
//   1. User calls `s.bind(sig)` (directly or via a constraint
//      factory like `distance(s, a, b, 1)`).
//   2. `Solver.bind` allocates a cell, copies `sig.peek()` into the
//      packed buffer, and lazy-installs this module's driver.
//   3. The driver is a `preEffect` that:
//        a. Reads each bound signal (subscribing via `.value`).
//        b. Pulls the current values into solver positions.
//        c. Runs `solver.step()`.
//        d. Writes solved positions back to signals.
//      `preEffect` self-mutes during its run, so step (d)'s writes
//      don't re-queue the driver.
//
// **Pin model**: this layer does NOT auto-pin user-written signals.
// The solver treats every cell with `mass > 0` as free; cells with
// `mass = 0` stay put. To get drag behaviour, flip the cell's mass
// (or use the `pin(sig)` helper).

import { type Pack, preEffect, type Signal } from "../signals";
import { Solver, setReactiveInstaller } from "./solver";

/** Install (or no-op if already installed) the reactive driver
 *  for `solver`. Called from `Solver.bind()`. */
function install(solver: Solver): void {
  if (solver._reactiveHandle !== undefined) return;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic pack typing across signal classes
  type Binding = { sig: Signal<any>; pack: Pack<any> };
  const bindings = solver._cellToBinding as readonly Binding[];

  solver._reactiveHandle = preEffect(() => {
    const positions = solver.positions;
    const offsets = solver.offsets;
    const N = solver.cellCount;
    // Read every bound signal (subscribing as a side effect of
    // `.value`) and snapshot into the solver's packed buffers.
    for (let id = 0; id < N; id++) {
      const b = bindings[id];
      if (!b) continue;
      b.pack.read(b.sig.value, positions, offsets[id]!);
    }
    // Solve.
    solver.step();
    // Write back. preEffect self-mute prevents re-queue.
    for (let id = 0; id < N; id++) {
      const b = bindings[id];
      if (!b) continue;
      // biome-ignore lint/suspicious/noExplicitAny: dynamic pack typing across signal classes
      (b.sig as Signal<any>).value = b.pack.write(positions, offsets[id]!);
    }
  });
}

setReactiveInstaller(install);

/** Pin a bound signal at its current value (`mass = 0`). Returns
 *  an `unpin` to restore the previous mass. */
// biome-ignore lint/suspicious/noExplicitAny: see Bindable
export function pin(sig: Signal<any>): () => void {
  const id = findCellId(sig);
  if (id === undefined) {
    throw new Error(
      "pin: signal is not bound to any solver. Call s.bind(sig) first or pass it to a constraint factory.",
    );
  }
  const { solver } = id;
  const prev = solver.massOf(id.cellId);
  solver.setMass(id.cellId, 0);
  return () => {
    solver.setMass(id.cellId, prev);
  };
}

// We can't enumerate all solvers globally without a registry. The
// pragmatic compromise: keep a WeakMap from signal → solver,
// populated by `Solver.bind()` indirectly. We store this here so
// `pin()` can resolve a signal to its solver.
//
// Implementation note: rather than mutate Solver to maintain this,
// we lookup at call time by scanning the solver passed to
// `Solver.bind()` — but `pin()` doesn't take a solver. The
// cleanest is a module-local WeakMap populated when the driver
// runs (which happens at least once per signal-write batch).
//
// For now: walk the binding list lazily. This is O(#solvers ×
// avg cells), acceptable while clusters stay small. If it becomes
// a hot path, we'll add an explicit reverse map.

// biome-ignore lint/suspicious/noExplicitAny: see Bindable
const sigSolverMap = new WeakMap<Signal<any>, { solver: Solver; cellId: number }>();

// biome-ignore lint/suspicious/noExplicitAny: see Bindable
function findCellId(sig: Signal<any>): { solver: Solver; cellId: number } | undefined {
  return sigSolverMap.get(sig);
}

// Hook into Solver.bind() to populate sigSolverMap. We do this by
// patching the prototype method. This is the only place we mutate
// Solver from outside its own module.
const originalBind = Solver.prototype.bind;
// biome-ignore lint/suspicious/noExplicitAny: see Bindable
Solver.prototype.bind = function bind(this: Solver, sig: Signal<any>): number {
  const id = originalBind.call(this, sig);
  if (!sigSolverMap.has(sig)) sigSolverMap.set(sig, { solver: this, cellId: id });
  return id;
};
