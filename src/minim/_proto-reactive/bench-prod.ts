// Production-style bench for merged Reactive. Mirrors
// `src/minim/_bench/signals.bench.ts` workloads so we can compare
// apples to apples with the current engine.
//
// Same scenarios as production:
//   - construction (signal, vec, num, new Vec(), new Num())
//   - untracked reads (signal.peek, vec.peek, vec.x.peek, num.peek)
//   - tracked read (computed.value cached)
//   - writes (signal.value=, vec.value=, vec.x.value=)
//   - write with 1 effect
//   - batch × 10
//   - 10-deep computed chain
//
// Run:
//   node --expose-gc node_modules/.bin/vite-node \
//     src/minim/_proto-reactive/bench-prod.ts

import { bench, group, do_not_optimize, run } from "mitata";
import {
  Reactive,
  signal, computed, effect, batch, derived,
} from "./reactive";
import { LINEAR, LERP, METRIC, EQUALS, type Linear } from "../signals/traits";

// ─── Test value classes (Vec/Num extending merged Reactive) ──────────

const nLinear: Linear<number> = {
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  scale: (a, k) => a * k,
};

class Num extends Reactive<number> {
  constructor(v: number = 0) { super(v); }
  get [LINEAR]() { return nLinear; }
  [LERP](a: number, b: number, t: number) { return a + (b - a) * t; }
  [METRIC](a: number, b: number) { return Math.abs(a - b); }
  [EQUALS](a: number, b: number) { return a === b; }
}

const vAdd = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  ({ x: a.x + b.x, y: a.y + b.y });
const vSub = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  ({ x: a.x - b.x, y: a.y - b.y });
const vScale = (a: { x: number; y: number }, k: number) =>
  ({ x: a.x * k, y: a.y * k });
const vLinear: Linear<{ x: number; y: number }> = { add: vAdd, sub: vSub, scale: vScale };

// Simple WeakMap-based field cache (the orthogonal cleanup from the plan)
const FIELD_CACHE = new WeakMap<Reactive<unknown>, Map<PropertyKey, unknown>>();

function field<P, K extends keyof P, C extends new () => Reactive<P[K]>>(
  parent: Reactive<P>, key: K, Cls: C,
): InstanceType<C> {
  let cache = FIELD_CACHE.get(parent as Reactive<unknown>);
  if (!cache) FIELD_CACHE.set(parent as Reactive<unknown>, cache = new Map());
  const cached = cache.get(key);
  if (cached) return cached as InstanceType<C>;
  const fl = derived(
    Cls,
    () => (parent.value as P)[key],
    (v: P[K]) => { parent.value = { ...(parent.peek() as object), [key]: v } as P; },
  );
  cache.set(key, fl);
  return fl as InstanceType<C>;
}

class Vec extends Reactive<{ x: number; y: number }> {
  constructor(v: { x: number; y: number } = { x: 0, y: 0 }) { super(v); }
  get [LINEAR]() { return vLinear; }
  [LERP](a: { x: number; y: number }, b: { x: number; y: number }, t: number) {
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }
  [METRIC](a: { x: number; y: number }, b: { x: number; y: number }) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
  [EQUALS](a: { x: number; y: number }, b: { x: number; y: number }) {
    return a === b || (a.x === b.x && a.y === b.y);
  }
  get x(): Num { return field(this, "x", Num); }
  get y(): Num { return field(this, "y", Num); }
}

const vec = (x: number = 0, y: number = 0): Vec => {
  const v = new Vec();
  v.x.bind(x);
  v.y.bind(y);
  return v;
};

const num = (v: number = 0): Num => {
  const n = new Num();
  n.bind(v);
  return n;
};

// ── Construction ────────────────────────────────────────────────────

group("construction (cost per signal) — MERGED", () => {
  bench("signal(0)", () => do_not_optimize(signal(0))).baseline(true);
  bench("vec(0, 0)", () => do_not_optimize(vec(0, 0)));
  bench("num(0)", () => do_not_optimize(num(0)));
  bench("new Vec()", () => do_not_optimize(new Vec()));
  bench("new Num()", () => do_not_optimize(new Num()));
});

// ── Reads ───────────────────────────────────────────────────────────

group("untracked reads — MERGED", () => {
  const s = signal(0);
  const v = vec(1, 2);
  const n = num(0);
  bench("signal.peek()", () => do_not_optimize(s.peek())).baseline(true);
  bench("vec.peek()", () => do_not_optimize(v.peek()));
  bench("vec.x.peek()", () => do_not_optimize(v.x.peek()));
  bench("num.peek()", () => do_not_optimize(n.peek()));
});

group("tracked reads (cached) — MERGED", () => {
  const s = signal(0);
  const c = computed(() => s.value * 2);
  void c.value;
  bench("computed.value (cached)", () => do_not_optimize(c.value)).baseline(true);
});

// ── Writes ──────────────────────────────────────────────────────────

group("writes (no subscribers) — MERGED", () => {
  const s = signal(0);
  const v = vec(0, 0);
  let i = 0;
  bench("signal.value = i", () => { s.value = ++i; }).baseline(true);
  bench("vec.value = {x,y}", () => { v.value = { x: ++i, y: i }; });
  bench("vec.x.value = i", () => { v.x.value = ++i; });
});

group("writes (with 1 effect subscriber) — MERGED", () => {
  const s = signal(0);
  effect(() => { do_not_optimize(s.value); });
  let i = 0;
  bench("signal.value = i (1 effect)", () => { s.value = ++i; });
});

group("writes inside batch (10 writes/batch, 1 effect) — MERGED", () => {
  const s = signal(0);
  effect(() => { do_not_optimize(s.value); });
  let i = 0;
  bench("batch × 10 writes", () => {
    batch(() => { for (let k = 0; k < 10; k++) s.value = ++i; });
  });
});

// ── Computed chains ─────────────────────────────────────────────────

group("computed chain (10-deep) — MERGED", () => {
  const root = signal(0);
  let chain: { value: number } = root;
  for (let i = 0; i < 10; i++) {
    const prev = chain;
    chain = computed(() => prev.value + 1);
  }
  do_not_optimize(chain.value);
  let i = 0;
  bench("write root, read tail (10-deep)", () => {
    root.value = ++i;
    do_not_optimize(chain.value);
  });
});

await run({ format: "mitata" });
