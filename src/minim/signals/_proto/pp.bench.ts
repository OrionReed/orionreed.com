// Head-to-head: production engine (eager single-parent backward) vs the
// push-pull variant (`signal-pp.ts`), on identical topologies via the same
// adapter-generic workloads. Questions:
//
//   1. Does the read-time drain check (`bwdDrained < bwdQueue.length` on
//      every `.value`) tax the FORWARD hot path? (fwd chain/fan)
//   2. Is a single eager write (outside a batch) unchanged? (bwd chain/fan)
//   3. Does push-pull WIN where it should — repeated writes to a view in
//      one batch coalesce to one walk? (batched repeat)
//   4. What does a small batch of one view write cost either way?
//
//   node --expose-gc node_modules/.bin/vite-node \
//        src/minim/signals/_proto/pp.bench.ts

import { group, run } from "mitata";
import { minim } from "../suite/adapters/minim";
import { reg } from "../suite/bench/runner";
import type { Reactive, Readable, Source, Update, View } from "../suite/adapters/types";
import {
  bwdChain,
  bwdFan,
  dragFan,
  fwdChain,
  fwdFan,
  type Tick,
} from "../suite/bench/workloads";
import { batch, type Cell, cell, derive, effect, lens as mlens, type Read, untracked } from "./signal-pp";

// ── push-pull adapter (mirrors suite/adapters/minim.ts over the variant) ──

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
  name: "minim-pp",
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

// ── batched workloads (where eager vs push-pull diverge) ──

/** One batch per tick containing `reps` writes to the SAME identity view,
 *  then read the source. Eager: `reps` walks/tick. Push-pull: 1 walk. */
function bwdBatchRepeat(rx: Reactive, reps: number): Tick {
  const s = rx.signal(0);
  const v = rx.lens(
    s,
    (x: number) => x,
    (t: number) => t,
  );
  return (i) => {
    rx.batch(() => {
      for (let k = 0; k < reps; k++) v.write(i + k);
    });
    return s.read();
  };
}

/** One batch per tick with a single view write (the common small batch). */
function bwdBatchSingle(rx: Reactive): Tick {
  const s = rx.signal(0);
  const v = rx.lens(
    s,
    (x: number) => x,
    (t: number) => t,
  );
  return (i) => {
    rx.batch(() => {
      v.write(i);
    });
    return s.read();
  };
}

// ── groups ──

group("fwd chain 50 (read hot path: drain-check tax?)", () => {
  reg("eager", fwdChain(minim, 50));
  reg("push-pull", fwdChain(pp, 50));
});
group("fwd fan 50", () => {
  reg("eager", fwdFan(minim, 50));
  reg("push-pull", fwdFan(pp, 50));
});
group("bwd chain 50 (single eager write)", () => {
  reg("eager", bwdChain(minim, 50));
  reg("push-pull", bwdChain(pp, 50));
});
group("bwd fan 50 (single eager write)", () => {
  reg("eager", bwdFan(minim, 50));
  reg("push-pull", bwdFan(pp, 50));
});
group("bwd batch: 1 write/batch", () => {
  reg("eager", bwdBatchSingle(minim));
  reg("push-pull", bwdBatchSingle(pp));
});
group("bwd batch: 32 writes/batch (coalescing)", () => {
  reg("eager", bwdBatchRepeat(minim, 32));
  reg("push-pull", bwdBatchRepeat(pp, 32));
});
group("drag fan 50 (live observer)", () => {
  reg("eager", dragFan(minim, 50));
  reg("push-pull", dragFan(pp, 50));
});

await run({ format: "mitata" });
