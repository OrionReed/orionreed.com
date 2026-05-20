// test.ts — engine + value-type edge-case suite for r2.
//
// Hand-rolled tests for things RFTS doesn't cover well: lens cascading,
// equality dispatch, field-cache identity, instanceof-after-derive,
// peek correctness post-write, batch+effect interactions, cycle detection,
// disposal semantics, NaN, bind teardown, etc.
//
// Run:
//   npx vitest run src/minim/_proto-r2/test.ts

import { describe, it, expect } from "vitest";
import {
  Reactive, signal, computed, lens, effect, batch, untracked,
  isSignal, isLens, isComputed,
  value,
} from "./reactive";
import { EQUALS } from "./traits";
import { field as _field } from "./field";
import { Num, num } from "./values/num";
import { Vec, vec, polar } from "./values/vec";
import { Box, box } from "./values/box";

// ─── Engine basics ──────────────────────────────────────────────────

describe("engine: signal", () => {
  it("read/write through .value", () => {
    const s = signal(1);
    expect(s.value).toBe(1);
    s.value = 2;
    expect(s.value).toBe(2);
  });

  it("notifies effects", () => {
    const s = signal(1);
    let seen = 0;
    effect(() => { seen = s.value; });
    expect(seen).toBe(1);
    s.value = 5;
    expect(seen).toBe(5);
  });

  it("equality dedup (===)", () => {
    const s = signal(1);
    let runs = 0;
    effect(() => { void s.value; runs++; });
    expect(runs).toBe(1);
    s.value = 1;
    expect(runs).toBe(1);
  });

  it("custom equals via opts.equals", () => {
    const s = signal({ a: 1 }, { equals: (x, y) => x.a === y.a });
    let runs = 0;
    effect(() => { void s.value; runs++; });
    s.value = { a: 1 };
    expect(runs).toBe(1);
    s.value = { a: 2 };
    expect(runs).toBe(2);
  });
});

describe("engine: computed", () => {
  it("reads & memoizes", () => {
    const s = signal(2);
    let evals = 0;
    const c = computed(() => { evals++; return s.value * 3; });
    expect(c.value).toBe(6);
    expect(c.value).toBe(6);
    expect(evals).toBe(1);
    s.value = 4;
    expect(c.value).toBe(12);
    expect(evals).toBe(2);
  });

  it("write throws", () => {
    const c = computed(() => 1);
    expect(() => { (c as Reactive<number>).value = 9; }).toThrow(/Cannot write to a Computed/);
  });

  it("cycle detection", () => {
    const c: Reactive<number> = computed(() => c.value + 1);
    expect(() => c.value).toThrow(/[Cc]ycl/);
  });

  it("computed(Cls, fn) returns Cls instance", () => {
    const a = num(3);
    const sum = computed(Num, () => a.value * 2);
    expect(sum).toBeInstanceOf(Num);
    expect(sum).toBeInstanceOf(Reactive);
    expect(sum.value).toBe(6);
  });
});

describe("engine: lens", () => {
  it("forwards reads & writes", () => {
    const s = signal(10);
    const half = lens(() => s.value / 2, (v) => { s.value = v * 2; });
    expect(half.value).toBe(5);
    half.value = 7;
    expect(s.value).toBe(14);
    expect(half.value).toBe(7);
  });

  it("typed lens preserves class", () => {
    const a = num(5);
    const doubled = lens(Num, () => a.value * 2, (v) => { a.value = v / 2; });
    expect(doubled).toBeInstanceOf(Num);
    expect(doubled.value).toBe(10);
    doubled.value = 30;
    expect(a.value).toBe(15);
  });

  it("isLens / isComputed / isSignal predicates", () => {
    const s = signal(1);
    const c = computed(() => s.value);
    const l = lens(() => s.value, (v) => { s.value = v; });
    expect(isSignal(s) && !isComputed(s) && !isLens(s)).toBe(true);
    expect(isSignal(c) && isComputed(c) && !isLens(c)).toBe(true);
    expect(isSignal(l) && !isComputed(l) && isLens(l)).toBe(true);
  });
});

