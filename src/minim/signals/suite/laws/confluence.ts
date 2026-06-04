// Confluence — batched write-through to disjoint sources settles to the
// same state regardless of the order writes are issued within the batch.
// (The shared-source case is last-write-wins and intentionally order-
// dependent; this law covers the disjoint case the engine must make
// deterministic.) The dual of forward batching atomicity.

import fc from "fast-check";
import type { Reactive, View } from "../adapters/types";
import { finite } from "../harness/arbitraries";

function run(rx: Reactive, vals: number[], order: number[]): number[] {
  const k = vals.length;
  const sources = Array.from({ length: k }, () => rx.signal(0));
  const views: View<number>[] = sources.map((s, i) =>
    rx.lens(
      s,
      x => x + i,
      v => v - i,
    ),
  );
  rx.batch(() => {
    for (const i of order) views[i].write(vals[i]);
  });
  return sources.map(s => s.read());
}

export function orderIndependent(rx: Reactive): fc.IPropertyWithHooks<[number[]]> {
  return fc.property(fc.array(finite(-1e3, 1e3), { minLength: 2, maxLength: 6 }), vals => {
    const k = vals.length;
    const identity = Array.from({ length: k }, (_unused, i) => i);
    const reversed = [...identity].reverse();
    const a = run(rx, vals, identity);
    const b = run(rx, vals, reversed);
    return a.every((x, i) => Math.abs(x - b[i]) < 1e-9);
  });
}
