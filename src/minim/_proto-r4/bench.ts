// bench.ts — r4 vs r2 (same engine, just type-system additions).

import { bench, group, run, do_not_optimize } from "mitata";

import * as R2 from "../signals/signal";
import { vec as r2vec } from "../signals/values/vec";

import * as R4 from "./signal";
import { vec as r4vec } from "./values/vec";

const r2sig = R2.signal(0); let r2acc = 0;
R2.effect(() => { r2acc = r2sig.value });

const r4sig = R4.signal(0); let r4acc = 0;
R4.effect(() => { r4acc = r4sig.value });

group("signal write (pre-constructed)", () => {
  bench("r2", () => { for (let i = 0; i < 10_000; i++) r2sig.value = i; do_not_optimize(r2acc) });
  bench("r4", () => { for (let i = 0; i < 10_000; i++) r4sig.value = i; do_not_optimize(r4acc) });
});

group("vec.x write-through (10k)", () => {
  bench("r2", () => {
    const v = r2vec(0, 0); let acc = 0;
    R2.effect(() => { acc = v.value.x });
    for (let i = 0; i < 10_000; i++) v.x.value = i;
    do_not_optimize(acc);
  });
  bench("r4", () => {
    const v = r4vec(0, 0); let acc = 0;
    R4.effect(() => { acc = v.value.x });
    for (let i = 0; i < 10_000; i++) v.x.value = i;
    do_not_optimize(acc);
  });
});

group("vec construction (10k)", () => {
  bench("r2", () => { for (let i = 0; i < 10_000; i++) do_not_optimize(r2vec(i, i)) });
  bench("r4", () => { for (let i = 0; i < 10_000; i++) do_not_optimize(r4vec(i, i)) });
});

group("chain depth 4: vec.add().add().add().add(), 10k source writes", () => {
  bench("r2", () => {
    const v = r2vec(0, 0);
    let c = v.add({ x: 1, y: 0 });
    for (let i = 0; i < 3; i++) c = c.add({ x: 1, y: 0 });
    let acc = 0;
    R2.effect(() => { acc = c.value.x });
    for (let i = 0; i < 10_000; i++) v.value = { x: i, y: 0 };
    do_not_optimize(acc);
  });
  bench("r4", () => {
    const v = r4vec(0, 0);
    let c = v.add({ x: 1, y: 0 });
    for (let i = 0; i < 3; i++) c = c.add({ x: 1, y: 0 });
    let acc = 0;
    R4.effect(() => { acc = c.value.x });
    for (let i = 0; i < 10_000; i++) v.value = { x: i, y: 0 };
    do_not_optimize(acc);
  });
});

await run({ format: "mitata" });
