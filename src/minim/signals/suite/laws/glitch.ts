// Backward glitch-freedom — the cross-framework discriminator.
//
// A single write fans out to N sources that reconverge into a downstream
// computed `total`, observed by an effect. A correct engine recomputes
// `total` once and the effect fires once, never observing a partial
// state (some sources updated, others not). The naive write-through —
// a setter that performs N independent source writes outside a batch —
// fires the effect up to N times and exposes intermediate sums. This is
// the backward dual of RFTS's diamond test, fully black-box.

import type { Reactive } from "../adapters/types";
import { newCounters } from "../harness/counters";
import { buildReconverge } from "../harness/graphs";

export interface DiamondResult {
  fires: number;
  /** Each effect run: was `total` consistent with the live source sum? */
  observations: boolean[];
  finalTotal: number;
  expectedTotal: number;
}

export function backwardDiamond(rx: Reactive, n: number, writeVal: number): DiamondResult {
  const c = newCounters();
  const g = buildReconverge(rx, n, c);
  void g.view.read();

  const observations: boolean[] = [];
  let fires = 0;
  const dispose = rx.effect(() => {
    const total = g.total.read();
    const liveSum = g.sources.reduce((a, s) => a + s.read(), 0);
    observations.push(Math.abs(total - liveSum) < 1e-9);
    fires++;
  });

  const baseline = fires;
  observations.length = 0;
  g.view.write(writeVal);
  const result: DiamondResult = {
    fires: fires - baseline,
    observations: [...observations],
    finalTotal: g.total.read(),
    expectedTotal: writeVal,
  };
  dispose();
  return result;
}
