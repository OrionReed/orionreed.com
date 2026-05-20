# minim engine v2 — candidate

A single consolidated prototype. All 34 tests pass. Bench results below.

## The design, top to bottom

### Engine surface — 5 yield shapes

```ts
type Yieldable =
  | undefined                  // park 1 frame
  | number                     // sleep N seconds (N ≤ 0 → park)
  | Animator                   // spawn child, await
  | readonly Yieldable[]       // run concurrently
  | Suspend                    // (wake, ctx) => dispose
  | Transduced                 // gen with attached transducer stack
```

### Two cooperation points with userland

```ts
// 1. Where does this gen run? (lifecycle escape hatch)
interface SuspendCtx {
  spawn(g: Animator): () => void;   // spawn at engine root, returns cancel
}
type Suspend<T> = (wake: Wake<T>, ctx: SuspendCtx) => void | (() => void);

// 2. What does this gen perceive? (clock + protocol)
interface Transducer {
  onYield?(v: Yieldable): Yieldable | undefined;   // gen → engine
  onResume?(tick: Tick): Tick | undefined;          // engine → gen (on wake)
  onTick?(dt: number): number;                      // per-step time advance
}

type Transduced = { [TRANSDUCE_KEY]: { gen: Animator; trans: readonly Transducer[] } };
function transduce(t: Transducer, target): Transduced;     // pushes onto stack
```

### One value contract

```ts
cut(v)  // settles enclosing concurrent group with v
```

That's the entire engine API. **11 concepts.** No symbol-keyed wrappers (`DETACH_KEY`, `SCALE_KEY` gone). No per-Active scale fields (`scale`, `inScaledSubtree`, `cumScale`, `cumScaleStep` gone). No `cumScaleOf()` walking parent chains. No tail-call branch on `number ≤ 0`.

### Userland — what was in the engine, now in 60 lines

```ts
// in userland.ts:

function scaled(rate, target) {
  return transduce({ onTick: (dt) => dt * rate() }, target);
}

function pauseWhen(pred, target) {
  return scaled(() => (pred() ? 0 : 1), target);
}

function slowmoWhen(pred, fraction, target) {
  return scaled(() => (pred() ? fraction : 1), target);
}

function pauseOnHidden(target) {
  return pauseWhen(() => document.hidden, target);
}

function trace(tag, target, log = console.log) {
  return transduce({
    onYield: (v) => { log(`[${tag}] yield ${describeYield(v)}`); return undefined; },
    onResume: (t) => { log(`[${tag}] resume dt=${t.dt} elapsed=${t.elapsed}`); return undefined; },
  }, target);
}

function* detach(g) {
  yield (wake, ctx) => { ctx.spawn(g); wake(); };
}
```

Each new policy (priority schedulers, supervision trees, replay/record, audio-sync,
breakpoint-style debug, throttle) is the same shape: an extra Transducer or a
Suspend.ctx coordinator. Engine doesn't change.

### Three hooks, three named moments

| Hook | Cadence | Direction | Used by |
|---|---|---|---|
| `onYield` | per-yield | gen → engine | trace, replay, breakpoint |
| `onResume` | per-wake | engine → gen | trace, custom Tick augmentation |
| `onTick` | per-frame | engine internal | scaled, pause, slowmo, pause-on-hidden |

All optional. All pay-as-you-go (skipped via one nullish check when absent).

The "three named moments" framing is what unstuck the design. `onYield`/`onResume`
are the two directions of the gen↔engine protocol. `onTick` is the third
operational moment — the engine's per-frame work — and that's also legitimately
distinct, not a leak. Naming it `onTick` (cadence-shaped) instead of `mapTime`
(domain-shaped) makes the asymmetry honest.

## What the engine gives up vs production

| Capability | Production | Candidate |
|---|---|---|
| `Detach` shape | engine-built-in | userland (`detach` via `Suspend.ctx.spawn`) |
| `Scaled` shape | engine-built-in | userland (`scaled` via `Transducer.onTick`) |
| `Active.scale`, `inScaledSubtree`, `cumScale`, `cumScaleStep` | 4 fields | gone |
| `cumScaleOf()`, `scaledChild()` methods | ~40 lines | gone |
| `step()` scaled-vs-fast split | branch | unified path |
| `yield N ≤ 0` tail-call | special case | gone (`yield N ≤ 0` = park) |
| `detach(scaled(r, g))` composes | broken (today) | works (stacking) |

What the engine adds:
- `SuspendCtx` parameter on `Suspend` (one extra arg).
- `Transduced` yield shape (one symbol-keyed object, dispatched in one place).
- Per-Active `trans: readonly Transducer[]` (replaces 4 scale-related fields).
- Three iteration sites for the transducer stack in `step()` and `advance()`.

Net engine: ~455 lines vs production's 521. Smaller, plus a much smaller
per-Active footprint (drops `scale`, `inScaledSubtree`, `cumScale`,
`cumScaleStep`, `parent`, `observeId` — 6 fields → 0; replaced by a single
`trans: readonly Transducer[]` slot, frozen-empty by default).

The `Anim` class public surface is now exactly:

