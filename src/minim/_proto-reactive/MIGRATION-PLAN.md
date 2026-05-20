# Reactive<T> migration plan

Consolidated audit + migration plan for replacing the Signal+Computed
split with a single `Reactive<T>` class in production.

## Current state (lines and exports)

```
src/minim/signals/
  signal.ts       573 lines   Signal, Computed, Lens, signal/computed/lens/effect/batch/untracked,
                              setSignalWriteHook, Read, Val, isSignal, SignalOptions
  derive.ts        71 lines   derived, field, ReactiveInit, viewClassFor (private)
  traits.ts        62 lines   LINEAR/LERP/METRIC/EQUALS symbols + helpers
  lerp.ts         435 lines   Tween/spring/toward/attract/follow/wave/driven/play/etc.
  clock.ts         15 lines   clockSignal
  index.ts        112 lines   re-exports
  values/
    num.ts         67 lines   Num, NumChain, num
    vec.ts        125 lines   Vec, VecChain, vec, polar
    box.ts        159 lines   Box, BoxChain, box
    color.ts       83 lines   Color, ColorChain, rgb, rgba
    transform.ts  135 lines   Transform, TransformChain, transform
    matrix.ts     185 lines   Matrix, MatrixChain, matrix
    anchor.ts      25 lines   Anchor, Dir
    index.ts       70 lines   re-exports + combine + mean
```

Total engine: 851 lines (signal.ts + derive.ts + traits.ts).
Total value types: 814 lines (excluding lerp/clock).

## What `Reactive<T>` migration deletes

### From `signal.ts`

- `class ComputedImpl extends Signal<T>` (~85 lines, signal.ts:341-441) — collapses into `Reactive.value` getter's computed-path
- `Computed` as separate runtime class (signal.ts:461-468) — becomes type alias
- `Lens<T> = ComputedImpl<T>` type alias (signal.ts:457) — becomes structural type
- `signal()`, `computed()`, `lens()` factories stay; bodies become 5 lines each

### From `derive.ts`

- **DELETE** `viewClassFor` (lines 13-40, ~28 lines)
- **DELETE** `VIEW_CLASS_CACHE` (line 13)
- **DELETE** `copyOwnProps` (lines 15-26)
- **SIMPLIFY** `derived()` from 8 lines to 5 lines
- **SIMPLIFY** `field()` from 19 lines to ~10 lines (still has FIELD_CACHE Symbol — see "open" below)
- **KEEP** `ReactiveInit<T>` type

Net: `derive.ts` shrinks from 71 lines to ~25 lines.

### From value types

NOTHING NEEDS TO CHANGE in value-type files. `Vec extends Signal<VecValue>` becomes `Vec extends Reactive<VecValue>` — same shape, same methods, same trait slots. The Chain classes in each value type are orthogonal (relate to the lens/iso work in `_proto-iso/`).

## What stays the same

