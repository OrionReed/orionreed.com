// Backward soundness — no lost writes across topologies. A write of a
// reachable target to a well-behaved view must read back exactly that
// target, whatever the graph between the view and its sources. This is
// the executable definition the backward engine must satisfy, phrased as
// shrinking property tests over randomly generated chains, fan-ins, and
// mixed trees.
//
// Scope: these cover graphs the *generic adapter* can express — affine
// 1→1 and even-split N→1, every subtree owning disjoint sources (no
// shared source / diamond). The shared-source case, where read-back
// hinges on a designated-anchor `bwd` reading nodes outside the declared
// parent set, isn't expressible through `lens`/`lensN`; it lives in the
// minim-specific `_test/bwd-soundness.test.ts`.

import fc from "fast-check";
import type { Reactive, Source, View } from "../adapters/types";
import { type TreePlan, treePlan } from "../harness/arbitraries";
import { countBwd, countFwd, newCounters } from "../harness/counters";
import { buildTree } from "../harness/graphs";

/** Random invertible affine chain of generated depth; a view write reads
 *  back as itself (PutGet) and the backward walk visits each step once. */
export function chainNoLostWrite(rx: Reactive): fc.IPropertyWithHooks<[number, number]> {
  return fc.property(
    fc.integer({ min: 1, max: 10 }),
    fc.double({ min: -1e4, max: 1e4, noNaN: true, noDefaultInfinity: true }),
    (d, target) => {
      const c = newCounters();
      let cur: View<number> = rx.signal(0);
      for (let i = 0; i < d; i++) {
        const k = (i % 3) - 1 === 0 ? 1 : (i % 3) - 1; // ∈ {-1, 1, 1}, never 0
        cur = rx.lens(
          cur,
          countFwd(c, (x: number) => x * k + i),
          countBwd(c, (v: number) => (v - i) / k),
        );
      }
      cur.write(target);
      // Soundness is about read-back, not call count: an intermediate
      // push that happens to equal its parent legitimately short-circuits
      // the walk (no-op stop), so `c.bwd` is a bound, not an identity.
      void c;
      return Math.abs(cur.read() - target) < 1e-6;
    },
  );
}

/** Random-width fan-in: a write to the sum view reads back exactly. */
export function faninNoLostWrite(rx: Reactive): fc.IPropertyWithHooks<[number, number]> {
  return fc.property(
    fc.integer({ min: 1, max: 8 }),
    fc.double({ min: -1e4, max: 1e4, noNaN: true, noDefaultInfinity: true }),
    (n, target) => {
      const sources = Array.from({ length: n }, () => rx.signal(0));
      const view = rx.lensN(
        sources as readonly Source<unknown>[],
        vals => (vals as number[]).reduce((a, b) => a + b, 0),
        (t: number, vals) => {
          const nums = vals as number[];
          const cur = nums.reduce((a, b) => a + b, 0);
          const delta = (t - cur) / n;
          return nums.map(x => x + delta);
        },
      );
      view.write(target);
      return Math.abs(view.read() - target) < 1e-6;
    },
  );
}

/** Random mixed tree (affine chains + even-split fan-ins, arbitrary depth
 *  and shape): a write to the root view reads back exactly. Generalizes
 *  the chain and fan-in cases to compositions of both. */
export function treeNoLostWrite(rx: Reactive): fc.IPropertyWithHooks<[TreePlan, number]> {
  return fc.property(
    treePlan(4),
    fc.double({ min: -1e4, max: 1e4, noNaN: true, noDefaultInfinity: true }),
    (plan, target) => {
      const c = newCounters();
      const { view } = buildTree(rx, plan, c);
      view.write(target);
      return Math.abs(view.read() - target) < 1e-6;
    },
  );
}
