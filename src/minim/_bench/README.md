# minim bench

Micro-benchmarks for the `signals/struct` framework. Built on
[mitata](https://github.com/evanwashere/mitata) — per-bench JIT
isolation keeps inline-cache state from leaking across variants
(a real problem we hit with a custom harness).

Validates:

- Cost of `Vec.signal` / `Box.signal` / etc. construction vs raw `signal({...})`
- Memory per instance (heap-delta sampling — fixed-population study)
- Axis read/write through framework lenses vs hand-written equivalents
- Per-arity unrolling: do the hand-unrolled cases (lifters 0/1/2,
  axis writers 1/2/4/6) actually beat the generic fallbacks?
- Lazy getter cost (first access vs cached own-property)
- Tween throughput (60-frame `.to(target, dur)` end-to-end)
- Tree fan-out: reactive worldFrame chain vs on-demand parent walk
- `delegate(host, key, struct)`: passthrough getters vs hand-rolled
  forwarder fields (`Part`-style)

## Run

```sh
node --expose-gc node_modules/.bin/vite-node src/minim/_bench/index.ts
```

`--expose-gc` is recommended for the memory benches; without it the
heap-delta numbers are rougher.

## Output

mitata prints per-`group` tables with `avg / p25 / p50 / p75 / p99 / p999`
and a relative comparison vs the group's `.baseline(true)` bench.
Memory rows print after at the bottom with `B/inst` and relative size.

## Adding benches

```ts
// _bench/my.bench.ts
import { bench, group } from "mitata";
import { memory } from "./memory";

group("my section", () => {
  bench("baseline", () => doThing()).baseline(true);
  bench("variant", () => doThingDifferently());
});

memory("my object", (i) => alloc(i));
```

Then add `import "./my.bench";` to `index.ts`.

## Conventions

- Within each group, the bench tagged `.baseline(true)` is the
  reference; mitata reports `rel` against it.
- For write benches, increment a counter (`++i`) into the value so
  equality doesn't suppress the notify path.
- For read-of-derived benches, force re-eval each iter by writing
  through one of the dependencies first.
- For "first access" vs "cached" comparisons (lazy getters, axis
  lenses), construct a fresh instance each iter for first-access and
  reuse the same instance with a warmed cache for the cached variant.
- mitata handles do-not-optimize on returned values internally —
  `return v` from the bench body is enough.

## Cross-process sanity check

`_isolated_check.ts` runs the delegate variants in fully separate
processes — useful when you want absolute confidence that a number
isn't an inline-cache artifact. mitata's per-bench isolation
addresses most of this already, but the cross-process script remains
the gold standard for "is this number real?" investigations.

```sh
node node_modules/.bin/vite-node src/minim/_bench/_isolated_check.ts -- direct x.value
node node_modules/.bin/vite-node src/minim/_bench/_isolated_check.ts -- cached center.x.value
# variants: direct | cached | naive | bound
# targets:  x.value | center.x.value | mixed
```