- All trait machinery (`traits.ts` unchanged)
- All `lerp.ts` animation primitives (tween/spring/etc.)
- All value-type math
- The alien-signals algorithm (we keep our own port — confirmed during Combo B exploration that wrapping alien adds overhead without benefit)
- `setSignalWriteHook` (used by `assert/record.ts`) — port to merged Reactive
- The `Read<T>` covariant type
- `Val<T>`, `value()`, `isSignal`
- `batch()`, `untracked()`
- `effect()` (`EffectImpl` class stays separate; doesn't need to merge)
- The `peek()` fix from earlier (already in production)

## Concrete migration steps

Each step is independently shippable and reversible.

### Step 1: Land `Reactive<T>` alongside existing `Signal<T>`

Add `src/minim/signals/reactive.ts` (copied from `_proto-reactive/reactive.ts`).
Don't change any existing imports. New code in parallel.

**Validates:** the merged engine compiles, all 161 RFTS tests pass against
it (already confirmed).

### Step 2: Swap `Signal` → `Reactive` internally in `signal.ts`

```ts
// signal.ts
export { Reactive as Signal } from "./reactive";
// Keep `Signal` as the public name; `Reactive` is the internal class.
```

The public API name `Signal` stays. Existing call sites work unchanged.
`signal.ts` becomes a thin re-export layer.

**Validates:** 233 production minim tests still pass.

### Step 3: Replace `Computed`, `Lens`, `derived`, `field`

```ts
// derive.ts (or fold into signal.ts)
export function derived<T, C extends Signal<T>>(
  Cls: new (...args: never[]) => C,
  fn: () => T,
  setter?: (v: T) => void,
): C {
  const inst = new Cls();
  inst.getter = fn;
  if (setter) inst.setter = setter;
  inst.flags = 0;
  return inst;
}

export type Computed<T = unknown> = Omit<Signal<T>, "value"> & {
  readonly value: T;
};
export type Lens<T = unknown> = Signal<T>; // both getter and setter set
```

`viewClassFor` deleted. `VIEW_CLASS_CACHE` deleted.

**Validates:** all derived value tests (`vec.add(b) instanceof Vec` etc.)
pass via native prototype chain.

### Step 4: Replace `FIELD_CACHE` Symbol with WeakMap (orthogonal cleanup)

```ts
const FIELD_CACHE = new WeakMap<Signal<unknown>, Map<PropertyKey, unknown>>();
```

Frees us from the `Symbol`-on-instance pattern. Same semantics, cleaner.
Optional — can ship before or after Step 3.

### Step 5: Update value types to use `Reactive` directly (or keep `Signal` alias)

Pure cosmetic — value-type files can keep `extends Signal<T>` (since
`Signal = Reactive`). If we ever rename `Signal` → `Reactive` publicly,
value-type files update; mechanical.

## What `derive.ts` looks like after

```ts
// derive.ts — final
import { Signal } from "./signal"; // (which is the merged Reactive)
import type { Val } from "./signal";

export type ReactiveInit<T> = { [K in keyof T]?: Val<T[K]> };

const FIELD_CACHE = new WeakMap<Signal<unknown>, Map<PropertyKey, unknown>>();

export function derived<T, C extends Signal<T>>(
  Cls: new (...args: never[]) => C,
  fn: () => T,
  setter?: (v: T) => void,
): C {
  const inst = new Cls();
  inst.getter = fn;
  if (setter) inst.setter = setter;
  inst.flags = 0;
  return inst;
}

export function field<P, K extends keyof P, Type extends new (...args: never[]) => Signal<P[K]>>(
  parent: Signal<P>,
  key: K,
  Type: Type,
): InstanceType<Type> {
  let cache = FIELD_CACHE.get(parent);
  if (!cache) FIELD_CACHE.set(parent, cache = new Map());
  const cached = cache.get(key);
  if (cached) return cached as InstanceType<Type>;
  const fl = derived(
    Type,
    () => (parent.value as P)[key],
    (v: P[K]) => { parent.value = { ...(parent.peek() as object), [key]: v } as P; },
  );
  cache.set(key, fl);
  return fl as InstanceType<Type>;
}
```

**~30 lines** vs current 71. No `viewClassFor`, no `VIEW_CLASS_CACHE`,
no `copyOwnProps`. Read-through-for-instanceof works natively because
`Cls extends Signal extends Reactive` is a real prototype chain.

## Better-ways inventory (worth doing alongside)

These are independent improvements; some can happen during or after the
core migration:

### A. `setSignalWriteHook` — port carefully

Currently `signal.ts:57` exports a write-hook setter used by
`assert/record.ts`. Need to wire this into the merged `Reactive`'s `set
value` so writes are still observable. ~10 lines.

### B. `Lens<T>` honest typing

Current: `type Lens<T> = ComputedImpl<T>` (type alias). The runtime
type doesn't distinguish lens from computed.

Proposed: `type Lens<T> = Signal<T>` (since merged Reactive treats lens
as "signal with setter") — but add a runtime predicate `isLens(x)`:

```ts
export const isLens = (x: unknown): x is Signal<unknown> =>
  x instanceof Signal && x.setter !== undefined;
```

Useful for downstream type-narrowing.

### C. Drop `Computed` runtime class export

Currently `Computed` is both a type AND a runtime class:
```ts
export const Computed = ComputedImpl as { new <T>(getter): Computed<T>; ... };
```

After migration: `Computed` is just a type alias for `Read<T>`. The
runtime construction goes through `computed()` factory only. Removes
one user-facing concept.

Check callers: `grep "new Computed"` (one usage in test file). Migrate
to `computed(fn)`.

### D. Chain mirror classes (`VecChain`, etc.) — orthogonal

The Chain classes (one per value type) were never connected to the
engine; they were authoring-time helpers for fused expressions. The
lens/iso work in `_proto-iso/` proposed unifying these. **Defer this
question** — the engine migration doesn't touch them and the lens
work can ship later independently.

### E. `Signal` rename to `Reactive`?

The class IS now `Reactive`. Public-facing name could rename for
clarity. But `Signal` is established in user code and docs. **Don't
rename** — keep `Signal` as the public name; `Reactive` is the
internal concept.

## Type inference checks

Tests to add/verify:

1. `derived(Vec, () => vAdd(v.value, b)) instanceof Vec` — true at runtime AND TS infers `Vec`
2. `vec.x` returns `Num` (via `field(this, 'x', Num)`)
3. `Lens<T>` types narrow correctly (writable type)
4. `Computed<T>` types reject writes at compile time
5. `effect(() => { void s.value })` infers `void` return for non-cleanup variant

The current `derive.ts` type signatures (`derived<T, C extends Signal<T>>`)
work unchanged. No type-system surgery needed.

## Cleanup of `_proto-*` folders

After the migration ships:

| Folder | Decision | Reasoning |
|---|---|---|
| `_proto/` | KEEP | Engine v2 (animation engine, separate concern) — still WIP |
| `_proto-reactive/` | DELETE (after porting to production) | `reactive.ts` becomes `src/minim/signals/reactive.ts`; tests/bench port to `_test/` and `_bench/` |
| `_proto-iso/` | KEEP (move forward) | Lens/iso work, layers on top of merged Reactive cleanly |
| `_proto-vc/` | DELETE | viewClassFor refactor attempts — superseded by merged Reactive |
| `_proto-callable/` | DELETE | Callable signals — rejected (breaking API + construction cost) |
| `_proto-combo-b/` | DELETE | alien-wrapped — rejected (no perf win, extra overhead) |
| `_proto-wrap/` | DELETE | alien-wrapped exploration — superseded by combo-b investigation |

Also remove dev deps no longer needed:
- `alien-signals` from `src/minim/package.json` (was added for benches)
- `@preact/signals-core` from `src/minim/package.json` (was added for benches)

## Risk assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Subtle behavior differences from current engine | Low | High | RFTS conformance already passes 161/161 |
| Perf regression on chain traversal | Confirmed (+10%) | Low (typical workloads invisible) | Document; bench production workloads |
| `setSignalWriteHook` breaks | Low | Medium (only assert/record) | Port carefully in Step 2 |
| Type inference regression | Low | Medium | Verify with existing tests + add type-tests |
| `viewClassFor`-dependent edge case | Low | Low | All uses go through `derived()` which has clean replacement |
| User code that uses `Computed` as runtime class | Low | Low | grep, migrate to factory |

## What this is NOT doing (left for separate decisions)

- Not adopting callable signals
- Not wrapping alien-signals as engine
- Not unifying `Chain` mirror classes (lens/iso work — separate decision)
- Not changing trait slot mechanism
- Not changing `lerp.ts` / animation primitives
- Not changing the public API of `signal()`, `computed()`, `lens()`, `effect()`, etc.

## Test plan

For each migration step:

1. `npx tsc --noEmit` — types pass
2. `cd src/minim && npm test` — all 233 minim tests pass
3. `npx vitest run src/minim/_test/conformance.test.ts` — 161 RFTS pass
4. `node --expose-gc node_modules/.bin/vite-node src/minim/_bench/index.ts` — bench numbers within ±15% of current

If any test fails, step is reversible (git stash/reset).

## Recommended execution order

1. Step 1 + Step 4 together (`reactive.ts` alongside + WeakMap field cache) — pure additions
2. Verify with all tests
3. Step 2 + Step 3 together (swap internally, replace derived/field) — the actual migration
4. Verify with all tests + bench
5. Step 5 + cleanup (rename/relocate value types, delete experiment folders)
6. Open question (B, C, D, E) — case-by-case after migration is stable
