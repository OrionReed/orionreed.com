// Functional tests: instanceof preservation, traits, derived, lens,
// equality short-circuit, etc.
//
// Run: npx vite-node src/minim/_proto-combo-b/test.ts

import {
  Reactive, signal, computed, lens, effect, batch, derived, isSignal,
} from "./reactive";
import { LINEAR, LERP, METRIC, EQUALS, type Linear } from "../signals/traits";

let passed = 0, failed = 0;
function suite(n: string, f: () => void) { console.log(`\n— ${n}`); f(); }
function it(n: string, f: () => void) {
  try { f(); passed++; console.log(`  ✓ ${n}`); }
  catch (e) { failed++; console.log(`  ✗ ${n}\n     ${(e as Error).message}`); }
}
function eq<T>(a: T, b: T) {
  if (typeof a === "object" && a !== null) {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
    return;
  }
  if (a !== b) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function throws(fn: () => void) {
  let did = false;
  try { fn(); } catch { did = true; }
  if (!did) throw new Error("expected throw");
}

// Vec class — extends Reactive, no viewClassFor needed
const vAdd = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  ({ x: a.x + b.x, y: a.y + b.y });
const vSub = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  ({ x: a.x - b.x, y: a.y - b.y });
const vScale = (a: { x: number; y: number }, k: number) =>
  ({ x: a.x * k, y: a.y * k });
const vLinear: Linear<{ x: number; y: number }> = { add: vAdd, sub: vSub, scale: vScale };

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
  add(b: { x: number; y: number }): Vec {
    return derived(Vec, () => vAdd(this.value, b));
  }
  perp(): Vec {
    return derived(Vec, () => ({ x: this.value.y, y: -this.value.x }));
  }
}

suite("Basic signal/computed/lens", () => {
  it("signal read/write", () => {
    const s = signal(5);
    eq(s.value, 5);
    s.value = 10;
    eq(s.value, 10);
  });

  it("computed derives", () => {
    const s = signal(5);
    const c = computed(() => s.value * 2);
    eq(c.value, 10);
    s.value = 7;
    eq(c.value, 14);
  });

  it("computed throws on write", () => {
    const c = computed(() => 5);
    throws(() => { c.value = 10; });
  });

  it("lens read/write", () => {
    const s = signal(5);
    const l = lens(() => s.value + 3, (v) => { s.value = v - 3; });
    eq(l.value, 8);
    l.value = 100;
    eq(s.value, 97);
  });

  it("effect re-fires on signal change", () => {
    const s = signal(0);
    let count = 0;
    const d = effect(() => { void s.value; count++; });
    eq(count, 1);
    s.value = 1;
    eq(count, 2);
    d();
  });

  it("batch defers effects", () => {
    const s = signal(0);
    let count = 0;
    const d = effect(() => { void s.value; count++; });
    eq(count, 1);
    batch(() => {
      s.value = 1;
      s.value = 2;
      s.value = 3;
    });
    eq(count, 2);
    d();
  });
});

suite("Equality short-circuit ([EQUALS] trait)", () => {
  it("Vec structurally-equal writes don't fire effects", () => {
    const v = new Vec({ x: 1, y: 2 });
    let count = 0;
    const d = effect(() => { void v.value; count++; });
    eq(count, 1);
    v.value = { x: 1, y: 2 }; // structurally equal, different object
    eq(count, 1); // SHOULD NOT FIRE — [EQUALS] short-circuits
    v.value = { x: 1, y: 3 };
    eq(count, 2);
    d();
  });

  it("plain signal (no EQUALS) only does !== check", () => {
    const s = signal({ x: 1, y: 2 });
    let count = 0;
    const d = effect(() => { void s.value; count++; });
    eq(count, 1);
    s.value = { x: 1, y: 2 }; // different object, no EQUALS trait
    eq(count, 2); // fires (alien default !==)
    d();
  });
});

suite("derived(Cls, fn) — no viewClassFor", () => {
  it("derived Vec is instanceof Vec (native chain)", () => {
    const v = new Vec({ x: 1, y: 2 });
    const d = derived(Vec, () => vAdd(v.value, { x: 10, y: 20 }));
    if (!(d instanceof Vec)) throw new Error("derived not instanceof Vec");
    if (!(d instanceof Reactive)) throw new Error("derived not instanceof Reactive");
  });

  it("derived Vec has trait slots", () => {
    const v = new Vec({ x: 1, y: 2 });
    const d = derived(Vec, () => vAdd(v.value, { x: 10, y: 20 }));
    const dt = d as Vec & { [k: symbol]: unknown };
    if (!dt[LINEAR]) throw new Error("no LINEAR");
    if (!dt[LERP]) throw new Error("no LERP");
  });

  it("methods chain through derived", () => {
    const v = new Vec({ x: 1, y: 2 });
    const d = derived(Vec, () => vAdd(v.value, { x: 10, y: 20 }));
    eq(d.value, { x: 11, y: 22 });
    const p = d.perp();
    eq(p.value, { x: 22, y: -11 });
    if (!(p instanceof Vec)) throw new Error("perp result not instanceof Vec");
  });

  it("derived Vec with setter (lens mode)", () => {
    const v = new Vec({ x: 0, y: 0 });
    const d = derived(
      Vec,
      () => vAdd(v.value, { x: 10, y: 20 }),
      (target) => { v.value = vSub(target, { x: 10, y: 20 }); },
    );
    eq(d.value, { x: 10, y: 20 });
    d.value = { x: 100, y: 200 };
    eq(v.value, { x: 90, y: 180 });
  });

  it("instanceof Vec false for non-Vec", () => {
    if (({} as unknown) instanceof Vec) throw new Error("plain object");
    if ((signal(1) as unknown) instanceof Vec) throw new Error("plain Reactive");
  });
});

suite("isSignal type guard", () => {
  it("returns true for signal/computed/lens/Vec", () => {
    eq(isSignal(signal(1)), true);
    eq(isSignal(computed(() => 1)), true);
    eq(isSignal(lens(() => 1, () => {})), true);
    eq(isSignal(new Vec()), true);
    eq(isSignal(derived(Vec, () => ({ x: 1, y: 2 }))), true);
  });
  it("returns false for non-reactive", () => {
    eq(isSignal({}), false);
    eq(isSignal(null), false);
    eq(isSignal(() => 1), false);
  });
});

suite("4-level chain (the test that found peek() bug originally)", () => {
  it("write src, read tail (cached chain re-evaluates correctly)", () => {
    const s = signal(0);
    const a = computed(() => s.value + 1);
    const b = computed(() => a.value * 2);
    const c = computed(() => b.value - 3);
    const d = computed(() => c.value + 10);
    eq(d.value, 9);
    s.value = 5;
    eq(s.peek(), 5);
    eq(d.value, 19);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
