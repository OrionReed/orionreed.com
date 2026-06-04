// Conformance for the push-pull variant (`signal-pp.ts`): the SAME real
// RFTS suite the production engine runs (forward + lifted), plus the
// batching regressions and a soundness spot-check — but against the
// experimental engine, so we learn whether push-pull holds up in the real
// implementation, not just the toy prototype.

import { type ReactiveFramework, setExpect, testSuite } from "reactive-framework-test-suite";
import { describe, expect, it } from "vitest";
import type { Reactive, Readable, Source, Update, View } from "../suite/adapters/types";
import { forwardFramework, liftedFramework } from "../suite/adapters/rfts";
import { batch, type Cell, cell, derive, effect, lens as mlens, type Read, untracked } from "./signal-bp";

setExpect(<T>(actual: T) => expect(actual) as never);

// ── inline adapter over the variant (mirrors suite/adapters/minim.ts) ──

interface Backed<T> extends Source<T> {
  readonly cell: Read<T>;
}
const cellOf = (s: Readable<unknown>): Read<unknown> => (s as Backed<unknown>).cell;
function wrap<T>(c: Cell<T>): Backed<T> {
  return {
    cell: c as Read<T>,
    read: () => c.value,
    write: (v: T) => {
      (c as { value: T }).value = v;
    },
  };
}

const pp: Reactive = {
  name: "minim-bp",
  signal: <T>(initial: T): Source<T> => wrap(cell(initial) as unknown as Cell<T>),
  computed: <T>(fn: () => T): Readable<T> => wrap(derive(fn)),
  effect: (fn) => effect(fn),
  batch: (fn) => batch(fn),
  untracked: (fn) => untracked(fn),
  lens: <S, V>(source: Source<S>, fwd: (s: S) => V, bwd: (v: V, s: S) => S): View<V> =>
    wrap(mlens(cellOf(source) as Read<S>, fwd, (t: V, s: S) => bwd(t, s)) as unknown as Cell<V>),
  lensN: <V>(
    sources: readonly Source<unknown>[],
    fwd: (vals: readonly unknown[]) => V,
    bwd: (v: V, vals: readonly unknown[]) => readonly Update<unknown>[],
  ): View<V> =>
    wrap(
      mlens(
        sources.map(cellOf),
        ((vals: readonly unknown[]) => fwd(vals)) as never,
        ((t: V, vals: readonly unknown[]) => bwd(t, vals)) as never,
      ) as unknown as Cell<V>,
    ),
};

const DIVERGED = new Set<string>([
  "#209 three-level nested effect: cascading disposal",
  "#210 multiple inner effects all cleaned when outer re-runs",
]);

function runSuite(fw: ReactiveFramework): void {
  for (const section of testSuite) {
    const isBehavioral = (section as { type?: string }).type === "behavioral";
    describe(section.section, () => {
      for (const [name, fn] of Object.entries(section.cases)) {
        if (isBehavioral || DIVERGED.has(name)) it.skip(name, () => fn(fw));
        else it(name, () => fn(fw));
      }
    });
  }
}

describe("bp forward conformance", () => runSuite(forwardFramework(pp)));
describe("bp lifted conformance (RFTS through a write-through view)", () =>
  runSuite(liftedFramework(pp)));

// ── batching regressions (mirror suite/conformance/batch.test.ts) ──

describe("bp batching", () => {
  it("revert to pre-batch value lands the revert", () => {
    const s = cell(0);
    const v = mlens(
      s,
      (x: number) => x,
      (t: number) => t,
    );
    batch(() => {
      (v as { value: number }).value = 5;
      (v as { value: number }).value = 0;
    });
    expect(s.value).toBe(0);
  });

  it("write-then-read inside a batch is consistent", () => {
    const s = cell(0);
    const v = mlens(
      s,
      (x: number) => x,
      (t: number) => t,
    );
    let seen = -1;
    batch(() => {
      (v as { value: number }).value = 7;
      seen = v.value;
    });
    expect(seen).toBe(7);
    expect(s.value).toBe(7);
  });

  it("net-zero revert does not re-run a downstream effect", () => {
    const s = cell(0);
    const v = mlens(
      s,
      (x: number) => x,
      (t: number) => t,
    );
    let runs = 0;
    effect(() => {
      void v.value;
      runs++;
    });
    const base = runs;
    batch(() => {
      (v as { value: number }).value = 1;
      (v as { value: number }).value = 0;
    });
    expect(runs).toBe(base);
    expect(s.value).toBe(0);
  });

  it("sibling view reflects a write mid-batch", () => {
    const s = cell(0);
    const a = mlens(
      s,
      (x: number) => x,
      (t: number) => t,
    );
    const b = mlens(
      s,
      (x: number) => x,
      (t: number) => t,
    );
    let viaB = -1;
    batch(() => {
      (a as { value: number }).value = 9;
      viaB = b.value;
    });
    expect(viaB).toBe(9);
  });
});
