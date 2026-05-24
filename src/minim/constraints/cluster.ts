// cluster.ts — AVBD constraints holder, built on `settle`.
//
// `constraints({...})` returns a `Constraints` instance — a holder
// for a `Solver` plus a reactive `settle` body that:
//
//   1. Reads each bound cell signal (subscribing as deps).
//   2. Snapshots into the solver buffer.
//   3. Runs `solver.step()` (forces' `initialize()` reads any param
//      signals via `.value`, also subscribing).
//   4. Writes solved values back to the cell signals.
//
// Self-exclusion (settle's contract) prevents the writes from re-firing
// the body. Auto-batched commit (settle's contract) makes the writes
// glitch-free for downstream observers.
//
// Relation contract: a single `bind(c)` method that registers
// whatever the relation needs (cell bindings + force) and returns a
// disposer. `c.add(rel)` calls `bind`; `c.remove(rel)` calls the
// disposer. Mutable parameters live as `Signal<number>` fields on
// the relation object — read them, write them, bind them to UI.

import {
  type Pack,
  requirePack,
  type Settle,
  settle,
  type Signal,
  signal,
  type WritableBrand,
} from "../signals";
import { Solver, type SolverOpts } from "./solver";

// ─── Relation interface ────────────────────────────────────────────

/** A constraint relation. `bind(c)` does whatever setup the relation
 *  needs (cell binding, force registration, slot allocation, …) and
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
  /** The numerical solver underneath. Exposed for advanced users. */
  readonly solver: Solver;

  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous binding registry
  private readonly _sigToCell = new Map<Signal<any>, number>();
  private readonly _bindings: (Binding | undefined)[] = [];
  /** Disposers for active relations, keyed by relation reference.
   *  `add(rel)` stores the disposer here; `remove(rel)` invokes it. */
  private readonly _disposers = new Map<Relation, () => void>();
  /** Generation counter; bumped on `_bind()`/`remove()` so the
   *  settle re-fires when structural state lands. */
  private readonly _gen: Signal<number> & WritableBrand;
  /** Settle handle. Lazy-installed on first `_bind`; once disposed
   *  (e.g., by `Simulation` taking over), never re-installed. */
  private _settle?: Settle;
  private _settleDisposed = false;

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

  /** Add one or more relations. Single-arg returns the relation;
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
    if (this._disposers.has(rel)) return;
    const dispose = rel.bind(this);
    this._disposers.set(rel, dispose);
    // Settle is installed lazily by `_bind` when the first cell
    // appears. We don't re-install here: `Simulation` deliberately
    // calls `dispose()` to take over the time loop, and adding a
    // new relation while sim owns the loop should NOT resurrect
    // the cluster's settle.
  }

  /** Remove a relation. No-op if not previously added. */
  remove(rel: Relation): void {
    const dispose = this._disposers.get(rel);
    if (dispose === undefined) return;
    dispose();
    this._disposers.delete(rel);
    // Force a re-solve: removed force is gone but solver state may
    // still reflect it.
    this._gen.value = this._gen.value + 1;
  }

  /** Tear down the cluster's reactive driver. Bound signals retain
   *  their current values but stop being constraint-driven; further
   *  `add` / `_bind` calls do NOT re-install the settle (this is
   *  permanent). Use case: `Simulation` calls this to take over
   *  the time loop. */
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

  // ─── Internals (used by Relation implementations) ────────────────

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
    if (this._settle === undefined && !this._settleDisposed) this._installSettle();
    this._gen.value = this._gen.value + 1;
    return id;
  }

  // ─── Settle wiring ───────────────────────────────────────────────

  private _installSettle(): void {
    const solver = this.solver;
    const bindings = this._bindings;
    const gen = this._gen;
    this._settle = settle(_dirty => {
      // Subscribe to gen so structural edits force a re-fire.
      gen.value;
      // Snapshot bound cell values into the solver buffer. `.value`
      // (not `.peek()`) subscribes the settler to each cell signal.
      const N = solver.cellCount;
      for (let id = 0; id < N; id++) {
        const b = bindings[id];
        if (!b) continue;
        b.pack.read(b.sig.value, solver.positions, solver.offsets[id]!);
      }
      // Solve. Forces' `initialize()` runs inside `solver.step()`;
      // each force `.value`-reads its own param signals there,
      // subscribing the settler. Inner-loop computeConstraint /
      // computeDerivatives use cached primitives only — no signal
      // access on the hot path.
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

/** Build a fresh `Constraints` holder. Canonical entry point.
 *
 *    const c = constraints({ iterations: 24 });
 *    c.add(distance(a, b, 100));
 *    c.iterations = 30;   // settable post-construction
 */
export function constraints(opts: SolverOpts = {}): Constraints {
  return new Constraints(opts);
}
