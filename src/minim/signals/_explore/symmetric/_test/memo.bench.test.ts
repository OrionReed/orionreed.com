// memo.bench.test.ts — cost of the "stateful lens" pattern (pure lens +
// eager `hold`) relative to an equivalent stateless multi-parent lens.
//
// The hold's price is one extra eager scan (effect + signal write) that
// re-runs on every forward source change. A backward write to the lens
// changes the sources, so it triggers that re-run too. This isolates:
//   • backward drag: stateless 3-parent lens vs hold-backed stateful lens
//   • forward input change: 3-parent computed vs same + a hold watcher
//
// `timed` = min-of-8 ns/op.

import { describe, it } from "vitest";
import { effect, hold, lens, signal } from "../index";

const N = 50_000;

function timed(label: string, fn: () => void): number {
  for (let w = 0; w < 5; w++) fn();
  let ms = Number.POSITIVE_INFINITY;
  for (let r = 0; r < 8; r++) {
    const t0 = performance.now();
    fn();
    const t1 = performance.now();
    if (t1 - t0 < ms) ms = t1 - t0;
  }
  console.info(
    `  ${label.padEnd(56)}  ${ms.toFixed(2).padStart(8)}ms  ${((ms * 1e6) / N).toFixed(0).padStart(4)} ns/op`,
  );
  return ms;
}

const mean3 = (v: readonly number[]) => (v[0]! + v[1]! + v[2]!) / 3;
const devs3 = (v: readonly number[]) => {
  const m = mean3(v);
  return [v[0]! - m, v[1]! - m, v[2]! - m];
};
const norm3 = (d: readonly number[]) => Math.hypot(d[0]!, d[1]!, d[2]!);

describe("BWD drag: stateless 3-parent lens vs hold-backed stateful lens", () => {
  it("STATELESS (units recomputed from current sources)", () => {
    const a = signal(1);
    const b = signal(2);
    const c = signal(3);
    const spread = lens(
      [a, b, c] as const,
      (v) => norm3(devs3(v as number[])),
      (s, v) => {
        const d = devs3(v as number[]);
        const cur = norm3(d);
        const m = mean3(v as number[]);
        const k = cur > 1e-9 ? (s as number) / cur : 0;
        return [m + d[0]! * k, m + d[1]! * k, m + d[2]! * k];
      },
    );
    void spread.value;
    timed("stateless spread drag ×N", () => {
      for (let i = 0; i < N; i++) {
        (spread as { value: number }).value = (i % 5) + 0.5;
      }
    });
  });

  it("STATEFUL (units from an eager hold)", () => {
    const a = signal(1);
    const b = signal(2);
    const c = signal(3);
    const units = hold<number[], number[]>(
      () => [a.value, b.value, c.value],
      (v, prev) => {
        const d = devs3(v);
        const s = norm3(d);
        return s > 1e-9 ? [d[0]! / s, d[1]! / s, d[2]! / s] : (prev ?? d);
      },
    );
    const spread = lens(
      [a, b, c] as const,
      (v) => norm3(devs3(v as number[])),
      (s, v) => {
        const m = mean3(v as number[]);
        const u = units.value;
        const t = s as number;
        return [m + t * u[0]!, m + t * u[1]!, m + t * u[2]!];
      },
    );
    void spread.value;
    timed("stateful  spread drag ×N (hold)", () => {
      for (let i = 0; i < N; i++) {
        (spread as { value: number }).value = (i % 5) + 0.5;
      }
    });
  });
});

describe("FWD source change: bare 3-dep computed vs same + hold watcher", () => {
  it("NO HOLD (plain computed observed)", () => {
    const a = signal(1);
    const b = signal(2);
    const c = signal(3);
    let sink = 0;
    effect(() => {
      sink += norm3(devs3([a.value, b.value, c.value]));
    });
    timed("fwd input change, no hold ×N", () => {
      for (let i = 0; i < N; i++) a.value = i;
    });
    void sink;
  });

  it("WITH HOLD (extra eager scan on the same sources)", () => {
    const a = signal(1);
    const b = signal(2);
    const c = signal(3);
    hold<number[], number[]>(
      () => [a.value, b.value, c.value],
      (v, prev) => {
        const d = devs3(v);
        const s = norm3(d);
        return s > 1e-9 ? [d[0]! / s, d[1]! / s, d[2]! / s] : (prev ?? d);
      },
    );
    let sink = 0;
    effect(() => {
      sink += norm3(devs3([a.value, b.value, c.value]));
    });
    timed("fwd input change, with hold ×N", () => {
      for (let i = 0; i < N; i++) a.value = i;
    });
    void sink;
  });
});
