# `_proto-r2` — merged `Reactive<T>`, treated as real

A round of prototyping for the merged-class reactivity primitive,
sized to surface what actually breaks rather than what looks clean
on a slide.

## What this is

A self-contained reactive layer:

```
reactive.ts      Reactive<T> + signal/computed/lens/effect/batch/untracked
traits.ts        LINEAR/LERP/METRIC/EQUALS (verbatim shape from prod)
field.ts         Typed field lens, Symbol-cached on parent
values/num.ts    Num + NumChain
values/vec.ts    Vec + VecChain + polar
values/box.ts    Box + BoxChain
index.ts         Public API
conformance.test.ts  RFTS (161 pass / 18 skipped — identical to prod)
engine.test.ts       50 hand-rolled tests: edges, footguns, value types
types.test.ts        TS overload + inference compile-time tests
bench-runner.ts  Minimal paired-comparison bench harness
bench.ts         minim (prod) vs r2 across 18 scenarios
```

All tests pass: **220 / 220** (with 18 RFTS divergences skipped, same as prod).

## API

The big rename: `derived(Cls, fn, setter?)` is split into two functions.
`computed(Cls?, fn)` for read-only views; `lens(Cls?, get, set)` for
writable views. The Cls argument is optional; without it you get
`Reactive<T>`.

```ts
signal(initial)                       // Reactive<T>, writable
computed(fn)                          // Reactive<T>, read-only
computed(Vec, fn)                     // Vec, read-only
lens(get, set)                        // Reactive<T>, writable derived
lens(Num, get, set)                   // Num, writable derived
effect(fn)                            // disposer
batch(fn)                             // coalesces flush
untracked(fn)                         // untracked read
```

Runtime predicates: `isSignal`, `isComputed`, `isLens`. Type aliases
`Computed<T>` (read-only narrow) and `Lens<T>` (writable narrow) are
provided.

## What we kept

- **Eager + fused chain duality.** `vec.add(b).scale(k)` allocates 2
  reactive Vecs (one per call), `vec.derive(c => c.add(b).scale(k))`
  allocates one. Both reactive over args. Bench confirms the lowering
  is a real perf win (-24 to -29% on the realistic chain).
- **Traits as module-local Symbols.** Same `[LINEAR]` / `[LERP]` /
  `[METRIC]` / `[EQUALS]` slots on prototype.
- **Symbol-cached field lenses** on the parent. Identical hot-path
  shape to prod.
- **Re-entrancy guard in `flush()`** (the cascading bind-effects fix
  that already landed in prod).
- **`peek()` propagation** for stranded subscribers after a write
  (the prod fix).

## What we dropped

- **`viewClassFor`** — no `Object.setPrototypeOf`, no copyOwnProps,
  no `View extends Computed` shape-walking. `computed(Vec, fn)` is
  literally `new Vec(); set getter`. `instanceof Vec` works because
  Vec naturally extends Reactive.
- **The Signal/Computed split.** One class, mode determined by which
  fields are set. Tradeoff documented under "what hurts".
- **The `derived(Cls, fn, setter?)` overload.** Replaced by the
  `computed` / `lens` pair. The split is honest about intent at
  call site and gives us a real `Lens<T>` type narrowing.

## What hurts (bench)

`npx vite-node src/minim/_proto-r2/bench.ts`

Stable picture across runs (CV mostly ±1–3%, except sub-20 ns ops
which are at the measurement floor):

| scenario                                  | minim    | r2       | Δ      |
| ----------------------------------------- | -------- | -------- | ------ |
| construction: signal(0)                   | ~15 ns   | ~17 ns   | +10%   |
| construction: vec(0, 0)                   | ~370 ns  | ~320 ns  | −13%   |
| construction: box(0, 0, 0, 0)             | 1.03 µs  | 670 ns   | **−35%** |
| read: signal.peek                         | 5.4 ns   | 5.6 ns   | +4%    |
| read: vec.x.peek                          | 26 ns    | 26 ns    | ≈      |
| write: signal.value =                     | 15 ns    | 16 ns    | +5%    |
| write + 1 effect                          | 50 ns    | 65 ns    | **+22%** |
| batch × 10 writes (1 effect)              | 205 ns   | 250 ns   | **+22%** |
| 10-deep computed chain (write+read)       | 310 ns   | 360 ns   | **+15%** |
| 50-deep computed chain (write+read)       | 1.4 µs   | 1.6 µs   | **+15%** |
| eager chain: vec.add().scale().offset()   | 192 ns   | 200 ns   | +5%    |
| fused chain: vec.derive(c=>...)           | 730 ns   | 540 ns   | **−26%** |
| realistic scene: 100 boxes / center       | 21 µs    | 23 µs    | +13%   |

The shape:

