// _proto-cell2/cell2.bench.test.ts — head-to-head perf:
//   current `Signal` (3-mode branched)
//   vs proto-cell `Cell`  (closure-dispatch, 1 class)
//   vs proto-cell2 `Source`/`Derived` (2-class split, no internal branching)

import { describe, it } from "vitest";
import { signal as sigSig, computed as sigComputed, lens as sigLens, effect as sigEffect } from "../signal";
import { cell as cellSrc, computed as cellComputed, lens as cellLens, effect as cellEffect } from "../_proto-cell/cell";
import { source as c2Source, computed as c2Computed, lens as c2Lens, effect as c2Effect } from "./cell2";

const N = 200_000;
const RUNS = 5;

function bench(label: string, fn: () => void): { mean: number; min: number } {
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

describe("perf: source read", () => {
  it("Signal vs Cell vs Source", () => {
    const s = sigSig(42);
    const c = cellSrc(42);
    const x = c2Source(42);

    bench("[Signal]  source .value (read)", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) sum += s.value;
      if (sum < -1e30) throw new Error("");
    });
    bench("[Cell]    source .value (read)", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) sum += c.value;
      if (sum < -1e30) throw new Error("");
    });
    bench("[Source]  .value (read)", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) sum += x.value;
      if (sum < -1e30) throw new Error("");
    });
  });
});

describe("perf: source write", () => {
  it("Signal vs Cell vs Source", () => {
    const s = sigSig(0);
    const c = cellSrc(0);
    const x = c2Source(0);

    bench("[Signal]  source .value = (write)", () => {
      for (let i = 0; i < N; i++) s.value = i;
    });
    bench("[Cell]    source .value = (write)", () => {
      for (let i = 0; i < N; i++) c.value = i;
    });
    bench("[Source]  .value = (write)", () => {
      for (let i = 0; i < N; i++) x.value = i;
    });
  });
});

describe("perf: write → 1 effect propagation", () => {
  it("Signal vs Cell vs Source", () => {
    const s = sigSig(0);
    const c = cellSrc(0);
    const x = c2Source(0);
    let sumS = 0, sumC = 0, sumX = 0;
    sigEffect(() => { sumS += s.value });
    cellEffect(() => { sumC += c.value });
    c2Effect(() => { sumX += x.value });
    sumS = sumC = sumX = 0;

    bench("[Signal]  write → 1 effect", () => {
      for (let i = 0; i < N; i++) s.value = i;
    });
    bench("[Cell]    write → 1 effect", () => {
      for (let i = 0; i < N; i++) c.value = i;
    });
    bench("[Source]  write → 1 effect", () => {
      for (let i = 0; i < N; i++) x.value = i;
    });
  });
});

describe("perf: computed cache-hit read", () => {
  it("Signal vs Cell vs Derived", () => {
    const s = sigSig(10);
    const cs = sigComputed(() => s.value * 2);
    void cs.value;

    const c = cellSrc(10);
    const cc = cellComputed(() => c.value * 2);
    void cc.value;

    const x = c2Source(10);
    const cx = c2Computed(() => x.value * 2);
    void cx.value;

    bench("[Signal]  computed cache-hit read", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) sum += cs.value;
      if (sum < -1e30) throw new Error("");
    });
    bench("[Cell]    computed cache-hit read", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) sum += cc.value;
      if (sum < -1e30) throw new Error("");
    });
    bench("[Derived] computed cache-hit read", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) sum += cx.value;
      if (sum < -1e30) throw new Error("");
    });
  });
});

describe("perf: computed recompute read (upstream changes each iter)", () => {
  it("Signal vs Cell vs Derived", () => {
    const s = sigSig(0);
    const cs = sigComputed(() => s.value * 2);
    const c = cellSrc(0);
    const cc = cellComputed(() => c.value * 2);
    const x = c2Source(0);
    const cx = c2Computed(() => x.value * 2);

    bench("[Signal]  computed recompute read", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) {
        s.value = i;
        sum += cs.value;
      }
      if (sum < -1e30) throw new Error("");
    });
    bench("[Cell]    computed recompute read", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) {
        c.value = i;
        sum += cc.value;
      }
      if (sum < -1e30) throw new Error("");
    });
    bench("[Derived] computed recompute read", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) {
        x.value = i;
        sum += cx.value;
      }
      if (sum < -1e30) throw new Error("");
    });
  });
});

describe("perf: lens write+read loop", () => {
  it("Signal vs Cell vs Derived", () => {
    const s = sigSig(0);
    const ls = sigLens(() => s.value * 2, v => { s.value = v / 2 });
    const c = cellSrc(0);
    const lc = cellLens(() => c.value * 2, v => { c.value = v / 2 });
    const x = c2Source(0);
    const lx = c2Lens(() => x.value * 2, v => { x.value = v / 2 });

    bench("[Signal]  lens write+read loop", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) {
        ls.value = i * 2;
        sum += ls.value;
      }
      if (sum < -1e30) throw new Error("");
    });
    bench("[Cell]    lens write+read loop", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) {
        lc.value = i * 2;
        sum += lc.value;
      }
      if (sum < -1e30) throw new Error("");
    });
    bench("[Derived] lens write+read loop", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) {
        lx.value = i * 2;
        sum += lx.value;
      }
      if (sum < -1e30) throw new Error("");
    });
  });
});

describe("perf: mixed read site (IC degradation test)", () => {
  it("Signal vs Cell vs Source+Derived", () => {
    const s = sigSig(1);
    const cs = sigComputed(() => s.value + 1);
    const c = cellSrc(1);
    const cc = cellComputed(() => c.value + 1);
    const x = c2Source(1);
    const cx = c2Computed(() => x.value + 1);

    bench("[Signal]  mixed read site", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) {
        sum += i % 2 === 0 ? s.value : cs.value;
      }
      if (sum < -1e30) throw new Error("");
    });
    bench("[Cell]    mixed read site", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) {
        sum += i % 2 === 0 ? c.value : cc.value;
      }
      if (sum < -1e30) throw new Error("");
    });
    bench("[Src+Der] mixed read site", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) {
        sum += i % 2 === 0 ? x.value : cx.value;
      }
      if (sum < -1e30) throw new Error("");
    });
  });
});
