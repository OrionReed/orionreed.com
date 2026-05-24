// cluster.ts — write-attribution constraint cluster, built on `settle`.
//
// The cluster is a `settle()` that:
//   1. Reads each bound signal (subscribing as deps).
//   2. Snapshots into the solver.
//   3. Runs `solver.step()`.
//   4. Writes back to each bound signal (auto-self-excluded by settle).
//
// **Termination is structural**: settle's body wraps writes in
// self-exclusion, so cluster writes can't re-trigger the cluster.
// Single solve per write batch.
//
// **Relations are values**: factories like `distance(a, b, 100)` return
// `Relation` objects (plain data + attach/detach lifecycle). Add them
// via `cluster.add(rel)`; remove via `cluster.remove(rel)`. Attach
// binds the relation's member signals to solver cells and registers
// its underlying `Force` with the solver; detach reverses both.
//
// **No internals assumed on bound signals**: `getter`/`setter`/
// `_fusedOf` untouched. Works for `Num`, `Vec`, `Box`, `Color`, custom
// classes, AND lens-derived signals (e.g. `vec.x`) — anything carrying
// the `pack` trait.
//
// **Auto-batched commit (glitch-free)**: settle wraps the body in
// `batch()`, so all the cluster's writes appear atomically to
// downstream observers.

import {
  type Pack,
  requirePack,
  type Settle,
  type Signal,
  settle,
  signal,
  type WritableBrand,
} from "../signals";
import type { Force } from "./force";
import { Solver, type SolverOpts } from "./solver";

// ─── Relation interface ────────────────────────────────────────────

/** A relation that lives in a `Cluster`. The kernel's view of "what
 *  to solve." Each relation knows the signals it touches (`members`)
 *  and how to attach/detach itself from a cluster (binding to cells,
 *  registering forces). Factory functions in this module return
 *  Relation instances; user code passes them to `cluster.add`. */
export interface Relation {
  /** Signals this relation reads/writes. The cluster uses this to
   *  decide which signals to subscribe to. */
  readonly members: readonly Signal<unknown>[];
  /** Bind this relation's members and register its forces with the
   *  cluster. Called by `cluster.add(rel)`. */
  attach(cluster: Cluster): void;
  /** Tear down: unregister forces, drop kernel-internal handles.
   *  Cells stay bound to the cluster (no automatic unbind) — same
   *  semantic as before. Called by `cluster.remove(rel)`. */
  detach(cluster: Cluster): void;
}

interface Binding {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic pack typing
  readonly sig: Signal<any>;
  // biome-ignore lint/suspicious/noExplicitAny: same
  readonly pack: Pack<any>;
}

// ─── Cluster ───────────────────────────────────────────────────────

export class Cluster {
  /** The numerical solver underneath. Exposed for advanced users. */
  readonly solver: Solver;

  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous binding registry
  private readonly _sigToCell = new Map<Signal<any>, number>();
  private readonly _bindings: (Binding | undefined)[] = [];
  /** Active relations. Reference identity. */
  private readonly _relations = new Set<Relation>();
  /** Generation counter; bumped on `bind()`/`add()`/`remove()` so the
   *  settle re-fires once new structural state lands. */
  private readonly _gen: Signal<number> & WritableBrand;
  /** Settle handle. Lazy-installed on first `add`/`bind`. */
  private _settle?: Settle;

  constructor(opts: SolverOpts = {}) {
    this.solver = new Solver(opts);
    this._gen = signal(0);
  }

