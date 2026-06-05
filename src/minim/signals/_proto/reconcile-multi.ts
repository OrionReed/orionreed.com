// Reconciliation, generalized — recursive backward over a lens DAG, with STATE
// at any node (not just roots). This corrects the "roots are the only state"
// overclaim from reconcile.ts.
//
// Honest model of STATE = the graph's free degrees of freedom:
//   * a ROOT is a cell with no parent — fully free (state).
//   * a PURE lens has zero free DOF — fully determined by its parents.
//   * a STATEFUL lens carries a COMPLEMENT — its own free DOF, living ON the
//     lens (matching the production engine's StatefulCore), NOT a root.
//
// A backward write distributes RECURSIVELY up the DAG. At each node it may:
//   * update lens-local complement, and/or
//   * emit a target for each parent (`undefined` ⇒ leave that parent — stop
//     the branch), recursing into the rest.
// Therefore a write can terminate having moved ONLY a complement, or — if every
// hop is a per-hop no-op — having moved NOTHING. It is never *necessary* for an
// upstream root to move. That is the property reconcile.ts hid.
//
// (This prototype is EAGER — writes resolve immediately — to isolate the
// state/recursion semantics from the lazy-pull machinery already validated in
// reconcile.ts. `step` / forward-direction complement evolution is out of
// scope here; this covers the backward direction.)

const eq = Object.is;
const counts = { bwd: 0, recompute: 0, commit: 0, effectRun: 0 };
const reset = (): void => {
  counts.bwd = counts.recompute = counts.commit = counts.effectRun = 0;
};

// ─── Graph core ─────────────────────────────────────────────────────

type Dependent = Computed | Bilens | Effect;
type Stateful = Root | Bilens; // nodes that can hold pending state
let observer: Dependent | undefined;
let batchDepth = 0;
// Monotonic id for the current backward-resolve pass. `staged()` memoizes its
// fold under this id so a single write folds each node once (O(depth), not
// O(depth²)); `flush` bumps it once all pendings are committed.
let pass = 0;
const dirty = new Set<Stateful>();
const pendingEffects = new Set<Effect>();

function flush(): void {
  let guard = 0;
  while (dirty.size > 0 || pendingEffects.size > 0) {
    if (++guard > 1_000_000) throw new Error("no convergence");
    for (const n of [...dirty]) n.commit();
    const fire = [...pendingEffects];
    pendingEffects.clear();
    for (const e of fire) e.run();
  }
  pass++; // invalidate all per-pass staged() memos; pendings are gone
}

export function batch(fn: () => void): void {
  batchDepth++;
  try {
    fn();
  } finally {
    if (--batchDepth === 0) flush();
  }
}

function invalidate(node: Root | Computed | Bilens): void {
  for (const sub of node.subs) {
    if (sub instanceof Effect) pendingEffects.add(sub);
    else if (sub.valid) {
      sub.valid = false;
      invalidate(sub);
    }
  }
}

/** Backward resolve, recursive. Distributes `target` up the DAG; per-hop stop
 *  at any node (root OR lens) whose current value already equals its target. */
function resolve(node: Stateful, target: unknown): void {
  if (node instanceof Root) {
    if (!eq(target, node.staged())) {
      node.pending = { v: target };
      node.svVal = target; // keep this pass's memo coherent for later siblings
      node.svPass = pass;
      dirty.add(node);
    }
    return;
  }
  // Bilens
  if (eq(target, node.staged())) return; // per-hop stop — may be this lens node
  counts.bwd++;
  const pvals = node.parents.map(p => p.staged());
  const c = node.stagedComplement();
  const { updates, complement } = node.bwd(target, pvals, c);
  if (!eq(complement, c)) {
    node.pendingComplement = { v: complement };
    node.svPass = -1; // staged depends on complement+parents; force recompute
    dirty.add(node);
  }
  for (let i = 0; i < updates.length; i++) {
    if (updates[i] !== undefined) resolve(node.parents[i], updates[i]);
  }
}

export function write(node: Stateful, target: unknown): void {
  resolve(node, target);
  if (batchDepth === 0) flush();
}

export function untracked<T>(fn: () => T): T {
  const prev = observer;
  observer = undefined;
  try {
    return fn();
  } finally {
    observer = prev;
  }
}

