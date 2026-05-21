# r3 — 3-class engine split prototype

Real working signals layer with:

- **3 primitive classes** — `Signal<T>`, `Computed<T>`, `Lens<T>` extending an abstract `Node<T>`. No mode flags, no `if (this.getter !== undefined)` branches in hot accessors.
- **No `derive()` / no `Chain`** — moved to future-perf notes. Eager invertible methods (`.add`, `.scale`) still produce write-through lenses; chains are just nested method calls.
- **Class-static `Vec.derive` / `Vec.lens`** — typed derived constructors per value class. The global `computed`/`lens` factories are bare and untyped.
- **Field-lens auto-promotion** — `vec.x` returns `NumLens` on writable receivers and `NumComputed` on RO receivers.
- **Structural `Num` / `Vec` types** — the public `Num`/`Vec` aliases are minimal read-only interfaces. All three concrete flavours (signal/computed/lens) satisfy them structurally; writes via the alias type-error correctly.

## Status: 35 tests passing, perf competitive with r2

```
$ cd src/minim && npm test -- src/minim/_proto-r3
Test Files  3 passed (3)
Tests       35 passed (35)
```

## Benchmark vs r2 (current production signals module)

Apple M2 Pro, node 22.19, single process. Numbers averaged across 3 runs; ± noise.

| benchmark | r2 | r3 | Δ |
|---|---|---|---|
| signal write (pre-constructed, 10k) | 235 µs | 232 µs | **−1%** |
| signal write incl. construction (10k) | 365 µs | 290 µs | **−21%** |
| computed chain of 5 (10k source writes) | 1.30 ms | 1.30 ms | **±0** |
| lens write-through `vec.x.value` (10k) | 1.20 ms | 940 µs | **−22%** |
| `vec(x, y)` construction (10k) | 3.13 ms | 3.02 ms | **−4%** |
| chain depth 2, 10k source writes | 1.05 ms | 1.01 ms | **−4%** |
| chain depth 4, 10k source writes | 1.69 ms | 1.83 ms | **+8%** |
| chain depth 8, 10k source writes | 2.74 ms | 2.84 ms | **+4%** |
| peek (100k reads, no subscription) | 493 µs | 432 µs | **−12%** |
| alloc 100k bare signals | 6.95 ms | 6.12 ms | **−12%** |

Net: meaningfully faster on the most common paths (signal writes, lens through-writes, peek, allocation). Small regression (~5–8%) in chain depths 4–8 — likely polymorphic dispatch on `.value` reads when the chain mixes Signal + Lens + Computed instances. Probably acceptable; can be mitigated by inlining hot paths if it shows up in production.

## What's in this folder

```
signal.ts         — Node + Signal + Computed + Lens + Effect + flush + factories
traits.ts         — TraitDict, Traits<T, K>, requireLinear/etc
ops.ts            — Op<V, Args> + applyOp1/applyOp2 (no Chain)
promote.ts        — Writable<T> = Signal<T> | Lens<T>
index.ts          — public surface
values/
  num.ts          — NumSignal / NumComputed / NumLens + factories + Num.derive/lens
  vec.ts          — VecSignal / VecComputed / VecLens + factories + Vec.derive/lens
_test/
  engine.test.ts  — primitives + factories + effects + batch/untracked
  values.test.ts  — value-class behaviour + field lenses + writability
  types.test.ts   — compile-time writability assertions
bench.ts          — comparative benchmark vs r2
README.md         — you are here
```

Not yet ported: `anim.ts` (spring/tween/Tween), `box.ts`, `color.ts`, `matrix.ts`, `transform.ts`, `anchor.ts`, `multi.ts`, `hyper.ts`, `clock.ts`. These all follow the same shape and would be mechanical migrations.

## Authoring shape per value class

Each value class is about 80–100 lines of TS — comparable to today's per-class size. The shape:

