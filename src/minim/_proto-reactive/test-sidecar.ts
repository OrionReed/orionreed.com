// Quick sanity test for sidecar Reactive.

import {
  Reactive, signal, computed, lens, effect, batch, derived,
} from "./reactive-sidecar";
import { LINEAR, LERP, METRIC, EQUALS, type Linear } from "../signals/traits";

let passed = 0, failed = 0;
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
  let did = false; try { fn(); } catch { did = true; }
  if (!did) throw new Error("expected throw");
}

const vLinear: Linear<{ x: number; y: number }> = {
  add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
  sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
  scale: (a, k) => ({ x: a.x * k, y: a.y * k }),
};
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
}

console.log("\n— Sidecar Reactive sanity");
it("signal read/write", () => {
  const s = signal(5); eq(s.value, 5); s.value = 10; eq(s.value, 10);
});
it("computed derives", () => {
  const s = signal(5); const c = computed(() => s.value * 2);
  eq(c.value, 10); s.value = 7; eq(c.value, 14);
});
it("computed throws on write", () => {
  const c = computed(() => 5); throws(() => { c.value = 10; });
});
it("lens read/write", () => {
  const s = signal(5);
  const l = lens(() => s.value + 3, (v) => { s.value = v - 3; });
  eq(l.value, 8); l.value = 100; eq(s.value, 97);
});
it("effect re-fires", () => {
  const s = signal(0); let n = 0;
  const d = effect(() => { void s.value; n++; });
  eq(n, 1); s.value = 1; eq(n, 2); d();
});
it("batch defers", () => {
  const s = signal(0); let n = 0;
  const d = effect(() => { void s.value; n++; });
  eq(n, 1);
  batch(() => { s.value = 1; s.value = 2; s.value = 3; });
  eq(n, 2); d();
});
it("Vec EQUALS short-circuit", () => {
  const v = new Vec({ x: 1, y: 2 }); let n = 0;
  const d = effect(() => { void v.value; n++; });
  eq(n, 1); v.value = { x: 1, y: 2 }; eq(n, 1);  // structurally equal
  v.value = { x: 1, y: 3 }; eq(n, 2); d();
});
it("derived(Vec, fn) instanceof Vec", () => {
  const v = new Vec({ x: 1, y: 2 });
  const d = derived(Vec, () => ({ x: v.value.x + 10, y: v.value.y + 20 }));
  if (!(d instanceof Vec)) throw new Error("not instanceof Vec");
  if (!(d instanceof Reactive)) throw new Error("not instanceof Reactive");
  eq(d.value, { x: 11, y: 22 });
});
it("4-level chain", () => {
  const s = signal(0);
  const a = computed(() => s.value + 1);
  const b = computed(() => a.value * 2);
  const c = computed(() => b.value - 3);
  const d = computed(() => c.value + 10);
  eq(d.value, 9); s.value = 5; eq(d.value, 19);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
