// _proto-cell3/cell3.bench.test.ts — 4-way bench.

import { describe, it } from "vitest";
import { signal as sigSig, computed as sigComputed, lens as sigLens, effect as sigEffect } from "../signal";
import { source as c2Source, computed as c2Computed, lens as c2Lens, effect as c2Effect } from "../_proto-cell2/cell2";
import { signal as c3Sig, computed as c3Computed, lens as c3Lens, effect as c3Effect } from "./cell3";

const N = 200_000;
const RUNS = 5;

function bench(label: string, fn: () => void): void {
  fn(); fn();
  const times: number[] = [];
  for (let r = 0; r < RUNS; r++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  const min = Math.min(...times);
  // eslint-disable-next-line no-console
  console.info(`  ${label.padEnd(48)}  min ${min.toFixed(2).padStart(7)}ms  (${((min * 1000) / N).toFixed(3)}µs/op)`);
}

describe("perf: source read", () => {
  it("Signal vs Src/Der vs FnRef", () => {
    const s1 = sigSig(42);
    const s2 = c2Source(42);
    const s3 = c3Sig(42);

    bench("[Signal]    source read", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) sum += s1.value;
      if (sum < -1e30) throw new Error("");
    });
    bench("[Src/Der]   source read", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) sum += s2.value;
      if (sum < -1e30) throw new Error("");
    });
    bench("[FnRef]     source read", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) sum += s3.value;
      if (sum < -1e30) throw new Error("");
    });
  });
});

describe("perf: source write", () => {
  it("Signal vs Src/Der vs FnRef", () => {
    const s1 = sigSig(0);
    const s2 = c2Source(0);
    const s3 = c3Sig(0);

    bench("[Signal]    source write", () => { for (let i = 0; i < N; i++) s1.value = i; });
    bench("[Src/Der]   source write", () => { for (let i = 0; i < N; i++) s2.value = i; });
    bench("[FnRef]     source write", () => { for (let i = 0; i < N; i++) s3.value = i; });
  });
});

describe("perf: write → 1 effect", () => {
  it("Signal vs Src/Der vs FnRef", () => {
    const s1 = sigSig(0); const s2 = c2Source(0); const s3 = c3Sig(0);
    let a = 0, b = 0, c = 0;
    sigEffect(() => { a += s1.value });
    c2Effect(() => { b += s2.value });
    c3Effect(() => { c += s3.value });
    a = b = c = 0;
    bench("[Signal]    write → 1 effect", () => { for (let i = 0; i < N; i++) s1.value = i });
    bench("[Src/Der]   write → 1 effect", () => { for (let i = 0; i < N; i++) s2.value = i });
    bench("[FnRef]     write → 1 effect", () => { for (let i = 0; i < N; i++) s3.value = i });
  });
});

describe("perf: computed cache-hit read", () => {
  it("Signal vs Src/Der vs FnRef", () => {
    const s1 = sigSig(10); const c1 = sigComputed(() => s1.value * 2); void c1.value;
    const s2 = c2Source(10); const c2 = c2Computed(() => s2.value * 2); void c2.value;
    const s3 = c3Sig(10); const c3 = c3Computed(() => s3.value * 2); void c3.value;

    bench("[Signal]    computed cache-hit read", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) sum += c1.value;
      if (sum < -1e30) throw new Error("");
    });
    bench("[Src/Der]   computed cache-hit read", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) sum += c2.value;
      if (sum < -1e30) throw new Error("");
    });
    bench("[FnRef]     computed cache-hit read", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) sum += c3.value;
      if (sum < -1e30) throw new Error("");
    });
  });
});

describe("perf: computed recompute read", () => {
  it("Signal vs Src/Der vs FnRef", () => {
    const s1 = sigSig(0); const c1 = sigComputed(() => s1.value * 2);
    const s2 = c2Source(0); const c2 = c2Computed(() => s2.value * 2);
    const s3 = c3Sig(0); const c3 = c3Computed(() => s3.value * 2);

    bench("[Signal]    computed recompute read", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) { s1.value = i; sum += c1.value; }
      if (sum < -1e30) throw new Error("");
    });
    bench("[Src/Der]   computed recompute read", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) { s2.value = i; sum += c2.value; }
      if (sum < -1e30) throw new Error("");
    });
    bench("[FnRef]     computed recompute read", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) { s3.value = i; sum += c3.value; }
      if (sum < -1e30) throw new Error("");
    });
  });
});

describe("perf: lens write+read loop", () => {
  it("Signal vs Src/Der vs FnRef", () => {
    const s1 = sigSig(0); const l1 = sigLens(() => s1.value * 2, v => { s1.value = v / 2 });
    const s2 = c2Source(0); const l2 = c2Lens(() => s2.value * 2, v => { s2.value = v / 2 });
    const s3 = c3Sig(0); const l3 = c3Lens(() => s3.value * 2, v => { s3.value = v / 2 });

    bench("[Signal]    lens write+read loop", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) { l1.value = i * 2; sum += l1.value; }
      if (sum < -1e30) throw new Error("");
    });
    bench("[Src/Der]   lens write+read loop", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) { l2.value = i * 2; sum += l2.value; }
      if (sum < -1e30) throw new Error("");
    });
    bench("[FnRef]     lens write+read loop", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) { l3.value = i * 2; sum += l3.value; }
      if (sum < -1e30) throw new Error("");
    });
  });
});

describe("perf: mixed read site", () => {
  it("Signal vs Src/Der vs FnRef", () => {
    const s1 = sigSig(1); const c1 = sigComputed(() => s1.value + 1);
    const s2 = c2Source(1); const c2 = c2Computed(() => s2.value + 1);
    const s3 = c3Sig(1); const c3 = c3Computed(() => s3.value + 1);

    bench("[Signal]    mixed read site", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) sum += i % 2 === 0 ? s1.value : c1.value;
      if (sum < -1e30) throw new Error("");
    });
    bench("[Src/Der]   mixed read site", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) sum += i % 2 === 0 ? s2.value : c2.value;
      if (sum < -1e30) throw new Error("");
    });
    bench("[FnRef]     mixed read site", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) sum += i % 2 === 0 ? s3.value : c3.value;
      if (sum < -1e30) throw new Error("");
    });
  });
});
