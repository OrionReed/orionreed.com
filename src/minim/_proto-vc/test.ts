// Verify: new viewClassFor (no setPrototypeOf) behaves identically to
// the current one for all the cases minim actually uses.
//
// Run: npx vite-node src/minim/_proto-vc/test.ts

import { Signal, Computed, effect } from "../signals/signal";
import { LINEAR, LERP, METRIC, EQUALS, type Linear } from "../signals/traits";
// V1: Symbol.hasInstance approach (4ns instanceof)
// V2: inverted-inheritance approach (native instanceof)
import { derived as derivedNew } from "./derive-vc2";
import { derived as derivedOld } from "../signals/derive";

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

// Minimal Vec class for testing.
const vAdd = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  ({ x: a.x + b.x, y: a.y + b.y });
const vSub = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  ({ x: a.x - b.x, y: a.y - b.y });
const vScale = (a: { x: number; y: number }, k: number) =>
  ({ x: a.x * k, y: a.y * k });
const vLinear: Linear<{ x: number; y: number }> = { add: vAdd, sub: vSub, scale: vScale };

class Vec extends Signal<{ x: number; y: number }> {
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
  perp(): Vec { return derivedNew(Vec, () => ({ x: this.value.y, y: -this.value.x })); }
}

// Separate Vec class for the parity (old) tests — keeps caches isolated
// so the two viewClassFor caches don't interfere.
class VecOld extends Signal<{ x: number; y: number }> {
  constructor(v = { x: 0, y: 0 }) { super(v); }
  get [LINEAR]() { return vLinear; }
}

suite("instanceof preservation", () => {
  it("literal Vec is instanceof Vec", () => {
    const v = new Vec({ x: 1, y: 2 });
    if (!(v instanceof Vec)) throw new Error("not instanceof Vec");
    if (!(v instanceof Signal)) throw new Error("not instanceof Signal");
  });

  it("derived Vec (new) is instanceof Vec + Signal", () => {
    const v = new Vec({ x: 1, y: 2 });
    const d = derivedNew(Vec, () => vAdd(v.value, { x: 10, y: 20 }));
    if (!(d instanceof Vec)) throw new Error(`derived not instanceof Vec`);
    if (!(d instanceof Signal)) throw new Error("derived not instanceof Signal");
    // V2 design tradeoff: NOT instanceof Computed (since View extends Cls, not Computed).
    // Only matters if code branches on `instanceof Computed` somewhere — grep shows it doesn't.
  });

  it("derived VecOld (current setPrototypeOf approach) is instanceof VecOld", () => {
    const v = new VecOld({ x: 1, y: 2 });
    const d = derivedOld(VecOld, () => vAdd(v.value, { x: 10, y: 20 }));
    if (!(d instanceof VecOld)) throw new Error("derived (old) not instanceof VecOld");
  });

  it("instanceof Vec returns false for non-Vec things", () => {
    if (({} as unknown) instanceof Vec) throw new Error("plain object passes instanceof Vec");
    if (([] as unknown) instanceof Vec) throw new Error("array passes instanceof Vec");
    if ((null as unknown) instanceof Vec) throw new Error("null passes instanceof Vec");
    if ((undefined as unknown) instanceof Vec) throw new Error("undefined passes instanceof Vec");
    if (("str" as unknown) instanceof Vec) throw new Error("string passes instanceof Vec");
    if ((42 as unknown) instanceof Vec) throw new Error("number passes instanceof Vec");
  });

  it("instanceof Vec returns false for plain Signals (no marker)", () => {
    const s = new Signal({ x: 1, y: 2 });
    if (s instanceof Vec) throw new Error("plain Signal passes instanceof Vec");
  });
});

suite("Methods work on derived Vec", () => {
  it("trait slots accessible on derived", () => {
    const v = new Vec({ x: 1, y: 2 });
    const d = derivedNew(Vec, () => vAdd(v.value, { x: 10, y: 20 }));
    const dWithTraits = d as Vec & { [k: symbol]: unknown };
    if (!dWithTraits[LINEAR]) throw new Error("no LINEAR on derived");
    if (!dWithTraits[LERP]) throw new Error("no LERP on derived");
  });

  it("methods chain through derived", () => {
    const v = new Vec({ x: 1, y: 2 });
    const d = derivedNew(Vec, () => vAdd(v.value, { x: 10, y: 20 }));
    eq(d.value, { x: 11, y: 22 });
    const p = d.perp();  // calls the method on derived (which itself returns a derived)
    eq(p.value, { x: 22, y: -11 });
  });
});

suite("Reactivity through derived", () => {
  it("effect re-runs when source changes", () => {
    const v = new Vec({ x: 1, y: 2 });
    const d = derivedNew(Vec, () => vAdd(v.value, { x: 10, y: 20 }));
    let seen: { x: number; y: number }[] = [];
    const dispose = effect(() => { seen.push({ ...d.value }); });
    eq(seen.length, 1);
    v.value = { x: 100, y: 200 };
    eq(seen.length, 2);
    eq(seen[1], { x: 110, y: 220 });
    dispose();
  });

  it("write through derived (lens form)", () => {
    const v = new Vec({ x: 0, y: 0 });
    const d = derivedNew(
      Vec,
      () => vAdd(v.value, { x: 10, y: 20 }),
      (target) => { v.value = vSub(target, { x: 10, y: 20 }); },
    );
    eq(d.value, { x: 10, y: 20 });
    d.value = { x: 100, y: 200 };
    eq(v.value, { x: 90, y: 180 });
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
