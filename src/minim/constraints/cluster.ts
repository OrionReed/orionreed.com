// cluster.ts — the `Constraints` holder.
//
// Holds a `Solver`, a registry of relations, and a `pipeline` of
// phases that runs on every `step(dt)`. Default pipeline is
// reactive (snapshot → prepare → solve → writeback) and a default
// reactive driver fires on bound-signal changes — so a freshly
// constructed `Constraints` is a sketchpad-style reactive solver
// with no further setup.
//
// Specialised factories (`physics`, `world`, …) overwrite the
// pipeline wholesale, allocate their own per-cell state, and
// dispose the reactive driver to take over the time loop.
// Subsystems are not classes — they're just factory functions
// that declare their pipeline.
//
// Relation contract: a single `bind(c)` method that registers
// whatever the relation needs (cell bindings + term) and returns
// a disposer. `c.add(rel)` calls `bind`; `c.remove(rel)` calls
// the disposer.

import {
  type Lifecycle,
  type Pack,
  type Read,
  requirePack,
  type Settle,
  settle,
  type Signal,
  signal,
  type WritableBrand,
} from "../signals";
import { when } from "../signals/settle-utils";
import { type Phase, reactivePipeline } from "./phases";
import { Solver, type SolverOpts } from "./solver";

// ─── Relation interface ────────────────────────────────────────────

/** A constraint relation. `bind(c)` does whatever setup the relation
 *  needs (cell binding, term registration, slot allocation, …) and
 *  returns a disposer that undoes it.
 *
 *  Factories return relations as plain objects; user code passes
 *  them to `c.add(rel)` and tears them down via `c.remove(rel)`. */
export interface Relation {
  bind(c: Constraints): () => void;
}

interface Binding {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic pack typing
  readonly sig: Signal<any>;
  // biome-ignore lint/suspicious/noExplicitAny: same
  readonly pack: Pack<any>;
}

// ─── Constraints ───────────────────────────────────────────────────

export class Constraints {
  /** The numerical solver underneath. Exposed for advanced users
   *  and for phase functions to read/write its buffers. */
  readonly solver: Solver;

  /** The pipeline of phases to run on each `step(dt)`. Mutable —
   *  factories declare their pipeline by assignment. The default
   *  is the reactive pipeline (snapshot/prepare/solve/writeback).
   *  Read it to debug; reassign it to specialise. */
  pipeline: Phase[];

  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous binding registry
  private readonly _sigToCell = new Map<Signal<any>, number>();
  private readonly _bindings: (Binding | undefined)[] = [];
  /** Disposers for active relations, keyed by relation reference.
   *  `add(rel)` stores the disposer here; `remove(rel)` invokes it. */
  private readonly _disposers = new Map<Relation, () => void>();
  /** Hooks fired when relations are added / removed. Used by
   *  factories that need to track specific relation kinds (e.g.
   *  `world` tracks `Body` instances for the broadphase). */
  private readonly _addHooks: Set<(rel: Relation) => void> = new Set();
  private readonly _removeHooks: Set<(rel: Relation) => void> = new Set();
  /** Generation counter; bumped on `_bind()`/`remove()` so the
   *  reactive driver re-fires when structural state changes. */
  private readonly _gen: Signal<number> & WritableBrand;
  /** Reactive driver — a settle that calls `step()` on signal
   *  change. Lazy-installed on first `_bind`; once `dispose()`d
   *  (e.g., by `physics()` / `world()` taking over the time loop),
   *  permanently silenced. */
  private _settle?: Settle;
  private _settleDisposed = false;

  constructor(opts: SolverOpts = {}) {
    this.solver = new Solver(opts);
    this._gen = signal(0);
    this.pipeline = reactivePipeline.slice();
  }

  // ─── Settable solver opts (proxy through to Solver) ──────────────

  get iterations(): number {
    return this.solver.iterations;
  }
  set iterations(v: number) {
    this.solver.iterations = v;
  }
  get alpha(): number {
    return this.solver.alpha;
  }
  set alpha(v: number) {
    this.solver.alpha = v;
  }
  get beta(): number {
    return this.solver.beta;
  }
  set beta(v: number) {
    this.solver.beta = v;
  }
  get gamma(): number {
    return this.solver.gamma;
  }
  set gamma(v: number) {
    this.solver.gamma = v;
  }
  get postStabilize(): boolean {
    return this.solver.postStabilize;
  }
  set postStabilize(v: boolean) {
    this.solver.postStabilize = v;
  }

  // ─── The single advance entry point ──────────────────────────────

  /** Run the pipeline once. `dt` is passed to each phase; defaults
   *  to `1` (the static-edit / reactive case where the regularizer
   *  weight is just `M`). Physics callers pass the real frame `dt`. */
  step(dt: number = 1): void {
    const p = this.pipeline;
    for (let i = 0; i < p.length; i++) p[i]!(this, dt);
  }

