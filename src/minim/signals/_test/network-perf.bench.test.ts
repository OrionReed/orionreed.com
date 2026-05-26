// network-perf.bench.test.ts — micro-benchmarks of `network`'s
// per-fire allocation cost.
//
// Numbers vary by machine; assertions are loose. Console.log
// records actual cost for inspection.

import { describe, expect, it } from "vitest";
import { batch, network, signal } from "../index";

function bench(label: string, runs: number, fn: () => void): number {
  for (let i = 0; i < Math.min(100, Math.floor(runs / 10)); i++) fn();
  const start = performance.now();
  for (let i = 0; i < runs; i++) fn();
  const elapsed = performance.now() - start;
  const perRun = (elapsed / runs) * 1e6;
  console.log(
    `  ${label}: ${perRun.toFixed(1)} ns/run (${runs} runs, ${elapsed.toFixed(1)} ms total)`,
  );
  return perRun;
}

describe("network — per-fire allocation cost", () => {
  it("simple network, single dep, no value change — flush() roundtrip", () => {
    const a = signal(0);
    const handle = network([a], () => {});
    const ns = bench("flush() with 1 dep, no change", 10_000, () => {
      handle.flush();
    });
    expect(ns).toBeLessThan(5000);
    handle.dispose();
  });

  it("network with 100 deps, single change per fire", () => {
    const sigs = Array.from({ length: 100 }, (_, i) => signal(i));
    let driverIdx = 0;
    const handle = network(sigs, () => {});
    const ns = bench("100 deps, 1 changes per fire", 1_000, () => {
      sigs[driverIdx]!.value = sigs[driverIdx]!.peek() + 1;
      driverIdx = (driverIdx + 1) % 100;
    });
    expect(ns).toBeLessThan(50_000);
    handle.dispose();
  });

  it("network with 1000 deps, batch update of 10 per fire", () => {
    const sigs = Array.from({ length: 1000 }, (_, i) => signal(i));
    const handle = network(sigs, () => {});
    let bursts = 0;
    const ns = bench("1000 deps, 10 changes per fire (batched)", 200, () => {
      const offset = bursts * 10;
      bursts = (bursts + 1) % 100;
      batch(() => {
        for (let i = 0; i < 10; i++) {
          sigs[(offset + i) % 1000]!.value = sigs[(offset + i) % 1000]!.peek() + 1;
        }
      });
    });
    expect(ns).toBeLessThan(500_000);
    handle.dispose();
  });

  it("manual-mode network, repeated flush", () => {
    const a = signal(0);
    const handle = network([a], () => {}, { manual: true });
    const ns = bench("manual flush, 1 dep, no change", 10_000, () => {
      handle.flush();
    });
    expect(ns).toBeLessThan(5000);
    handle.dispose();
  });

  it("auto-fire: 100 deps, network reads them all on each fire", () => {
    const sigs = Array.from({ length: 100 }, (_, i) => signal(i));
    const handle = network(sigs, () => {
      let sum = 0;
      for (const s of sigs) sum += s.value;
      void sum;
    });
    let i = 0;
    const ns = bench("100 deps, auto-fire + sum-read", 1_000, () => {
      sigs[i]!.value = sigs[i]!.peek() + 1;
      i = (i + 1) % 100;
    });
    expect(ns).toBeLessThan(100_000);
    handle.dispose();
  });
});