// ─── Root: a free DOF (state). ──────────────────────────────────────

export class Root<T = unknown> {
  current: T;
  pending: { v: T } | undefined;
  svPass = -1;
  svVal: T = undefined as T;
  readonly subs = new Set<Dependent>();
  constructor(v: T) {
    this.current = v;
  }
  /** Value including any uncommitted pending write (sequential within a batch). */
  staged(): T {
    if (this.svPass === pass) return this.svVal;
    this.svVal = this.pending !== undefined ? this.pending.v : this.current;
    this.svPass = pass;
    return this.svVal;
  }
  get(): T {
    if (this.pending !== undefined) this.commit();
    if (observer !== undefined) {
      this.subs.add(observer);
      observer.deps.add(this);
    }
    return this.current;
  }
  commit(): void {
    const p = this.pending;
    dirty.delete(this);
    if (p === undefined) return;
    this.pending = undefined;
    counts.commit++;
    if (!eq(p.v, this.current)) {
      this.current = p.v;
      invalidate(this);
    }
  }
}

// ─── Computed: pure forward observer (read-only, not in backward paths). ──

export class Computed<T = unknown> {
  cached: T = undefined as T;
  valid = false;
  readonly deps = new Set<Root | Computed | Bilens>();
  readonly subs = new Set<Dependent>();
  constructor(readonly fn: () => T) {}
  get(): T {
    if (!this.valid) {
      counts.recompute++;
      for (const d of this.deps) d.subs.delete(this);
      this.deps.clear();
      const prev = observer;
      observer = this;
      try {
        this.cached = this.fn();
        this.valid = true;
      } finally {
        observer = prev;
      }
    }
    if (observer !== undefined) {
      this.subs.add(observer);
      observer.deps.add(this);
    }
    return this.cached;
  }
}

// ─── Effect: a watcher; re-runs when a dep actually changed. ─────────

export class Effect {
  readonly deps = new Set<Root | Computed | Bilens>();
  disposed = false;
  constructor(readonly body: () => void) {
    this.run();
  }
  run(): void {
    if (this.disposed) return;
    counts.effectRun++;
    for (const d of this.deps) d.subs.delete(this);
    this.deps.clear();
    const prev = observer;
    observer = this;
    try {
      this.body();
    } finally {
      observer = prev;
    }
  }
  dispose(): void {
    this.disposed = true;
    for (const d of this.deps) d.subs.delete(this);
    this.deps.clear();
    pendingEffects.delete(this);
  }
}

// ─── Bilens: forward fn of parents (+ complement); recursive backward. ──

export interface Bwd {
  /** Per-parent target; `undefined` ⇒ leave that parent (stop the branch). */
  updates: (unknown | undefined)[];
  /** New complement (lens-local state); equal to the old one ⇒ unchanged. */
  complement: unknown;
}

// Handlers are stored over `unknown` (T appears only covariantly, in `get()`),
// so `Bilens<T>` is assignable to `Bilens<unknown>`. Typed construction goes
// through the `lens` / `statefulLens` / `lensN` factories.
export class Bilens<T = unknown> {
  valid = false;
  cached: unknown;
  complement: unknown;
  pendingComplement: { v: unknown } | undefined;
  readonly deps = new Set<Root | Computed | Bilens>();
  readonly subs = new Set<Dependent>();
  constructor(
    readonly parents: Stateful[],
    readonly fwd: (parentVals: unknown[], complement: unknown) => unknown,
    readonly bwd: (target: unknown, parentVals: unknown[], complement: unknown) => Bwd,
    complement: unknown = null,
  ) {
    this.complement = complement;
  }
  svPass = -1;
  svVal: unknown;
  /** Forward value from STAGED parents + staged complement (for resolve). */
  staged(): unknown {
    if (this.svPass === pass) return this.svVal;
    this.svVal = this.fwd(
      this.parents.map(p => p.staged()),
      this.stagedComplement(),
    );
    this.svPass = pass;
    return this.svVal;
  }
  stagedComplement(): unknown {
    return this.pendingComplement !== undefined ? this.pendingComplement.v : this.complement;
  }
  get(): T {
    if (!this.valid) {
      counts.recompute++;
      for (const d of this.deps) d.subs.delete(this);
      this.deps.clear();
      const prev = observer;
      observer = this;
      try {
        this.cached = this.fwd(
          this.parents.map(p => p.get()),
          this.complement,
        );
        this.valid = true;
      } finally {
        observer = prev;
      }
    }
    if (observer !== undefined) {
      this.subs.add(observer);
      observer.deps.add(this);
    }
    return this.cached as T;
  }
  commit(): void {
    const p = this.pendingComplement;
    dirty.delete(this);
    if (p === undefined) return;
    this.pendingComplement = undefined;
    counts.commit++;
    if (!eq(p.v, this.complement)) {
      this.complement = p.v;
      this.valid = false;
      invalidate(this);
    }
  }
}

