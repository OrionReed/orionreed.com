// _proto-multiport/meld.bench.test.ts — does meld pay the same perf
// price as the `combine`/`mean` it would supersede?
//
// The fear: the per-evaluation Contribution allocation costs us
// vs hand-rolled combine. Pre-allocated scratch helps but each merge
// fn call still walks N small records.

import { describe, it } from "vitest";
import { mean as oldMean, num } from "../index";
import { mean as mixMean } from "../mix";
import { deltaEven, meld } from "./meld";

const N = 50_000;

function timed(label: string, fn: () => void): void {
  fn(); fn();
  const times: number[] = [];
  for (let r = 0; r < 5; r++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  const min = Math.min(...times);
  // eslint-disable-next-line no-console
  console.info(`  ${label.padEnd(48)}  min ${min.toFixed(2).padStart(7)}ms  (${((min * 1000) / N).toFixed(3)}µs/op)`);
}

describe("perf: mean (production) vs meld(Num, mean, deltaEven)", () => {
  it("3-contributor read in tight loop", () => {
    const a1 = num(1), a2 = num(2), a3 = num(3);
    const mMean = oldMean(a1, a2, a3);

    const b1 = num(1), b2 = num(2), b3 = num(3);
    const mMeld = meld(num(0).constructor as never, mixMean as never, deltaEven as never);
    mMeld.add(b1); mMeld.add(b2); mMeld.add(b3);

    timed("[mean]  3-contrib read", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) sum += mMean.value;
      if (sum < -1e30) throw new Error("");
    });
    timed("[meld]  3-contrib read", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) sum += (mMeld.value as unknown as number);
      if (sum < -1e30) throw new Error("");
    });
  });

  it("3-contributor write (deltaEven)", () => {
    const a1 = num(1), a2 = num(2), a3 = num(3);
    const mMean = oldMean(a1, a2, a3);

    const b1 = num(1), b2 = num(2), b3 = num(3);
    const mMeld = meld(num(0).constructor as never, mixMean as never, deltaEven as never);
    mMeld.add(b1); mMeld.add(b2); mMeld.add(b3);

    timed("[mean]  3-contrib write", () => {
      for (let i = 0; i < N; i++) mMean.value = i;
    });
    timed("[meld]  3-contrib write", () => {
      for (let i = 0; i < N; i++) (mMeld as unknown as { value: number }).value = i;
    });
  });

  it("write-then-read round-trip churn", () => {
    const a1 = num(1), a2 = num(2), a3 = num(3);
    const mMean = oldMean(a1, a2, a3);

    const b1 = num(1), b2 = num(2), b3 = num(3);
    const mMeld = meld(num(0).constructor as never, mixMean as never, deltaEven as never);
    mMeld.add(b1); mMeld.add(b2); mMeld.add(b3);

    timed("[mean]  write+read loop", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) {
        mMean.value = i;
        sum += mMean.value;
      }
      if (sum < -1e30) throw new Error("");
    });
    timed("[meld]  write+read loop", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) {
        (mMeld as unknown as { value: number }).value = i;
        sum += (mMeld.value as unknown as number);
      }
      if (sum < -1e30) throw new Error("");
    });
  });
});
