// bench.ts — comparative bench against the current merged-Signal r2.
//
// Run:
//   node --expose-gc node_modules/.bin/vite-node \
//        src/minim/_proto-r3/bench.ts

import { bench, group, run, do_not_optimize } from "mitata";

// r2 (current production)
import * as R2 from "../signals/signal";
import { Vec as R2Vec, vec as r2vec } from "../signals/values/vec";
import { Num as R2Num, num as r2num } from "../signals/values/num";

// r3 (this prototype)
import * as R3 from "./signal";
import { VecSignal as R3VecSignal, vec as r3vec } from "./values/vec";
import { NumSignal as R3NumSignal, num as r3num } from "./values/num";

// ─── 1. Bare signal write — pre-constructed ────────────────────────

const r2sig = R2.signal(0);
let r2acc = 0;
R2.effect(() => { r2acc = r2sig.value });

const r3sig = R3.signal(0);
let r3acc = 0;
R3.effect(() => { r3acc = r3sig.value });

group("signal write only (pre-constructed, 10k writes)", () => {
  bench("r2 (merged Signal)", () => {
    for (let i = 0; i < 10_000; i++) r2sig.value = i;
    do_not_optimize(r2acc);
  });

  bench("r3 (split Signal class)", () => {
    for (let i = 0; i < 10_000; i++) r3sig.value = i;
    do_not_optimize(r3acc);
  });
});

group("signal: 10k writes including construction (effect subscribed)", () => {
  bench("r2 (merged Signal)", () => {
    const s = R2.signal(0);
    let acc = 0;
    R2.effect(() => { acc = s.value });
    for (let i = 0; i < 10_000; i++) s.value = i;
    do_not_optimize(acc);
  });

  bench("r3 (split Signal class)", () => {
    const s = R3.signal(0);
    let acc = 0;
    R3.effect(() => { acc = s.value });
    for (let i = 0; i < 10_000; i++) s.value = i;
    do_not_optimize(acc);
  });
});

// ─── 2. Computed propagation ───────────────────────────────────────

group("computed: chain of 5, 10k source writes", () => {
  bench("r2", () => {
    const a = R2.signal(0);
    const b = R2.computed(() => a.value + 1);
    const c = R2.computed(() => b.value * 2);
    const d = R2.computed(() => c.value + 3);
    const e = R2.computed(() => d.value * 2);
    let acc = 0;
    R2.effect(() => { acc = e.value });
    for (let i = 0; i < 10_000; i++) a.value = i;
    do_not_optimize(acc);
  });

  bench("r3", () => {
    const a = R3.signal(0);
    const b = R3.computed(() => a.value + 1);
    const c = R3.computed(() => b.value * 2);
    const d = R3.computed(() => c.value + 3);
    const e = R3.computed(() => d.value * 2);
    let acc = 0;
    R3.effect(() => { acc = e.value });
    for (let i = 0; i < 10_000; i++) a.value = i;
    do_not_optimize(acc);
  });
});

// ─── 3. Lens write-through (field-of-Vec) ──────────────────────────

group("lens: vec.x.value = i, 10k writes (effect on .value)", () => {
  bench("r2", () => {
    const v = r2vec(0, 0);
    let acc = 0;
    R2.effect(() => { acc = v.value.x });
    for (let i = 0; i < 10_000; i++) v.x.value = i;
    do_not_optimize(acc);
  });

  bench("r3", () => {
    const v = r3vec(0, 0);
    let acc = 0;
    R3.effect(() => { acc = v.value.x });
    for (let i = 0; i < 10_000; i++) v.x.value = i;
    do_not_optimize(acc);
  });
});

// ─── 4. Vec construction ───────────────────────────────────────────

group("construction: 10k vec(x, y)", () => {
  bench("r2", () => {
    for (let i = 0; i < 10_000; i++) do_not_optimize(r2vec(i, i));
  });
  bench("r3", () => {
    for (let i = 0; i < 10_000; i++) do_not_optimize(r3vec(i, i));
  });
});

// ─── 5. Fused chain (eager methods, varying depth) ────────────────

for (const depth of [2, 4, 8]) {
  group(`chain depth ${depth}: vec.add(b).scale(2)..., 10k source writes`, () => {
    bench("r2", () => {
      const v = r2vec(0, 0);
      let chain = v.add({ x: 0, y: 0 });
      for (let i = 0; i < depth - 1; i++) chain = chain.add({ x: 1, y: 0 });
      let acc = 0;
      R2.effect(() => { acc = chain.value.x });
      for (let i = 0; i < 10_000; i++) v.value = { x: i, y: 0 };
      do_not_optimize(acc);
    });
    bench("r3", () => {
      const v = r3vec(0, 0);
      let chain = v.add({ x: 0, y: 0 });
      for (let i = 0; i < depth - 1; i++) chain = chain.add({ x: 1, y: 0 });
      let acc = 0;
      R3.effect(() => { acc = chain.value.x });
      for (let i = 0; i < 10_000; i++) v.value = { x: i, y: 0 };
      do_not_optimize(acc);
    });
  });
}

// ─── 6. Pure peek (no subscription) ────────────────────────────────

group("peek: 100k untracked reads on a Vec field lens", () => {
  bench("r2", () => {
    const v = r2vec(1, 2);
    const x = v.x;
    let acc = 0;
    for (let i = 0; i < 100_000; i++) acc += x.peek();
    do_not_optimize(acc);
  });
  bench("r3", () => {
    const v = r3vec(1, 2);
    const x = v.x;
    let acc = 0;
    for (let i = 0; i < 100_000; i++) acc += x.peek();
    do_not_optimize(acc);
  });
});

// ─── 7. Heap shape: pure source signal ─────────────────────────────

group("alloc: 100k bare signals", () => {
  bench("r2", () => {
    const arr: unknown[] = [];
    for (let i = 0; i < 100_000; i++) arr.push(R2.signal(i));
    do_not_optimize(arr);
  });
  bench("r3", () => {
    const arr: unknown[] = [];
    for (let i = 0; i < 100_000; i++) arr.push(R3.signal(i));
    do_not_optimize(arr);
  });
});

await run({ format: "mitata" });