// ─── Lens constructors ──────────────────────────────────────────────

/** Pure single-parent lens (no state). */
export function lens<P, T>(
  parent: Stateful,
  fwd: (p: P) => T,
  put: (target: T, current: P) => P,
): Bilens<T> {
  return new Bilens<T>(
    [parent],
    pv => fwd(pv[0] as P),
    (t, pv) => ({ updates: [put(t as T, pv[0] as P)], complement: null }),
  );
}

/** Stateful lens: complement lives on the lens; `bwd` may leave the parent. */
export function statefulLens<P, T, C>(
  parent: Stateful,
  fwd: (p: P, c: C) => T,
  bwd: (target: T, p: P, c: C) => { update: P | undefined; complement: C },
  init: C,
): Bilens<T> {
  return new Bilens<T>(
    [parent],
    (pv, c) => fwd(pv[0] as P, c as C),
    (t, pv, c) => {
      const r = bwd(t as T, pv[0] as P, c as C);
      return { updates: [r.update], complement: r.complement };
    },
    init,
  );
}

/** N→M lens: `bwd` returns per-parent updates (`undefined` ⇒ leave parent). */
export function lensN<T>(
  parents: Stateful[],
  fwd: (vals: unknown[]) => T,
  bwd: (target: T, vals: unknown[]) => (unknown | undefined)[],
): Bilens<T> {
  return new Bilens<T>(
    parents,
    pv => fwd(pv),
    (t, pv) => ({ updates: bwd(t as T, pv), complement: null }),
  );
}

// ─── Case studies: state beyond roots, writes that stop partway ─────

