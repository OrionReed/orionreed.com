// cluster.ts — AVBD constraints holder, built on `settle`.
//
// `constraints({...})` returns a `Constraints` instance — a holder
// for a `Solver` plus a reactive `settle` body that:
//
//   1. Subscribes to all relation members (cell signals + param signals).
//   2. Snapshots cell signals into the solver buffer.
//   3. Runs `solver.step()`.
//   4. Writes solved values back to the cell signals.
//
// Self-exclusion (settle's contract) prevents the writes from re-firing
// the body. Auto-batched commit (settle's contract) makes the writes
// glitch-free for downstream observers.
//
// Relation contract: `members: readonly Signal<unknown>[]`,
// `attach(c)`, `detach(c)`. Members include both *cells* (signals
// bound to solver storage via `c.bind(sig)`) AND *parameters*
// (mutable signals like a distance's rest length); the body reads
// every member to subscribe, and forces read their cached snapshot
// of param signals during the inner solve loop.

import {
  type Pack,
  requirePack,
  type Settle,
  type Signal,
  type Relation as SignalRelation,
  settle,
  signal,
  type WritableBrand,
} from "../signals";
import type { Force } from "./force";
import { Solver, type SolverOpts } from "./solver";

// ─── Relation interface ────────────────────────────────────────────

/** A constraint relation that lives in a `Constraints` holder.
 *  Extends the signals-level `Relation { members }` with the AVBD
 *  attach/detach lifecycle. Factories in this module return objects
 *  satisfying this; user code passes them to `c.add(rel)`. */
export interface Relation extends SignalRelation {
  attach(c: Constraints): void;
  detach(c: Constraints): void;
}

interface Binding {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic pack typing
  readonly sig: Signal<any>;
  // biome-ignore lint/suspicious/noExplicitAny: same
  readonly pack: Pack<any>;
}

// ─── Constraints ───────────────────────────────────────────────────

export class Constraints {
  /** The numerical solver underneath. Exposed for advanced users. */
  readonly solver: Solver;

  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous binding registry
  private readonly _sigToCell = new Map<Signal<any>, number>();
  private readonly _bindings: (Binding | undefined)[] = [];
  private readonly _relations = new Set<Relation>();
  /** Generation counter; bumped on `_bind()`/`remove()` so the
   *  settle re-fires when structural state lands. */
  private readonly _gen: Signal<number> & WritableBrand;
  /** Settle handle. Lazy-installed on first `add`. */
  private _settle?: Settle;

