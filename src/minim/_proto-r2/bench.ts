// bench.ts — paired comparison of production minim vs r2 prototype.
//
// Same scenarios on both sides, run back-to-back with isolated setups.
// Reports median ±MAD and only flags deltas larger than the noise floor.
//
// Run:
//   npx vite-node src/minim/_proto-r2/bench.ts
//
// Notes:
//   - These numbers are for regression spotting, not absolute ranking.
//   - Anything inside one MAD of noise should be treated as a tie.

import {
  type Bench, type ComparisonResult,
  runBench, compare, printComparison, do_not_optimize,
} from "./bench-runner";

// ─── PROD minim ─────────────────────────────────────────────────────
import * as M_sig from "../signals/signal";
import * as M_vec from "../signals/values/vec";
import * as M_num from "../signals/values/num";
import * as M_box from "../signals/values/box";

// ─── r2 ─────────────────────────────────────────────────────────────
import * as R from "./reactive";
import * as R_vec from "./values/vec";
import * as R_num from "./values/num";
import * as R_box from "./values/box";

// Shared workload tunings
const ITER = 200_000;
const ITER_HEAVY = 50_000;

// ─── Bench definitions ─────────────────────────────────────────────

function defs(side: "minim" | "r2"): Bench[] {
  if (side === "minim") {
    return [
      {
        name: "construction: signal(0)",
        iters: ITER,
        run: () => M_sig.signal(0),
      },
      {
        name: "construction: num(0)",
        iters: ITER,
        run: () => M_num.num(0),
      },
      {
        name: "construction: vec(0, 0)",
        iters: ITER,
        run: () => M_vec.vec(0, 0),
      },
      {
        name: "construction: box(0,0,0,0)",
        iters: ITER,
        run: () => M_box.box(0, 0, 0, 0),
      },
      {
        name: "read: signal.peek()",
        iters: ITER,
        setup: () => M_sig.signal(42),
        run: (s) => (s as { peek(): number }).peek(),
      },
      {
        name: "read: num.peek()",
        iters: ITER,
        setup: () => M_num.num(42),
        run: (s) => (s as { peek(): number }).peek(),
      },
      {
        name: "read: vec.peek()",
        iters: ITER,
        setup: () => M_vec.vec(1, 2),
        run: (s) => (s as { peek(): unknown }).peek(),
      },
      {
        name: "read: vec.x.peek()",
        iters: ITER,
        setup: () => M_vec.vec(1, 2),
        run: (v) => (v as M_vec.Vec).x.peek(),
      },
      {
        name: "read: computed.value (cached)",
        iters: ITER,
        setup: () => {
          const s = M_sig.signal(0);
          const c = M_sig.computed(() => s.value * 2);
          void c.value;
          return c;
        },
        run: (c) => (c as { value: number }).value,
      },
      {
        name: "write: signal.value = i",
        iters: ITER,
        setup: () => ({ s: M_sig.signal(0), i: 0 }),
        run: (st) => {
          const s = st as { s: M_sig.Signal<number>; i: number };
          s.s.value = ++s.i;
          return s.s.value;
        },
      },
      {
        name: "write: vec.x.value = i",
        iters: ITER,
        setup: () => ({ v: M_vec.vec(0, 0), i: 0 }),
        run: (st) => {
          const s = st as { v: M_vec.Vec; i: number };
          s.v.x.value = ++s.i;
          return s.v.x.value;
        },
      },
      {
        name: "write + 1 effect",
        iters: ITER,
        setup: () => {
          const s = M_sig.signal(0);
          M_sig.effect(() => { do_not_optimize(s.value); });
          return { s, i: 0 };
        },
        run: (st) => {
          const s = st as { s: M_sig.Signal<number>; i: number };
          s.s.value = ++s.i;
          return 0;
        },
      },
      {
        name: "batch × 10 writes (1 effect)",
        iters: ITER_HEAVY,
        setup: () => {
          const s = M_sig.signal(0);
          M_sig.effect(() => { do_not_optimize(s.value); });
          return { s, i: 0 };
        },
        run: (st) => {
          const s = st as { s: M_sig.Signal<number>; i: number };
          M_sig.batch(() => {
            for (let k = 0; k < 10; k++) s.s.value = ++s.i;
          });
          return 0;
        },
      },
      {
        name: "10-deep computed chain (write+read)",
        iters: ITER_HEAVY,
        setup: () => {
          const root = M_sig.signal(0);
          let chain: { value: number } = root;
          for (let i = 0; i < 10; i++) {
            const prev = chain;
            chain = M_sig.computed(() => prev.value + 1);
          }
          void chain.value;
          return { root, chain, i: 0 };
        },
        run: (st) => {
          const s = st as { root: M_sig.Signal<number>; chain: { value: number }; i: number };
          s.root.value = ++s.i;
          return s.chain.value;
        },
      },
      {
        name: "50-deep computed chain (write+read)",
        iters: ITER_HEAVY,
        setup: () => {
          const root = M_sig.signal(0);
          let chain: { value: number } = root;
          for (let i = 0; i < 50; i++) {
            const prev = chain;
            chain = M_sig.computed(() => prev.value + 1);
          }
          void chain.value;
          return { root, chain, i: 0 };
        },
        run: (st) => {
          const s = st as { root: M_sig.Signal<number>; chain: { value: number }; i: number };
          s.root.value = ++s.i;
          return s.chain.value;
        },
      },
      {
        name: "eager chain: vec.add().scale().offset()",
        iters: ITER_HEAVY,
        setup: () => {
          const a = M_vec.vec(0, 0);
          const r = a.add(M_vec.vec(1, 1)).scale(2).offset(1, 1);
          void r.peek();
          return { a, r, i: 0 };
        },
        run: (st) => {
          const s = st as { a: M_vec.Vec; r: M_vec.Vec; i: number };
          s.a.value = { x: ++s.i, y: s.i };
          return s.r.value.x;
        },
      },
      {
        name: "fused chain: vec.derive(c=>c.add().scale().offset())",
        iters: ITER_HEAVY,
        setup: () => {
          const a = M_vec.vec(0, 0);
          const r = a.derive((c) => c.add(M_vec.vec(1, 1)).scale(2).offset(1, 1));
          void r.peek();
          return { a, r, i: 0 };
        },
        run: (st) => {
          const s = st as { a: M_vec.Vec; r: M_vec.Vec; i: number };
          s.a.value = { x: ++s.i, y: s.i };
          return s.r.value.x;
        },
      },
      {
        name: "realistic scene: 100 boxes, animate center",
        iters: 500,
        setup: () => {
          const boxes = Array.from({ length: 100 }, (_, i) => M_box.box(i, 0, 10, 10));
          const centers = boxes.map((b) => b.center);
          M_sig.batch(() => centers.forEach((c) => M_sig.effect(() => do_not_optimize(c.value))));
          return { boxes, i: 0 };
        },
        run: (st) => {
          const s = st as { boxes: M_box.Box[]; i: number };
          M_sig.batch(() => {
            const t = ++s.i;
            for (const b of s.boxes) b.x.value = t;
          });
          return 0;
        },
      },
    ];
  }
  // r2
  return [
    {
      name: "construction: signal(0)",
      iters: ITER,
      run: () => R.signal(0),
    },
    {
      name: "construction: num(0)",
      iters: ITER,
      run: () => R_num.num(0),
    },
    {
      name: "construction: vec(0, 0)",
      iters: ITER,
      run: () => R_vec.vec(0, 0),
    },
    {
      name: "construction: box(0,0,0,0)",
      iters: ITER,
      run: () => R_box.box(0, 0, 0, 0),
    },
    {
      name: "read: signal.peek()",
      iters: ITER,
      setup: () => R.signal(42),
      run: (s) => (s as R.Reactive<number>).peek(),
    },
    {
      name: "read: num.peek()",
      iters: ITER,
      setup: () => R_num.num(42),
      run: (s) => (s as R_num.Num).peek(),
    },
    {
      name: "read: vec.peek()",
      iters: ITER,
      setup: () => R_vec.vec(1, 2),
      run: (s) => (s as R_vec.Vec).peek(),
    },
    {
      name: "read: vec.x.peek()",
      iters: ITER,
      setup: () => R_vec.vec(1, 2),
      run: (v) => (v as R_vec.Vec).x.peek(),
    },
    {
      name: "read: computed.value (cached)",
      iters: ITER,
      setup: () => {
        const s = R.signal(0);
        const c = R.computed(() => s.value * 2);
        void c.value;
        return c;
      },
      run: (c) => (c as R.Reactive<number>).value,
    },
    {
      name: "write: signal.value = i",
      iters: ITER,
      setup: () => ({ s: R.signal(0), i: 0 }),
      run: (st) => {
        const s = st as { s: R.Reactive<number>; i: number };
        s.s.value = ++s.i;
        return s.s.value;
      },
    },
    {
      name: "write: vec.x.value = i",
      iters: ITER,
      setup: () => ({ v: R_vec.vec(0, 0), i: 0 }),
      run: (st) => {
        const s = st as { v: R_vec.Vec; i: number };
        s.v.x.value = ++s.i;
        return s.v.x.value;
      },
    },
    {
      name: "write + 1 effect",
      iters: ITER,
      setup: () => {
        const s = R.signal(0);
        R.effect(() => { do_not_optimize(s.value); });
        return { s, i: 0 };
      },
      run: (st) => {
        const s = st as { s: R.Reactive<number>; i: number };
        s.s.value = ++s.i;
        return 0;
      },
    },
    {
      name: "batch × 10 writes (1 effect)",
      iters: ITER_HEAVY,
      setup: () => {
        const s = R.signal(0);
        R.effect(() => { do_not_optimize(s.value); });
        return { s, i: 0 };
      },
      run: (st) => {
        const s = st as { s: R.Reactive<number>; i: number };
        R.batch(() => {
          for (let k = 0; k < 10; k++) s.s.value = ++s.i;
        });
        return 0;
      },
    },
    {
      name: "10-deep computed chain (write+read)",
      iters: ITER_HEAVY,
      setup: () => {
        const root = R.signal(0);
        let chain: { value: number } = root;
        for (let i = 0; i < 10; i++) {
          const prev = chain;
          chain = R.computed(() => prev.value + 1);
        }
        void chain.value;
        return { root, chain, i: 0 };
      },
      run: (st) => {
        const s = st as { root: R.Reactive<number>; chain: { value: number }; i: number };
        s.root.value = ++s.i;
        return s.chain.value;
      },
    },
    {
      name: "50-deep computed chain (write+read)",
      iters: ITER_HEAVY,
      setup: () => {
        const root = R.signal(0);
        let chain: { value: number } = root;
        for (let i = 0; i < 50; i++) {
          const prev = chain;
          chain = R.computed(() => prev.value + 1);
        }
        void chain.value;
        return { root, chain, i: 0 };
      },
      run: (st) => {
        const s = st as { root: R.Reactive<number>; chain: { value: number }; i: number };
        s.root.value = ++s.i;
        return s.chain.value;
      },
    },
    {
      name: "eager chain: vec.add().scale().offset()",
      iters: ITER_HEAVY,
      setup: () => {
        const a = R_vec.vec(0, 0);
        const r = a.add(R_vec.vec(1, 1)).scale(2).offset(1, 1);
        void r.peek();
        return { a, r, i: 0 };
      },
      run: (st) => {
        const s = st as { a: R_vec.Vec; r: R_vec.Vec; i: number };
        s.a.value = { x: ++s.i, y: s.i };
        return s.r.value.x;
      },
    },
    {
      name: "fused chain: vec.derive(c=>c.add().scale().offset())",
      iters: ITER_HEAVY,
      setup: () => {
        const a = R_vec.vec(0, 0);
        const r = a.derive((c) => c.add(R_vec.vec(1, 1)).scale(2).offset(1, 1));
        void r.peek();
        return { a, r, i: 0 };
      },
      run: (st) => {
        const s = st as { a: R_vec.Vec; r: R_vec.Vec; i: number };
        s.a.value = { x: ++s.i, y: s.i };
        return s.r.value.x;
      },
    },
    {
      name: "realistic scene: 100 boxes, animate center",
      iters: 500,
      setup: () => {
        const boxes = Array.from({ length: 100 }, (_, i) => R_box.box(i, 0, 10, 10));
        const centers = boxes.map((b) => b.center);
        R.batch(() => centers.forEach((c) => R.effect(() => do_not_optimize(c.value))));
        return { boxes, i: 0 };
      },
      run: (st) => {
        const s = st as { boxes: R_box.Box[]; i: number };
        R.batch(() => {
          const t = ++s.i;
          for (const b of s.boxes) b.x.value = t;
        });
        return 0;
      },
    },
  ];
}

// ─── Run paired ────────────────────────────────────────────────────

const minimDefs = defs("minim");
const r2Defs = defs("r2");

const rows: ComparisonResult[] = [];
const phases = Number(process.env.BENCH_PHASES ?? 12);
const warmup = Number(process.env.BENCH_WARMUP ?? 4);

console.log(`bench: phases=${phases} warmup=${warmup}`);
for (let i = 0; i < minimDefs.length; i++) {
  // Adjacent execution: minim then r2 for the same scenario.
  // Drift between scenarios cancels by pairing.
  const a = runBench(minimDefs[i], { phases, warmupPhases: warmup });
  const b = runBench(r2Defs[i], { phases, warmupPhases: warmup });
  rows.push(compare(minimDefs[i].name, a, b));
  process.stdout.write(".");
}
console.log("");

printComparison(rows, ["minim (prod)", "r2 (proto)"]);

const regressions = rows.filter((r) => r.significant && r.delta > 0.05);
const improvements = rows.filter((r) => r.significant && r.delta < -0.05);
console.log(`Significant regressions (>5%): ${regressions.length}`);
console.log(`Significant improvements (>5%): ${improvements.length}`);
console.log(`Within noise: ${rows.length - regressions.length - improvements.length}`);
