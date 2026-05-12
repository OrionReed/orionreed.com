// Runnable spike: correctness + head-to-head perf.
//
//   node --expose-gc node_modules/.bin/vite-node src/minim/_proto/run.ts

import { effect, computed, signal } from "../core/signal";
import { Point } from "../scene/point";
import { Vec, pt as ptNew, type V } from "./vec";
import { AABB, boxAt } from "./aabb";
import { Matrix2D, translate, matrixRotate } from "./matrix";
import { Frame } from "./frame";
import { meanVec, meanNum } from "./aggregates";
import { prop, iso, combine, at } from "./lens";

// ─────────────────────────────────────────────────────────────────────
//  Correctness
// ─────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const fails: string[] = [];

function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
  } else {
    failed++;
    fails.push(`${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function correctness() {
  console.log("\n── Correctness ─────────────────────────────────────────");

  // ── Vec ──
  {
    const p = ptNew(20, 30);
    check("Vec read .value", p.value.x === 20 && p.value.y === 30);
    check("Vec read .x.value", p.x.value === 20);
  }
  {
    const p = ptNew(0, 0);
    p.value = { x: 7, y: 11 };
    check("Vec write .value", p.value.x === 7 && p.value.y === 11);
    check("Vec axis sees write", p.x.value === 7 && p.y.value === 11);
  }
  {
    const p = ptNew(1, 2);
    p.x.value = 5;
    check("Vec write .x → .value", p.value.x === 5 && p.value.y === 2);
    p.y.value = 9;
    check("Vec write .y → .value", p.value.x === 5 && p.value.y === 9);
  }
  {
    const p = ptNew(3, 4);
    let fires = 0;
    const stop = effect(() => {
      p.value;
      fires++;
    });
    fires = 0;
    p.value = { x: 3, y: 4 };
    check("Vec equality suppresses no-op write", fires === 0);
    p.value = { x: 3, y: 5 };
    check("Vec changed write fires", fires === 1);
    stop();
  }
  {
    const a = ptNew(1, 2);
    const b = ptNew(3, 4);
    const sum = a.add(b);
    check("Vec.add: initial", sum.value.x === 4 && sum.value.y === 6);
    a.value = { x: 10, y: 20 };
    check("Vec.add: tracks change", sum.value.x === 13 && sum.value.y === 24);
  }
  {
    const a = ptNew(1, 1);
    const b = ptNew(2, 3);
    const chain = a.add(b).scale(2).perp();
    check(
      "Vec chained: initial",
      chain.value.x === -8 && chain.value.y === 6,
    );
    a.value = { x: 0, y: 0 };
    check(
      "Vec chained: tracks change",
      chain.value.x === -6 && chain.value.y === 4,
    );
  }
  {
    const a = ptNew(3, 4);
    const len = a.length();
    check("Vec.length: initial", len.value === 5);
    a.value = { x: 6, y: 8 };
    check("Vec.length: tracks change", len.value === 10);
  }
  {
    const a = ptNew(1, 0);
    const k = signal(3);
    const scaled = a.scale(k);
    check("Vec op accepts Signal arg", scaled.value.x === 3 && scaled.value.y === 0);
    k.value = 4;
    check("Vec op tracks Signal change", scaled.value.x === 4);
  }
  {
    const a = ptNew(1, 2);
    check("Vec field accessor caches", a.x === a.x);
  }
  {
    // arity-2: lerp
    const a = ptNew(0, 0);
    const b = ptNew(10, 20);
    const t = signal(0.25);
    const m = a.lerp(b, t);
    check("Vec.lerp arity-2", m.value.x === 2.5 && m.value.y === 5);
    t.value = 0.5;
    check("Vec.lerp tracks t", m.value.x === 5 && m.value.y === 10);
  }

  // ── Vec.lens ── (writable view over a derived expression)
  {
    const a = ptNew(0, 0);
    // A lens that reads/writes via `a` but offsets x by 100 on both sides.
    const view = Vec.lens(
      () => ({ x: a.value.x + 100, y: a.value.y }),
      (v) => {
        a.value = { x: v.x - 100, y: v.y };
      },
    );
    check("Vec.lens: read", view.value.x === 100 && view.value.y === 0);
    view.value = { x: 250, y: 7 };
    check(
      "Vec.lens: write propagates to source",
      a.value.x === 150 && a.value.y === 7,
    );
    check("Vec.lens: read sees own write", view.value.x === 250);
    // Lens has the same op vocabulary
    const offset = view.add(ptNew(1, 1));
    check("Vec.lens: ops work", offset.value.x === 251 && offset.value.y === 8);
  }

  // ── AABB ──
  {
    const b = AABB.signal({ x: 10, y: 20, w: 100, h: 50 });
    check("AABB read .value", b.value.x === 10 && b.value.w === 100);
    check(
      "AABB axes",
      b.x.value === 10 && b.y.value === 20 && b.w.value === 100 && b.h.value === 50,
    );
    b.w.value = 200;
    check("AABB axis write", b.value.w === 200 && b.value.x === 10);
  }
  {
    const b = AABB.signal({ x: 0, y: 0, w: 10, h: 10 });
    const expanded = b.expand(5);
    check(
      "AABB.expand",
      expanded.value.x === -5 &&
        expanded.value.y === -5 &&
        expanded.value.w === 20 &&
        expanded.value.h === 20,
    );
    b.value = { x: 100, y: 100, w: 4, h: 4 };
    check(
      "AABB.expand tracks change",
      expanded.value.x === 95 && expanded.value.w === 14,
    );
  }
  {
    const a = AABB.signal({ x: 0, y: 0, w: 10, h: 10 });
    const b = AABB.signal({ x: 5, y: 5, w: 20, h: 20 });
    const u = a.union(b);
    check(
      "AABB.union",
      u.value.x === 0 && u.value.y === 0 && u.value.w === 25 && u.value.h === 25,
    );
  }
  {
    const b = AABB.signal({ x: 0, y: 0, w: 10, h: 10 });
    const center = boxAt(b, 0.5, 0.5);
    check("AABB anchor (boxAt)", center.value.x === 5 && center.value.y === 5);
    b.value = { x: 100, y: 100, w: 20, h: 20 };
    check(
      "AABB anchor tracks resize",
      center.value.x === 110 && center.value.y === 110,
    );
    const offset = center.add(ptNew(1, 2));
    check("AABB anchor composes with Vec ops", offset.value.x === 111);
  }

  // ── Matrix2D + cross-struct ops (`.in(matrix)`) ──
  {
    const m = Matrix2D.signal({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    check("Matrix2D identity reads", m.value.a === 1 && m.value.e === 0);
    m.a.value = 2;
    check("Matrix2D field write (6-field struct)", m.value.a === 2);
    m.value = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  }
  {
    // multiply: M → M
    const t = translate(10, 20);
    const r = matrixRotate(0); // identity rotation
    const product = t.multiply(r);
    check(
      "Matrix2D.multiply",
      product.value.e === 10 && product.value.f === 20,
    );
  }
  {
    // determinant: scalar
    const m = Matrix2D.signal({ a: 2, b: 0, c: 0, d: 3, e: 0, f: 0 });
    check("Matrix2D.determinant", m.determinant().value === 6);
    m.value = { a: 1, b: 0, c: 0, d: 5, e: 0, f: 0 };
    check("Matrix2D.determinant tracks change", m.determinant().value === 5);
  }
  {
    // Cross-struct: pt.in(matrix). Reactive in both inputs.
    const p = ptNew(3, 4);
    const m = translate(10, 20);
    const transformed = p.in(m);
    check(
      "pt.in(matrix) initial",
      transformed.value.x === 13 && transformed.value.y === 24,
    );
    p.value = { x: 0, y: 0 };
    check(
      "pt.in(matrix) tracks point change",
      transformed.value.x === 10 && transformed.value.y === 20,
    );
    m.e.value = 100;
    check(
      "pt.in(matrix) tracks matrix change",
      transformed.value.x === 100 && transformed.value.y === 20,
    );
    // Result composes as Vec — chain further
    const offset = transformed.add(ptNew(1, 1)).scale(2);
    check(
      "pt.in(matrix) composes downstream",
      offset.value.x === 202 && offset.value.y === 42,
    );
  }
  {
    // Cross-struct: aabb.in(matrix)
    const b = AABB.signal({ x: 0, y: 0, w: 10, h: 10 });
    const m = translate(5, 5);
    const transformed = b.in(m);
    check(
      "aabb.in(matrix) initial",
      transformed.value.x === 5 &&
        transformed.value.y === 5 &&
        transformed.value.w === 10 &&
        transformed.value.h === 10,
    );
    m.e.value = 100;
    check(
      "aabb.in(matrix) tracks matrix change",
      transformed.value.x === 100,
    );
  }

  // ── Frame: emerges from Matrix2D + the cross-struct `in` op. ──
  {
    const root = Frame.identity();
    const local = translate(10, 20);
    const child = Frame.child(root, local);
    const p = ptNew(3, 4);
    const inWorld = p.in(child);
    check(
      "Frame: identity.child(translate) → composed transform applies",
      inWorld.value.x === 13 && inWorld.value.y === 24,
    );
    // Mutate the local — child re-derives, and downstream re-derives.
    local.e.value = 100;
    check(
      "Frame: local change propagates through child to dependent point",
      inWorld.value.x === 103 && inWorld.value.y === 24,
    );
    // Mutate root — child re-derives. root translates by (1, 0); local
    // by (100, 20). Composed translation = (101, 20). p=(3,4) → (104, 24).
    root.e.value = 1;
    check(
      "Frame: root change propagates",
      inWorld.value.x === 104 && inWorld.value.y === 24,
    );
  }
  {
    // Three-deep frame nesting (the kind Shape parent-walks need).
    const a = Frame.identity();
    const b = Frame.child(a, translate(1, 0));
    const c = Frame.child(b, translate(0, 1));
    const p = ptNew(0, 0);
    const inC = p.in(c);
    check("Frame: 3-deep composition", inC.value.x === 1 && inC.value.y === 1);
    a.e.value = 10;
    check("Frame: change at root walks 3 levels", inC.value.x === 11);
  }

  // ── Lens combinators ──
  {
    // prop: equivalent to what the framework uses internally for axes
    const p = signal({ x: 1, y: 2 });
    const x = prop(p, "x");
    check("prop: read", x.value === 1);
    x.value = 9;
    check("prop: write round-trips", p.value.x === 9 && p.value.y === 2);
  }
  {
    // at: index a list signal
    const list = signal<readonly number[]>([10, 20, 30]);
    const second = at(list, 1);
    check("at: read", second.value === 20);
    second.value = 99;
    check("at: write", list.value[1] === 99 && list.value[0] === 10);
  }
  {
    // iso: bijective view — Celsius / Fahrenheit
    const c = signal(0);
    const f = iso(
      c,
      (c) => c * 9 / 5 + 32,
      (f) => (f - 32) * 5 / 9,
    );
    check("iso: read forward", f.value === 32);
    f.value = 212;
    check("iso: write back", c.value === 100);
  }
  {
    // combine: 3-input mean with delta-distribution
    const a = signal(0);
    const b = signal(10);
    const c = signal(20);
    const mean = combine<number>(
      [a, b, c],
      (vs) => (vs[0] + vs[1] + vs[2]) / 3,
      (next, prev) => {
        const d = next - (prev[0] + prev[1] + prev[2]) / 3;
        return [prev[0] + d, prev[1] + d, prev[2] + d];
      },
    );
    check("combine: read mean", mean.value === 10);
    mean.value = 100; // shift all by +90
    check(
      "combine: write distributes delta",
      a.value === 90 && b.value === 100 && c.value === 110,
    );
  }

  // ── Aggregates (built on combine) ──
  {
    const a = ptNew(0, 0);
    const b = ptNew(10, 0);
    const c = ptNew(20, 0);
    const m = meanVec(a, b, c);
    check("meanVec: read", m.value.x === 10 && m.value.y === 0);
    // Move the centroid — translate the group rigidly.
    m.value = { x: 50, y: 5 };
    check(
      "meanVec: write distributes delta",
      a.value.x === 40 && b.value.x === 50 && c.value.x === 60 && a.value.y === 5,
    );
    // Aggregate is a Reactive<Vec> — Vec ops compose.
    const offset = m.add(ptNew(1, 0));
    check("meanVec: result has Vec method surface", offset.value.x === 51);
  }
  {
    const a = signal(0);
    const b = signal(10);
    const m = meanNum(a, b);
    check("meanNum: read", m.value === 5);
    m.value = 100;
    check("meanNum: write distributes", a.value === 95 && b.value === 105);
  }

  console.log(`  ${passed} passed, ${failed} failed`);
  if (fails.length) {
    console.log("  failures:");
    for (const f of fails) console.log(`    ✗ ${f}`);
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Microbench
// ─────────────────────────────────────────────────────────────────────

const sink = { v: 0 };

function gc() {
  const g = (globalThis as unknown as { gc?: () => void }).gc;
  if (g) g();
}

function heapMB() {
  const m = (globalThis as unknown as {
    process?: { memoryUsage?: () => { heapUsed: number } };
  }).process?.memoryUsage?.();
  return m ? m.heapUsed / 1024 / 1024 : NaN;
}

function bench(label: string, runs: number, fn: () => void) {
  for (let i = 0; i < 3; i++) fn();
  gc();
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const min = samples[0];
  console.log(
    `  ${label.padEnd(48)}  median=${median.toFixed(2)}ms  min=${min.toFixed(2)}ms`,
  );
  return { median, min };
}

/** Heap-delta benchmark: GC, snapshot, allocate, hold, snapshot.
 *  Returns bytes per object as a rough estimate. */
function memBench(label: string, n: number, allocate: () => unknown[]) {
  if (!(globalThis as unknown as { gc?: () => void }).gc) {
    console.log(`  ${label.padEnd(48)}  (run with --expose-gc for memory)`);
    return;
  }
  gc();
  gc();
  const before = heapMB();
  const arr = allocate();
  const after = heapMB();
  const total = (after - before) * 1024; // KB
  const perObj = (total * 1024) / n; // bytes
  console.log(
    `  ${label.padEnd(48)}  +${total.toFixed(0)}KB total, ~${perObj.toFixed(0)}B/object`,
  );
  // Hold the array so it doesn't get collected mid-measure
  if (arr.length === -1) console.log(arr);
}

function microbench() {
  console.log("\n── Microbench ──────────────────────────────────────────");

  const N = 5000;
  const RUNS = 15;

  // ── A. Construction
  console.log(`\n  A. Construction (N=${N})`);
  bench("legacy new Point()                          ", RUNS, () => {
    const arr = new Array(N);
    for (let i = 0; i < N; i++) arr[i] = new Point({ x: i, y: i });
    sink.v += arr.length;
  });
  bench("new    Vec.signal()                         ", RUNS, () => {
    const arr = new Array(N);
    for (let i = 0; i < N; i++) arr[i] = Vec.signal({ x: i, y: i });
    sink.v += arr.length;
  });
  bench("baseline raw signal({x,y})                  ", RUNS, () => {
    const arr = new Array(N);
    for (let i = 0; i < N; i++) arr[i] = signal({ x: i, y: i });
    sink.v += arr.length;
  });

  // ── B. Construct + amortized axis reads
  console.log(`\n  B. Construct N=${N}, read .x/.y × 100 each`);
  bench("legacy Point + 100× .x/.y reads             ", RUNS, () => {
    for (let i = 0; i < N; i++) {
      const p = new Point({ x: i, y: i });
      for (let r = 0; r < 100; r++) sink.v += p.x.value + p.y.value;
    }
  });
  bench("new    Vec.signal + 100× .x/.y reads        ", RUNS, () => {
    for (let i = 0; i < N; i++) {
      const p = Vec.signal({ x: i, y: i });
      for (let r = 0; r < 100; r++) sink.v += p.x.value + p.y.value;
    }
  });

  // ── C. Derived chain construction
  console.log(`\n  C. Chain construction (N=${N}) — add.scale.perp`);
  bench("legacy DerivedPoint chain                   ", RUNS, () => {
    const arr = new Array(N);
    const b = new Point({ x: 1, y: 1 });
    for (let i = 0; i < N; i++) {
      arr[i] = new Point({ x: i, y: i }).add(b).scale(2).perp();
    }
    sink.v += arr.length;
  });
  bench("new    Reactive<Vec> chain                  ", RUNS, () => {
    const arr = new Array(N);
    const b = Vec.signal({ x: 1, y: 1 });
    for (let i = 0; i < N; i++) {
      arr[i] = Vec.signal({ x: i, y: i }).add(b).scale(2).perp();
    }
    sink.v += arr.length;
  });

  // ── D. Cold read throughput
  const READS = 500_000;
  console.log(`\n  D. Chain .value reads (1 chain × ${READS.toLocaleString()})`);
  {
    const a = new Point({ x: 1, y: 2 });
    const b = new Point({ x: 3, y: 4 });
    const chain = a.add(b).scale(2).perp();
    bench("legacy chain.value × 500_000                ", RUNS, () => {
      for (let i = 0; i < READS; i++) sink.v += chain.value.x;
    });
  }
  {
    const a = Vec.signal({ x: 1, y: 2 });
    const b = Vec.signal({ x: 3, y: 4 });
    const chain = a.add(b).scale(2).perp();
    bench("new    chain.value × 500_000                ", RUNS, () => {
      for (let i = 0; i < READS; i++) sink.v += chain.value.x;
    });
  }
  {
    // Baseline: hand-rolled raw computed equivalent
    const a = signal({ x: 1, y: 2 });
    const b = signal({ x: 3, y: 4 });
    const sum = computed(() => ({
      x: a.value.x + b.value.x,
      y: a.value.y + b.value.y,
    }));
    const scaled = computed(() => ({ x: sum.value.x * 2, y: sum.value.y * 2 }));
    const perp = computed(() => ({ x: -scaled.value.y, y: scaled.value.x }));
    bench("baseline raw computed chain × 500_000       ", RUNS, () => {
      for (let i = 0; i < READS; i++) sink.v += perp.value.x;
    });
  }

  // ── E. Write-propagate
  console.log(`\n  E. Write-propagate (N=${N} writes, 1 chain, 1 effect)`);
  {
    const a = new Point({ x: 0, y: 0 });
    const b = new Point({ x: 1, y: 1 });
    const chain = a.add(b).scale(2).perp();
    const stop = effect(() => {
      sink.v += chain.value.x;
    });
    bench("legacy: write a.value × N                   ", RUNS, () => {
      for (let i = 0; i < N; i++) a.value = { x: i, y: i };
    });
    stop();
  }
  {
    const a = Vec.signal({ x: 0, y: 0 });
    const b = Vec.signal({ x: 1, y: 1 });
    const chain = a.add(b).scale(2).perp();
    const stop = effect(() => {
      sink.v += chain.value.x;
    });
    bench("new:    write a.value × N                   ", RUNS, () => {
      for (let i = 0; i < N; i++) a.value = { x: i, y: i };
    });
    stop();
  }

  // ── F. Scalar op
  console.log(`\n  F. Scalar .length() construction + read (N=${N})`);
  bench("legacy a.length() build + read              ", RUNS, () => {
    for (let i = 0; i < N; i++) {
      sink.v += new Point({ x: 3, y: 4 }).length().value;
    }
  });
  bench("new    a.length() build + read              ", RUNS, () => {
    for (let i = 0; i < N; i++) {
      sink.v += Vec.signal({ x: 3, y: 4 }).length().value;
    }
  });

  // ── G. Animation-shape: 200 chains × 60 frames + effect
  const SHAPES = 200;
  const FRAMES = 60;
  console.log(`\n  G. Anim-shape: ${SHAPES} shapes × ${FRAMES} frames + effect`);
  bench("legacy: 200 chains × 60 source writes       ", RUNS, () => {
    const sources = new Array<Point>(SHAPES);
    const stops = new Array<() => void>(SHAPES);
    const b = new Point({ x: 1, y: 1 });
    for (let i = 0; i < SHAPES; i++) {
      const a = (sources[i] = new Point({ x: 0, y: 0 }));
      const chain = a.add(b).scale(2).perp();
      stops[i] = effect(() => {
        sink.v += chain.value.x;
      });
    }
    for (let f = 0; f < FRAMES; f++) {
      for (let i = 0; i < SHAPES; i++) sources[i].value = { x: f, y: f };
    }
    for (let i = 0; i < SHAPES; i++) stops[i]();
  });
  bench("new:    200 chains × 60 source writes       ", RUNS, () => {
    const sources = new Array<ReturnType<typeof Vec.signal>>(SHAPES);
    const stops = new Array<() => void>(SHAPES);
    const b = Vec.signal({ x: 1, y: 1 });
    for (let i = 0; i < SHAPES; i++) {
      const a = (sources[i] = Vec.signal({ x: 0, y: 0 }));
      const chain = a.add(b).scale(2).perp();
      stops[i] = effect(() => {
        sink.v += chain.value.x;
      });
    }
    for (let f = 0; f < FRAMES; f++) {
      for (let i = 0; i < SHAPES; i++) sources[i].value = { x: f, y: f };
    }
    for (let i = 0; i < SHAPES; i++) stops[i]();
  });

  // ── H. Axis tween (the actual `translate.x.to(target)` hot path).
  // Many writes to `.x.value` directly, with an effect at the
  // .value level. This stresses the axis-lens write path.
  const TWEEN_WRITES = 10_000;
  console.log(`\n  H. Axis tween: write .x.value × ${TWEEN_WRITES.toLocaleString()}`);
  {
    const p = new Point({ x: 0, y: 0 });
    const stop = effect(() => {
      sink.v += p.value.x;
    });
    bench("legacy: write p.x.value × N                 ", RUNS, () => {
      for (let i = 0; i < TWEEN_WRITES; i++) p.x.value = i;
    });
    stop();
  }
  {
    const p = Vec.signal({ x: 0, y: 0 });
    const stop = effect(() => {
      sink.v += p.value.x;
    });
    bench("new:    write p.x.value × N                 ", RUNS, () => {
      for (let i = 0; i < TWEEN_WRITES; i++) p.x.value = i;
    });
    stop();
  }

  // ── I. Many-effect fan-out: 1 source, N effects subscribed.
  // Tests notify-list traversal cost on a write.
  const NEFFECTS = 1000;
  const NWRITES = 1000;
  console.log(`\n  I. Fan-out: 1 source, ${NEFFECTS} effects, ${NWRITES} writes`);
  bench("legacy fan-out                              ", RUNS, () => {
    const a = new Point({ x: 0, y: 0 });
    const stops = new Array<() => void>(NEFFECTS);
    for (let i = 0; i < NEFFECTS; i++) {
      stops[i] = effect(() => {
        sink.v += a.value.x;
      });
    }
    for (let i = 0; i < NWRITES; i++) a.value = { x: i, y: i };
    for (let i = 0; i < NEFFECTS; i++) stops[i]();
  });
  bench("new    fan-out                              ", RUNS, () => {
    const a = Vec.signal({ x: 0, y: 0 });
    const stops = new Array<() => void>(NEFFECTS);
    for (let i = 0; i < NEFFECTS; i++) {
      stops[i] = effect(() => {
        sink.v += a.value.x;
      });
    }
    for (let i = 0; i < NWRITES; i++) a.value = { x: i, y: i };
    for (let i = 0; i < NEFFECTS; i++) stops[i]();
  });

  // ── H2. Same as H but on a 4-field AABB (.w writes — most common
  // in resize animations). Tests the {x,y,w,h} static-key path.
  console.log(`\n  H2. AABB resize: write .w.value × ${TWEEN_WRITES.toLocaleString()}`);
  {
    const b = AABB.signal({ x: 0, y: 0, w: 0, h: 0 });
    const stop = effect(() => {
      sink.v += b.value.w;
    });
    bench("new:    write box.w.value × N (4-field)     ", RUNS, () => {
      for (let i = 0; i < TWEEN_WRITES; i++) b.w.value = i;
    });
    stop();
  }

  // ── H3. Matrix2D field write × N (the {a,b,c,d,e,f} static-key path).
  console.log(`\n  H3. Matrix axis: write .e.value × ${TWEEN_WRITES.toLocaleString()}`);
  {
    const m = Matrix2D.signal({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    const stop = effect(() => {
      sink.v += m.value.e;
    });
    bench("new:    write m.e.value × N (6-field)       ", RUNS, () => {
      for (let i = 0; i < TWEEN_WRITES; i++) m.e.value = i;
    });
    stop();
  }

  // ── J. AABB chain: validates 4-field struct under chain ops.
  console.log(`\n  J. AABB chain: expand.union(...) × ${N} × N=${N}`);
  bench("new    AABB.expand.union construction       ", RUNS, () => {
    const arr = new Array(N);
    const ref = AABB.signal({ x: 0, y: 0, w: 10, h: 10 });
    for (let i = 0; i < N; i++) {
      const b = AABB.signal({ x: i, y: i, w: 5, h: 5 });
      arr[i] = b.expand(2).union(ref);
    }
    sink.v += arr.length;
  });

  // ── K. Memory: heap delta after construction
  console.log(`\n  K. Memory after construction (N=${N})`);
  memBench(
    "legacy Point",
    N,
    () => {
      const arr = new Array(N);
      for (let i = 0; i < N; i++) arr[i] = new Point({ x: i, y: i });
      return arr;
    },
  );
  memBench(
    "new    Vec.signal",
    N,
    () => {
      const arr = new Array(N);
      for (let i = 0; i < N; i++) arr[i] = Vec.signal({ x: i, y: i });
      return arr;
    },
  );
  memBench(
    "baseline raw signal({x,y})",
    N,
    () => {
      const arr = new Array(N);
      for (let i = 0; i < N; i++) arr[i] = signal({ x: i, y: i });
      return arr;
    },
  );
  console.log(`\n  K2. Memory after CHAIN construction (N=${N})`);
  memBench(
    "legacy chain (Point + 3 derived)",
    N,
    () => {
      const arr = new Array(N);
      const b = new Point({ x: 1, y: 1 });
      for (let i = 0; i < N; i++) {
        arr[i] = new Point({ x: i, y: i }).add(b).scale(2).perp();
      }
      return arr;
    },
  );
  memBench(
    "new    chain (Vec + 3 derived)",
    N,
    () => {
      const arr = new Array(N);
      const b = Vec.signal({ x: 1, y: 1 });
      for (let i = 0; i < N; i++) {
        arr[i] = Vec.signal({ x: i, y: i }).add(b).scale(2).perp();
      }
      return arr;
    },
  );

  // Sanity check
  const v1 = new Point({ x: 3, y: 4 })
    .add(new Point({ x: 1, y: 1 }))
    .scale(2)
    .perp().value;
  const v2 = Vec.signal({ x: 3, y: 4 })
    .add(Vec.signal({ x: 1, y: 1 }))
    .scale(2)
    .perp().value;
  console.log(
    `\n  Sanity: legacy=${JSON.stringify(v1)} new=${JSON.stringify(v2)} match=${
      v1.x === v2.x && v1.y === v2.y
    }`,
  );
  console.log(`  (sink absorbed ${sink.v.toExponential(2)})`);
}

// ─────────────────────────────────────────────────────────────────────
//  Type-level checks (compile-time)
// ─────────────────────────────────────────────────────────────────────

function _typeChecks() {
  const a = ptNew(1, 2);
  const b = ptNew(3, 4);
  a.value = { x: 5, y: 6 };
  a.x.value = 9;
  const chain = a.add(b).scale(2).perp();
  const _v: V = chain.value;
  const len = a.length();
  const _len: number = len.value;
  const k = signal(2);
  const scaled = a.scale(k);
  const _sv: V = scaled.value;

  const box = AABB.signal({ x: 0, y: 0, w: 10, h: 10 });
  box.w.value = 20;
  const bigger = box.expand(5);
  const _bv = bigger.value;
  const _area: number = box.area().value;
  const _hit: boolean = box.contains(ptNew(1, 1)).value;

  void [_v, _len, _sv, _bv, _area, _hit, scaled];
}
void _typeChecks;

// ─────────────────────────────────────────────────────────────────────
//  Entry
// ─────────────────────────────────────────────────────────────────────

correctness();
microbench();
console.log();