export function runDemo(): void {
  let failures = 0;
  const check = (name: string, cond: boolean, detail = ""): void => {
    if (!cond) failures++;
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };

  console.log("reconciliation (recursive) — state beyond roots\n");

  // CS1: an absorb-all stateful lens. Every write lands ENTIRELY in the lens's
  // complement; the upstream root NEVER moves, and the root's sibling view is
  // never recomputed. This is the case "roots are the only state" denied.
  {
    reset();
    const r = new Root(5);
    const sibling = lens(
      r,
      (x: number) => x * 10,
      (t: number) => t / 10,
    );
    const s = statefulLens<number, number, number>(
      r,
      (x, c) => x + c, // view = root + complement
      (t, x) => ({ update: undefined, complement: t - x }), // absorb all into complement, never touch root
      0,
    );
    let rRuns = 0;
    let sibRuns = 0;
    let sRuns = 0;
    new Effect(() => {
      void r.get();
      rRuns++;
    });
    new Effect(() => {
      void sibling.get();
      sibRuns++;
    });
    new Effect(() => {
      void s.get();
      sRuns++;
    });
    const r0 = rRuns;
    const sib0 = sibRuns;
    const s0 = sRuns;
    write(s, 12);
    check("absorb-all: view follows write", s.get() === 12, `s=${s.get()}`);
    check("absorb-all: ROOT never moved", r.current === 5, `r=${r.current}`);
    check("absorb-all: complement holds the state", s.complement === 7, `c=${s.complement}`);
    check("absorb-all: root effect NOT re-run", rRuns === r0, `+${rRuns - r0}`);
    check("absorb-all: sibling view NOT re-run", sibRuns === sib0, `+${sibRuns - sib0}`);
    check("absorb-all: the lens's own view re-ran once", sRuns === s0 + 1, `+${sRuns - s0}`);
  }

  // CS2: snap-to-grid. Sub-cell nudges land in the complement (offset); only when
  // the write crosses a cell boundary does the parent root move. Here the lens
  // always emits the cell as the parent target, and `resolve`'s own per-hop check
  // drops it when the cell is unchanged — the automatic complement to `undefined`.
  {
    reset();
    const step = 10;
    const grid = new Root(0); // cell base (multiple of step)
    const pos = statefulLens<number, number, number>(
      grid,
      (g, off) => g + off, // view = base + offset
      (t, _g) => {
        const cell = Math.floor(t / step) * step;
        const off = t - cell;
        return { update: cell, complement: off }; // returns the cell; resolve's per-hop drops it if unchanged
      },
      3, // initial offset → view = 3
    );
    check("grid: starts at 3", pos.get() === 3);
    write(pos, 7); // same cell (0) → root untouched, offset 3→7
    check(
      "grid: sub-cell write keeps root",
      grid.current === 0 && pos.complement === 7 && pos.get() === 7,
      `g=${grid.current} c=${pos.complement}`,
    );
    write(pos, 13); // cell 10 → root moves, offset→3
    check(
      "grid: crossing the cell moves root",
      grid.current === 10 && pos.complement === 3 && pos.get() === 13,
      `g=${grid.current} c=${pos.complement}`,
    );
  }

  // CS3: recursive multi-parent fan-out. A centroid over TWO deep lens chains;
  // one write distributes recursively down both chains to two distinct roots.
  {
    reset();
    const ra = new Root(0);
    const rb = new Root(0);
    const chain = (root: Root): Bilens<number> => {
      let n: Stateful = root;
      for (let i = 0; i < 3; i++) {
        n = lens(
          n,
          (x: number) => x + 1,
          (t: number) => t - 1,
        );
      }
      return n as Bilens<number>;
    };
    const a = chain(ra); // ra + 3
    const b = chain(rb); // rb + 3
    const mean = lensN<number>(
      [a, b],
      pv => ((pv[0] as number) + (pv[1] as number)) / 2,
      (t, pv) => {
        const d = t - ((pv[0] as number) + (pv[1] as number)) / 2;
        return [(pv[0] as number) + d, (pv[1] as number) + d];
      },
    );
    check("fan-out: mean starts at 3", mean.get() === 3);
    write(mean, 8); // delta +5 to each chain → each root +5
    check("fan-out: mean follows", mean.get() === 8, `mean=${mean.get()}`);
    check(
      "fan-out: distributed recursively to BOTH deep roots",
      ra.current === 5 && rb.current === 5,
      `ra=${ra.current} rb=${rb.current}`,
    );
  }

  // CS4: a TRUE no-op write — writing the current value moves nothing at all.
  // No root, no complement; per-hop stops at the written node; zero commits/fires.
  {
    reset();
    const r = new Root(4);
    const s = statefulLens<number, number, number>(
      r,
      (x, c) => x + c,
      (t, x) => ({ update: undefined, complement: t - x }),
      0,
    );
    let runs = 0;
    new Effect(() => {
      void s.get();
      runs++;
    });
    const cur = s.get();
    const runs0 = runs;
    const commits0 = counts.commit;
    write(s, cur); // write current value back
    check(
      "no-op: nothing committed",
      counts.commit === commits0,
      `commits +${counts.commit - commits0}`,
    );
    check("no-op: effect not re-run", runs === runs0, `+${runs - runs0}`);
    check("no-op: complement unchanged", s.complement === 0);
    check("no-op: root unchanged", r.current === 4);
  }

  // CS5: the complement IS observable state, but it is NOT a root — it has a
  // parent (the lens's source) and is owned by the lens. Writing the root
  // forward still flows through; the complement persists across it.
  {
    reset();
    const r = new Root(5);
    const s = statefulLens<number, number, number>(
      r,
      (x, c) => x + c,
      (t, x) => ({ update: undefined, complement: t - x }),
      0,
    );
    write(s, 12); // complement = 7, root still 5, view 12
    write(r, 100); // forward change to the root; complement (7) persists
    check(
      "complement persists across a forward root write",
      s.get() === 107 && s.complement === 7,
      `s=${s.get()} c=${s.complement}`,
    );
  }

  console.log(
    `\n${failures === 0 ? "ALL PASS — state lives at roots AND complements" : `${failures} FAILURE(S)`}`,
  );
}