describe("engine: effect", () => {
  it("cleanup runs", () => {
    const s = signal(1);
    const cleans: number[] = [];
    const stop = effect(() => {
      const v = s.value;
      return () => cleans.push(v);
    });
    s.value = 2;
    s.value = 3;
    stop();
    expect(cleans).toEqual([1, 2, 3]);
  });

  it("untracked", () => {
    const a = signal(1); const b = signal(10);
    let runs = 0; let sum = 0;
    effect(() => {
      runs++;
      sum = a.value + untracked(() => b.value);
    });
    expect(runs).toBe(1); expect(sum).toBe(11);
    b.value = 20;
    expect(runs).toBe(1);
    a.value = 2;
    expect(runs).toBe(2); expect(sum).toBe(22);
  });

  it("batch coalesces", () => {
    const a = signal(1); const b = signal(2);
    let runs = 0; let last = 0;
    effect(() => { runs++; last = a.value + b.value; });
    expect(runs).toBe(1);
    batch(() => { a.value = 10; b.value = 20; });
    expect(runs).toBe(2);
    expect(last).toBe(30);
  });
});

describe("engine: peek", () => {
  it("untracked read", () => {
    const a = signal(1); const b = signal(2);
    let runs = 0;
    effect(() => { runs++; void a.value; void b.peek(); });
    expect(runs).toBe(1);
    b.value = 99;
    expect(runs).toBe(1);
    a.value = 2;
    expect(runs).toBe(2);
  });

  // Specifically guards the pre-existing bug: peek() after a write must
  // propagate to subscribers, else they stay stranded.
  it("propagates Dirty-clear to subscribers", () => {
    const a = signal(1);
    const c = computed(() => a.value + 1);
    let seen = 0;
    effect(() => { seen = c.value; });
    expect(seen).toBe(2);
    a.value = 10;
    expect(a.peek()).toBe(10);
    expect(seen).toBe(11);
  });
});

// ─── Footguns ──────────────────────────────────────────────────────

describe("footguns", () => {
  it("toPrimitive throws", () => {
    const s = signal(5);
    expect(() => `${s}` as unknown as string).toThrow(/coerced/);
    expect(() => (s as unknown as number) + 1).toThrow(/coerced/);
  });

  it("re-entry during set is safe (re-entrancy guard on flush)", () => {
    // Cascading bind-effects: a chain of N lensed signals, each effect
    // writes through to the next. Without the flush guard, a deep cascade
    // overflows the stack at N≈1000.
    const N = 2000;
    const sigs = Array.from({ length: N }, (_, i) => signal(i));
    const stops: Array<() => void> = [];
    for (let i = 0; i < N - 1; i++) {
      const src = sigs[i]; const dst = sigs[i + 1];
      stops.push(effect(() => { dst.value = src.value + 1; }));
    }
    sigs[0].value = 100;
    expect(sigs[N - 1].value).toBe(100 + N - 1);
    stops.forEach((s) => s());
  });
});

// ─── Value: Num ────────────────────────────────────────────────────

describe("value: Num", () => {
  it("instanceof Num & Reactive", () => {
    const n = num(3);
    expect(n).toBeInstanceOf(Num);
    expect(n).toBeInstanceOf(Reactive);
  });

  it("eager methods produce Num computeds", () => {
    const a = num(2); const b = num(5);
    const sum = a.add(b);
    expect(sum).toBeInstanceOf(Num);
    expect(sum.value).toBe(7);
    b.value = 10;
    expect(sum.value).toBe(12);
  });

  it("chain form (one signal, identical outcome)", () => {
    const a = num(2); const b = num(5); const k = num(3);
    const eager = a.add(b).scale(k);
    const chain = a.derive((c) => c.add(b).scale(k));
    expect(chain).toBeInstanceOf(Num);
    expect(chain.value).toBe(eager.value);
    b.value = 8;
    expect(chain.value).toBe(eager.value);
    k.value = 0.5;
    expect(chain.value).toBe(eager.value);
  });

  it("traits resolved on computed Num", () => {
    const a = num(2);
    const dbl = a.scale(2);
    expect(typeof (dbl as unknown as Record<symbol, unknown>)[Symbol.for("does-not-exist")]).toBe("undefined");
    expect(typeof dbl[EQUALS]).toBe("function");
  });
});

// ─── Value: Vec ────────────────────────────────────────────────────

