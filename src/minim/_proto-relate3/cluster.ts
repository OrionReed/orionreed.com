// cluster.ts — write-attribution constraint cluster.
//
// The cluster is just a regular `effect()` that:
//   1. Reads each bound signal (subscribing as deps).
//   2. Snapshots into the solver.
//   3. Runs solver.step().
//   4. Writes back to each bound signal via `sig.writeBack(...)`,
//      which propagates to other subs but excludes the cluster
//      effect itself from notification.
//
// **Termination is structural**: `writeBack` skips this effect from
// `propagate`, so the writes can't re-trigger the effect. No
// convergence, no `_equals` rounding, no second iteration. Single
// solve per write batch.
//
// **No internals assumed**: bound signals are not modified. Their
// `getter`, `setter`, `_fusedOf` — all untouched. The cluster
// works with `Num`, `Vec`, `Box`, `Color`, custom subclasses, AND
// lens-derived signals (e.g. `vec.x`) — anything carrying the
// `pack` trait.
//
// **Lens compatible**: writing through a lens just calls its bwd,
// which writes the parent. The parent's normal propagation
// happens; the cluster doesn't reach into lens internals.
//
// Trade-off: the cluster runs in normal effect-queue order. If a
// UI effect is registered before the cluster, the UI sees stale
// state on the first run after a write, then refreshes on the
// second run (after the cluster's writes). In typical app
// structure, constraints are declared early (before UI) so the
// natural order is constraint → UI → no staleness. If a hard
// pre-flush guarantee is needed later, that's a separate generic
// feature (effect priority) that can be added orthogonally.

import { type Pack, requirePack, effect, signal, type Signal, type WritableBrand } from "../signals";
import { Solver, type SolverOpts } from "../_proto-avbd/solver";

interface Binding {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic pack typing
  readonly sig: Signal<any>;
  // biome-ignore lint/suspicious/noExplicitAny: same
  readonly pack: Pack<any>;
}

export class Cluster {
  /** The numerical solver underneath. Exposed for advanced users. */
  readonly solver: Solver;

  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous binding registry
  private readonly _sigToCell = new Map<Signal<any>, number>();
  private readonly _bindings: (Binding | undefined)[] = [];

  /** Generation counter as a signal. Each `bind()` bumps it; the
   *  cluster effect subscribes to it so newly-bound signals get
   *  picked up on the next effect run. Cheap: one signal write +
   *  one effect re-run per bind, regardless of cluster size. */
  private readonly _gen: Signal<number> & WritableBrand;
  /** Cluster effect handle (`undefined` before first bind). */
  private _disposeEffect?: () => void;

  constructor(opts: SolverOpts = {}) {
    this.solver = new Solver(opts);
    this._gen = signal(0);
  }

  /** Bind a `Signal` to this cluster and return its cell id. */
  // biome-ignore lint/suspicious/noExplicitAny: see Bindable
  bind(sig: Signal<any>): number {
    const existing = this._sigToCell.get(sig);
    if (existing !== undefined) return existing;
    const pack = requirePack(sig as never) as Pack<unknown>;
    const id = this.solver.addCell(pack.dim);
    pack.read(sig.peek(), this.solver.positions, this.solver.offsets[id]!);
    this._sigToCell.set(sig, id);
    this._bindings[id] = { sig, pack };

    if (this._disposeEffect === undefined) this._installEffect();
    // Bump generation. The cluster effect is subscribed to `_gen`,
    // so this re-fires it; the effect's next run picks up this
    // new binding as a dep alongside the existing ones.
    this._gen.value = this._gen.value + 1;
    return id;
  }

  /** Pin a bound signal (`mass = 0`). Returns an unpin thunk. */
  // biome-ignore lint/suspicious/noExplicitAny: see Bindable
  pin(sig: Signal<any>): () => void {
    const id = this._sigToCell.get(sig);
    if (id === undefined) {
      throw new Error("pin: signal is not bound to this cluster.");
    }
    const prev = this.solver.massOf(id);
    this.solver.setMass(id, 0);
    return () => this.solver.setMass(id, prev);
  }

  /** Tear down the cluster's effect. Bound signals retain their
   *  current values but stop being constraint-driven. */
  dispose(): void {
    if (this._disposeEffect !== undefined) {
      this._disposeEffect();
      this._disposeEffect = undefined;
    }
  }

  /** Number of bound signals. */
  get size(): number {
    return this._sigToCell.size;
  }

  // ─── Internals ───────────────────────────────────────────────────

  private _installEffect(): void {
    const solver = this.solver;
    const bindings = this._bindings;
    const gen = this._gen;
    this._disposeEffect = effect(() => {
      // Subscribe to gen so new binds re-fire us.
      gen.value;
      // Read every bound signal (subscribes; refreshes deps each
      // run so newly-bound signals are picked up).
      const N = solver.cellCount;
      for (let id = 0; id < N; id++) {
        const b = bindings[id];
        if (!b) continue;
        b.pack.read(b.sig.value, solver.positions, solver.offsets[id]!);
      }
      // Solve.
      solver.step();
      // Write back, excluding self via `writeBack`. Structural
      // termination guarantee: the cluster effect is in `sig.subs`
      // (we read it above), but propagate skips it, so we can't
      // re-trigger ourselves.
      for (let id = 0; id < N; id++) {
        const b = bindings[id];
        if (!b) continue;
        // biome-ignore lint/suspicious/noExplicitAny: dynamic pack typing
        (b.sig as Signal<any>).writeBack(b.pack.write(solver.positions, solver.offsets[id]!));
      }
    });
  }
}
