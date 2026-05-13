# minim bench

Micro-benchmarks for the `signals/struct` framework. Used to validate:

- Cost of `Vec.signal` / `Box.signal` / etc. construction vs raw `signal({...})`
- Memory per instance (heap-delta sampling)
- Axis read/write through framework lenses vs hand-written equivalents
- Per-arity unrolling: do the hand-unrolled cases (lifters 0/1/2,
  axis writers 1/2/4/6) actually beat the generic fallbacks?
- Lazy getter cost (first access vs cached own-property)
- Tween throughput (60-frame `.to(target, dur)` end-to-end)
- Tree fan-out: reactive worldFrame chain vs on-demand parent walk
  (informs the Frames-in-Shapes redesign)
- Cell-primitive hypothesis: does a hand-built Vec on a tiny `defineCell`
  primitive perform comparably to the framework Vec? (informs the
  framework simplification direction.)

## Run

```sh
node --expose-gc node_modules/.bin/vite-node src/minim/_bench/index.ts
```

`--expose-gc` is recommended — without it, the memory benches still
run but use rougher heap-delta numbers.

## Output

Each suite prints a small table with `ns/op`, `ops/sec`, and `rel`
(relative speed against the section's baseline — the first declared
bench). Memory rows show `B/inst` (bytes per instance, heap-delta).

## Adding benches

```ts
// _bench/my.bench.ts
import { suite, bench, memory } from "./harness";

suite("my section", () => {
  bench("baseline", () => doThing());
  bench("variant", () => doThingDifferently());
  memory("plain object", (i) => ({ x: i }));
});
```

Then add `import "./my.bench";` to `index.ts`.

## Conventions

- The first `bench()` in a suite is the *baseline* — others' `rel`
  column is `baseline.ns / variant.ns` (so `>1.0x` means *faster*).
- For write benches, increment a counter (`++i`) into the value so
  equality doesn't suppress the notify path.
- For read-of-derived benches, force re-eval each iter by writing
  through one of the dependencies first.
- For "first access" vs "cached" comparisons (lazy getters, axis
  lenses), construct a fresh instance each iter for first-access and
  reuse the same instance with a warmed cache for the cached variant.
- Auto-tuning: the harness picks an iter count to fit the target
  budget (default 250ms). Override via `bench(name, fn, { iters })`.
