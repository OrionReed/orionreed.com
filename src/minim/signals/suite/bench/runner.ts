// mitata registration with a JIT pre-warm, mirroring the house style in
// `_bench/anim.bench.ts`. A bench drives `iters` edits per measured
// sample; the accumulator is sunk so the work can't be elided.

import { bench, do_not_optimize } from "mitata";
import type { Tick } from "./workloads";

export function reg(name: string, tick: Tick, iters = 1000): void {
  const drive = (): number => {
    let acc = 0;
    for (let i = 0; i < iters; i++) acc += tick(i);
    return acc;
  };
  for (let w = 0; w < 200; w++) do_not_optimize(drive());
  if ((globalThis as { gc?: () => void }).gc) (globalThis as { gc: () => void }).gc();
  bench(name, () => do_not_optimize(drive()));
}
