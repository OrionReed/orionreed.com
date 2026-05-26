// fusion-iso.bench.test.ts — isolated microbenchmarks for fusion vs
// non-fusion path costs. Higher N for tighter timings, and isolates
// just the closure overhead in setters vs the engine's lens-cell
// dispatch overhead.

import { describe, it } from "vitest";
import { Num, Signal, Transform, transform, Vec } from "../index";

const N = 100_000;

function timed(label: string, fn: () => void): number {
  fn();
  fn();
  fn();
  const t0 = performance.now();
  fn();
  const t1 = performance.now();
  const ms = t1 - t0;
  // eslint-disable-next-line no-console
  console.info(
    `  ${label.padEnd(64)}  ${ms.toFixed(2).padStart(7)}ms  (${((ms * 1000) / N).toFixed(2)}µs/op)`,
  );
  return ms;
}

describe("microbench: field-chain write (the regression site)", () => {
  // Fused: 1 cell, composed (priorBwd ∘ bwdLocal ∘ priorFwd) in setter
  const tr = transform({ translate: { x: 0, y: 0 } });
  const fusedX = tr.translate.x;

  // Hand-nested: 2 lens cells, each with a 1-step closure setter
  type V = { translate: { x: number; y: number } };
  const tr2 = new Transform() as Transform & { value: V };
  const translateLens = Signal.install(
    Vec,
    () => tr2.value.translate,
    (v: { x: number; y: number }) => {
      tr2.value = { ...tr2.value, translate: v };
    },
  );
  const xLens = Signal.install(
    Num,
    () => translateLens.value.x,
    (v: number) => {
      translateLens.value = { ...translateLens.value, x: v };
    },
  );

  // Direct: write to root with the full spread inline, NO cells at all.
  // This is the floor — any wrapping has cost >= this.
  const tr3 = new Transform() as Transform & { value: V };
  const directWrite = (v: number) => {
    const s = tr3.value;
    tr3.value = { ...s, translate: { ...s.translate, x: v } };
  };

  it("field-chain writes", () => {
    timed("fused (1 cell, composed setter)", () => {
      for (let i = 0; i < N; i++) fusedX.value = i;
    });
    timed("hand-nested (2 cells, dispatch chain)", () => {
      for (let i = 0; i < N; i++) xLens.value = i;
    });
    timed("direct (no cells, just root write)", () => {
      for (let i = 0; i < N; i++) directWrite(i);
    });
  });

  it("field-chain reads (with intervening writes)", () => {
    timed("fused read", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        fusedX.value = i;
        s += fusedX.value;
      }
      if (s < -1e30) throw new Error("");
    });
    timed("hand-nested read", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        xLens.value = i;
        s += xLens.value;
      }
      if (s < -1e30) throw new Error("");
    });
    timed("direct read (no cells)", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        directWrite(i);
        s += tr3.value.translate.x;
      }
      if (s < -1e30) throw new Error("");
    });
  });
});