  // ─── Add / remove relations ──────────────────────────────────────

  /** Add one or more relations. Single-arg returns the relation;
   *  multi-arg returns an array (destructure as needed). */
  add<R extends Relation>(rel: R): R;
  add<R extends Relation>(rel1: R, rel2: R, ...rest: R[]): R[];
  add(...rels: Relation[]): Relation | Relation[] {
    for (const rel of rels) this._addOne(rel);
    return rels.length === 1 ? rels[0]! : rels;
  }

  private _addOne(rel: Relation): void {
    if (this._disposers.has(rel)) return;
    const dispose = rel.bind(this);
    this._disposers.set(rel, dispose);
    for (const fn of this._addHooks) fn(rel);
  }

  /** Add `rels` while `cond` is truthy; remove them when falsy. */
  addWhile(cond: Read<unknown>, ...rels: Relation[]): Lifecycle {
    return when(cond, () => {
      for (const r of rels) this._addOne(r);
      return () => {
        for (const r of rels) {
          const dispose = this._disposers.get(r);
          if (dispose === undefined) continue;
          dispose();
          this._disposers.delete(r);
          for (const fn of this._removeHooks) fn(r);
        }
        this._gen.value = this._gen.value + 1;
      };
    });
  }

  /** Remove a relation. No-op if not previously added. */
  remove(rel: Relation): void {
    const dispose = this._disposers.get(rel);
    if (dispose === undefined) return;
    dispose();
    this._disposers.delete(rel);
    for (const fn of this._removeHooks) fn(rel);
    this._gen.value = this._gen.value + 1;
  }

  /** Subscribe to relation-add events. Returns an unsubscribe thunk.
   *  Called synchronously from `add` after the relation's `bind` runs. */
  onAdd(fn: (rel: Relation) => void): () => void {
    this._addHooks.add(fn);
    return () => this._addHooks.delete(fn);
  }

  /** Subscribe to relation-remove events. Returns an unsubscribe thunk. */
  onRemove(fn: (rel: Relation) => void): () => void {
    this._removeHooks.add(fn);
    return () => this._removeHooks.delete(fn);
  }

  /** Tear down the reactive driver. Bound signals retain their
   *  current values but stop being constraint-driven; further
   *  `add` / `_bind` calls do NOT re-install it (this is permanent).
   *  Physics-flavored factories call this to take over the time
   *  loop — manual `step(dt)` calls are then the only way to
   *  advance. */
  dispose(): void {
    if (this._settle !== undefined) {
      this._settle.dispose();
      this._settle = undefined;
    }
    this._settleDisposed = true;
  }

  /** Number of bound signal cells (= solver cell count). */
  get cellCount(): number {
    return this._sigToCell.size;
  }

  // ─── Internals (used by Relation implementations and Phases) ────

  /** @internal — bind a signal as a cell. Idempotent: same signal
   *  returns the same cell id. Cells are append-only; once bound a
   *  signal stays bound for the cluster's lifetime. Called from
   *  Relation `bind` implementations. */
  // biome-ignore lint/suspicious/noExplicitAny: see header
  _bind(sig: Signal<any>): number {
    const existing = this._sigToCell.get(sig);
    if (existing !== undefined) return existing;
    const pack = requirePack(sig as never) as Pack<unknown>;
    const id = this.solver.addCell(pack.dim);
    pack.read(sig.peek(), this.solver.positions, this.solver.offsets[id]!);
    this._sigToCell.set(sig, id);
    this._bindings[id] = { sig, pack };
    if (this._settle === undefined && !this._settleDisposed) this._installReactiveDriver();
    this._gen.value = this._gen.value + 1;
    return id;
  }

  // ─── Reactive driver wiring ─────────────────────────────────────

  private _installReactiveDriver(): void {
    const gen = this._gen;
    this._settle = settle(_dirty => {
      // Subscribe to gen so structural edits force a re-fire.
      gen.value;
      // Run the pipeline — snapshot phase reads cell signals via
      // `.value` (so the settler subscribes), solve runs, writeback
      // writes back through settle's auto-self-exclusion + auto-batch.
      this.step();
    });
  }
}

/** Build a fresh `Constraints` holder with the reactive default
 *  pipeline. Canonical entry point for sketchpad / IK / layout
 *  scenes that don't need time integration.
 *
 *    const c = constraints({ iterations: 24 });
 *    c.add(distance(a, b, 100));
 *    c.iterations = 30;
 *
 *  For physics scenes use `physics(opts)` or `world(opts)`. */
export function constraints(opts: SolverOpts = {}): Constraints {
  return new Constraints(opts);
}