  constructor(opts: SolverOpts = {}) {
    this.solver = new Solver(opts);
    this._gen = signal(0);
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

  // ─── Add / remove relations ──────────────────────────────────────

  /** Add one or more relations. Single-arg form returns the relation;
   *  multi-arg returns an array (destructure as needed):
   *
   *    const r = c.add(distance(a, b, 100));
   *    const [r1, r2] = c.add(distance(a, b, 100), spring(b, c, 60, 200));
   */
  add<R extends Relation>(rel: R): R;
  add<R extends Relation>(rel1: R, rel2: R, ...rest: R[]): R[];
  add(...rels: Relation[]): Relation | Relation[] {
    for (const rel of rels) this._addOne(rel);
    return rels.length === 1 ? rels[0]! : rels;
  }

  private _addOne(rel: Relation): void {
    if (this._relations.has(rel)) return;
    rel.attach(this);
    this._relations.add(rel);
    if (this._settle === undefined) this._installSettle();
  }

  /** Remove a relation. No-op if not previously added. */
  remove(rel: Relation): void {
    if (!this._relations.has(rel)) return;
    rel.detach(this);
    this._relations.delete(rel);
    // Force a re-solve: removed force is gone but solver state may
    // still reflect it.
    this._gen.value = this._gen.value + 1;
  }

  /** Pin a signal already known to the solver (mass = 0). Returns an
   *  unpin thunk. The signal must already be a member of some
   *  relation (otherwise the cluster has no cell for it). Compose
   *  with `when` from settle-utils for conditional pinning:
   *
   *    when(dragging, () => c.pin(sig));  // pinned while dragging */
  // biome-ignore lint/suspicious/noExplicitAny: see header
  pin(sig: Signal<any>): () => void {
    const id = this._sigToCell.get(sig);
    if (id === undefined)
      throw new Error("pin: signal is not a member of any relation in this cluster.");
    const prev = this.solver.massOf(id);
    this.solver.setMass(id, 0);
    return () => this.solver.setMass(id, prev);
  }

  /** Tear down the cluster's settle. Bound signals retain their
   *  current values but stop being constraint-driven. Active
   *  relations stay registered (don't auto-detach) — call
   *  `dispose()` only when the cluster is being thrown away. */
  dispose(): void {
    if (this._settle !== undefined) {
      this._settle.dispose();
      this._settle = undefined;
    }
  }

  /** Number of bound signals (i.e., signals that have a solver cell). */
  get size(): number {
    return this._sigToCell.size;
  }

  /** Number of active relations. */
  get relationCount(): number {
    return this._relations.size;
  }

  // ─── Internals (used by Relation implementations via `c._bind`) ──

  /** @internal — bind a signal as a cell. Idempotent: same signal
   *  returns the same cell id. Cells are append-only; once bound a
   *  signal stays bound for the cluster's lifetime. Called from
   *  Relation `attach` implementations. */
  // biome-ignore lint/suspicious/noExplicitAny: see header
  _bind(sig: Signal<any>): number {
    const existing = this._sigToCell.get(sig);
    if (existing !== undefined) return existing;
    const pack = requirePack(sig as never) as Pack<unknown>;
    const id = this.solver.addCell(pack.dim);
    pack.read(sig.peek(), this.solver.positions, this.solver.offsets[id]!);
    this._sigToCell.set(sig, id);
    this._bindings[id] = { sig, pack };
    if (this._settle === undefined) this._installSettle();
    this._gen.value = this._gen.value + 1;
    return id;
  }

  // ─── Settle wiring ───────────────────────────────────────────────

  private _installSettle(): void {
    const solver = this.solver;
    const bindings = this._bindings;
    const relations = this._relations;
    const gen = this._gen;
    this._settle = settle(_dirty => {
      // Subscribe to gen so structural edits force a re-fire.
      gen.value;
      // Snapshot bound cell values into the solver buffer. `.value`
      // (not `.peek()`) subscribes the settler — required so external
      // mutations trigger re-fire.
      const N = solver.cellCount;
      for (let id = 0; id < N; id++) {
        const b = bindings[id];
        if (!b) continue;
        b.pack.read(b.sig.value, solver.positions, solver.offsets[id]!);
      }
      // Solve. Forces' `initialize()` runs inside `solver.step()`
      // (called from `prepare()`); each force `.value`-reads its
      // own parameter signals there, subscribing the settler to
      // them too. So mutations to a distance's rest length, a
      // bounds' lo/hi, etc. trigger re-fire through the normal
      // signal DAG without needing a separate members iteration
      // here. Inner-loop computeConstraint/computeDerivatives
      // calls use cached primitives — no signal access on the
      // hot path.
      solver.step();
      // Write back. settle's auto-self-exclusion prevents re-fire;
      // auto-batch makes the writes atomic for downstream observers.
      for (let id = 0; id < N; id++) {
        const b = bindings[id];
        if (!b) continue;
        // biome-ignore lint/suspicious/noExplicitAny: dynamic pack
        (b.sig as Signal<any>).value = b.pack.write(solver.positions, solver.offsets[id]!);
      }
    });
  }
}

/** Build a fresh `Constraints` holder. The canonical entry point
 *  (you don't need `new`).
 *
 *    const c = constraints({ iterations: 24 });
 *    c.add(distance(a, b, 100));
 *    c.iterations = 30;   // settable post-construction
 */
export function constraints(opts: SolverOpts = {}): Constraints {
  return new Constraints(opts);
}

// ─── Relation builder helper ───────────────────────────────────────

/** Build a `Relation` from member signals and a force-construction
 *  callback. Used by factories that don't need mutable parameters
 *  (the build callback captures all params at construction time).
 *
 *  For factories WITH mutable parameters, define a class that
 *  exposes setter/getter for ergonomic mutation. Members should
 *  include parameter signals so the cluster subscribes to them. */
export function defineRelation(
  members: readonly Signal<unknown>[],
  build: (c: Constraints) => Force,
): Relation {
  let force: Force | undefined;
  return {
    members,
    attach(c) {
      force = build(c);
    },
    detach(c) {
      if (force !== undefined) {
        c.solver.removeForce(force);
        force = undefined;
      }
    },
  };
}
