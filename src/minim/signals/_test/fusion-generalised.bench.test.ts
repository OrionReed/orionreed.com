// fusion-generalised.bench.test.ts — perf for the generalised fusion
// across `lensTo`, `deriveTo`, and the `field()` helper.
//
// Compares:
//   1. deriveTo chains — fused (one cell onto root) vs hand-nested
//      (N cells via Signal.install).
//   2. lensTo chains   — same, writable.
//   3. field() chains  — transform.translate.x via fused field() vs
//      a manually-installed equivalent chain.
//
// All bench cases construct the comparator (un-fused) via direct
// `Signal.install` so each layer materialises a separate cell, which
// is what the dep-graph used to look like before fusion was extended
// beyond `.lens()`.

import { describe, it } from "vitest";
import { Num, num, Signal, signal, Transform, transform, Vec } from "../index";

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
    `  ${label.padEnd(60)}  ${ms.toFixed(2).padStart(7)}ms  (${((ms * 1000) / N).toFixed(2)}µs/op)`,
  );
  return ms;
}

describe("bench: derive chain fusion vs hand-nested computed cells", () => {
  it("2-deep derive chain — read", () => {
    const a = num(1);
    const fused = Num.derive(
      Num.derive(a, v => v * 2),
      v => v + 10,
    );

    // Un-fused equivalent via direct installs (two cells).
    const b = num(1);
    const inner = Signal.install(Num, () => b.value * 2);
    const outer = Signal.install(Num, () => inner.value + 10);

    timed("derive fused (1 cell) read", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        a.value = i;
        s += fused.value;
      }
      if (s < -1e30) throw new Error("");
    });
    timed("hand-nested derive (2 cells) read", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        b.value = i;
        s += outer.value;
      }
      if (s < -1e30) throw new Error("");
    });
  });

  it("4-deep derive chain — read (stress)", () => {
    const a = num(1);
    const l1 = Num.derive(a, v => v * 2);
    const l2 = Num.derive(l1, v => v + 10);
    const l3 = Num.derive(l2, v => v * 3);
    const fused = Num.derive(l3, v => v - 5);

    const b = num(1);
    const u1 = Signal.install(Num, () => b.value * 2);
    const u2 = Signal.install(Num, () => u1.value + 10);
    const u3 = Signal.install(Num, () => u2.value * 3);
    const l4 = Signal.install(Num, () => u3.value - 5);

    timed("derive fused (1 cell) read (4-deep)", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        a.value = i;
        s += fused.value;
      }
      if (s < -1e30) throw new Error("");
    });
    timed("hand-nested derive (4 cells) read", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        b.value = i;
        s += l4.value;
      }
      if (s < -1e30) throw new Error("");
    });
  });
});

describe("bench: lens chain fusion vs hand-nested lens cells", () => {
  it("2-deep lens chain — read+write", () => {
    type S = { a: number };
    const root = signal<S>({ a: 0 });
    // Fused: Num.lens to a.a, then endo lens to Num.
    const inner1 = Num.lens(
      root,
      s => s.a,
      (v, s) => ({ ...s, a: v }),
    );
    const fused = inner1.lens(
      v => v + 100,
      v => v - 100,
    ) as Num & { value: number };

    const root2 = signal<S>({ a: 0 });
    // Un-fused equivalent via two raw lens installs.
    const inner = Signal.install(
      Num,
      () => root2.value.a,
      (v: number) => {
        root2.value = { ...root2.value, a: v };
      },
    );
    const outer = Signal.install(
      Num,
      () => inner.value + 100,
      (v: number) => {
        inner.value = v - 100;
      },
    );

    timed("lens fused (1 cell) read", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        root.value = { a: i };
        s += fused.value;
      }
      if (s < -1e30) throw new Error("");
    });
    timed("hand-nested lens (2 cells) read", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        root2.value = { a: i };
        s += outer.value;
      }
      if (s < -1e30) throw new Error("");
    });

    timed("lens fused (1 cell) write", () => {
      for (let i = 0; i < N; i++) fused.value = i + 100;
    });
    timed("hand-nested lens (2 cells) write", () => {
      for (let i = 0; i < N; i++) outer.value = i + 100;
    });
  });
});

