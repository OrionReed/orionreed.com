// _proto-cell/cell.bench.test.ts — head-to-head perf:
//   current `Signal` (3-mode branched) vs sketch `Cell` (1-mode unified).
//
// The bench probes the hottest paths:
//   - source read (1M iterations)
//   - source write
//   - computed read (cache-hit and recompute)
//   - lens write
//   - effect-driven propagation
//   - mixed-call-site reads (worst case for V8 inline cache)

import { describe, it } from "vitest";
import { signal as sourceSignal, computed as computedSignal, lens as lensSignal, effect as effectSignal } from "../signal";
import { cell as sourceCell, computed as computedCell, lens as lensCell, effect as effectCell } from "./cell";

const N = 200_000;
const RUNS = 5;

function bench(label: string, fn: () => void): { mean: number; min: number } {
  // Warm up.
  fn(); fn();
  const times: number[] = [];
  for (let r = 0; r < RUNS; r++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const min = Math.min(...times);
  // eslint-disable-next-line no-console
  console.info(
    `  ${label.padEnd(48)}  mean ${mean.toFixed(2).padStart(7)}ms  min ${min.toFixed(2).padStart(7)}ms  (${((min * 1000) / N).toFixed(3)}µs/op)`,
  );
  return { mean, min };
}

describe("perf: source-cell read", () => {
  it("Signal vs Cell — pure read in a tight loop", () => {
    const s = sourceSignal(42);
    const c = sourceCell(42);

    bench("Signal source .value (read)", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) sum += s.value;
      if (sum < -1e30) throw new Error("");
    });
    bench("Cell   source .value (read)", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) sum += c.value;
      if (sum < -1e30) throw new Error("");
    });
  });

  it("Signal vs Cell — read-then-write churn", () => {
    const s = sourceSignal(0);
    const c = sourceCell(0);

    bench("Signal source read+write loop", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) {
        s.value = i;
        sum += s.value;
      }
      if (sum < -1e30) throw new Error("");
    });
    bench("Cell   source read+write loop", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) {
        c.value = i;
        sum += c.value;
      }
      if (sum < -1e30) throw new Error("");
    });
  });
});

describe("perf: source-cell write", () => {
  it("Signal vs Cell — pure writes (no subs)", () => {
    const s = sourceSignal(0);
    const c = sourceCell(0);

    bench("Signal source .value = (write)", () => {
      for (let i = 0; i < N; i++) s.value = i;
    });
    bench("Cell   source .value = (write)", () => {
      for (let i = 0; i < N; i++) c.value = i;
    });
  });

  it("Signal vs Cell — writes propagating to one effect", () => {
    const s = sourceSignal(0);
    const c = sourceCell(0);
    let sumS = 0, sumC = 0;
    effectSignal(() => { sumS += s.value });
    effectCell(()   => { sumC += c.value });
    sumS = sumC = 0;

    bench("Signal write → 1 effect", () => {
      for (let i = 0; i < N; i++) s.value = i;
    });
    bench("Cell   write → 1 effect", () => {
      for (let i = 0; i < N; i++) c.value = i;
    });
  });
});

describe("perf: computed-cell read", () => {
  it("Signal vs Cell — cache-hit reads (no upstream change)", () => {
    const s = sourceSignal(10);
    const cs = computedSignal(() => s.value * 2);
    void cs.value; // prime

    const c = sourceCell(10);
    const cc = computedCell(() => c.value * 2);
    void cc.value;

    bench("Signal computed cache-hit read", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) sum += cs.value;
      if (sum < -1e30) throw new Error("");
    });
    bench("Cell   computed cache-hit read", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) sum += cc.value;
      if (sum < -1e30) throw new Error("");
    });
  });

  it("Signal vs Cell — recompute every read (upstream changes each iter)", () => {
    const s = sourceSignal(0);
    const cs = computedSignal(() => s.value * 2);

    const c = sourceCell(0);
    const cc = computedCell(() => c.value * 2);

    bench("Signal computed recompute read", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) {
        s.value = i;
        sum += cs.value;
      }
      if (sum < -1e30) throw new Error("");
    });
    bench("Cell   computed recompute read", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) {
        c.value = i;
        sum += cc.value;
      }
      if (sum < -1e30) throw new Error("");
    });
  });
});

describe("perf: lens read+write", () => {
  it("Signal vs Cell — lens (g, s) write-then-read loop", () => {
    const s = sourceSignal(0);
    const ls = lensSignal(() => s.value * 2, v => { s.value = v / 2 });
    const c = sourceCell(0);
    const lc = lensCell(() => c.value * 2, v => { c.value = v / 2 });

    bench("Signal lens write+read loop", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) {
        ls.value = i * 2;
        sum += ls.value;
      }
      if (sum < -1e30) throw new Error("");
    });
    bench("Cell   lens write+read loop", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) {
        lc.value = i * 2;
        sum += lc.value;
      }
      if (sum < -1e30) throw new Error("");
    });
  });
});

describe("perf: mixed-site reads (IC degradation test)", () => {
  it("Signal vs Cell — interleaved reads of source + computed at one site", () => {
    // The site sees both source and computed instances. The current
    // Signal design takes a branch (predictable); the unified Cell
    // design dispatches via a closure call (IC). This is where unified
    // is at highest risk vs current.
    const s = sourceSignal(1);
    const cs = computedSignal(() => s.value + 1);
    const c = sourceCell(1);
    const cc = computedCell(() => c.value + 1);

    bench("Signal mixed read site", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) {
        sum += i % 2 === 0 ? s.value : cs.value;
      }
      if (sum < -1e30) throw new Error("");
    });
    bench("Cell   mixed read site", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) {
        sum += i % 2 === 0 ? c.value : cc.value;
      }
      if (sum < -1e30) throw new Error("");
    });
  });
});
