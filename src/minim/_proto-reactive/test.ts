// Verify the merged Reactive class behaves identically to the
// Signal+Computed split — covering all the cases minim relies on.
//
// Run: npx vite-node src/minim/_proto-reactive/test.ts

import {
  Reactive,
  signal, computed, lens, effect, batch,
  derived, isSignal,
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
function throws(fn: () => void, msg?: string) {
  let did = false;
  try { fn(); } catch { did = true; }
  if (!did) throw new Error(`expected throw${msg ? " — " + msg : ""}`);
}

// ─── Basic signal/computed/lens ─────────────────────────────────────

suite("Basic signal", () => {
  it("read/write", () => {
    const s = signal(5);
    eq(s.value, 5);
    s.value = 10;
    eq(s.value, 10);
  });

  it("peek does not subscribe", () => {
    const s = signal(0);
    let fires = 0;
    const dispose = effect(() => { void s.peek(); fires++; });
    eq(fires, 1);
    s.value = 1;
    eq(fires, 1);
    dispose();
  });

  it("equality short-circuits", () => {
    const s = signal(1);
    let fires = 0;
    const dispose = effect(() => { void s.value; fires++; });
    eq(fires, 1);
    s.value = 1;  // same value
    eq(fires, 1);
    dispose();
  });
});

suite("Basic computed", () => {
  it("derives from signal", () => {
    const s = signal(5);
    const c = computed(() => s.value * 2);
    eq(c.value, 10);
    s.value = 7;
    eq(c.value, 14);
  });

  it("multi-level chain", () => {
    const s = signal(0);
    const a = computed(() => s.value + 1);
    const b = computed(() => a.value * 2);
    const c = computed(() => b.value - 3);
    const d = computed(() => c.value + 10);
    eq(d.value, 9);
    s.value = 5;
    eq(d.value, 19);
  });

  it("computed cached on second read", () => {
    let count = 0;
    const s = signal(1);
    const c = computed(() => { count++; return s.value * 2; });
    eq(c.value, 2);
    eq(c.value, 2);
    eq(count, 1);
  });

  it("computed throws on write", () => {
    const s = signal(1);
    const c = computed(() => s.value);
    throws(() => { c.value = 5; });
  });
});

suite("Lens (computed with setter)", () => {
  it("write through lens propagates", () => {
    const s = signal(5);
    const l = lens(() => s.value + 3, (v) => { s.value = v - 3; });
    eq(l.value, 8);
    l.value = 20;
    eq(s.value, 17);
  });
});

// ─── peek() correctness (the bug we fixed in original) ───────────────

suite("peek() correctness", () => {
  it("peek between write and downstream read doesn't strand subscribers", () => {
    const s = signal(0);
    const a = computed(() => s.value + 1);
    const b = computed(() => a.value * 2);
    const d = computed(() => b.value);
    void d.value;  // warm cache
    s.value = 10;
    void s.peek();  // ← would have stranded subscribers in old code
    eq(d.value, 22);  // computed re-evaluates correctly
  });
});

// ─── derived(Cls, ...) — the key new mechanism ───────────────────────

const vAdd = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  ({ x: a.x + b.x, y: a.y + b.y });
const vSub = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  ({ x: a.x - b.x, y: a.y - b.y });
const vScale = (a: { x: number; y: number }, k: number) =>
  ({ x: a.x * k, y: a.y * k });
const vLinear: Linear<{ x: number; y: number }> = { add: vAdd, sub: vSub, scale: vScale };

class Vec extends Reactive<{ x: number; y: number }> {
  constructor(v = { x: 0, y: 0 }) { super(v); }
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
  perp(): Vec { return derived(Vec, () => ({ x: this.value.y, y: -this.value.x })); }
}

suite("derived(Vec, fn) — no viewClassFor needed", () => {
  it("derived Vec is instanceof Vec (native chain)", () => {
    const v = new Vec({ x: 1, y: 2 });
    const d = derived(Vec, () => vAdd(v.value, { x: 10, y: 20 }));
    if (!(d instanceof Vec)) throw new Error("derived not instanceof Vec");
    if (!(d instanceof Reactive)) throw new Error("derived not instanceof Reactive");
  });

  it("derived Vec has Vec's trait slots", () => {
    const v = new Vec({ x: 1, y: 2 });
    const d = derived(Vec, () => vAdd(v.value, { x: 10, y: 20 }));
    const dt = d as Vec & { [k: symbol]: unknown };
    if (!dt[LINEAR]) throw new Error("no LINEAR");
    if (!dt[LERP]) throw new Error("no LERP");
  });

  it("derived Vec's methods work (perp on derived)", () => {
    const v = new Vec({ x: 1, y: 2 });
    const d = derived(Vec, () => vAdd(v.value, { x: 10, y: 20 }));
    eq(d.value, { x: 11, y: 22 });
    const p = d.perp();
    eq(p.value, { x: 22, y: -11 });
    if (!(p instanceof Vec)) throw new Error("perp result not instanceof Vec");
  });

  it("derived Vec with setter — write back through", () => {
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
    if (({} as unknown) instanceof Vec) throw new Error("plain object passes");
    if ((null as unknown) instanceof Vec) throw new Error("null passes");
    if ((signal(1) as unknown) instanceof Vec) throw new Error("plain Reactive passes");
  });
});

// ─── Reactivity through derived(Vec) ─────────────────────────────────

suite("Reactivity", () => {
  it("effect re-fires when source changes (via derived Vec)", () => {
    const v = new Vec({ x: 1, y: 2 });
    const d = derived(Vec, () => vAdd(v.value, { x: 10, y: 20 }));
    let seen: { x: number; y: number }[] = [];
    const dispose = effect(() => { seen.push({ ...d.value }); });
    eq(seen.length, 1);
    v.value = { x: 100, y: 200 };
    eq(seen.length, 2);
    eq(seen[1], { x: 110, y: 220 });
    dispose();
  });

  it("batch defers effects (incl. through derived)", () => {
    const s = signal(0);
    const c = computed(() => s.value * 2);
    let seen: number[] = [];
    const dispose = effect(() => { seen.push(c.value); });
    eq(seen, [0]);
    batch(() => {
      s.value = 1;
      s.value = 2;
      s.value = 3;
    });
    eq(seen, [0, 6]);
    dispose();
  });
});

// ─── isSignal type guard ─────────────────────────────────────────────

suite("isSignal", () => {
  it("isSignal returns true for signals, computeds, lens, Vec", () => {
    eq(isSignal(signal(1)), true);
    eq(isSignal(computed(() => 1)), true);
    eq(isSignal(lens(() => 1, () => {})), true);
    eq(isSignal(new Vec()), true);
    eq(isSignal(derived(Vec, () => ({ x: 1, y: 2 }))), true);
  });

  it("isSignal returns false for non-reactive", () => {
    eq(isSignal({}), false);
    eq(isSignal(null), false);
    eq(isSignal(42), false);
    eq(isSignal(() => 1), false);
  });
});

// ─── Summary ─────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