describe("bench: field() chain (the headline case)", () => {
  it("transform.translate.x — read", () => {
    const tr = transform({ translate: { x: 0, y: 0 } });
    const x = tr.translate.x;

    // Un-fused equivalent: manually-installed 2-level lens chain.
    type V = { translate: { x: number; y: number } };
    // Cast: `new Transform()` is RO via interface merge; raw bench
    // writes signal-mode value directly so we treat it as writable.
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

    timed("fused field tr.translate.x read", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        tr.value = { ...tr.value, translate: { x: i, y: 0 } };
        s += x.value;
      }
      if (s < -1e30) throw new Error("");
    });
    timed("hand-nested 2-lens equivalent read", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        tr2.value = { ...tr2.value, translate: { x: i, y: 0 } };
        s += xLens.value;
      }
      if (s < -1e30) throw new Error("");
    });
  });

  it("transform.translate.x — write (back-propagation through fused setter)", () => {
    const tr = transform({ translate: { x: 0, y: 0 } });
    const x = tr.translate.x;

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

    timed("fused field tr.translate.x write", () => {
      for (let i = 0; i < N; i++) x.value = i;
    });
    timed("hand-nested 2-lens equivalent write", () => {
      for (let i = 0; i < N; i++) xLens.value = i;
    });
  });

  it("read with active effect on the field (full dep-graph involvement)", () => {
    // Simulate the realistic scenario: an effect is subscribing to the
    // field. This exercises link/unlink, shallowPropagate, and the
    // engine's dep-graph traversal under real reactive load.
    const tr = transform({ translate: { x: 0, y: 0 } });
    const x = tr.translate.x;

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

    // Use an inline "effect-like" pattern via Signal value reads.
    // For the bench, we instead drive writes to the root and read the
    // field — the dep tracking cost shows up via link/unlink.

    timed("fused field write+read cycle (root write, leaf read)", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        tr.value = { ...tr.value, translate: { x: i, y: 0 } };
        s += x.value;
      }
      if (s < -1e30) throw new Error("");
    });
    timed("hand-nested write+read cycle (root write, leaf read)", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        tr2.value = { ...tr2.value, translate: { x: i, y: 0 } };
        s += xLens.value;
      }
      if (s < -1e30) throw new Error("");
    });
  });
});

describe("bench: 3-deep field chain (the worst case in real UI code)", () => {
  // Hypothetical: `t.transform.translate.x`. Construct via nested
  // composite types to bench a real-ish 3-deep path.
  it("3-deep nested field chain — read", () => {
    type Outer = { inner: { translate: { x: number; y: number } } };
    const root = signal<Outer>({ inner: { translate: { x: 0, y: 0 } } });

    // Fused: 2 Cls.lens calls fuse into one cell onto root.
    const innerLens = Vec.lens(
      root,
      o => o.inner.translate,
      (v: { x: number; y: number }, o) => ({
        ...o,
        inner: { ...o.inner, translate: v },
      }),
    );
    const fusedX = Num.lens(
      innerLens,
      v => v.x,
      (n: number, v) => ({ ...v, x: n }),
    );

    // Un-fused: 3-cell manually-installed chain.
    const root2 = signal<Outer>({ inner: { translate: { x: 0, y: 0 } } });
    const l1 = Signal.install(
      Vec,
      () => root2.value.inner.translate,
      (v: { x: number; y: number }) => {
        root2.value = { ...root2.value, inner: { ...root2.value.inner, translate: v } };
      },
    );
    const l2 = Signal.install(
      Num,
      () => l1.value.x,
      (n: number) => {
        l1.value = { ...l1.value, x: n };
      },
    );

    timed("fused 3-deep field chain read", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        root.value = { inner: { translate: { x: i, y: 0 } } };
        s += fusedX.value;
      }
      if (s < -1e30) throw new Error("");
    });
    timed("hand-nested 3-cell equivalent read", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        root2.value = { inner: { translate: { x: i, y: 0 } } };
        s += l2.value;
      }
      if (s < -1e30) throw new Error("");
    });
  });
});
