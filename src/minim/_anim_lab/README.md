# anim_lab

Isolated playground for rewriting `core/anim.ts`. Same yield contract,
faster + simpler. Don't import anything from here in the rest of the
codebase.

## Layout

- `engine-current.ts` — verbatim copy of `core/anim.ts` for in-lab benching
  (so we compare apples-to-apples without changing imports).
- `engine-v*.ts` — candidate rewrites.
- `bench.ts` — micro-benchmarks across engines.
- `equiv.ts` — semantic equivalence checks (yield contract conformance).

## Run

```sh
node --expose-gc node_modules/.bin/vite-node src/minim/_anim_lab/bench.ts
node node_modules/.bin/vite-node src/minim/_anim_lab/equiv.ts
```
