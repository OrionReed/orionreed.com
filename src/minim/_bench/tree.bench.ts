// Frames-in-Shapes design question: should `worldFrame` be a reactive
// chain (each shape's worldFrame derived via parent's worldFrame) or
// computed on-demand (manual parent-walk only when read)?
//
// The reactive chain is API-cleaner — `point.in(worldFrame)` works
// uniformly across the tree. But it pays for every ancestor change
// even if no one reads the descendant.
//
// These benches measure the trade-off in three regimes:
//
//   1. Read all  — every descendant is consumed (renderer pass).
//   2. Read one  — only the deepest descendant is read (cross-frame
//                  query like `aabbInRoot(leaf)`).
//   3. No read   — write only, never observe (most ancestors during
//                  drag operations).

import { computed, effect, signal } from "../core/signal";
import {
  identity,
  multiply,
  type M,
} from "../signals/matrix";
import { Matrix2D } from "../signals/matrix";
import { bench, suite } from "./harness";

const N = 1000;
const STEP: M = { a: 1, b: 0, c: 0, d: 1, e: 1, f: 0 };

// ── Strategy A: reactive chain (proposed Frames-in-Shapes)
//   Each level: world[i] = world[i-1].multiply(local[i])
function buildReactiveChain(n: number) {
  const local = Array.from({ length: n }, () => signal<M>({ ...STEP }));
  const world: { value: M }[] = [];
  world.push(local[0]);
  for (let i = 1; i < n; i++) {
    const prev = world[i - 1];
    const cur = local[i];
    world.push(computed(() => multiply(prev.value, cur.value)));
  }
  return { local, world };
}

// ── Strategy B: on-demand walk (current Shape behavior)
//   Each shape stores a parent ref; reading worldFrame walks up.
function buildWalkChain(n: number) {
  const local = Array.from({ length: n }, () => signal<M>({ ...STEP }));
  const parent = (i: number): number | null => (i === 0 ? null : i - 1);
  const worldOf = (i: number): M => {
    let m = local[i].value;
    let p = parent(i);
    while (p !== null) {
      m = multiply(local[p].value, m);
      p = parent(p);
    }
    return m;
  };
  return { local, worldOf };
}

suite("tree fan-out: write root, READ ALL N world frames", () => {
  const A = buildReactiveChain(N);
  const B = buildWalkChain(N);

  let i = 0;
  bench(`reactive chain  (n=${N})`, () => {
    A.local[0].value = { ...STEP, e: ++i };
    let s = 0;
    for (let k = 0; k < N; k++) s += A.world[k].value.e | 0;
    return s;
  });
  bench(`on-demand walk  (n=${N})`, () => {
    B.local[0].value = { ...STEP, e: ++i };
    let s = 0;
    for (let k = 0; k < N; k++) s += B.worldOf(k).e | 0;
    return s;
  });
});

suite("tree fan-out: write root, READ ONE LEAF", () => {
  const A = buildReactiveChain(N);
  const B = buildWalkChain(N);

  let i = 0;
  bench(`reactive chain  (n=${N})`, () => {
    A.local[0].value = { ...STEP, e: ++i };
    return A.world[N - 1].value.e | 0;
  });
  bench(`on-demand walk  (n=${N})`, () => {
    B.local[0].value = { ...STEP, e: ++i };
    return B.worldOf(N - 1).e | 0;
  });
});

suite("tree fan-out: write root, NO READ (drag-only pattern)", () => {
  const A = buildReactiveChain(N);
  const B = buildWalkChain(N);

  let i = 0;
  bench(`reactive chain  (n=${N})`, () => {
    A.local[0].value = { ...STEP, e: ++i };
  });
  bench(`on-demand walk  (n=${N})`, () => {
    B.local[0].value = { ...STEP, e: ++i };
  });
});

// ── Variant: same chain but every world frame has a subscriber
// effect (mimics each shape attaching its CSS transform to its
// worldFrame). This is closer to how Shape uses transform today.

suite(`tree fan-out: chain w/ subscribers on EVERY level (n=${N})`, () => {
  const A = buildReactiveChain(N);
  const B = buildWalkChain(N);

  // Subscribe to each world frame on the reactive side.
  const disposers: Array<() => void> = [];
  let observed = 0;
  for (const w of A.world) {
    disposers.push(
      effect(() => {
        observed = (w.value.e | 0) + observed;
      }),
    );
  }
  // For the walk side, simulate "render reads worldOf at end of frame":
  // we don't subscribe, we just call worldOf(i) for all i after each write.

  let i = 0;
  bench(`reactive chain  (effects fire on write)`, () => {
    A.local[0].value = { ...STEP, e: ++i };
  });
  bench(`on-demand walk  (worldOf each child after write)`, () => {
    B.local[0].value = { ...STEP, e: ++i };
    for (let k = 0; k < N; k++) observed += B.worldOf(k).e | 0;
  });

  void disposers;
  void observed;
});

// ── Reactive chain with Matrix2D struct (the actual primitive Shape
//    would use). This is the most realistic measure of the proposed
//    rework.

suite(
  `tree fan-out: reactive chain via Matrix2D struct (n=${N}, READ ALL)`,
  () => {
    const local = Array.from({ length: N }, () => Matrix2D.signal({ ...STEP }));
    const world: any[] = [local[0]];
    for (let k = 1; k < N; k++) {
      world.push(world[k - 1].multiply(local[k]));
    }
    let i = 0;
    bench(`Matrix2D.multiply chain (n=${N})`, () => {
      local[0].value = { ...STEP, e: ++i };
      let s = 0;
      for (let k = 0; k < N; k++) s += world[k].value.e | 0;
      return s;
    });
  },
);

void identity;
