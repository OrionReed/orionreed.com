// through.bench.test.ts — perf comparisons for `.lens()`.
//
// Three axes:
//   1. Parity:    .lens(f, g) vs hand-rolled Num.lens(...).
//   2. Fusion:    N consecutive .lens()s vs N nested Num.lens(...).
//                 Fused should win on read & write.
//   3. Equivalence: .scale(k).add(off) (uses .lens internally), vs
//                 hand-written `.lens ∘ .lens`, vs .affine — should all
//                 converge since they share the path.

import { describe, it } from "vitest";
import { Num, num } from "../index";

const N = 10_000;

function timed(label: string, fn: () => void): number {
  fn();
  fn();
  const t0 = performance.now();
  fn();
  const t1 = performance.now();
  const ms = t1 - t0;
  // eslint-disable-next-line no-console
  console.info(
    `  ${label.padEnd(58)}  ${ms.toFixed(2).padStart(7)}ms  (${((ms * 1000) / N).toFixed(2)}µs/op)`,
  );
  return ms;
}

describe("bench: .lens() parity vs hand-rolled lens", () => {
  it("single-layer read", () => {
    const a = num(0.5);

    // Hand-rolled: explicit Num.lens with closed-over fwd/bwd.
    const f = (v: number) => v * 200 + 30;
    const g = (n: number) => (n - 30) / 200;
    const handRolled = Num.lens(
      () => f(a.value),
      v => {
        a.value = g(v);
      },
    );

    const a2 = num(0.5);
    const viaThrough = a2.lens(f, g);

    timed(".lens(f,g) read", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        a2.value = i / N;
        s += viaThrough.value;
      }
      if (s < -1e30) throw new Error("");
    });
    timed("Num.lens(...) read (hand-rolled)", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        a.value = i / N;
        s += handRolled.value;
      }
      if (s < -1e30) throw new Error("");
    });
  });

  it("single-layer write", () => {
    const a = num(0.5);
    const f = (v: number) => v * 200 + 30;
    const g = (n: number) => (n - 30) / 200;
    const handRolled = Num.lens(
      () => f(a.value),
      v => {
        a.value = g(v);
      },
    );

    const a2 = num(0.5);
    const viaThrough = a2.lens(f, g);

    timed(".lens(f,g) write", () => {
      for (let i = 0; i < N; i++) viaThrough.value = 30 + i * 0.02;
    });
    timed("Num.lens(...) write (hand-rolled)", () => {
      for (let i = 0; i < N; i++) handRolled.value = 30 + i * 0.02;
    });
  });
});

describe("bench: .lens() fusion vs nested lenses", () => {
  it("2-deep chain — read", () => {
    // Fused: `.lens(f1,g1).lens(f2,g2)` collapses to one lens.
    const a = num(1);
    const fused = a
      .lens(
        v => v * 2,
        v => v / 2,
      )
      .lens(
        v => v + 10,
        v => v - 10,
      );

    // Unfused: same composition via two hand-rolled Num.lens layers.
    const b = num(1);
    const inner = Num.lens(
      () => b.value * 2,
      v => {
        b.value = v / 2;
      },
    );
    const outer = Num.lens(
      () => inner.value + 10,
      v => {
        inner.value = v - 10;
      },
    );

    timed(".lens fused (1 cell) read", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        a.value = i;
        s += fused.value;
      }
      if (s < -1e30) throw new Error("");
    });
    timed("Num.lens nested (2 cells) read", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        b.value = i;
        s += outer.value;
      }
      if (s < -1e30) throw new Error("");
    });
  });

  it("2-deep chain — write", () => {
    const a = num(1);
    const fused = a
      .lens(
        v => v * 2,
        v => v / 2,
      )
      .lens(
        v => v + 10,
        v => v - 10,
      );

    const b = num(1);
    const inner = Num.lens(
      () => b.value * 2,
      v => {
        b.value = v / 2;
      },
    );
    const outer = Num.lens(
      () => inner.value + 10,
      v => {
        inner.value = v - 10;
      },
    );

    timed(".lens fused (1 cell) write", () => {
      for (let i = 0; i < N; i++) fused.value = i;
    });
    timed("Num.lens nested (2 cells) write", () => {
      for (let i = 0; i < N; i++) outer.value = i;
    });
  });

  it("4-deep chain — read", () => {
    // Stress-test fusion depth.
    const a = num(1);
    const fused = a
      .lens(
        v => v * 2,
        v => v / 2,
      )
      .lens(
        v => v + 10,
        v => v - 10,
      )
      .lens(
        v => v * 3,
        v => v / 3,
      )
      .lens(
        v => v - 5,
        v => v + 5,
      );

    const b = num(1);
    const l1 = Num.lens(
      () => b.value * 2,
      v => {
        b.value = v / 2;
      },
    );
    const l2 = Num.lens(
      () => l1.value + 10,
      v => {
        l1.value = v - 10;
      },
    );
    const l3 = Num.lens(
      () => l2.value * 3,
      v => {
        l2.value = v / 3;
      },
    );
    const l4 = Num.lens(
      () => l3.value - 5,
      v => {
        l3.value = v + 5;
      },
    );

    timed(".lens fused (1 cell) read (4-deep)", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        a.value = i;
        s += fused.value;
      }
      if (s < -1e30) throw new Error("");
    });
    timed("Num.lens nested (4 cells) read", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        b.value = i;
        s += l4.value;
      }
      if (s < -1e30) throw new Error("");
    });
  });

  it("4-deep chain — write", () => {
    const a = num(1);
    const fused = a
      .lens(
        v => v * 2,
        v => v / 2,
      )
      .lens(
        v => v + 10,
        v => v - 10,
      )
      .lens(
        v => v * 3,
        v => v / 3,
      )
      .lens(
        v => v - 5,
        v => v + 5,
      );

    const b = num(1);
    const l1 = Num.lens(
      () => b.value * 2,
      v => {
        b.value = v / 2;
      },
    );
    const l2 = Num.lens(
      () => l1.value + 10,
      v => {
        l1.value = v - 10;
      },
    );
    const l3 = Num.lens(
      () => l2.value * 3,
      v => {
        l2.value = v / 3;
      },
    );
    const l4 = Num.lens(
      () => l3.value - 5,
      v => {
        l3.value = v + 5;
      },
    );

    timed(".lens fused (1 cell) write (4-deep)", () => {
      for (let i = 0; i < N; i++) fused.value = i;
    });
    timed("Num.lens nested (4 cells) write", () => {
      for (let i = 0; i < N; i++) l4.value = i;
    });
  });
});

