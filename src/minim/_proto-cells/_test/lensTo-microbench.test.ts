// Focused microbench for lensTo+through reads.

import { describe, it } from "vitest";
import { Num, Signal } from "../index";

const N = 100_000;

function timed(label: string, fn: () => void): number {
  fn();
  fn();
  fn();
  fn();
  const t0 = performance.now();
  fn();
  const t1 = performance.now();
  const ms = t1 - t0;
  console.info(`  ${label.padEnd(50)}  ${ms.toFixed(2).padStart(7)}ms  (${((ms * 1000) / N).toFixed(2)}µs/op)`);
  return ms;
}

describe("microbench: lensTo + through read", () => {
  it("warm-pinned", () => {
    type S = { a: number };
    const root = new Signal<S>({ a: 0 });
    const fused = root
      .lensTo(
        Num,
        s => s.a,
        (v, s) => ({ ...s, a: v }),
      )
      .through(
        v => v + 100,
        v => v - 100,
      ) as Num & { value: number };

    timed("write root, read fused (cold)", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        root.value = { a: i };
        s += fused.value;
      }
      if (s < -1e30) throw new Error("");
    });
    timed("write root, read fused (warm)", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        root.value = { a: i };
        s += fused.value;
      }
      if (s < -1e30) throw new Error("");
    });
    timed("write root, read fused (hot)", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        root.value = { a: i };
        s += fused.value;
      }
      if (s < -1e30) throw new Error("");
    });
  });
});
