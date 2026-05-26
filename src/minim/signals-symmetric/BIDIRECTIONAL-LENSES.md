# Bidirectional Lenses

The lens algorithm used by `@minim/signals`. This document describes the
mechanism, the invariants it preserves, the optimizations it performs, and
the failure modes it catches (or doesn't).

It is a reference for library authors and engine maintainers, not a tutorial.
For usage patterns see the `Signal` and value-class docstrings in
[`signal.ts`](./signal.ts), [`values/`](./values/), and the test suites
under [`_test/`](./_test/).

---

## 1. Overview

A `Signal<T>` is a single reactive cell that can be in one of three modes,
determined by which fields are populated:

| Mode       | `getter` | `setter` | Truth lives in        |
| ---------- | -------- | -------- | --------------------- |
| signal     | unset    | unset    | `currentValue`        |
| computed   | set      | unset    | `cachedValue` (lazy)  |
| **lens**   | set      | **set**  | parent's stored value |

A **lens** is a Signal in the third mode: a writable view onto another
Signal (or onto an aggregate over several). Reads compute through the
`getter`; writes flow through the `setter`. The lens itself stores no
state — it is a pure view, with the truth held by the root signal(s)
it ultimately derives from.

The defining property: writing through a lens is a value-space inversion
that updates the source(s), after which all downstream consumers
(including the lens itself) re-derive from the new source value(s). The
engine never "remembers" what you wrote; it remembers what the source
became, and on the next read recomputes the lens value from there.

Lenses are constructed three ways:

```ts
// 1. Endo-lens: same-class transform on a Signal of T → Signal of T
n.lens(v => v + 1, n => n - 1)            // Num → Num via add/sub-1

// 2. Cross-class: parent of type P → derived cell of type C
Vec.lens(numSignal, v => ({x: v, y: 0}), p => p.x)   // Num → Vec

// 3. N-input fan-in: multiple parents → one aggregate cell
Num.lens([a, b], vs => vs[0] + vs[1], (t, vs) => [...redistribute...])
```

Plus three engine-internal lens shapes built on top of `Cls.lens`:

- **`field(parent, "key", Cls)`** — `Writable<Cls>` projecting one
  property of an object-typed Signal. Spread-replace setter.
- **`Cls.derive(parent, fn)`** — read-only computed view. Same machinery
  as `Cls.lens` but with no setter installed.
- Value-class methods like `n.add(k)`, `v.scale(k)`, `t.translate.x` —
  all sugar over `Cls.lens` / `field()`.

---

## 2. The write algorithm

A write to a lens is the only interesting half of the algorithm. Reads
are conventional reactive recomputation; writes do the inversion.

### 2.1 Entry point

The public API is `lens.value = v`, which dispatches through the
prototype setter installed on `Signal.prototype`. That setter calls
`this._setWithExclusion(v, activeNetwork)`. The `excluding` parameter
exists so a network body can write a signal it subscribes to without
re-firing itself; outside a `network()`, `activeNetwork === undefined`
and the exclusion is a no-op.

### 2.2 Lens-mode dispatch

In [`signal.ts:1010`](./signal.ts), `_setWithExclusion` branches on
`this.getter`:

```ts
if (this.getter !== undefined) {
  const set = this.setter;
  if (set === undefined) throw new TypeError("Cannot write to a Computed");
  set(next);
  return;
}
```

**Crucial:** the lens cell does NOT update its own `pendingValue`. The
lens has no state of its own. It delegates entirely to the installed
`setter`, which is a closure built at construction time by `_fuse` (or
`_fanin` for N-input lenses).

### 2.3 The setter closure

The closure was assembled when the lens was constructed. For the
single-parent case (`_fuse`), it has one of four shapes depending on
whether the chain has a prior fused layer and whether the bwd is
stateful:

```ts
// 1-level, stateless                 (setter at signal.ts:899)
v => { parent._setWithExclusion(bwdLocal(v, undefined), activeNetwork); }

// 1-level, stateful                  (setter at signal.ts:906)
v => { parent._setWithExclusion(bwdLocal(v, parent.peek()), activeNetwork); }

// N-level, stateless                 (setter at signal.ts:916)
v => { parent._setWithExclusion(priorBwd(bwdLocal(v, undefined), undefined),
                                activeNetwork); }

// N-level, stateful                  (setter at signal.ts:926)
v => { const s = parent.peek();
       parent._setWithExclusion(priorBwd(bwdLocal(v, priorFwd!(s)), s),
                                activeNetwork); }
```

In every shape, `parent` is the **root** signal at the bottom of the
fused chain (`prior?.parent ?? receiver`). The composed bwd runs in one
closure call and the write goes directly to root.

### 2.4 Propagation

`parent._setWithExclusion` (now in signal mode, because `parent` is the
root) does:

1. Update `pendingValue`.
2. Apply `_equals` (per-instance, falls back to `===`).
3. If unchanged, **stop**. No propagation, no flush. This is the
   primary safety net against drift loops on re-writes.
4. If changed, set `Dirty` flag, run `propagate(subs, ...)`, then
   `flush()` if not inside a batch.

`propagate` walks the subscriber DAG, marking each subscriber `Pending`
or `Dirty`, and queues any `Watching` effects. **It never invokes any
setter or bwd.** The write phase is strictly one-way upstream-to-root;
the propagate phase is strictly one-way root-to-downstream.

### 2.5 Lazy recomputation

The lens cell IS a subscriber to its parent (because its getter reads
`parent.value`), so it gets marked `Pending` by propagate. On the next
read, the lens's `_update` runs its getter — `() => composedFwd(parent.value)`
— and refreshes `cachedValue`. Downstream consumers (effects, computeds,
other lenses) see one settled value: `composedFwd(composedBwd(target, prevSource))`.

**Consumers never observe the originally-written value as a distinct
event.** It exists only as the input to the bwd closure; what lands in
any signal's state is the post-bwd parent value, and what consumers
read is the post-fwd projection of that.

### 2.6 Reads are cached

The `value` getter (signal.ts:1210) branches on `getter !== undefined`
into a single read path that covers BOTH computed and lens modes. That
path checks the `Dirty` / `Pending` flags, runs `_update` only if the
cache is stale, and returns `cachedValue!`. A hot read loop on a lens
cell is one cached-property access plus dep-link bookkeeping — same
cost as a computed.

The cache is invalidated when the parent changes: `propagate` marks
the lens `Pending`, and the next `value` read calls `_update`, which
re-runs `composedFwd(parent.value)` and refreshes `cachedValue`.
Multiple reads between writes always hit the cache.

This means lens reads do NOT recompute the fwd chain on every access —
the only recomputation cost is one fwd evaluation per write that
actually changed the root.

### 2.7 Bound on write cost

A write to a lens with chain depth `D` and `K` total subscribers on the
root costs:

- **1** setter call (the composed closure)
- **D** arithmetic steps inside that closure (composed bwd ops)
- **1** root write (`parent._setWithExclusion`)
- **`O(K)`** propagation walk
- **`O(queued-effects)`** flush

The chain depth `D` shows up as inlined arithmetic, not as nested
function calls — fusion collapses what would be `D` setter invocations
into one. No iteration, no fixpoint, no convergence loop. The write
terminates in bounded time, identical in shape to a plain signal write.

---

## 3. Fusion

Fusion is the optimization that turns a chain of `.lens(f, b)` calls
into a single composed cell. It is **purely operational** — fused
chains are semantically equivalent to the un-fused, hand-nested
equivalent. The only observable difference is performance.

### 3.1 What fuses

Any chain of receiver-anchored lens operations:

```ts
const a = num(0);
const b = a.add(1).add(5).sub(3);   // 3 calls, but b is ONE cell
const c = b.add(5);                  // c is ALSO one cell, parent = a
```

Each `.add(k)` / `.sub(k)` / `.scale(k)` / `.lens(f, b)` runs through
`Signal.prototype.lens`, which calls `_fuse` with the receiver and the
new local `(fwd, bwd)`. `_fuse` looks at the receiver's `_fusedOf` tag;
if present, the new cell takes the receiver's `parent` and composes
fwd/bwd into the existing chain. The intermediate cells from
`a.add(1)` and `a.add(1).add(5)` are not referenced by `b` — `b`'s
setter writes directly to `a`.

### 3.2 The composition rule

Worked example for `b = a.add(1).add(5)` then `c = b.add(5)`:

```
a.add(1):
  composedFwd = v => v + 1
  composedBwd = n => n - 1
  setter      = v => a._setWithExclusion(v - 1, …)
  _fusedOf    = { parent: a, fwd: …, bwd: …, stateful: false }

.add(5) on that cell:
  composedFwd = s => (s + 1) + 5     ≡  s => s + 6
  composedBwd = n => (n - 5) - 1     ≡  n => n - 6
  setter      = v => a._setWithExclusion(v - 6, …)
  _fusedOf    = { parent: a, fwd: …, bwd: …, stateful: false }

c = b.add(5):
  composedFwd = s => (s + 6) + 5     ≡  s => s + 11
  composedBwd = n => (n - 5) - 6     ≡  n => n - 11
  setter      = v => a._setWithExclusion(v - 11, …)
  _fusedOf    = { parent: a, fwd: …, bwd: …, stateful: false }
```

So `b.value = T` runs ONE setter call doing `T - 6` and one write to
`a`; `c.value = T` runs ONE setter call doing `T - 11` and one write
to `a`. Chain depth never materializes as call depth.

### 3.3 Statefulness, in fusion

The composed chain is stateful iff any layer is stateful. The setter
branches on this — stateless setters skip `parent.peek()` and the
`priorFwd(s)` call. This matters for cells with expensive parents (a
peek is an untracked read; for a fused chain it's cheap, but
`priorFwd(s)` may run user code).

### 3.4 Cross-class fusion

`Cls.lens(parent, fwd, bwd)` and `Cls.derive(parent, fn)` go through
the same `_fuse` machinery as endo `.lens`. The composed cell is
constructed via `Signal.install(Cls, getter, setter?)` so it has the
correct type, even though it shares the root with its parent.

### 3.5 RO-receiver guard

`_fuse` (signal.ts:835) throws at construction time if you try to
install a writable lens on top of a fused read-only chain:

```ts
if (bwdLocal !== undefined && prior !== undefined && prior.bwd === undefined) {
  throw new TypeError("Signal: cannot install a writable view on top of …");
}
```

This catches an entire class of "lens has no bwd path" errors at
construction rather than at first write.

---

## 4. Statefulness inference

### 4.1 Why stateful bwds exist

Some inverses are reconstructible from the target alone. `add(k)`'s
inverse is `sub(k)` — to recover the source, subtract `k` from the
target. The source's current value is irrelevant; you'd compute the
same answer no matter what was there before. This is a **stateless**
bwd: `bwd : T → T`.

Other inverses fundamentally need the source's current value to do
anything sensible:

- **`field(parent, "x")`** writes `5` to `.x`. The bwd has to produce
  a NEW parent object that's `{ ...oldParent, x: 5 }` — it MUST read
  the parent to preserve the other fields. Without `s`, it'd have to
  invent values for `y`, `z`, etc.

- **`cyclic(2π)`** writes `π/4` to an accumulated angle of `100π`.
  The bwd picks the representative of `π/4` nearest to the current
  source, which means it has to know the current source is `100π` to
  land at `100π + π/4` rather than jumping back to `π/4`.

- **`pulleySum(a, b)`** writes `20` to a sum that's currently `10`.
  The bwd distributes the delta `(20 − 10)` evenly: `a += 5`, `b +=
  5`. To compute the delta, it needs both `a` and `b`'s current
  values — without them, it can't preserve the conservation invariant.

- **`centroidLens(...points)`** writes a new centroid. The bwd
  shifts all points by `(target − currentCentroid)` — needs the
  current centroid (computed from current points) to compute the
  shift.

Without statefulness, these lenses would be unauthorable. The
engine's stateful bwd path threads the right state into the bwd
closure so authors can write them naturally.

The trade-off: stateful bwds require one `parent.peek()` per write
(an untracked read), which is why the engine bothers to distinguish
stateless ones — they skip the peek.

### 4.2 What `s` actually represents

Precise rule: **in a stateful bwd `(v, s) => …`, `s` is the current
value of the cell on which `.lens()` was called — the receiver**, not
necessarily the root.

For a 1-level lens these coincide (receiver = root). For a multi-
level fused chain they don't, and the engine threads each layer's
bwd the value of *its own* receiver:

Walk-through with `b = a.cyclic(2*Math.PI).add(5)`:

- When you wrote `a.cyclic(2*PI)`, the receiver was `a`. So in
  cyclic's bwd, `s` is `a.value`.
- When you wrote `.add(5)` on the cyclic cell, the receiver was the
  cyclic cell. So in add's bwd, `s` would be the cyclic cell's value,
  which is `cyclic_fwd(a.value)`.

Fusion collapses both into one composed setter (signal.ts:927):

```ts
v => {
  const s = parent.peek();                        // s = root value = a.value
  parent._setWithExclusion(
    priorBwd(bwdLocal(v, priorFwd!(s)), s),       //         ^^^^^^^^^^^^^   ^
    activeNetwork,                                // add's s = cyclic_fwd(a) cyclic's s = a
  );
}
```

Two different `s` values get threaded:

- `s` to **bwdLocal** (add's bwd) = `priorFwd(root)` — the value
  add SAW as its receiver when authored.
- `s` to **priorBwd** (cyclic's bwd) = `root` — the value cyclic
  SAW as its receiver when authored.

Each layer's bwd gets the value of *its own receiver*, computed
correctly through the prior chain. The author of add's bwd never
needs to know about cyclic; they just know "`s` is the value of
whatever I'm a lens on."

For a 1-level lens this is just `parent.peek()`. For deeper chains,
fusion's invariant is "the local bwd sees what it would have seen if
the chain were unfused" — `s` is conceptually "the receiver's value
at the layer you authored against."

### 4.3 The arity footgun (and how to retire it)

```ts
.lens(v => v, (v, s = 0) => …)             // length === 1, treated stateless
```

`Function.length` counts parameters before the first default. The
user intended a stateful bwd; the engine treats it as stateless and
passes `undefined` for `s`, which the default rewrites to `0`. The
stateful logic appears to use a static source value. Tested in
[`footgun-probe.test.ts`](./_test/footgun-probe.test.ts).

Three ways to retire it:

- **A. Explicit tag**: `Cls.lens(fwd, bwd, { stateful: true })`.
  Default stateless; opt-in stateful. Removes arity inference; new
  failure mode is forgetting to tag, which has the same shape as
  today's footgun just relocated.

- **B. Two methods**: `Cls.lens(fwd, statelessBwd)` and
  `Cls.statefulLens(fwd, statefulBwd)`. The bwd types differ
  (`(v: T) => T` vs `(v: T, s: T) => T`), so TS catches the mismatch
  at the call site. Minor footgun: picking the wrong method.

- **C. Always pass `s`**: every bwd has signature `(v: T, s: T) => T`;
  stateless bwds ignore `s`. The engine always reads `parent.peek()`
  on every write. No inference, no footgun, slight perf cost
  (one untracked `peek()` per write — cheap for signals, more
  noticeable for fused chains where it triggers `priorFwd` to run
  user code).

The current arity inference is clever; (C) is the simplest
elimination if the perf cost is acceptable, (B) preserves the perf
optimization while moving the check into the type system. Either is
strictly safer than the current model.

---

## 5. N-input lenses (fan-in)

`_fanin` (signal.ts:1531) handles `Cls.lens([parents], fwd, bwd)`.
Reads:

```ts
const getter = () => {
  for (let i = 0; i < n; i++) vals[i] = parents[i].value;
  return fwd(vals);
};
```

A single scratch `vals` array, reused across reads. Subscribes to all
N parents via the normal dep-tracking machinery.

Writes:

```ts
const setter = v => {
  for (let i = 0; i < n; i++) vals[i] = parents[i].peek();   // stateful only
  const updates = sBwd(v, vals);
  batch(() => {
    for (let i = 0; i < n; i++) {
      const u = updates[i];
      if (u === undefined) continue;        // sparse update: skip pin
      parents[i]._setWithExclusion(u, activeNetwork);
    }
  });
};
```

Two guarantees worth highlighting:

1. **Atomic writes.** All N parent writes are wrapped in `batch()`, so
   downstream subscribers see one settled state (no glitches mid-write).
2. **Sparse updates.** A bwd returning `undefined` at index `i` means
   "leave parent `i` alone." Used by `reflectionLens`, axis-pinned
   policies, `argminNum` with `weights[i] === 0`, etc.

N-input lenses do NOT fuse (no `_fusedOf` tag is set on them); they
sit at chain boundaries. This is intentional — fusion of a fan-in
would require composing across the N-way bwd, which has no closed
form in general.

---

## 6. Field-path fast path

A frequent pattern is nested field access on object-typed Signals:

```ts
tr.translate.x.value = 5;        // Transform → translate (Vec) → x (Num)
```

Each `.translate` / `.x` is a `field()` call producing a `_fusedOf`
cell tagged with a `fieldPath` array. When chained, `_fuse` detects
that the entire chain is field-only (signal.ts:868-877) and collapses
to a path-walking setter (signal.ts:881-889) that spreads in a single
closure with one `parent.peek()` and N spread-replaces.

The fast path is correctness-equivalent to the generic stateful
composition; it's specialized for the common case to skip the user-
closure dispatch chain. Length-specialized for paths 1–3 deep, falls
back to `pathSetN` recursion for deeper chains.

**Correctness condition:** the fast path only runs when EVERY layer in
the fused chain is field-tagged. A non-field bwd in the middle (e.g.,
a custom `Cls.lens` or an endo `.lens`) breaks the assumption that the
setter can write directly to root via path walking; in that case
`_fuse` falls back to the generic stateful composition.

---

## 7. Network: bidirectional sub-DAGs

For "many signals tied together with feedback" — constraint networks,
propagators, hand-rolled bidirectional relations — the `network(body)`
primitive (signal.ts:1445) provides:

1. Auto-tracking of every signal read in `body` (subscribes).
2. **Self-exclusion**: bare `signal.value = …` writes inside the body
   self-exclude the network node from the propagation walk, so the
   body doesn't re-fire from its own writes.
3. **Auto-batching**: the body runs inside `batch()`, so all writes
   commit atomically.
4. A `dirty` set passed to the body listing signals whose value
   actually changed since the previous run.

Termination is structural: the self-exclusion guarantees the body
doesn't re-fire from its own writes. Re-firing happens only when an
external signal the body reads changes.

The mechanism is `activeNetwork`, a module-global pointer set by
`_NetworkNode._runBody` (signal.ts:1389) and read by every
`_setWithExclusion` call. Lens setters thread `activeNetwork` through
to `parent._setWithExclusion`, so a write through a lens inside a
network body still self-excludes correctly.

---

## 8. What the algorithm assures

In decreasing order of "how much the engine enforces this for you":

### 8.1 Engine-enforced (you cannot violate these)

- **Bounded writes.** A lens write is `O(D + K)` for chain depth `D`
  and root subscriber count `K`. No fixpoints, no iteration, no
  convergence loops in the lens machinery itself. The only path to
  unbounded work is effect-mediated cycles (same as plain signals).

- **Glitch-free downstream observation.** A write triggers exactly
  one root write per outer call (or one batched flush for N-input
  fan-in). All effects fire after the propagation walk completes;
  downstream consumers never see intermediate states.

- **One value per write, post-projection.** The value you wrote
  (`X`) never lands in any signal's state. Consumers observe
  `composedFwd(composedBwd(X, prevSource))`. For iso lenses this
  equals `X`; for lossy lenses it equals the projection.

- **Equality short-circuit at the root.** If the composed bwd produces
  a root value equal (under `_equals`) to the existing one, no
  propagation fires. This is the primary defense against drift loops
  on re-writes through deterministic bwds.

- **Cycle detection on computed self-reads.** A computed that reads
  its own value during evaluation throws `RangeError` at the read
  site (signal.ts:1216). Hard, fast, loud.

- **No RO writes.** Writing to a computed (no setter installed)
  throws `TypeError` at `_setWithExclusion` (signal.ts:1015).

- **No writable on RO chain.** Constructing a writable lens whose
  receiver is a fused RO chain throws `TypeError` in `_fuse`
  (signal.ts:836). Construction-time, not first-write-time.

- **Atomic N-input writes.** Fan-in bwds wrap parent writes in
  `batch()`, so downstream sees all N updates as one.

- **Network self-write termination.** Bodies that read and write the
  same signal terminate structurally via `activeNetwork` exclusion.

### 8.2 Lens-law compliance (engine-checked for built-ins via tests)

The classical asymmetric lens laws are defined in
[`_test/_laws.ts`](./_test/_laws.ts):

- **PutGet**: `get(set(s, v)) ≈ v` — read what you wrote.
- **GetPut**: `set(s, get(s)) ≈ s` — writing back the read is a no-op.
- **PutPut**: `set(set(s, v₁), v₂) ≈ set(s, v₂)` — only the last
  write survives.

A lens satisfying all three is **very well-behaved**; missing PutPut
gives **well-behaved**; missing GetPut/PutPut but holding PutGet
within a restricted view space is **lossy**.

Every built-in invertible (`Num.add/sub/scale/affine`,
`Vec.add/sub/scale/offset`, field lenses, etc.) is property-tested in
[`_test/laws.test.ts`](./_test/laws.test.ts) against random inputs.
Lossy lenses (`clamp`, `quantize`, `cyclic`) verify PutGet only,
within the view space they preserve.

**For user-written `Cls.lens(fwd, bwd)`, the engine cannot inspect
closures, so law compliance is the author's responsibility.** A bwd
that violates the laws produces a lens that's still operationally
sound (no crashes, no freezes, no glitches) but its observable
behaviour will surprise consumers expecting standard lens semantics.

### 8.3 Lawfulness hierarchy of the built-ins

"Tested" = property-checked in
[`_test/laws.test.ts`](./_test/laws.test.ts) against random trials.
"Inferred" = the bwd's algebraic form makes the law hold by
construction, but no automated test pins it.

| Lens                                   | Class               | Tested |
| -------------------------------------- | ------------------- | ------ |
| `n.add(k)` / `.sub(k)`                 | iso (very well-behaved) | yes |
| `n.scale(k)`, k ≠ 0                    | iso                 | yes    |
| `n.affine(k, off)`, k ≠ 0              | iso                 | yes    |
| `v.add/sub/scale/offset/up/down/…`     | iso                 | yes    |
| `box.add/sub/scale/translate/inset/…`  | iso                 | yes    |
| `color.lighten/darken/…`               | iso                 | yes    |
| `field()` (spread-replace)             | iso (structural eq) | yes    |
| `n.clamp(lo, hi)`                      | lossy (PutGet within [lo, hi]) | yes |
| `n.quantize(step)`                     | lossy (PutGet at multiples of step) | yes |
| `n.cyclic(period)`                     | lossy (PutGet within ±period/2) | yes |
| `meanLens`, `centroidLens`             | well-behaved aggregate (distribute-delta bwd) | inferred |
| `pulleySum`, `diffLens`                | well-behaved aggregate (conservation-preserving) | inferred |
| `reflectionLens`                       | well-behaved (involutive bwd; axis pinned) | inferred |
| `vecLerp`                              | well-behaved (rigid shift; `t` pinned) | inferred |
| `argminNum`, `argminVec`               | numerical (PutGet ≈ within FD eps; not strictly idempotent) | empirical in `_explore` |
| `factorLens` (Jacobian-LSQ M-output)   | numerical (cross-channel invariance approximate) | empirical in `_explore` |

The "well-behaved aggregate" cases satisfy all three laws even though
their source space is N-dimensional and view space is 1-D — the
distribute-delta bwd shifts the source by the *exact* delta required
to land on the target, so a second write computes the *same* delta-
adjustment relative to the new source, which composes to the right
direct-write outcome.

The "numerical" cases violate strict idempotence at FD-eps scale (the
saturating drift documented in
[`_explore/factor-lens.test.ts`](./_explore/factor-lens.test.ts) §4).
For most app uses this is below visual threshold; for precision-
critical use it's the price of generic Jacobian-LSQ over a non-linear
forward.

---

## 9. Composition

Lens composition is engine-internal: `_fuse` composes fwd and bwd in
value-space at construction. The lawfulness of a composed chain is
governed by the "weakest layer" rule:

- iso ∘ iso = iso
- iso ∘ lossy = lossy
- lossy ∘ lossy = lossy
- (anything) ∘ numerical = numerical

Composition does NOT silently break the engine guarantees in §8.1 —
those hold for any composed chain. It can change the lawfulness class
(§8.2) in ways consumers should know about IF they're relying on
exactness; for most consumers (animations, UI bindings, drag handles),
the projection behaviour is exactly what's wanted.

---

## 10. Termination and convergence

The complete list of paths to unbounded work, with their resolutions:

1. **Composed bwd in a lens chain.** Bounded — runs once per outer
   write, O(D) inlined arithmetic.

2. **N-input bwd in a fan-in.** Bounded — runs once per outer write,
   writes wrapped in `batch()`.

3. **Subscriber propagation.** Bounded — O(K) graph walk that never
   re-enters any setter.

4. **Effect cascades.** An effect can write a signal that triggers
   other effects that write more signals. Same as plain signals.
   Bounded by the dep graph size in well-formed cases; can be
   unbounded if effects form a write cycle.

5. **Cyclic computeds.** Throws `RangeError` at read time (engine
   invariant).

6. **Lens-DAG cycles.** Cannot be constructed: a lens needs its parent
   to exist at construction time, so the dep graph is built bottom-up
   as a DAG. Cycles via effects are an effect-level concern, not
   lens-level.

7. **Network bodies that loop.** Don't, because of `activeNetwork`
   self-exclusion. A body's own writes don't re-fire it.

8. **`relate()` divergence.** Yes, a non-contractive bidirectional
   relation can diverge (see `relate.ts`). `relate` is experimental
   and is the only engine-level path to unbounded writes; slated for
   removal.

The only remaining concrete failure mode is **effect cycles**, which
plain signals already let you write. This is parity with non-lens
reactive systems.

---

## 11. Footgun catalog

What can go wrong, what catches it, and where:

| Footgun | Engine response | Location |
| ------- | --------------- | -------- |
| Write to a computed | `TypeError` at write | signal.ts:1015 |
| Writable lens on RO chain | `TypeError` at construction | signal.ts:836 |
| Computed reads itself | `RangeError` at read | signal.ts:1216 |
| Coercion to string/number | `TypeError` at coercion | signal.ts:1096 |
| Effect writes its own dep | Silently swallowed (single run) | RecursedCheck flag |
| Default args reduce bwd arity | Silent — treated stateless | (no diagnostic) |
| Side effects in fwd | Re-fire per read | (no diagnostic) |
| N-input bwd returns wrong length | Missing parents stay unchanged | (silent, by design) |
| User bwd violates lens laws | Best-effort behaviour, no crash | (no diagnostic) |
| Numerical (FD) drift on rewrite | Saturates at ~FD-eps; doesn't accumulate | equals short-circuit at root |
| `relate` non-contractive divergence | Diverges to `Infinity`, then `===` short-circuit terminates | (experimental, being removed) |
| Direct `tr.value.x = 5` mutation | No reactivity; field-bypass | tested in footgun-realuser |

The silent-swallow behaviours (rows 5, 6, 7, 8, 9) are by design — the
engine prefers "your code runs once and produces a defined result" over
"your code crashes with a stack trace." Plain signals make the same
trade. Where this becomes a maintenance footgun, the test suites under
[`_test/footgun-*.test.ts`](./_test/) pin the behaviour so it doesn't
silently change.

---

## 12. Performance characteristics

Hard numbers depend on hardware. The bench suites under
[`_test/`](./_test/) (`through.bench.test.ts`,
`fusion-generalised.bench.test.ts`,
`fusion-iso.bench.test.ts`,
`lazy-realworld.bench.test.ts`, and the exploration suite under
[`_explore/`](./_explore/)) are the source of truth. What the
algorithm guarantees about *shape* of cost:

**Read cost:**

- Bare signal read: one `value` getter + dep-link bookkeeping.
- Fused lens read: one composedFwd closure call + one root read. Chain
  depth does not show up as call depth (it's inlined arithmetic).
- Field chain read: path-walking closure, length-specialized for 1–3
  deep, recursive fallback past that. One root `peek`.
- N-input read: scratch-buffer fill from N parent reads + one `fwd`
  call.

**Write cost:**

- Fused lens write: one setter call + one composedBwd computation + one
  root `_setWithExclusion` + propagate.
- Field chain write: one path-walking spread-replace + one root write.
- N-input write: one bwd call + N parent writes wrapped in `batch()`
  (so one flush at the end).
- Jacobian-LSQ aggregate write: O(M²·N) per write (M output channels,
  N input scalars). M·N forward evaluations for FD Jacobian, M³ for
  Gauss-Jordan inversion of `J W Jᵀ + λI`. Acceptable for K~10; gets
  expensive past K~100.

**Fusion's measured payoff** (from
`fusion-generalised.bench.test.ts`, hardware-dependent but shape
holds):

| Comparison                                          | Fusion ratio       |
| --------------------------------------------------- | ------------------ |
| 2-deep `.lens(f,g).lens(f,g)` write vs hand-nested  | ~2× faster fused   |
| 4-deep `.lens` chain read vs hand-nested            | ~2.5× faster fused |
| `tr.translate.x` field-chain write vs hand-nested   | ~2× faster fused   |

The biggest perf cliff is the Jacobian-LSQ path in
[`aggregates.ts`](./aggregates.ts). For most production cases, closed-
form aggregates (`centroidLens`, `pulleySum`, `meanLens`, the
prototype `procrustesLens`) are roughly an order of magnitude faster
than the numerical fallback AND exact rather than approximate. Reach
for `argminNum`/`argminVec`/`factorLens` only when no closed-form
policy fits the forward map.

---

## 13. Examples

### 13.1 Iso chain on a primitive

```ts
const a = num(0);
const b = a.add(1).scale(2).sub(3);   // ((a+1)*2-3) — one fused cell

b.value = 7;        // composed bwd: ((7+3)/2 - 1) = 4 written to a
a.value             // 4
b.value             // 7
```

### 13.2 Field chain on a struct

```ts
const tr = transform({ translate: { x: 0, y: 0 } });
tr.translate.x.value = 5;          // path-walking setter
tr.value                            // { translate: { x: 5, y: 0 }, … }
tr.translate.x.value                // 5
```

### 13.3 Lossy projection

```ts
const v = num(50);
const u = v.clamp(0, 10);
u.value = 999;        // clamped to 10 before write
v.value               // 10
u.value               // 10 (read of source clamped)
```

### 13.4 N-input aggregate with distribute-delta bwd

```ts
const a = num(3), b = num(7);
const sum = pulleySum(a, b);        // (a+b)/1 with delta/2 to each
sum.value = 20;                      // delta = +10, half each
a.value                              // 8
b.value                              // 12
```

### 13.5 Bidirectional network with self-exclusion

```ts
const x = num(0);
const y = num(0);
network(() => {
  // Reads both, writes both; activeNetwork excludes self-re-fire
  if (x.value > 10) y.value = x.value - 10;
  else y.value = 0;
});
x.value = 25;     // body fires once; y becomes 15; no re-fire
```

---

## 14. Where this fits

This algorithm is the substrate for several higher layers:

- **Animation primitives** (`anim.ts`): `spring`, `tween`, `attract`
  all consume `Writable<T>` cells and don't care whether they're
  bare signals, field lenses, or numerical aggregates — the engine
  guarantees from §8.1 are enough for them to work uniformly.

- **Aggregate primitives** (`aggregates.ts`, `new-primitives.ts`,
  the prototype `_explore/factor-lens.ts`): closed-form and
  numerical bwd policies for N→1 and N→M cardinalities. All ride on
  the same `Cls.lens([parents], fwd, bwd)` API.

- **Constraint and physics layers** (`constraints/`, `propagators/`):
  use `network()` to coordinate multi-cell updates with self-
  exclusion guarantees.

- **Shape and handle authoring** (`shapes/handle.ts`): builds drag
  handles by wiring `Writable<Vec>` cells to pointer events. The
  bidirectionality means the same cell can be both authored
  programmatically and driven by direct manipulation.

The trust model for downstream consumers is: a `Writable<T>` always
returns the current value of its source-as-projected; writes are
finite, terminate, propagate glitch-free, notify subscribers exactly
once per logical change, and apply the lens's bwd policy to the
source(s). That's the contract. The lawfulness of any specific bwd
is a property of how the lens was authored, not of the engine.
