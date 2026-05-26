// network.ts — propagator network holder.
//
// A propagator network is a single `network()` whose body runs a
// fixpoint loop over the registered propagators.
//
// Termination: bounded by `iterations` fuel cap. Inside the loop,
// freshness propagation: each pass runs only propagators whose
// READS were freshly modified in the prior pass.
//
// AUTO-EXPAND: at install time, every propagator's declared
// `reads` is expanded transitively via `transitiveDeps()` — every
// signal the read-set transitively depends on becomes part of the
// EFFECTIVE read-set used for subscription and freshness gating.
// This means a propagator that reads a lens chain (`a.scale(2)`)
// implicitly reads the chain's parents too. Without this, writes
// inside the fixpoint loop that update a chain's parent wouldn't
// re-fire propagators reading the chain — a silent freshness gap.
//
// Self-exclusion of the network's own body keeps writes from re-
// firing the network. External writes (outside the body) re-fire
// it normally.

import {
  network as makeNetwork,
  type Network,
  type Signal,
  transitiveDeps,
} from "../signals";
import type { Propagator } from "./propagator";

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous signal registry
type AnySignal = Signal<any>;

interface Entry {
  p: Propagator;
  /** Transitively-expanded read set. Includes every direct read
   *  plus every signal those reads depend on (lens-chain parents,
   *  fan-in lens parents, etc.). */
  expanded: readonly AnySignal[];
}

export interface PropagatorsOpts {
  /** Maximum fixpoint iterations per body run. Default 1000.
   *  Hitting the cap throws — propagators never silently diverge. */
  iterations?: number;
}

export class Propagators {
  private readonly _entries: Entry[] = [];
  private readonly _maxIterations: number;
  private _network?: Network;

  constructor(opts: PropagatorsOpts = {}) {
    this._maxIterations = opts.iterations ?? 1000;
  }

  /** Add one or more propagators. Multi-direction combinators (e.g.
   *  `add`) return arrays; spread them. Subscribes new deps and
   *  flushes the network once per `add()` call regardless of how
   *  many propagators or cells are added. */
  add(...props: readonly (Propagator | readonly Propagator[])[]): void {
    const newDeps = new Set<AnySignal>();
    for (const p of props) {
      if (Array.isArray(p)) for (const pp of p) this._addOne(pp, newDeps);
      else this._addOne(p as Propagator, newDeps);
    }
    if (this._network === undefined) {
      this._install();
    } else {
      // Subscribe before flush so the new deps are in the topology
      // when the body runs.
      this._network.subscribe(...newDeps);
      // Flush so newly-added propagators get a chance to run, even
      // if their reads were already in the dep set.
      this._network.flush();
    }
  }

  private _addOne(p: Propagator, newDeps: Set<AnySignal>): void {
    const expanded = expandReads(p.reads);
    this._entries.push({ p, expanded });
    for (const s of expanded) newDeps.add(s);
  }

  /** Number of propagators currently in the network. */
  get count(): number {
    return this._entries.length;
  }

  /** Tear down the underlying reactive driver. */
  dispose(): void {
    this._network?.dispose();
    this._network = undefined;
  }

  // ─── Internals ─────────────────────────────────────────────────

  private _install(): void {
    // Collect all expanded reads across all current propagators as
    // the network's explicit topology. New propagators added later
    // grow it via `_addOne`'s `network.subscribe(...)` call.
    const allDeps = new Set<AnySignal>();
    for (const { expanded } of this._entries) {
      for (const s of expanded) allDeps.add(s);
    }
    this._network = makeNetwork(
      [...allDeps] as readonly Signal<unknown>[],
      dirty => {
        this._runFixpoint(dirty as ReadonlySet<AnySignal>);
      },
    );
  }

  private _runFixpoint(initialDirty: ReadonlySet<AnySignal>): void {
    if (this._entries.length === 0) return;
    let fresh: Set<AnySignal> = new Set(initialDirty);
    // First fire: fresh is empty (initial run had no prior). Run
    // every propagator once to populate the network.
    if (fresh.size === 0) {
      const newFresh = new Set<AnySignal>();
      for (const { p } of this._entries) {
        const changed = runPropagator(p);
        for (const w of changed) newFresh.add(w);
      }
      fresh = newFresh;
    }
    let iters = 0;
    while (fresh.size > 0 && iters < this._maxIterations) {
      iters++;
      const newFresh = new Set<AnySignal>();
      for (const { p, expanded } of this._entries) {
        if (!hasExpandedFreshRead(expanded, fresh)) continue;
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

/** Auto-expand declared reads to include transitive lens-chain
 *  parents. Each direct read contributes itself plus every signal
 *  it depends on (recursively). The expanded set is what the
 *  freshness algorithm uses for both subscription and fire-gating. */
function expandReads(reads: readonly AnySignal[]): readonly AnySignal[] {
  const set = new Set<AnySignal>();
  for (const r of reads) {
    for (const dep of transitiveDeps(r)) set.add(dep);
  }
  return [...set];
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

/** True iff any signal in the EXPANDED read-set is fresh. The
 *  expansion at install time is what makes lens-chain parents
 *  appear here even when the propagator's declared reads only
 *  named the chain. */
function hasExpandedFreshRead(
  expanded: readonly AnySignal[],
  fresh: ReadonlySet<AnySignal>,
): boolean {
  for (const r of expanded) if (fresh.has(r)) return true;
  return false;
}

export function propagators(opts: PropagatorsOpts = {}): Propagators {
  return new Propagators(opts);
}
