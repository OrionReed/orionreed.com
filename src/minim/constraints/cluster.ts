// cluster.ts — the `Constraints` holder.
//
// Holds a `Solver`, a registry of relations, and a `pipeline` of
// phases run on every `step(dt)`. The default reactive pipeline plus
// a driver that fires on bound-signal changes make a freshly
// constructed `Constraints` a sketchpad-style reactive solver with
// no further setup.
//
// Specialised factories (`physics`, `world`, …) overwrite the
// pipeline, allocate their own per-cell state, and dispose the
// reactive driver to take over the time loop.
//
// Relation contract: `bind(c)` registers what the relation needs and
// returns a disposer. `c.add(rel)` calls `bind`; `c.remove(rel)`
// calls the disposer.

import {
  type Cell,
  cell,
  type Lifecycle,
  type Network,
  network,
  type Pack,
  type Read,
  requirePack,
  type Writable,
} from "../signals";
import { when } from "../signals/network-utils";
import { type Phase, reactivePipeline } from "./phases";
import { Solver, type SolverOpts } from "./solver";

// ─── Relation interface ────────────────────────────────────────────

/** A constraint relation. `bind(c)` sets up (cell binding, term
 *  registration, …) and returns a disposer. */
export interface Relation {
  bind(c: Constraints): () => void;
}

interface Binding {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic pack typing
  readonly sig: Cell<any>;
  // biome-ignore lint/suspicious/noExplicitAny: same
  readonly pack: Pack<any>;
}

// ─── Constraints ───────────────────────────────────────────────────

export class Constraints {
  /** The numerical solver underneath. Phases read/write its buffers. */
  readonly solver: Solver;

  /** Phases run on each `step(dt)`. Mutable — factories specialise by
   *  reassigning. Defaults to the reactive pipeline. */
  pipeline: Phase[];

  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous binding registry
  private readonly _sigToCell = new Map<Cell<any>, number>();
  private readonly _bindings: (Binding | undefined)[] = [];
  /** Active-relation disposers, keyed by relation reference. */
  private readonly _disposers = new Map<Relation, () => void>();
  /** Add / remove hooks for factories tracking relation kinds (e.g.
   *  `world` tracks `Body` instances for the broadphase). */
  private readonly _addHooks: Set<(rel: Relation) => void> = new Set();
  private readonly _removeHooks: Set<(rel: Relation) => void> = new Set();
  /** Bumped on structural change so the reactive driver re-fires. */
  private readonly _gen: Writable<Cell<number>>;
  /** Reactive driver: a network calling `step()` on signal change.
   *  Lazy-installed on first `_bind`; permanently silenced once
   *  `dispose()`d (e.g. when physics/world take the time loop). */
  private _network?: Network;
  private _networkDisposed = false;

  constructor(opts: SolverOpts = {}) {
    this.solver = new Solver(opts);
    this._gen = cell(0);
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

  /** Run the pipeline once. `dt` defaults to `1` (static-edit case);
   *  physics callers pass the real frame `dt`. */
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
        this._gen.value += 1;
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
    this._gen.value += 1;
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

  /** Tear down the reactive driver, permanently — later `add`/`_bind`
   *  won't re-install it. Bound signals keep their values but stop
   *  being constraint-driven; `step(dt)` is the only way to advance.
   *  Physics-flavored factories call this to take the time loop. */
  dispose(): void {
    if (this._network !== undefined) {
      this._network.dispose();
      this._network = undefined;
    }
    this._networkDisposed = true;
  }

  /** Number of bound signal cells (= solver cell count). */
  get cellCount(): number {
    return this._sigToCell.size;
  }

  // ─── Internals (used by Relation implementations and Phases) ────

  /** @internal — bind a signal as a cell. Idempotent (same signal →
   *  same id); cells are append-only for the cluster's lifetime. */
  // biome-ignore lint/suspicious/noExplicitAny: see header
  _bind(sig: Cell<any>): number {
    const existing = this._sigToCell.get(sig);
    if (existing !== undefined) return existing;
    const pack = requirePack(sig as never) as Pack<unknown>;
    const id = this.solver.addCell(pack.dim);
    pack.read(sig.peek(), this.solver.positions, this.solver.offsets[id]!);
    this._sigToCell.set(sig, id);
    this._bindings[id] = { sig, pack };
    if (this._network === undefined && !this._networkDisposed) {
      this._installReactiveDriver();
    } else if (this._network !== undefined) {
      // Network already running — subscribe the new cell so its later
      // `.value` mutations fire the body and trigger a solve.
      this._network.subscribe(sig);
    }
    this._gen.value += 1;
    return id;
  }

  /** @internal — subscribe a reactive Term parameter. Without this,
   *  mutating the param wouldn't fire the network (body reads don't
   *  auto-track). Called from relations with reactive params. */
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous params
  _trackParam(sig: Cell<any>): void {
    if (this._network !== undefined) this._network.subscribe(sig);
    else this._pendingParamDeps.push(sig);
  }
  /** Params bound before the network existed; folded in at install. */
  // biome-ignore lint/suspicious/noExplicitAny: same
  private _pendingParamDeps: Cell<any>[] = [];

  // ─── Reactive driver wiring ─────────────────────────────────────

  private _installReactiveDriver(): void {
    const gen = this._gen;
    // Initial deps: gen, every bound cell signal, and params
    // registered before the network came up.
    const initialDeps: Cell<unknown>[] = [gen as Cell<unknown>];
    for (const [sig] of this._sigToCell) initialDeps.push(sig as Cell<unknown>);
    for (const sig of this._pendingParamDeps) initialDeps.push(sig as Cell<unknown>);
    this._pendingParamDeps.length = 0;
    this._network = network(initialDeps, () => {
      // Explicit-deps mode: body reads don't subscribe; deps come from
      // the initial array + later `subscribe(...)` in `_bind`/`_trackParam`.
      this.step();
    });
  }
}

/** Build a reactive `Constraints` (sketchpad / IK / layout, no time
 *  integration). For physics use `physics(opts)` or `world(opts)`.
 *
 *    const c = constraints({ iterations: 24 });
 *    c.add(distance(a, b, 100));
 *    c.iterations = 30;
 */
export function constraints(opts: SolverOpts = {}): Constraints {
  return new Constraints(opts);
}