  /** Bind a signal and return its cell id. Idempotent — same signal
   *  returns the same cell id. Cells are append-only; once bound a
   *  signal stays bound for the cluster's lifetime. */
  // biome-ignore lint/suspicious/noExplicitAny: see file header
  bind(sig: Signal<any>): number {
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

  /** Pin a bound signal (mass = 0). Returns an unpin thunk. The
   *  signal must already be bound (a relation that touches it must
   *  be attached, or you must call `bind()` explicitly first). */
  // biome-ignore lint/suspicious/noExplicitAny: see file header
  pin(sig: Signal<any>): () => void {
    const id = this._sigToCell.get(sig);
    if (id === undefined) throw new Error("pin: signal is not bound to this cluster.");
    const prev = this.solver.massOf(id);
    this.solver.setMass(id, 0);
    return () => this.solver.setMass(id, prev);
  }

  /** Add a relation. Calls `rel.attach(this)`, which is responsible
   *  for binding member signals (idempotently via `bind`) and
   *  registering the relation's forces with the solver.
   *
   *  Returns the relation for ergonomic chaining (`const r =
   *  cluster.add(distance(...))`). The cluster does NOT track
   *  relation identity for double-add detection — adding the same
   *  relation twice would result in duplicate force entries.
   *  (Relations as live objects belong to one cluster at a time.) */
  add<R extends Relation>(rel: R): R {
    if (this._relations.has(rel)) return rel;
    // attach calls bind() (which bumps gen → settle fires once with
    // the new bindings + any prior forces). The new force itself is
    // added by attach AFTER bind; the fire-on-bind is essentially a
    // warm-up — the actual solve with this new force happens on the
    // next signal write. Matches the original Cluster semantic of
    // "lazy solve until something actually changes."
    rel.attach(this);
    this._relations.add(rel);
    if (this._settle === undefined) this._installSettle();
    return rel;
  }

  /** Remove a relation: calls `rel.detach(this)`. No-op if the
   *  relation wasn't added. */
  remove(rel: Relation): void {
    if (!this._relations.has(rel)) return;
    rel.detach(this);
    this._relations.delete(rel);
    // Force a re-solve: the removed relation's force is gone but the
    // solver state may still reflect its constraint. Bumping gen
    // re-fires the settle, which solves and writes back without it.
    this._gen.value = this._gen.value + 1;
  }

  /** Force a re-solve on the next flush. Use after manual mutations
   *  to solver-internal state (rare; most consumers don't need this). */
  update(): void {
    this._gen.value = this._gen.value + 1;
  }

  /** Tear down the cluster's settle. Bound signals keep their current
   *  values but stop being constraint-driven. Active relations stay
   *  in the cluster's set (don't auto-detach) — call `dispose()` only
   *  when the cluster is being thrown away. */
  dispose(): void {
    if (this._settle !== undefined) {
      this._settle.dispose();
      this._settle = undefined;
    }
  }

  /** Number of bound signals. */
  get size(): number {
    return this._sigToCell.size;
  }

  /** Number of active relations. */
  get relationCount(): number {
    return this._relations.size;
  }

  // ─── Internals ───────────────────────────────────────────────────

  private _installSettle(): void {
    const solver = this.solver;
    const bindings = this._bindings;
    const gen = this._gen;
    this._settle = settle(_dirty => {
      // Subscribe to gen so structural edits force a re-fire.
      gen.value;
      // Read every bound signal: subscribes (so external mutations
      // re-fire us) + snapshots into the solver's float buffer.
      const N = solver.cellCount;
      for (let id = 0; id < N; id++) {
        const b = bindings[id];
        if (!b) continue;
        b.pack.read(b.sig.value, solver.positions, solver.offsets[id]!);
      }
      // Solve.
      solver.step();
      // Write back. settle's auto-self-exclusion ensures the cluster
      // doesn't re-fire from its own writes; auto-batch ensures
      // downstream observers see all writes atomically.
      for (let id = 0; id < N; id++) {
        const b = bindings[id];
        if (!b) continue;
        // biome-ignore lint/suspicious/noExplicitAny: dynamic pack typing
        (b.sig as Signal<any>).value = b.pack.write(solver.positions, solver.offsets[id]!);
      }
    });
  }
}

// ─── Relation builder helper ───────────────────────────────────────

/** Build a `Relation` from member signals and a force-construction
 *  callback. Used by factories that don't need mutable parameters
 *  (the build callback captures all params at construction time).
 *
 *  For factories WITH mutable parameters (e.g., `distance(a, b, len)`
 *  where `len` is a signal), construct a class that reads param
 *  signals inside its build and exposes setter/getter for ergonomic
 *  mutation. */
export function defineRelation(
  members: readonly Signal<unknown>[],
  build: (cluster: Cluster) => Force,
): Relation {
  let force: Force | undefined;
  return {
    members,
    attach(cluster) {
      force = build(cluster);
    },
    detach(cluster) {
      if (force !== undefined) {
        cluster.solver.removeForce(force);
        force = undefined;
      }
    },
  };
}