```ts
// 1. Pure value-space functions (also serve as trait impls)
type V = { x: number; y: number };
export const add = (a: V, b: V): V => ({...});
// ... sub, scale, lerp, metric, equals, ...

// 2. Op declarations
const addOp: Op<V, [V]> = { fwd: add, bwd: sub };
// ...

// 3. Shared method tables — split by capability
const readable = { normalize, perp, lerp, distance };
const writable = { ...readable, add, sub, scale, offset };

// 4. Field-lens descriptors (descriptors, not getters — getters can't carry `this`)
const roField = (key) => ({ get(this) { return this.field(key, (g) => new NumComputed(g)) } });
const rwField = (key) => ({ get(this) { return this.field(key, (g, s) => new NumLens(g, s)) } });

// 5. Three concrete classes
export class VecSignal extends Signal<V> { static traits = TRAITS; declare add: ...; }
Object.assign(VecSignal.prototype, writable);
Object.defineProperties(VecSignal.prototype, { x: rwField("x"), ... });

export class VecComputed extends Computed<V> { static traits = TRAITS; ... }
Object.assign(VecComputed.prototype, readable);
Object.defineProperties(VecComputed.prototype, { x: roField("x"), ... });

export class VecLens extends Lens<V> { static traits = TRAITS; declare add: ...; }
Object.assign(VecLens.prototype, writable);
Object.defineProperties(VecLens.prototype, { x: rwField("x"), ... });

// 6. Public surface
export interface Vec { /* structural read-only */ }
export type WritableVec = VecSignal | VecLens;
export function vec(x = 0, y = 0): VecSignal { ... }
export const Vec = { derive, lens, [Symbol.hasInstance] };
```

The mixin via `Object.assign` keeps method bodies declared exactly once. The `declare` slots on each concrete class hand TS the types without duplicating implementation.

## What this prototype proves

1. **3-class engine split works.** Engine code is monomorphic per class, hot paths are clean, no mode-flag branches. Memory is smaller (no unused mode slots per instance).
2. **Performance is competitive with merged Signal.** Faster on signal writes / lens through-writes / peek / allocation; tiny regression on mid-depth chains.
3. **Type correctness is perfect** for the patterns we care about. All `@ts-expect-error` assertions in types.test.ts fire correctly. The structural `Num`/`Vec` aliases close the union-write footgun (`(n: Num).value = 5` is rejected).
4. **No prototype trickery.** Each value-class instance has a clean prototype chain: `VecSignal → Signal → Node → Object`. `instanceof` works naturally.
5. **Authoring cost is comparable to today.** Per value class, ~20 lines longer than today's merged-class version (due to declaring 3 concrete classes instead of 1), but no `WritableXxx` subclass duplication and the methods are factored into shared tables.

## Open questions before going further

1. **Mid-depth chain regression** (5–8% at depth 4). Worth investigating with a profiler before committing. Likely V8 polymorphic-dispatch when mixed Signal/Lens/Computed are read in the same hot loop. Could be fixed by careful inlining of `.value` getters or by sharing a `_readValue` private helper.
2. **`interface Vec { … }` vs union type.** I went with structural interface to close the union-write footgun. The trade-off: `instanceof Vec` requires a `Symbol.hasInstance` trick on the namespace object. Acceptable?
3. **Engine globals as module-local `let`s** is critical for V8 perf (10× difference). Means everything has to live in one file. signal.ts is ~580 lines. Acceptable, but worth flagging.
4. **No derive() means no fused chains.** Users wanting fused chains today (`vec.derive(c => c.add(b).scale(2))`) lose that ergonomics. The compromise: invertible eager methods (`vec.add(b).scale(2)`) still produce write-through lenses, just not fused into one node. For most cases this is fine; for animation hot paths it's a marginal cost.
5. **Untested production patterns.** The other 7 value classes + multi/hyper/anim are mechanical to port but might reveal pain points. Worth porting Box and Transform before committing.
