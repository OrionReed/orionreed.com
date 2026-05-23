// cluster-bench.test.ts — head-to-head perf vs the `_proto-avbd`
// preEffect-based reactive integration.
//
// Both run the SAME numerical kernel (the AVBD `Solver` + `Force`
// subclasses). The only difference is the reactive layer:
//   - `_proto-avbd`: preEffect with phase-ordered flush.
//   - `_proto-relate2`: lazy-solve via getter+pulse.
//
// Comparing apples to apples: same scenes, same iter count.

import { describe, expect, it } from "vitest";
import { vec, type Vec, type Writable } from "../../signals";
import { Cluster, distance as clusterDistance } from "../index";
import { distance as avbdDistance, Solver as AvbdSolver } from "../../_proto-avbd";

type WVec = Writable<Vec>;

function buildCluster(N: number, iters: number) {
  const cells: WVec[] = [];
  for (let i = 0; i < N; i++) cells.push(vec(i, 0));
  const c = new Cluster({ iterations: iters });
  for (let i = 1; i < N; i++) clusterDistance(c, cells[i - 1]!, cells[i]!, 1);
  c.pin(cells[0]!);
  c.pin(cells[N - 1]!);
  return { c, cells };
}

function buildAvbd(N: number, iters: number) {
  const cells: WVec[] = [];
  for (let i = 0; i < N; i++) cells.push(vec(i, 0));
  const s = new AvbdSolver({ iterations: iters });
  for (let i = 1; i < N; i++) avbdDistance(s, cells[i - 1]!, cells[i]!, 1);
  s.pin(cells[0]!);
  s.pin(cells[N - 1]!);
  return { s, cells };
}

describe("Cluster vs preEffect — head-to-head bench", () => {
  it("chain N=256 iter=5: drag tail, log per-step time", () => {
    const N = 256;
    const drags = 50;

    // Cluster (lazy-solve)
    const cl = buildCluster(N, 5);
    cl.cells[N - 1]!.value = { x: N - 5, y: 1 };
    // Force a read to converge initial state.
    void cl.cells[N - 1]!.value;
    let dy = 1;
    const t0 = performance.now();
    for (let i = 0; i < drags; i++) {
      dy += 0.01;
      cl.cells[N - 1]!.value = { x: N - 5, y: dy };
      // Read to trigger solve (matches "interactive read after each frame's writes")
      void cl.cells[N - 1]!.value;
    }
    const tCluster = (performance.now() - t0) / drags;

    // AVBD preEffect
    const av = buildAvbd(N, 5);
    av.cells[N - 1]!.value = { x: N - 5, y: 1 };
    let dy2 = 1;
    const t1 = performance.now();
    for (let i = 0; i < drags; i++) {
      dy2 += 0.01;
      av.cells[N - 1]!.value = { x: N - 5, y: dy2 };
    }
    const tAvbd = (performance.now() - t1) / drags;

    console.log(
      `  chain N=256 iter=5: cluster=${tCluster.toFixed(3)}ms, avbd=${tAvbd.toFixed(3)}ms (cluster is ${(tAvbd / tCluster).toFixed(2)}× ${tAvbd > tCluster ? "faster" : "slower"})`,
    );
    expect(Number.isFinite(tCluster)).toBe(true);
    expect(Number.isFinite(tAvbd)).toBe(true);
  });
});