describe("value: Vec", () => {
  it("instanceof Vec", () => {
    const v = vec(1, 2);
    expect(v).toBeInstanceOf(Vec);
  });

  it("computed Vec is instanceof Vec", () => {
    const a = vec(1, 2); const b = vec(3, 4);
    const sum = a.add(b);
    expect(sum).toBeInstanceOf(Vec);
    expect(sum.value).toEqual({ x: 4, y: 6 });
  });

  it("field lens read/write", () => {
    const v = vec(1, 2);
    expect(v.x.value).toBe(1);
    expect(v.y.value).toBe(2);
    v.x.value = 10;
    expect(v.value).toEqual({ x: 10, y: 2 });
  });

  it("field cache identity (.x === .x)", () => {
    const v = vec(0, 0);
    expect(v.x).toBe(v.x);
    expect(v.y).toBe(v.y);
  });

  it("eager == chain equivalence", () => {
    const a = vec(1, 2); const b = vec(0.5, 0.5);
    const eager = a.add(b).scale(2).offset(1, 1);
    const chain = a.derive((c) => c.add(b).scale(2).offset(1, 1));
    expect(chain).toBeInstanceOf(Vec);
    expect(chain.value).toEqual(eager.value);
  });

  it("polar: bidirectional reactive args", () => {
    const c = vec(10, 10);
    const r = num(5);
    const p = polar(c, r, () => Math.PI / 2);
    expect(p.value.x).toBeCloseTo(10);
    expect(p.value.y).toBeCloseTo(15);
    r.value = 2;
    expect(p.value.y).toBeCloseTo(12);
  });

  it("equality: structural via [EQUALS]", () => {
    const v = vec(1, 2);
    let runs = 0;
    effect(() => { void v.value; runs++; });
    expect(runs).toBe(1);
    v.value = { x: 1, y: 2 };
    expect(runs).toBe(1);
    v.value = { x: 1, y: 3 };
    expect(runs).toBe(2);
  });
});

// ─── Value: Box ────────────────────────────────────────────────────

describe("value: Box", () => {
  it("instanceof Box", () => {
    const b = box(0, 0, 10, 10);
    expect(b).toBeInstanceOf(Box);
  });

  it("cardinal lazy memoization", () => {
    const b = box(0, 0, 10, 10);
    expect(b.center).toBe(b.center);
    expect(b.center.value).toEqual({ x: 5, y: 5 });
  });

  it("field lens drives nested computed", () => {
    const b = box(0, 0, 10, 10);
    const area = b.area;
    expect(area.value).toBe(100);
    b.w.value = 20;
    expect(area.value).toBe(200);
  });

  it("eager == chain", () => {
    const b = box(0, 0, 10, 10);
    const eager = b.expand(2).scale(0.5);
    const chain = b.derive((c) => c.expand(2).scale(0.5));
    expect(chain.value).toEqual(eager.value);
  });
});

// ─── Cascade: chains of typed signals ──────────────────────────────

describe("cascade: typed lens chains", () => {
  it("long chain through field lenses works under cascade", () => {
    const v0 = vec(0, 0);
    const N = 50;
    const vs: Vec[] = [v0];
    const stops: Array<() => void> = [];
    for (let i = 0; i < N; i++) {
      const prev = vs[i];
      const next = vec(0, 0);
      stops.push(effect(() => { next.x.value = prev.x.value + 1; }));
      stops.push(effect(() => { next.y.value = prev.y.value + 1; }));
      vs.push(next);
    }
    v0.value = { x: 100, y: 100 };
    expect(vs[N].x.value).toBe(100 + N);
    expect(vs[N].y.value).toBe(100 + N);
    stops.forEach((s) => s());
  });

  it("eager chain still works after deep recomputation", () => {
    const a = vec(0, 0);
    let r = a as Vec;
    for (let i = 0; i < 20; i++) r = r.add(vec(1, 1));
    expect(r.value).toEqual({ x: 20, y: 20 });
    a.value = { x: 10, y: 10 };
    expect(r.value).toEqual({ x: 30, y: 30 });
  });
});

// ─── value() helper ────────────────────────────────────────────────

describe("value()", () => {
  it("unwraps Reactive, function, or plain", () => {
    expect(value(5)).toBe(5);
    expect(value(() => 7)).toBe(7);
    expect(value(signal(9))).toBe(9);
  });
});

// ─── bind() teardown ───────────────────────────────────────────────

