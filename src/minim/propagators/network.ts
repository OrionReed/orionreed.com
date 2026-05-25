// network.ts — propagator network holder. PROTOTYPE.
//
// A propagator network is a single `network()` whose body runs a
// fixpoint loop over the registered propagators. Same shape as
// `Constraints` in `../constraints/cluster.ts`. The propagator
// equivalent of `Constraints.add(rel)` is `Propagators.add(p)`.
//
// Termination: bounded by `iterations` fuel cap. Inside the loop,
// freshness propagation: each pass runs only propagators whose
// READS were freshly modified in the prior pass. This avoids
// "user wrote c=20; propagator immediately overwrites c with
// computed value" pathology — propagators that write a fresh-from-
// user signal don't fire in the same iteration as the user's write.
//
// The freshness rule:
//   1. On body entry, fresh = `dirty` (signals changed since last fire).
//   2. Each iteration: run propagators whose reads ∩ fresh ≠ ∅.
//      Track which writes actually changed value (peek-based).
//   3. Set fresh = changed writes. Loop.
//   4. Empty fresh → fixpoint.
//
// Self-exclusion of the network's own body keeps writes from re-
// firing the network. External writes (outside the body) re-fire
// it normally.

import { network as makeNetwork, type Network, type Signal } from "../signals";
import type { Propagator } from "./propagator";

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous signal registry
type AnySignal = Signal<any>;

export interface PropagatorsOpts {
  /** Maximum fixpoint iterations per body run. Default 1000.
   *  Hitting the cap throws — propagators never silently diverge. */
  iterations?: number;
}

export class Propagators {
  private readonly _propagators: Propagator[] = [];
  private readonly _maxIterations: number;
  private _network?: Network;

  constructor(opts: PropagatorsOpts = {}) {
    this._maxIterations = opts.iterations ?? 1000;
  }

  /** Add one or more propagators. Multi-direction combinators (e.g.
   *  `adder`) return arrays; spread them. */
  add(...props: readonly (Propagator | readonly Propagator[])[]): void {
    for (const p of props) {
      if (Array.isArray(p)) this._propagators.push(...p);
      else this._propagators.push(p as Propagator);
    }
    if (this._network === undefined) this._install();
    else {
      // Network already running — force it to re-fire so the new
      // propagators run for the first time. Cheapest way: write a
      // dummy signal we control. For now, the easiest is to call
      // its flush directly (works in both manual and auto modes).
      this._network.flush();
    }
  }

  /** Number of propagators currently in the network. */
  get count(): number {
    return this._propagators.length;
  }

  /** Tear down the underlying reactive driver. */
  dispose(): void {
    this._network?.dispose();
    this._network = undefined;
  }

  // ─── Internals ─────────────────────────────────────────────────

  private _install(): void {
    this._network = makeNetwork(dirty => {
      this._runFixpoint(dirty as ReadonlySet<AnySignal>);
    });
  }

  private _runFixpoint(initialDirty: ReadonlySet<AnySignal>): void {
    if (this._propagators.length === 0) return;
    let fresh: Set<AnySignal> = new Set(initialDirty);
    // First fire: fresh is empty (initial run had no prior). Treat
    // every propagator as needing to run once at least, to populate.
    if (fresh.size === 0) {
      // Touch all readable cells so the network subscribes.
      for (const p of this._propagators) {
        for (const s of p.reads) s.value;
      }
      // Run every propagator once and accumulate fresh writes.
      const newFresh = new Set<AnySignal>();
      for (const p of this._propagators) {
        const changed = runPropagator(p);
        for (const w of changed) newFresh.add(w);
      }
      fresh = newFresh;
    }
    let iters = 0;
    while (fresh.size > 0 && iters < this._maxIterations) {
      iters++;
      const newFresh = new Set<AnySignal>();
      for (const p of this._propagators) {
        if (!hasFreshRead(p, fresh)) continue;
        const changed = runPropagator(p);
        for (const w of changed) newFresh.add(w);
      }
      fresh = newFresh;
    }
    if (iters >= this._maxIterations) {
      throw new PropagatorDivergedError(
        `Propagators: did not converge after ${this._maxIterations} iterations. ` +
          `${fresh.size} signal(s) still changing.`,
        fresh,
      );
    }
  }
}

/** Thrown when the fixpoint loop hits its iteration cap. The
 *  `pending` set lists signals that were still being modified on
 *  the last iteration — useful for debugging non-converging
 *  propagator configurations. */
export class PropagatorDivergedError extends Error {
  constructor(
    message: string,
    readonly pending: ReadonlySet<AnySignal>,
  ) {
    super(message);
    this.name = "PropagatorDivergedError";
  }
}

/** Run a propagator's `step()` and return the set of WRITE signals
 *  whose values actually changed. */
function runPropagator(p: Propagator): Set<AnySignal> {
  const before: unknown[] = new Array(p.writes.length);
  for (let i = 0; i < p.writes.length; i++) before[i] = p.writes[i]!.peek();
  p.step();
  const changed = new Set<AnySignal>();
  for (let i = 0; i < p.writes.length; i++) {
    if (p.writes[i]!.peek() !== before[i]) changed.add(p.writes[i]!);
  }
  return changed;
}

/** True iff any of the propagator's read signals is in the fresh set. */
function hasFreshRead(p: Propagator, fresh: ReadonlySet<AnySignal>): boolean {
  for (const r of p.reads) if (fresh.has(r)) return true;
  return false;
}

export function propagators(opts: PropagatorsOpts = {}): Propagators {
  return new Propagators(opts);
}
