// Lossy composition — a stack of range-clamping write-throughs. Lossy
// lenses are only PutGet on their preserved range, so the laws split:
//
//   in-range PutGet : a target inside the surviving range reads back
//                     exactly, even through a deep clamp chain.
//   absorption      : re-writing the settled view (a no-op) commits zero
//                     source changes — the engine must stop a write that
//                     doesn't move the view, the whole point of lossy
//                     short-circuiting (see signals engine header).

import fc from "fast-check";
import type { Reactive, Source, View } from "../adapters/types";
import { observeSources } from "../harness/counters";

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

function buildClampChain(
  rx: Reactive,
  depth: number,
  lo: number,
  hi: number,
): { source: Source<number>; top: View<number> } {
  const source = rx.signal(lo);
  let cur: View<number> = source;
  for (let i = 0; i < depth; i++) {
    cur = rx.lens(
      cur,
      x => clamp(x, lo, hi),
      v => clamp(v, lo, hi),
    );
  }
  return { source, top: cur };
}

const inRange = fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true });
const chainDepth = fc.integer({ min: 1, max: 6 });

/** In-range writes survive a clamp chain unchanged. */
export function lossyChainInRange(rx: Reactive): fc.IPropertyWithHooks<[number, number]> {
  return fc.property(chainDepth, inRange, (d, v) => {
    const { top } = buildClampChain(rx, d, 0, 100);
    top.write(v);
    return Math.abs(top.read() - v) < 1e-9;
  });
}

/** Re-writing the settled view value commits no source change. */
export function lossyChainAbsorbsNoop(rx: Reactive): fc.IPropertyWithHooks<[number, number]> {
  return fc.property(chainDepth, inRange, (d, v) => {
    const { source, top } = buildClampChain(rx, d, 0, 100);
    top.write(v);
    void top.read();
    const obs = observeSources(rx, [source]);
    obs.reset();
    top.write(top.read());
    const changes = obs.changes();
    obs.dispose();
    return changes === 0;
  });
}
