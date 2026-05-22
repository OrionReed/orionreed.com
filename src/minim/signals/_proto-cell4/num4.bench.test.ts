// _proto-cell4/num4.bench.test.ts — composition wrapper vs current Num.
//
// Measures the indirection cost of `num.value` → `num._cell.value`
// across hot paths, to decide if composition is viable for value classes.

import { describe, it } from "vitest";
import { num as currentNum, effect as currentEffect, Num } from "../index";
import { num4, Num4 } from "./num4";
import { source as c2Source, effect as c2Effect } from "../_proto-cell2/cell2";

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

describe("perf: value-class read (source)", () => {
  it("current Num vs Num4 (composition) vs bare Source", () => {
    const a = currentNum(42);
    const b = num4(42);
    const c = c2Source(42);

    bench("[Num]       num(42).value", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) sum += a.value;
      if (sum < -1e30) throw new Error("");
    });
    bench("[Num4]      num4(42).value (wrap)", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) sum += b.value;
      if (sum < -1e30) throw new Error("");
    });
    bench("[Source]    bare Source.value", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) sum += c.value;
      if (sum < -1e30) throw new Error("");
    });
  });
});

describe("perf: value-class write (source)", () => {
  it("current Num vs Num4 vs bare Source", () => {
    const a = currentNum(0);
    const b = num4(0);
    const c = c2Source(0);

    bench("[Num]       num.value = i", () => { for (let i = 0; i < N; i++) a.value = i });
    bench("[Num4]      num4.value = i (wrap)", () => { for (let i = 0; i < N; i++) b.value = i });
    bench("[Source]    bare Source.value = i", () => { for (let i = 0; i < N; i++) c.value = i });
  });
});

describe("perf: write → 1 effect (engine-matched)", () => {
  it("current Num+sigEffect vs Num4+c2Effect", () => {
    // Crucial: each value class must use its own engine's effect.
    // Num lives in Signal-engine → currentEffect.
    // Num4 lives in Src/Der-engine → c2Effect.
    const a = currentNum(0); const b = num4(0); const c = c2Source(0);
    let x = 0, y = 0, z = 0;
    currentEffect(() => { x += a.value });
    c2Effect(() => { y += b.value });
    c2Effect(() => { z += c.value });
    x = y = z = 0;

    bench("[Num]       write → 1 effect (Signal-engine)", () => { for (let i = 0; i < N; i++) a.value = i });
    bench("[Num4]      write → 1 effect (Src/Der-engine, wrapped)", () => { for (let i = 0; i < N; i++) b.value = i });
    bench("[Source]    write → 1 effect (Src/Der-engine, bare)", () => { for (let i = 0; i < N; i++) c.value = i });
  });
});

describe("perf: invertible chain — .add(b)", () => {
  it("current Num.add vs Num4.add", () => {
    const a = currentNum(0); const aChain = a.add(2);
    const b = num4(0); const bChain = b.add(2);

    bench("[Num]       .add(2).value (read)", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) { a.value = i; sum += aChain.value; }
      if (sum < -1e30) throw new Error("");
    });
    bench("[Num4]      .add(2).value (read, wrap)", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) { b.value = i; sum += bChain.value; }
      if (sum < -1e30) throw new Error("");
    });

    bench("[Num]       .add(2).value = (write)", () => {
      for (let i = 0; i < N; i++) aChain.value = i;
    });
    bench("[Num4]      .add(2).value = (write, wrap)", () => {
      for (let i = 0; i < N; i++) bChain.value = i;
    });
  });
});

describe("perf: invertible chain — .add(2).scale(3) (both auto-fuse)", () => {
  it("current Num vs Num4", () => {
    const a = currentNum(0); const aChain = a.add(2).scale(3);
    const b = num4(0); const bChain = b.add(2).scale(3);

    bench("[Num]       .add(2).scale(3) read (fused)", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) { a.value = i; sum += aChain.value; }
      if (sum < -1e30) throw new Error("");
    });
    bench("[Num4]      .add(2).scale(3) read (fused)", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) { b.value = i; sum += bChain.value; }
      if (sum < -1e30) throw new Error("");
    });

    bench("[Num]       .add(2).scale(3) write (fused)", () => {
      for (let i = 0; i < N; i++) aChain.value = i;
    });
    bench("[Num4]      .add(2).scale(3) write (fused)", () => {
      for (let i = 0; i < N; i++) bChain.value = i;
    });
  });
});

describe("instanceof check", () => {
  it("Num.is and Num4.is both work via instanceof", () => {
    const a = currentNum(0);
    const b = num4(0);
    if (!(a instanceof Num)) throw new Error("a not instanceof Num");
    if (!(b instanceof Num4)) throw new Error("b not instanceof Num4");
    if (!Num.is(a)) throw new Error("Num.is(a) false");
    if (!Num4.is(b)) throw new Error("Num4.is(b) false");
  });
});