1. **Construction is faster** for non-trivial types (vec, box) because
   we skip `viewClassFor` and its prototype gymnastics.
2. **Fused chains are faster** because the chain wrapper has a tighter
   hidden class with the merged design (and we avoid an extra Computed
   shape in the dep graph).
3. **Hot write+effect paths are ~15–25% slower** because:
   - The base class has 3 extra fields (`cachedValue`, `getter`,
     `setter`) compared to prod's `Signal`, all set to `undefined` for
     signal-mode instances.
   - `set value` has one extra branch (`if (this.getter !== undefined)`)
     to distinguish signal vs computed/lens writes.
4. **Asymptotically the same.** 50-deep chain regression is the same
   percentage as 10-deep. The merge doesn't introduce scaling cost.

The realistic-scene cost of +13% is ~2 µs on 100 boxes per frame
update. At 60 fps that's 0.012% of the frame budget per 100 boxes.
This is the price tag for losing `viewClassFor`.

### Tried and didn't move the needle

- Swapping the branch order in `set value` (check getter first, then
  setter inside that branch). No measurable change on hot signal
  writes — the branch is well-predicted either way.

### Won't try, on principle

- Splitting back to `Reactive` + `DerivedReactive` subclass with
  per-instance dispatch. That immediately needs `viewClassFor` again
  to give `computed(Vec, fn) instanceof Vec`. Defeats the whole point.

## Footguns surfaced (and caught)

Each of these has a test in `engine.test.ts` keeping us honest:

1. **`peek()` clearing `Dirty` without propagating subscribers.**
   Pre-existing bug — present in prod minim, fixed there and here.
   Test: `peek > propagates Dirty-clear to subscribers`.
2. **Cascading bind-effects on field lenses overflow the call stack.**
   Same prod bug. Re-entrancy guard in `flush`. Test:
   `footguns > re-entry during set is safe` (N=2000 cascade).
3. **`+ signal` accidental coercion.** `Symbol.toPrimitive` throws
   rather than silently turning into `NaN`. Test:
   `footguns > toPrimitive throws`.
4. **Field-cache identity must be stable** (`vec.x === vec.x`), else
   `.bind` on `.x` leaks. Symbol-cache enforces this. Test:
   `value: Vec > field cache identity`.
5. **`instanceof Vec` must hold through `computed(Vec, fn)`** so trait
   dispatch resolves. The natural prototype chain handles this — no
   `setPrototypeOf` needed. Tests cover both `Num` and `Vec`.
6. **Lens-over-lens write paths.** A lens whose getter reads another
   lens, whose setter writes through. Both directions tested.
7. **Cycle detection on self-referential computed.** Throws cleanly.
8. **Diamond dependency single-update.** Test confirms `effect` runs
   once, not twice, when both forks share a root.
9. **Equality dedup at intermediate computed.** When a computed's
   value stays equal under a custom `[EQUALS]`, downstream effects
   don't re-run.
10. **Effect cleanup ordering** — `clean(N)` runs before `run(N+1)`
    and final cleanup runs on dispose.
11. **`bind()` teardown** on re-bind, on `.set(x)`, on returned
    disposer.

## What's still open

These are deliberate non-goals for this prototype but matter before any
production move:

- **`combine` / `mean`** (writable N-to-1 lenses). These use `derived`
  with a setter in prod; should port cleanly to `lens(Cls, get, set)`.
  Not implemented here yet.
- **Animation system integration** (`tween`, `spring`, `Anim`). The
  signal-write hook is plumbed (`setSignalWriteHook`) so the
  scheduler should attach without surgery.
- **Other value types** (`Color`, `Matrix`, `Transform`, `Anchor`).
  Mechanical port — same shape as `Num`/`Vec`/`Box`.
- **Bench infrastructure**: still single-process, single-file. Per-
  scenario subprocess isolation would tighten CVs further, but for a
  paired comparison this is fine.

## How to run

```bash
# All tests (RFTS conformance + engine + types)
npx vitest run src/minim/_proto-r2/

# Bench (minim prod vs r2, paired, 12 phases each)
npx vite-node src/minim/_proto-r2/bench.ts

# Tunable
BENCH_PHASES=30 BENCH_WARMUP=10 npx vite-node src/minim/_proto-r2/bench.ts
```

## Verdict

The merged design pays its bills: cleaner architecture, no
`viewClassFor`, honest `Lens<T>` / `Computed<T>` type narrowing, no
asymptotic regressions, real wins on construction and fused chains. The
~20% hot-write regression is real and worth knowing about but doesn't
move the needle on any realistic frame budget I can construct.

The footguns are charted and tested, the bench infrastructure can spot
a regression without lying about it, and the call sites are nicer to
read. Architecturally this is the right shape; the perf cost is
proportional to the magic we removed.
