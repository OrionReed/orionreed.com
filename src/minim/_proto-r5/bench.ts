// bench.ts — r5 vs r2.

import { bench, group, run, do_not_optimize } from "mitata";

import * as R2 from "../signals/signal";
import { vec as r2vec } from "../signals/values/vec";

import * as R5 from "./signal";
import { vec as r5vec } from "./values/vec";

const r2sig = R2.signal(0); let r2acc = 0;
R2.effect(() => { r2acc = r2sig.value });
const r5sig = R5.signal(0); let r5acc = 0;
R5.effect(() => { r5acc = r5sig.value });

group("signal write (pre-constructed, 10k)", () => {
  bench("r2", () => { for (let i = 0; i < 10_000; i++) r2sig.value = i; do_not_optimize(r2acc) });
  bench("r5", () => { for (let i = 0; i < 10_000; i++) r5sig.value = i; do_not_optimize(r5acc) });
});

group("vec.x write-through (10k)", () => {
  bench("r2", () => {
    const v = r2vec(0, 0); let acc = 0;
    R2.effect(() => { acc = v.value.x });
    for (let i = 0; i < 10_000; i++) v.x.value = i;
    do_not_optimize(acc);
  });
  bench("r5", () => {
    const v = r5vec(0, 0); let acc = 0;
    R5.effect(() => { acc = v.value.x });
    for (let i = 0; i < 10_000; i++) v.x.value = i;
    do_not_optimize(acc);
  });
});

group("vec construction (10k)", () => {
  bench("r2", () => { for (let i = 0; i < 10_000; i++) do_not_optimize(r2vec(i, i)) });
  bench("r5", () => { for (let i = 0; i < 10_000; i++) do_not_optimize(r5vec(i, i)) });
});

group("chain depth 4: vec.add().add()..., 10k source writes", () => {
  bench("r2", () => {
    const v = r2vec(0, 0);
    let c = v.add({ x: 1, y: 0 });
    for (let i = 0; i < 3; i++) c = c.add({ x: 1, y: 0 });
    let acc = 0;
    R2.effect(() => { acc = c.value.x });
    for (let i = 0; i < 10_000; i++) v.value = { x: i, y: 0 };
    do_not_optimize(acc);
  });
  bench("r5", () => {
    const v = r5vec(0, 0);
    let c = v.add({ x: 1, y: 0 });
    for (let i = 0; i < 3; i++) c = c.add({ x: 1, y: 0 });
    let acc = 0;
    R5.effect(() => { acc = c.value.x });
    for (let i = 0; i < 10_000; i++) v.value = { x: i, y: 0 };
    do_not_optimize(acc);
  });
});

await run({ format: "mitata" });