describe("bind()", () => {
  it("second .bind() disposes the first", () => {
    const a = num(1); const b = num(10); const target = num(0);
    target.bind(a);
    expect(target.value).toBe(1);
    target.bind(b);
    expect(target.value).toBe(10);
    a.value = 999;
    expect(target.value).toBe(10);
  });

  it(".set(x) disposes binding", () => {
    const a = num(1); const target = num(0);
    target.bind(a);
    expect(target.value).toBe(1);
    target.set(50);
    a.value = 999;
    expect(target.value).toBe(50);
  });

  it("returned disposer stops propagation", () => {
    const a = num(1); const target = num(0);
    const stop = target.bind(a);
    a.value = 5; expect(target.value).toBe(5);
    stop();
    a.value = 99; expect(target.value).toBe(5);
  });

  it("plain T binding is a no-op disposer", () => {
    const t = num(0);
    const stop = t.bind(7);
    expect(t.value).toBe(7);
    stop(); // should not throw
    expect(t.value).toBe(7);
  });
});

// ─── Diamond dependencies ─────────────────────────────────────────

describe("diamond dependency", () => {
  it("single update for both forks", () => {
    const root = signal(1);
    const a = computed(() => root.value * 2);
    const b = computed(() => root.value + 10);
    let runs = 0; let sum = 0;
    effect(() => { runs++; sum = a.value + b.value; });
    expect(runs).toBe(1); expect(sum).toBe(13);
    root.value = 2;
    expect(runs).toBe(2); expect(sum).toBe(16);
  });

  it("doesn't recompute downstream when intermediate stays equal", () => {
    const a = signal(1);
    let bRuns = 0;
    const b = computed(() => { bRuns++; return a.value > 0; });
    let cRuns = 0;
    effect(() => { cRuns++; void b.value; });
    expect(bRuns).toBe(1); expect(cRuns).toBe(1);
    a.value = 2; // still > 0
    expect(bRuns).toBe(2);
    expect(cRuns).toBe(1); // dedup at b
  });
});

// ─── Lens-over-lens ────────────────────────────────────────────────

describe("lens over lens", () => {
  it("chained lens propagates both ways", () => {
    const s = signal(10);
    const half = lens(() => s.value / 2, (v) => { s.value = v * 2; });
    const quarter = lens(() => half.value / 2, (v) => { half.value = v * 2; });
    expect(quarter.value).toBe(2.5);
    quarter.value = 5;
    expect(half.value).toBe(10);
    expect(s.value).toBe(20);
    s.value = 80;
    expect(quarter.value).toBe(20);
  });

  it("field-lens-of-field-lens", () => {
    const v = vec(0, 0);
    // a derived lens that scales x by 10 on read, divides on write
    const x10 = lens(Num, () => v.x.value * 10, (n) => { v.x.value = n / 10; });
    expect(x10.value).toBe(0);
    x10.value = 100;
    expect(v.x.value).toBe(10);
    expect(v.value.x).toBe(10);
  });
});

// ─── Effect cleanup ordering ───────────────────────────────────────

describe("effect cleanup ordering", () => {
  it("cleanup runs before re-run", () => {
    const a = signal(1);
    const log: string[] = [];
    effect(() => {
      const v = a.value;
      log.push(`run-${v}`);
      return () => log.push(`clean-${v}`);
    });
    a.value = 2;
    a.value = 3;
    expect(log).toEqual(["run-1", "clean-1", "run-2", "clean-2", "run-3"]);
  });

  it("cleanup runs on dispose", () => {
    const a = signal(1);
    const log: string[] = [];
    const stop = effect(() => {
      void a.value;
      return () => log.push("clean");
    });
    stop();
    expect(log).toEqual(["clean"]);
    a.value = 2;
    expect(log).toEqual(["clean"]); // no re-run after dispose
  });
});

// ─── Computed with no deps ─────────────────────────────────────────

describe("computed: constant getter", () => {
  it("caches the constant", () => {
    let evals = 0;
    const c = computed(() => { evals++; return 42; });
    expect(c.value).toBe(42);
    expect(c.value).toBe(42);
    expect(evals).toBe(1);
  });
});

// ─── isLens runtime predicate stability ────────────────────────────

describe("isLens semantics", () => {
  it("typed lens reports as lens", () => {
    const a = num(5);
    const l = lens(Num, () => a.value * 2, (v) => { a.value = v / 2; });
    expect(isLens(l)).toBe(true);
    expect(isComputed(l)).toBe(false);
  });

  it("computed reports as not-lens", () => {
    const a = num(5);
    const c = computed(Num, () => a.value * 2);
    expect(isLens(c)).toBe(false);
    expect(isComputed(c)).toBe(true);
  });

  it("plain signal reports as neither", () => {
    const s = num(5);
    expect(isLens(s)).toBe(false);
    expect(isComputed(s)).toBe(false);
    expect(isSignal(s)).toBe(true);
  });
});
