// network.ts — propagator network holder.
//
// A single `network()` whose body runs a fixpoint loop over the
// registered propagators, bounded by an `iterations` fuel cap. Each
// pass is freshness-gated: only propagators whose reads changed in
// the prior pass re-run.
//
// At install time each propagator's `reads` is expanded transitively
// (via `transitiveDeps()`) into the effective read-set used for
// subscription and gating. Without this, a propagator reading a lens
// chain wouldn't re-fire when a write inside the loop updates the
// chain's parent — a silent freshness gap.
//
// The network body self-excludes its own writes; external writes
// re-fire it normally.

import { network as makeNetwork, type Network, type Cell, transitiveDeps } from "../signals";
import type { Propagator } from "./propagator";

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous signal registry
type AnySignal = Cell<any>;

interface Entry {
  p: Propagator;
  /** Transitively-expanded read set: direct reads plus everything
   *  they depend on (lens-chain / fan-in parents). */
  expanded: readonly AnySignal[];
}

export interface PropagatorsOpts {
  /** Max fixpoint iterations per body run. Default 1000. Hitting
   *  the cap throws — propagators never silently diverge. */
  iterations?: number;
  /** Don't auto-run on read changes; advance via `.step()`. For
   *  animated solvers, narrowing demos, or batched offline runs. */
  manual?: boolean;
}

export class Propagators {
  private readonly _entries: Entry[] = [];
  private readonly _maxIterations: number;
  private readonly _manual: boolean;
  private _network?: Network;
  /** Propagators added but not yet first-fired; drained on the body's
   *  next run. */
  private _firstFireQueue: Propagator[] = [];
  /** Undrained fresh writes. Auto mode drains inline in the body;
   *  manual mode persists between `step()` calls. */
  private _pendingFresh = new Set<AnySignal>();

  constructor(opts: PropagatorsOpts = {}) {
    this._maxIterations = opts.iterations ?? 1000;
    this._manual = opts.manual ?? false;
  }

  /** Add one or more propagators (combinators returning arrays may be
   *  spread). Each gets one atomic "first fire" in the body; later
   *  passes are freshness-gated. Returns `this` for chaining. */
  add(...props: readonly (Propagator | readonly Propagator[])[]): this {
    const startIndex = this._entries.length;
    const newDeps = new Set<AnySignal>();
    for (const p of props) {
      if (Array.isArray(p)) for (const pp of p) this._addOne(pp, newDeps);
      else this._addOne(p as Propagator, newDeps);
    }
    for (let i = startIndex; i < this._entries.length; i++) {
      this._firstFireQueue.push(this._entries[i]!.p);
    }
    if (this._network === undefined) {
      // Install fires the body once, draining _firstFireQueue.
      this._install();
    } else {
      this._network.subscribe(...newDeps);
      // Flush so the queue gets first-fired at add() time, even in
      // manual mode (the user's `step()` controls later narrowing).
      this._network.flush();
    }
    return this;
  }

  /** Advance the fixpoint loop. Runs to convergence by default; pass
   *  a smaller `maxIterations` to step N waves at a time. Only
   *  meaningful in `manual` mode (auto drains inline). */
  step(maxIterations: number = this._maxIterations): void {
    if (this._network === undefined) return;
    // Pull external-dirty signals in; manual mode otherwise sits on them.
    this._network.flush();
    this._drain(maxIterations);
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
    // Seed the topology with every current propagator's expanded
    // reads; later adds grow it via `network.subscribe(...)`.
    const allDeps = new Set<AnySignal>();
    for (const { expanded } of this._entries) {
      for (const s of expanded) allDeps.add(s);
    }
    this._network = makeNetwork(
      [...allDeps] as readonly Cell<unknown>[],
      dirty => {
        // 1) First-fire any propagators that were just added.
        for (const p of this._firstFireQueue) {
          const changed = runPropagator(p);
          for (const w of changed) this._pendingFresh.add(w);
        }
        this._firstFireQueue = [];
        // 2) Fold external-dirty into pending fresh.
        for (const s of dirty) this._pendingFresh.add(s);
        // 3) Auto mode: drain to convergence. Manual: leave for step().
        if (!this._manual) this._drain(this._maxIterations);
      },
      { manual: this._manual },
    );
  }

  /** Drain `_pendingFresh` wave by wave for up to `maxIterations`
   *  passes. Each wave consumes the current fresh set and re-fires
   *  any propagator whose expanded read-set intersects it. */
  private _drain(maxIterations: number): void {
    if (this._entries.length === 0) return;
    let iters = 0;
    while (this._pendingFresh.size > 0 && iters < maxIterations) {
      iters++;
      const fresh = this._pendingFresh;
      this._pendingFresh = new Set<AnySignal>();
      for (const { p, expanded } of this._entries) {
        if (!hasExpandedFreshRead(expanded, fresh)) continue;
        const changed = runPropagator(p);
        for (const w of changed) this._pendingFresh.add(w);
      }
    }
    // Auto mode: didn't converge → throw. Manual mode: leftover sits
    // in _pendingFresh until the next step().
    if (!this._manual && iters >= this._maxIterations && this._pendingFresh.size > 0) {
      const stuck = this._pendingFresh;
      this._pendingFresh = new Set<AnySignal>();
      throw new PropagatorDivergedError(
        `Propagators: did not converge after ${this._maxIterations} iterations. ` +
          `${stuck.size} cell(s) still changing.`,
        stuck,
      );
    }
  }
}

/** Thrown when the fixpoint loop hits its iteration cap. `pending`
 *  lists signals still changing on the last pass. */
export class PropagatorDivergedError extends Error {
  constructor(
    message: string,
    readonly pending: ReadonlySet<AnySignal>,
  ) {
    super(message);
    this.name = "PropagatorDivergedError";
  }
}

/** Expand declared reads to include transitive deps (lens-chain
 *  parents). The result drives both subscription and fire-gating. */
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

/** True iff any signal in the expanded read-set is fresh. */
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

/** One-shot sugar for `propagators().add(...props)`. */
export function propagate(...props: readonly (Propagator | readonly Propagator[])[]): Propagators {
  return new Propagators().add(...props);
}