```ts
class Anim {
  onError: (e: unknown) => void;     // error handler (replaceable)
  get clock(): number;               // engine wall-clock
  start(g): () => void;              // spawn + return cancel
  stop(): void;                      // cancel all, reset clock
  step(dt: number): void;            // advance by dt
}
```

Five members. Anything else (per-step listeners, observation, frame-rate
adaptation, throttling) is one-line userland — e.g. per-step subscription
is just wrapping `step`:

```ts
const tap = (anim: Anim, cb: (dt: number) => void) => {
  const orig = anim.step.bind(anim);
  anim.step = (dt) => { cb(dt); orig(dt); };
};
```

## Performance — realistic 10K @ 125fps target

Total CPU over 1 second of wall time. `%budget` = ms / (125 × 8 ms). Lower is better.

```
=== parker (yield only) ===
N        depth   proto ms   prod ms   proto %   prod %   proto/prod
10000      0       37.5      35.4     3.75%    3.54%   1.06×
10000      1       68.8      47.2     6.88%    4.72%   1.46×
10000      2       88.9      65.1     8.89%    6.51%   1.36×

=== tween (spring math per frame, realistic) ===
N        depth   proto ms   prod ms   proto %   prod %   proto/prod
10000      0       48.2      44.8     4.82%    4.48%   1.08×
10000      1       84.3      62.8     8.43%    6.28%   1.34×
10000      2      110.6      81.8    11.06%    8.18%   1.35×
```

Reading the numbers:
- **Depth 0 (no transducer)**: ~equivalent to production. Pay-as-you-go works — the `a.trans.length > 0` check is essentially free.
- **Depth 1 (one withScale/scaled)**: ~35-45% slower. ~8% of frame budget at 10K with realistic work.
- **Depth 2**: ~35% slower. ~11% of frame budget at 10K with realistic work.
- **Curve shape**: linear with N (same as production). Constant is ~1.35× at depth ≥ 1 due to list iteration vs cached cumScale.

The gap is the cost of "scaling-via-function-call-chain" vs production's
"cached cumScale field". It's recoverable later by a fast-path that detects
the common case where all transducers in the stack are scaled-only and folds
them into a single cached rate per active per step (see "fast-path option"
below). I'd ship without it and add it only if needed.

For realistic minim depths (most actives at depth 0, some at 1, occasional 2),
the budget impact is single-digit %. Well within the 8ms frame budget at 10K.

## What's new that production can't do

| | Production | Candidate |
|---|---|---|
| `detach(scaled(r, g))` | broken (key wrappers don't compose) | works |
| `pauseWhen(pred, anim)` | requires engine surgery | 3 lines userland |
| `pauseOnHidden(anim)` | requires engine surgery | 3 lines userland |
| `trace(tag, anim)` | not possible | 5 lines userland |
| `pool(n, gens)` | requires engine surgery | ~25 lines userland (Suspend.ctx coordinator) |
| supervision, priority, replay, audio-sync | not possible | each ~5–30 lines userland |
| Multiple time-scaling layers compose | broken | works |

## Honest costs

1. **~35% slower at depth ≥ 1.** Recoverable via a scaled-fast-path optimization (deferred).
2. **`yield N ≤ 0` no longer tail-calls.** No real code used this; tests of the
   feature are the only callers.
3. **Authors writing transducers must understand the 3-hook contract.** This
   is ~30 lines of documentation. Today's analog is "modify `core/anim.ts`",
   which has no documentation.
4. **Authors writing Suspend coordinators must understand `wake` + `ctx.spawn`
   semantics.** This is ~15 lines of documentation.

## Files

```
_proto/
  engine.ts      — runtime, single file, no imports (~420 lines)
  userland.ts    — scaled, detach, pauseWhen, slowmoWhen, pauseOnHidden, trace (~90 lines)
  test.ts        — 34 tests, all pass
  bench.ts       — scaling bench vs production
```

Run:
```sh
npx tsx src/minim/_proto/test.ts   # all tests
npx tsx src/minim/_proto/bench.ts  # scaling bench
```

## Migration sketch (if/when committed)

1. Land `SuspendCtx` first as a one-arg-extension to today's `Suspend`. Verify
   what the historical detach-via-ctx gotchas were and confirm they don't
   recur. Ship `detach` as userland.
2. Add `Transduced` yield shape + `Transducer` interface to the engine.
3. Replace `Scaled` / `cumScale` machinery; ship `scaled` and `withScale` as
   userland.
4. Drop the `number ≤ 0` tail-call branch.
5. (Optional) Add the scaled-fast-path if 10K + depth-≥1 benchmarks show it
   matters in your real workloads.

## Fast-path option (deferred)

To close the perf gap to production for the scaled-only case: in `step()`,
detect actives whose `trans` is all-scaled (every transducer is exactly
`{ onTick: (dt) => dt * rate() }`). Cache `cumRate = ∏ rates()` once per
step on the Active. Use `subjDt = dt * cumRate` instead of walking the chain.

~30 lines in the engine. Transducer authors unaffected. Apply only when
measured to matter.
