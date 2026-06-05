# Bidirectional engine — prototype notes & resume point

A working journal for the "find the correct-by-construction + fast bidirectional
architecture" thread. Read this first when resuming. The shipped engine
(`../signal.ts`) is still the production one; everything in `_proto/` is
exploration toward a foundationally cleaner successor.

---

## 1. The thesis (reconciliation model)

A forward write and a backward write are **the same operation**. Both stage a
pending value on some state and push invalidation; the getter pulls. The only
difference is *what* gets staged:

- forward write → a **literal** on a root (`root := v`)
- backward write → resolve the view's target *up the DAG* into per-root targets,
  staging each (a thunk / put-chain); the getter pulls as usual.

State is **not** only at roots. It lives at roots **and** on stateful lens
complements. A backward write can stop partway — landing entirely in a lens's
complement with **no root touched** (this killed the earlier "roots are the only
state" overclaim; see CS1/CS5 in `reconcile-multi.ts`).

### Backward no-op semantics (settled in `reconcile-noop.ts`)

Three candidate "stop" rules were compared empirically:

1. **source-level** — propagate to root, stop if root unchanged. ❌ drifts (FP),
   over-fires.
2. **per-hop** — at each node (lens *or* root) compare incoming target to the
   node's current value; equal ⇒ stop that branch. ✅ **chosen.** It's the true
   dual of forward memoization, prevents FP drift, sound with siblings.
3. **view-change** — write, re-derive the view, discard if view unchanged. ❌
   unsound: ignores sibling views, silently suppresses their writes.

"Stop propagation" explicitly means a write may terminate at a **lens** node, not
just a root. ("source" is overloaded; we use **root** for non-lens non-derived
state.)

---

## 2. File map (`_proto/`)

| file | what it is |
|---|---|
| `reconcile.ts` | First reconciliation sketch. **Single-parent** chains. Has the precompiled per-lens resolver + iterative forward-fold (avoids the O(depth²) trap and deep-chain stack overflow) + `composes`/`prev` pending-chain for sequential read-after-write within a batch. `pendingKind` flat-field idea (alien `F`-style). Models a stateful complement as an *auxiliary root* — a reframe, not the truth. |
| `reconcile-multi.ts` | **The general engine.** Recursive backward over a lens **DAG**; state at roots AND on lens complements (matches production `StatefulCore`); multi-parent splits; per-hop stop. This is the one wired into the real suite. Exports `Root`, `Computed`, `Effect`, `Bilens`, `lens`, `statefulLens`, `lensN`, `batch`, `write`, `untracked`, `runDemo`. |
| `reconcile-multi.demo.ts` | Runs the 17 inline case studies: `npx vite-node …/reconcile-multi.demo.ts`. |
| `reconcile-noop.ts` | The 3-way no-op semantics comparison (above). |
| `reconcile-alloc.bench.ts` | Pending representation micro-bench: closure-per-write vs flat-object vs flat-fields. Flat fields (alien `F`) win ~3× in drag patterns; precompiled resolver beats per-write closure. |
| `descriptors.ts` | Lens-fusion idea (compose static lens chains into one fwd/put at construction; O(depth)→O(1)). **Deferred** — known optimization, topo-dependent constant. |
| `signal-pp.ts`, `pp.*` | Push-pull forward experiments. |
| `signal-bp.ts`, `bp.test.ts`, `push-pull-bwd.ts` | BwdPending / push-pull-backward experiments. |

---

## 3. What's wired into the REAL harness (this session)

The suite (`../suite/`) is adapter-generic: laws/benches run against any
`Reactive` adapter, never against minim directly.

- **`../suite/adapters/reconcile.ts`** — `Reactive` adapter over `reconcile-multi`.
- **`../suite/conformance/reconcile-laws.test.ts`** — full bireactive law set
  against the adapter.
- Benches: `reconcile` added to `forward.bench.ts`, `backward.bench.ts`,
  `mixed.bench.ts` head-to-head with `minim` / `alien` / `preact`.

Run:
```
# laws (vitest)
node_modules/.bin/vitest --config vitest.config.ts run \
  src/minim/signals/suite/conformance/reconcile-laws.test.ts
# benches (mitata)
node --expose-gc node_modules/.bin/vite-node src/minim/signals/suite/bench/index.ts
```

### Results

**Correctness: 15/15 bireactive laws — identical to production `minim`.**
Lens laws (GetPut/PutGet/PutPut), lossy PutGet, soundness (random
chains/fan-ins/trees), confluence, lossy absorption, backward minimality
(D bwd calls / 1 change / 1 fire; no-op 0/0; fan-in 1 bwd / N changes / 1 fire),
and **backward glitch-freedom (diamond, 1 consistent fire)**.

**Performance** (depth/width 50, after the fix in §4):

| workload | minim | reconcile | ratio |
|---|---|---|---|
| backward chain | 2.2 ms | 4.1 ms | 1.9× |
| backward fan-in | 3.2 ms | 5.2 ms | 1.6× |
| forward chain | 1.5 ms | 8.1 ms | 5× |
| drag fan-in w64 | 5.3 ms | 13.4 ms | 2.5× |

---

## 4. The one real perf fix made this session

`resolve()` was **O(depth²)**: it called `node.staged()` and
`parents.map(p => p.staged())` at every hop, and each `staged()` re-folded the
whole chain back to the root. Backward chain depth-50 was **42 ms (≈19× minim)**.

Fix: a **per-pass memo** on `staged()` (module-level monotonic `pass` id; bump
once per flush after all pendings commit). Fold happens once → **O(depth)**.
Backward chain 42 ms → **4.1 ms**. Memo is kept coherent when staging a root
pending (update memo); a staged complement invalidates the node's memo.

---

## 5. Known limitations / honest caveats

- **Naive forward core** is the bottleneck (the 5× forward gap). Eager invalidate
  + pull-refold, **no version/checkDirty short-circuit**. Every bench reads the
  sink each tick, so forward recompute dominates *everything*, including the
  backward/drag numbers. The architecture's thesis assumes backward rides a
  *proper* forward engine; this prototype deliberately doesn't have one.
- **Forward minimality (RFTS) not claimed** — the naive forward over-recomputes
  on diamonds where an intermediate value doesn't change. The bireactive laws
  tested here are value-based + the topologies that don't depend on that.
- **`staged()` memo + shared-source backward diamonds**: a second branch sharing
  a root sees the *pre-pending* staged value (its own staged was memoized before
  the first branch staged the root). Not exercised by the generic laws (they use
  disjoint sources per subtree). If we keep recursive backward over true
  shared-source DAGs, this needs upward memo invalidation or a one-shot
  bottom-up fold with re-fold on interfering writes.
- Backward gap to minim (~2×) is **constant-factor**, not asymptotic: `Set`
  churn on `deps`/`subs`, `parents.map` allocation per hop.

---

## 6. Next steps (in priority order)

1. **Close the forward gap properly**: drop the naive forward core, run the same
   backward layer on top of the production alien-style push-pull forward
   (version/checkDirty, flat dep arrays). Then re-run *this same harness* — the
   adapters + tests are already in place for the comparison. This is the real
   test of the thesis ("backward rides a proper forward engine").
2. **Merge `reconcile.ts` ⊕ `reconcile-multi.ts`**: lazy-pull + precompiled
   per-lens resolver (single-parent fast path) from the former, recursive
   complement-on-lens DAG from the latter, into one prototype.
3. **Harden untested corners**: compose+fork on the same root with stale caches;
   coupled resolutions interfering across shared roots in one batch; cycles;
   shared-source backward diamonds (the memo caveat above).
4. **Constant-factor backward**: kill `Set` churn (flat arrays / versioned deps),
   special-case single-parent in `resolve` to avoid `parents.map` alloc.
5. **Then** lens fusion (`descriptors.ts`) for the O(depth)→O(1) static-chain win
   and "aggregate DOF as a root" for O(N)→O(1) on movable aggregates.
6. Eventually carve a production `signal-rc.ts` and run it through RFTS forward
   conformance + `_test/bwd-soundness.test.ts` + the full bench set.

---

## 7. Pointers

- Production engine + `StatefulCore` (complement-on-lens ground truth):
  `../signal.ts`.
- Adapter surface the suite is written against: `../suite/adapters/types.ts`.
- Black-box law counters (fwd/bwd/changes/fires, all observable, no engine
  introspection): `../suite/harness/counters.ts`.
- Full transcript of this thread (search by keyword, don't read linearly):
  `agent-transcripts/881c863b-2d71-4273-92a0-2b9860f1a3c5/…jsonl`.
