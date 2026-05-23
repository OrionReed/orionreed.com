// cluster.ts — lazy-solve constraint cluster (no preEffect).
//
// Design: a `Cluster` is a graph node that owns a set of bound
// signals coupled by a constraint solver. Reactive integration
// uses two existing signal primitives — `signal()` and the
// existing computed-style `getter`/`setter` install — instead of
// inventing a new `preEffect` concept.
//
// Lifecycle of a write:
//
//   1. `sig.value = X` calls `sig.setter(X)`.
//   2. The setter writes `X` into the cluster's positions buffer
//      (the solver's `positions[off+k]`) and increments a per-
//      cluster pulse signal: `cluster._pulse.value++`.
//   3. The pulse increment triggers normal alien-signals dirty
//      propagation. Every cluster signal subscribes to the pulse
//      via its getter, so they all transition to Pending. Their
//      effect-subscribers re-fire as usual.
//
// Lifecycle of a read:
//
//   1. `sig.value` calls `sig.getter()`.
//   2. The getter reads `cluster._pulse.value` (re-establishes
//      subscription, marks this getter clean once update runs).
//   3. If `cluster._dirty`, run the solver in place on
//      `positions`; clear the dirty flag.
//   4. Return the typed value via `pack.write(positions, off)`.
//
// Properties:
//
//   - **Pure pull semantics**. Solve runs on the first read after
//     a write, never speculatively. Multiple writes between reads
//     coalesce into a single solve naturally.
//   - **No `preEffect`**. The signal layer's existing dirty
//     propagation handles ordering: subscribers see solved values
//     because `getter` solves before returning.
//   - **No phase ordering hacks**. No "pre-flush queue", no
//     `RecursedCheck` self-mute trickery.
//   - **No monkey-patching**. We mutate the bound signal in place
//     by installing `getter`/`setter` — same mechanism `lensTo` /
//     `computed` use to behave like read-write derived nodes.
//
// Trade-off: writing a bound signal and then immediately reading
// it (without an intermediate read of any other cluster signal)
// returns the *solved* value, not what was written — unless the
// signal is pinned via `cluster.pin(sig)`. This matches what
// other subscribers see, but differs from a plain `Signal` where
// `s.value = X; s.value` is X. Worth being explicit about.

import { type Pack, requirePack, signal, type Signal, type WritableBrand } from "../signals";
import { Solver, type SolverOpts } from "../_proto-avbd/solver";

interface Binding {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic pack typing across signal classes
  readonly sig: Signal<any>;
  // biome-ignore lint/suspicious/noExplicitAny: same
  readonly pack: Pack<any>;
}

export class Cluster {
  /** The numerical solver underneath. Exposed for advanced users
   *  who want to add raw-cell forces or read solver state directly. */
  readonly solver: Solver;

  /** Pulse signal that fires on every cluster write. Cluster
   *  signals subscribe to this via their getters, so any write
   *  propagates dirty to all of them. */
  private readonly _pulse: Signal<number> & WritableBrand;
  private _dirty = false;

  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous binding registry
  private readonly _sigToCell = new Map<Signal<any>, number>();
  private readonly _bindings: (Binding | undefined)[] = [];

  constructor(opts: SolverOpts = {}) {
    this.solver = new Solver(opts);
    this._pulse = signal(0);
  }

  /** Bind a `Signal` (any value class declaring the `pack` trait
   *  — `Num`, `Vec`, `Box`, `Color`, …) to this cluster. The
   *  signal's `getter`/`setter` are replaced so reads/writes flow
   *  through the cluster. Repeat calls return the same cell id. */
  // biome-ignore lint/suspicious/noExplicitAny: see Bindable
  bind(sig: Signal<any>): number {
    const existing = this._sigToCell.get(sig);
    if (existing !== undefined) return existing;
    const pack = requirePack(sig as never) as Pack<unknown>;
    const id = this.solver.addCell(pack.dim);
    pack.read(sig.peek(), this.solver.positions, this.solver.offsets[id]!);
    this._sigToCell.set(sig, id);
    this._bindings[id] = { sig, pack };

    // Replace the signal's get/set behaviour. From here on this
    // signal acts like a lens onto the cluster's positions buffer.
    // We use the same `getter`/`setter` slots that `lensTo` and
    // `computed` use — no new signal-layer mechanism needed.
    const cluster = this;
    const off = this.solver.offsets[id]!;
    const pulse = this._pulse;
    // biome-ignore lint/suspicious/noExplicitAny: same as Bindable variance escape
    const sigAny = sig as any;
    sigAny.getter = () => {
      pulse.value; // subscribe — re-fires on cluster writes
      if (cluster._dirty) cluster._solve();
      return pack.write(cluster.solver.positions, off);
    };
    sigAny.setter = (v: unknown) => {
      pack.read(v, cluster.solver.positions, off);
      cluster._dirty = true;
      pulse.value = pulse.value + 1;
    };
    // Reset signal flags so the get/set hot path takes the
    // computed/lens branch (which honours getter/setter).
    sigAny.flags = 0;

    return id;
  }

  /** Pin a bound signal (`mass = 0`). Returns an `unpin` thunk. */
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

  /** Number of bound signals. */
  get size(): number {
    return this._sigToCell.size;
  }

  // ─── Internals ───────────────────────────────────────────────────

  private _solve(): void {
    this.solver.step();
    this._dirty = false;
  }
}
