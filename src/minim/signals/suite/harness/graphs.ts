// Named topologies, parameterized by adapter and instrumented with
// counters. Shared by laws (small, exact-count assertions) and benches
// (large, timed). Lenses are affine so they are invertible (very-well-
// behaved) and the forward/backward arithmetic is trivial — the point is
// graph shape, not closure cost.

import type { Reactive, Source, Update, View } from "../adapters/types";
import { type Counters, countBwd, countFwd } from "./counters";

/** A 1→1 lens chain of `depth` affine steps over one numeric source.
 *  Writing `top` propagates back to `source` (each step's `bwd` runs
 *  once); reading `top` pulls forward. Backward walk length == depth. */
export interface ChainGraph {
  source: Source<number>;
  top: View<number>;
  depth: number;
}

export function buildChain(rx: Reactive, depth: number, c: Counters): ChainGraph {
  const source = rx.signal(0);
  let cur: View<number> = source;
  for (let i = 0; i < depth; i++) {
    cur = rx.lens(
      cur,
      countFwd(c, (x: number) => x + 1),
      countBwd(c, (v: number) => v - 1),
    );
  }
  return { source, top: cur, depth };
}

/** N sources joined by a fan-in view (sum). Writing the view distributes
 *  the delta evenly across all N (a 1→N split); a downstream computed
 *  `total` reconverges them. The backward analogue of a forward diamond:
 *  one write fans out to N sources that re-merge into one consumer. */
export interface ReconvergeGraph {
  sources: Source<number>[];
  view: View<number>;
  total: { read(): number };
  n: number;
}

export function buildReconverge(rx: Reactive, n: number, c: Counters): ReconvergeGraph {
  const sources = Array.from({ length: n }, () => rx.signal(0));
  const view = rx.lensN(
    sources as readonly Source<unknown>[],
    countFwd(c, (vals: readonly unknown[]) => (vals as number[]).reduce((a, b) => a + b, 0)),
    countBwd(c, (target: number, vals: readonly unknown[]): readonly Update<unknown>[] => {
      const nums = vals as number[];
      const cur = nums.reduce((a, b) => a + b, 0);
      const delta = (target - cur) / n;
      return nums.map(x => x + delta);
    }),
  );
  const total = rx.computed(() => sources.reduce((a, s) => a + s.read(), 0));
  return { sources, view, total, n };
}