describe("bench: eager-op equivalence (all ride on .lens)", () => {
  // After the rewrite, .add/.scale/.affine all call .lens() internally,
  // so .scale(k).add(off) auto-fuses to one lens cell — same path as a
  // hand-written `.lens ∘ .lens`. These should produce ~identical
  // numbers; if they diverge we've regressed.

  it("scale.add chain == manual lens.lens == affine — read", () => {
    const a = num(0.5);
    const opsChain = a.scale(200).add(30);

    const a2 = num(0.5);
    const fused = a2
      .lens(
        v => v * 200,
        v => v / 200,
      )
      .lens(
        v => v + 30,
        v => v - 30,
      );

    const a3 = num(0.5);
    const affine = a3.affine(200, 30);

    timed(".scale(200).add(30) read (auto-fused)", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        a.value = i / N;
        s += opsChain.value;
      }
      if (s < -1e30) throw new Error("");
    });
    timed(".lens ∘ .lens manual fused read", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        a2.value = i / N;
        s += fused.value;
      }
      if (s < -1e30) throw new Error("");
    });
    timed(".affine(200, 30) read (single .lens)", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        a3.value = i / N;
        s += affine.value;
      }
      if (s < -1e30) throw new Error("");
    });
  });

  it("scale.add chain == manual lens.lens == affine — write", () => {
    const a = num(0.5);
    const opsChain = a.scale(200).add(30);

    const a2 = num(0.5);
    const fused = a2
      .lens(
        v => v * 200,
        v => v / 200,
      )
      .lens(
        v => v + 30,
        v => v - 30,
      );

    const a3 = num(0.5);
    const affine = a3.affine(200, 30);

    timed(".scale(200).add(30) write (auto-fused)", () => {
      for (let i = 0; i < N; i++) opsChain.value = 30 + i * 0.02;
    });
    timed(".lens ∘ .lens manual fused write", () => {
      for (let i = 0; i < N; i++) fused.value = 30 + i * 0.02;
    });
    timed(".affine(200, 30) write (single .lens)", () => {
      for (let i = 0; i < N; i++) affine.value = 30 + i * 0.02;
    });
  });
});

describe("bench: clamp/quantize re-implementation parity", () => {
  it("clamp via .lens (current) vs equivalent typed Num.lens(g, s)", () => {
    const a = num(0);
    const c = a.clamp(0, 1); // now uses .lens internally

    const a2 = num(0);
    const c2 = Num.lens(
      () => {
        const v = a2.value;
        return v < 0 ? 0 : v > 1 ? 1 : v;
      },
      v => {
        a2.value = v < 0 ? 0 : v > 1 ? 1 : v;
      },
    );

    timed("Num.clamp (.lens) write within range", () => {
      for (let i = 0; i < N; i++) c.value = (i / N) * 0.9 + 0.05;
    });
    timed("Num.lens(g,s) write within range", () => {
      for (let i = 0; i < N; i++) c2.value = (i / N) * 0.9 + 0.05;
    });
    timed("Num.clamp (.lens) write clipped", () => {
      for (let i = 0; i < N; i++) c.value = (i / N) * 2 - 0.5;
    });
    timed("Num.lens(g,s) write clipped", () => {
      for (let i = 0; i < N; i++) c2.value = (i / N) * 2 - 0.5;
    });
  });
});
