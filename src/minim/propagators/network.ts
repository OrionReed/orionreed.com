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

import { network as makeNetwork, type Network, type Signal, transitiveDeps } from "../signals";
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
  /** Manual mode: don't auto-run when reads change. Call `.step()`
   *  to advance the fixpoint. Use for animated solvers, demos that
   *  want to visualise narrowing, or batched offline runs. */
  manual?: boolean;
}

export class Propagators {
  private readonly _entries: Entry[] = [];
  private readonly _maxIterations: number;
  private readonly _manual: boolean;
  private _network?: Network;
  /** Propagators added but not yet given their first fire. The body
   *  drains this queue on its next run (which we trigger via
   *  `flush()` after subscribing new deps). */
  private _firstFireQueue: Propagator[] = [];
  /** Fresh signal-writes that haven't been drained yet. In auto mode,
   *  drained inline in the body callback. In manual mode, persists
   *  between `step()` calls. */
  private _pendingFresh = new Set<AnySignal>();

  constructor(opts: PropagatorsOpts = {}) {
    this._maxIterations = opts.iterations ?? 1000;
    this._manual = opts.manual ?? false;
  }

  /** Add one or more propagators. Multi-direction combinators (e.g.
   *  `add`) return arrays; spread them. Each new propagator gets one
   *  "first fire" inside the network body so writes happen atomically;
   *  subsequent passes are freshness-gated. Returns `this` for
   *  chaining: `propagators().add(p1, p2, ...)`. */
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
      // Trigger body so the queue gets processed. In manual mode we
      // still flush so first-fire happens at add() time (consistent
      // with auto mode); the user's `step()` controls subsequent
      // narrowing.
      this._network.flush();
    }
    return this;
  }

  /** Advance the fixpoint loop. By default runs to convergence (up to
   *  `iterations`); pass a smaller `maxIterations` to advance only
   *  N waves at a time — useful for animated solvers / demos.
   *
   *  Only meaningful in `manual: true` mode; in auto mode the network
   *  drains inline in `add()` and on every read change. */
  step(maxIterations: number = this._maxIterations): void {
    if (this._network === undefined) return;
    // Pull any external-dirty signals into the body; in manual mode
    // the network otherwise sits on them.
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
          `${stuck.size} signal(s) still changing.`,
        stuck,
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

/** One-shot sugar: build a network from N propagators with default opts.
 *  Equivalent to `propagators().add(...props)`. Returns the holder so
 *  callers can `.dispose()` later. */
export function propagate(...props: readonly (Propagator | readonly Propagator[])[]): Propagators {
  return new Propagators().add(...props);
}
