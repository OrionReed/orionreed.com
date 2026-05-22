// mix.bench.test.ts — perf comparisons for the new mix() primitive.
//
// We compare against:
//   - hand-rolled raw `lens(g, s)` (theoretical floor — no merge dispatch)
//   - production `centroid(...)` (which is mix(Vec, parts, mean, deltaEven))
//
// What we want to confirm:
//   1. The pre-allocated scratch buffer trick gives a real perf win
//      over the old combine/mean which freshly-allocated per write.
//   2. The merge/writeback dispatch overhead is small (V8 inlines
//      well for monomorphic call sites).
//
// Hot paths we bench:
//   - read of mean over 3 contributors
//   - write of mean+deltaEven over 3 contributors
//   - read of mean over 8 contributors (larger N)
//   - write of mean+deltaEven over 8 contributors

import { describe, it } from "vitest";
import { lens, Mix, mix, Num, num } from "../index";

const N = 50_000;
const RUNS = 5;

function timed(label: string, fn: () => void): void {
  fn();
  fn();
  const times: number[] = [];
  for (let r = 0; r < RUNS; r++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  const min = Math.min(...times);
  // eslint-disable-next-line no-console
  console.info(
    `  ${label.padEnd(54)}  min ${min.toFixed(2).padStart(7)}ms  (${((min * 1000) / N).toFixed(3)}µs/op)`,
  );
}

describe("perf: mix(Num, mean) read vs hand-rolled lens", () => {
  it("3-contributor read", () => {
    const a = num(1),
      b = num(2),
      c = num(3);
    const m = mix(Num, [a, b, c], Mix.mean, Mix.deltaEven);

    // Hand-rolled: same semantics, no merge dispatch
    const a2 = num(1),
      b2 = num(2),
      c2 = num(3);
    const hand = lens<number>(
      () => (a2.value + b2.value + c2.value) / 3,
      next => {
        const cur = (a2.peek() + b2.peek() + c2.peek()) / 3;
        const d = next - cur;
        a2.value = a2.peek() + d;
        b2.value = b2.peek() + d;
        c2.value = c2.peek() + d;
      },
    );

    timed("[mix]   3-contrib read", () => {
      let s = 0;
      for (let i = 0; i < N; i++) s += m.value;
      if (s < -1e30) throw new Error("");
    });
    timed("[hand]  3-contrib read", () => {
      let s = 0;
      for (let i = 0; i < N; i++) s += hand.value;
      if (s < -1e30) throw new Error("");
    });
  });

  it("3-contributor write (delta-even)", () => {
    const a = num(1),
      b = num(2),
      c = num(3);
    const m = mix(Num, [a, b, c], Mix.mean, Mix.deltaEven);

    const a2 = num(1),
      b2 = num(2),
      c2 = num(3);
    const hand = lens<number>(
      () => (a2.value + b2.value + c2.value) / 3,
      next => {
        const cur = (a2.peek() + b2.peek() + c2.peek()) / 3;
        const d = next - cur;
        a2.value = a2.peek() + d;
        b2.value = b2.peek() + d;
        c2.value = c2.peek() + d;
      },
    );

    timed("[mix]   3-contrib write", () => {
      for (let i = 0; i < N; i++) (m as unknown as { value: number }).value = i;
    });
    timed("[hand]  3-contrib write", () => {
      for (let i = 0; i < N; i++) hand.value = i;
    });
  });
});

describe("perf: mix scaling to 8 contributors", () => {
  it("8-contrib read", () => {
    const parts = Array.from({ length: 8 }, (_, i) => num(i));
    const m = mix(Num, parts, Mix.mean, Mix.deltaEven);

    timed("[mix]   8-contrib read", () => {
      let s = 0;
      for (let i = 0; i < N; i++) s += m.value;
      if (s < -1e30) throw new Error("");
    });
  });

  it("8-contrib write (delta-even)", () => {
    const parts = Array.from({ length: 8 }, (_, i) => num(i));
    const m = mix(Num, parts, Mix.mean, Mix.deltaEven);

    timed("[mix]   8-contrib write", () => {
      for (let i = 0; i < N; i++) (m as unknown as { value: number }).value = i;
    });
  });
});
