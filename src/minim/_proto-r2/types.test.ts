// types.test.ts — TS-only inference checks. No runtime assertions matter;
// what we test is whether the overloads and value-class types compose
// without manual annotation. Compilation success = pass.
//
// Run:
//   npx vitest run src/minim/_proto-r2/types.test.ts

import { describe, it, expect } from "vitest";
import {
  Reactive, signal, computed, lens, effect, batch, untracked,
  type Val, type Read, type Computed, type Lens, type ValueOf,
} from "./reactive";
import {
  requireLinear, requireMetric,
  type HasLinear, type HasMetric,
} from "./traits";
import { Num, num } from "./values/num";
import { Vec, vec, polar, type VecValue } from "./values/vec";
import { Box, box, type BoxValue } from "./values/box";

// Assert utility: `Expect<Eq<A, B>>` fails to compile if A ≠ B.
type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

describe("types", () => {
  it("signal", () => {
    const s = signal(1);
    type _s = Expect<Eq<typeof s, Reactive<number>>>;
    const _v: number = s.value;
    expect(_v).toBe(1);
  });

  it("computed overloads narrow correctly", () => {
    // untyped: Reactive<T>
    const c1 = computed(() => 1 + 2);
    type _c1 = Expect<Eq<typeof c1, Reactive<number>>>;

    // typed: returns Cls instance
    const c2 = computed(() => 5, Num);
    type _c2 = Expect<Eq<typeof c2, Num>>;
    // ← here `c2.add(...)` should resolve to Num's method, returning Num
    const c3 = c2.add(1);
    type _c3 = Expect<Eq<typeof c3, Num>>;

    const c4 = computed(() => ({ x: 0, y: 0 }) as { x: number; y: number }, Vec);
    type _c4 = Expect<Eq<typeof c4, Vec>>;
    const c5 = c4.x;
    type _c5 = Expect<Eq<typeof c5, Num>>;

    expect(c1.value).toBe(3);
    expect(c2.value).toBe(5);
  });

  it("lens overloads narrow correctly", () => {
    const s = signal(10);
    // untyped
    const l1 = lens(() => s.value, (v) => { s.value = v; });
    type _l1 = Expect<Eq<typeof l1, Reactive<number>>>;
    // typed
    const a = num(5);
    const l2 = lens(() => a.value, (v: number) => { a.value = v; }, Num);
    type _l2 = Expect<Eq<typeof l2, Num>>;
    const l3 = l2.add(1);
    type _l3 = Expect<Eq<typeof l3, Num>>;
    expect(l3.value).toBe(6);
  });

  it("Val<T> accepts plain, fn, Reactive uniformly", () => {
    const a = num(2);
    const _e1 = a.add(1);
    const _e2 = a.add(() => 1);
    const _e3 = a.add(num(1));
    expect(_e1.value).toBe(3); expect(_e2.value).toBe(3); expect(_e3.value).toBe(3);
  });

  it("Vec field lens is typed Num (Read interface)", () => {
    const v = vec(1, 2);
    // Use Read<number> as parameter site
    const consume = (_: Read<number>): number => _.value;
    expect(consume(v.x)).toBe(1);
  });

  it("polar accepts mixed reactive args", () => {
    const c = vec(1, 1);
    const p = num(5);
    const v: Vec = polar(c, p, () => 0);
    expect(v).toBeInstanceOf(Vec);
  });

  it("Computed<T> / Lens<T> type aliases", () => {
    const _c: Computed<number> = computed(() => 1);
    const _l: Lens<number> = lens(() => 0, () => {});
    expect(_c.value).toBe(1);
  });

  it("box field lenses typed", () => {
    const b = box(0, 0, 10, 10);
    type _bx = Expect<Eq<typeof b, Box>>;
    type _bxx = Expect<Eq<typeof b.x, Num>>;
    type _bxc = Expect<Eq<typeof b.center, Vec>>;
    expect(b.center.value).toEqual({ x: 5, y: 5 });
  });

  it("effect/batch/untracked typing", () => {
    const s = signal(1);
    const stop: () => void = effect(() => { void s.value; });
    const r: number = batch(() => 2);
    const u: string = untracked(() => "x");
    stop();
    expect(r).toBe(2); expect(u).toBe("x");
  });

  it("ValueOf<R> extracts inner type", () => {
    type _vov = Expect<Eq<ValueOf<Vec>, VecValue>>;
    type _bov = Expect<Eq<ValueOf<Box>, BoxValue>>;
    type _nov = Expect<Eq<ValueOf<Num>, number>>;
    type _ron = Expect<Eq<ValueOf<Reactive<string>>, string>>;
    expect(true).toBe(true);
  });

  it("HasLinear / HasMetric constrain at call site", () => {
    // The constraint type means TS rejects a signal whose class lacks
    // the trait. We exercise the positive cases at runtime; negatives
    // are compile-time-only (see `_typeOnlyConstraintProbe` below).
    function mustHaveLinearMetric<R extends Read<unknown> & HasLinear<ValueOf<R>> & HasMetric<ValueOf<R>>>(s: R): R {
      requireLinear(s);
      requireMetric(s);
      return s;
    }
    // Vec & Num both have linear+metric → accepted, runtime OK
    expect(mustHaveLinearMetric(vec(0, 0))).toBeInstanceOf(Vec);
    expect(mustHaveLinearMetric(num(0))).toBeInstanceOf(Num);
  });
});

// Type-only probes: these blocks NEVER run; they exist purely so the
// TS compiler complains if the constraints regress. The function
// `_typeOnlyConstraintProbe` is referenced by `void 0` so the bundler
// doesn't tree-shake the body away (which would defeat the check).
function _typeOnlyConstraintProbe(): void {
  if (Math.random() < -1) {
    function needsLinearMetric<R extends Read<unknown> & HasLinear<ValueOf<R>> & HasMetric<ValueOf<R>>>(_s: R): void {}
    function needsMetric<R extends Read<unknown> & HasMetric<ValueOf<R>>>(_s: R): void {}

    // ✓ Accepted
    needsLinearMetric(vec(0, 0));
    needsLinearMetric(num(0));

    // ✗ Plain signal has no traits dict on its class
    // @ts-expect-error
    needsLinearMetric(signal(0));

    // ✗ Box has linear+lerp+equals but no metric
    // @ts-expect-error
    needsMetric(box(0, 0, 10, 10));
  }
}
void _typeOnlyConstraintProbe;
