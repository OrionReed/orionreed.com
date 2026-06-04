// Backward minimality — "don't recompute the world to settle a write".
// The dual of js-reactivity-benchmark's over-execution metric. Stated as
// observable counts (closure calls, source changes, effect fires), so it
// holds on any engine. Optimum:
//
//   1→1 chain of depth D : exactly D `bwd` calls, exactly 1 source
//                          change, downstream effects fire once.
//   no-op re-write       : 0 source changes (equality short-circuit).
//   N→M fan-in           : 1 `bwd` call, exactly N source changes,
//                          downstream effect fires once (not N times).
//
// `chainScaling` lifts the per-graph bound to a property: `bwd` calls
// must stay linear in depth, never super-linear.

import fc from "fast-check";
import type { Reactive } from "../adapters/types";
import { depth as depthArb } from "../harness/arbitraries";
import { newCounters, observeSources, probeEffect, resetCounters } from "../harness/counters";
import { buildChain, buildReconverge } from "../harness/graphs";

export interface WriteCost {
  bwd: number;
  changes: number;
  fires: number;
}

/** Cost of one write through a depth-`D` 1→1 chain. */
export function chainWriteCost(rx: Reactive, depth: number, writeVal: number): WriteCost {
  const c = newCounters();
  const g = buildChain(rx, depth, c);
  void g.top.read(); // realize forward
  const obs = observeSources(rx, [g.source]);
  const eff = probeEffect(rx, () => void g.top.read());
  resetCounters(c);
  obs.reset();
  eff.reset();
  g.top.write(writeVal);
  const cost = { bwd: c.bwd, changes: obs.changes(), fires: eff.fires() };
  obs.dispose();
  eff.dispose();
  return cost;
}

/** Cost of re-writing the current view value (should be a no-op). */
export function noopWriteCost(rx: Reactive, depth: number): WriteCost {
  const c = newCounters();
  const g = buildChain(rx, depth, c);
  const settled = g.top.read();
  const obs = observeSources(rx, [g.source]);
  const eff = probeEffect(rx, () => void g.top.read());
  resetCounters(c);
  obs.reset();
  eff.reset();
  g.top.write(settled);
  const cost = { bwd: c.bwd, changes: obs.changes(), fires: eff.fires() };
  obs.dispose();
  eff.dispose();
  return cost;
}

/** Cost of one write through an N-wide fan-in view. */
export function reconvergeWriteCost(rx: Reactive, n: number, writeVal: number): WriteCost {
  const c = newCounters();
  const g = buildReconverge(rx, n, c);
  void g.view.read();
  void g.total.read();
  const obs = observeSources(rx, g.sources);
  const eff = probeEffect(rx, () => void g.total.read());
  resetCounters(c);
  obs.reset();
  eff.reset();
  g.view.write(writeVal);
  const cost = { bwd: c.bwd, changes: obs.changes(), fires: eff.fires() };
  obs.dispose();
  eff.dispose();
  return cost;
}

/** Property: backward-walk work is linear in chain depth. A fresh
 *  depth-`D` chain over source 0 settles its view at `D`, so writing
 *  `D + delta` (delta ≥ 1) guarantees a real change at every level —
 *  no short-circuit — and the walk must visit each level exactly once. */
export function chainScaling(rx: Reactive): fc.IPropertyWithHooks<[number, number]> {
  return fc.property(depthArb(16), fc.integer({ min: 1, max: 1000 }), (d, delta) => {
    const cost = chainWriteCost(rx, d, d + delta);
    return cost.bwd === d && cost.changes === 1;
  });
}
