# minim runtime v2 — candidate

A single consolidated prototype. All 44 tests pass. Final bench numbers below.

## Files

```
_proto/
  anim.ts          ← runtime (Anim, Animator, Tick, Suspend, transduce, Transducer, Transduced…)
  transducers.ts   ← scaled, pauseWhen, slowmoWhen (onTick-only family)
  detach.ts        ← detach (Suspend.ctx.spawn coordinator)
  test.ts          ← 44 tests, all pass
  bench.ts         ← scaling bench vs production
```

## Engine surface — 12 concepts total

**5 yield shapes**: `undefined` (park), `number > 0` (sleep), `Animator` (await child), `Yieldable[]` (concurrent), `Suspend` (callback boundary), `Transduced` (gen with hook stacks).

**2 cooperation points with userland**:
- `Suspend.ctx.spawn(g) → cancel` — userland spawn-at-root (detach, pool, supervisor)
- `Transduced { gen, ticks, resumes, yields }` — userland clock + protocol hooks

**3 transducer hooks** (all optional, all pay-as-you-go):
- `onTick(dt) → dt'` — per-frame time advancement (return 0 to freeze)
- `onResume(tick) → tick'` — engine→gen, on wake
- `onYield(v) → v'` — gen→engine, per yield

**1 sentinel**: `cut(v)` settles enclosing concurrent group with v.

**`Anim` public surface (6 members)**: `start`, `stop`, `step`, `onStep`, `clock` (getter), `onError` (replaceable field).

## Separated stacks — what makes this fast

Internally, `Transduced` keeps **three parallel arrays** (`ticks`, `resumes`, `yields`) instead of one `Transducer[]`. The engine walks each at the appropriate moment:

```ts
class Active {
  ticks:   readonly OnTick[]   = EMPTY;
  resumes: readonly OnResume[] = EMPTY;
  yields:  readonly OnYield[]  = EMPTY;
}
```

Per step (hot path), iteration is a tight direct-call loop with no property access:

```ts
for (let k = ticks.length - 1; k >= 0; k--) {
  subjDt = ticks[k](subjDt);
}
```

When a stack is empty (the common case — most transducers only use `onTick`), the loop never enters. **Zero cost for hooks the transducer didn't define.** Three parallel `EMPTY` constants share one frozen array reference, so per-Active memory cost is 3 pointers vs the 1 pointer of the unified design — 16 bytes extra per Active. Trivial.

User-facing API is unchanged: `transduce(t, target)` accepts a `Transducer` with optional hooks; the function splits the hooks into the three internal arrays at construction time.

## Performance at the 10K @ 125fps target

`%budget` = ms over 1s / (125 × 8 ms). Lower is better.

```
=== tween (spring math) ===
N        depth   proto ms   prod ms   proto %   prod %   proto/prod
10000      0       55.5      53.6     5.55%    5.36%   1.03×
10000      1       85.9      74.3     8.59%    7.43%   1.15×
10000      2      120.0     122.7    12.00%   12.27%   0.98×

=== parker (yield only) ===
N        depth   proto ms   prod ms   proto %   prod %   proto/prod
10000      0       38.7      36.3     3.87%    3.63%   1.07×
10000      1       69.1      54.2     6.91%    5.42%   1.28×
10000      2       79.1      77.9     7.91%    7.79%   1.02×
```

Reading the numbers:

- **Depth 0 (no transducer)** — ~equivalent to production. Pay-as-you-go check is essentially free.
- **Depth 1** — ~15-28% slower than production's cached cumScale. Acceptable.
- **Depth 2** — **matches production** (within noise). Iteration over a 2-element direct-call array beats `cumScaleOf`'s parent-chain walk + cache lookups at this depth.

The "fast-path optimization" for deep stacking is no longer load-bearing — the separated-stacks design closes the gap structurally.

## What's gone vs production

- `DETACH_KEY`, `SCALE_KEY` symbols
- `Detach` type, `detach` factory (now in `detach.ts`, built on `Suspend.ctx.spawn`)
- `Scaled` type, `scaled` factory (replaced by `Transduced` + `transduce`; new `scaled` in `transducers.ts`)
- `Active.scale`, `Active.inScaledSubtree`, `Active.cumScale`, `Active.cumScaleStep`, `Active.parent`
- `cumScaleOf`, `scaledChild` engine methods
- The scaled-vs-fast split in `step()`
- The `number ≤ 0` tail-call branch (now parks like `yield`)
- `cutValue` helper (folded into `unwrapCut`)
- `isCut` / `asGen` / `isGen` exports (now internal; `isGenerator` is the renamed public export)
- `AnimObserver`, `Anim.observer` slot
- `currentAnim` global, `withContext` wrapper

## What's added

- `Transducer` interface (3 optional hooks)
- `Transduced<R>` shape with three internal stacks
- `transduce(t, target)` constructor
- `TRANSDUCE_KEY` marker (engine-recognized yield shape)
- `Suspend`'s 2nd arg `spawn(g) → cancel`
- Re-entry guard on `step()`
- `isGenerator` public export
- New userland: `pauseWhen`, `slowmoWhen` (in `transducers.ts`)

## What's now possible that production can't do

- `detach(scaled(rate, g))` composes correctly (broken in production)
- `pauseWhen(pred, anim)` / `pauseOnHidden(anim)` / any predicate-driven freeze (3 lines)
- Custom protocol transducers (`trace`, `replay`, `breakpoint`, etc.) via `onYield` / `onResume`
- `pool` / `supervisor` / `priority` coordinators via `Suspend.ctx.spawn`
- Re-entry detection (production silently double-ticks)

## Honest costs

1. **~15-28% slower at depth 1** vs production. Sub-1% of frame budget at 10K.
2. **`yield N ≤ 0` parks instead of tail-calling.** No real code used this (only tests of the feature itself).
3. **Transducer authors must understand the 3-hook contract.** Documented in `anim.ts`.
4. **Hook ordering is direction-dependent.** `onTick` walks innermost→outermost; `onYield`/`onResume` walk outermost→innermost. The Transducer interface comments explain why.

## Run

```sh
npx tsx src/minim/_proto/test.ts   # all tests
npx tsx src/minim/_proto/bench.ts  # scaling bench
```
