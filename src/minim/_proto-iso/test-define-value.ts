// Validate the declarative defineValue() pattern.
//
// Run: npx vite-node src/minim/_proto-iso/test-define-value.ts

import { effect } from "../signals/signal";
import { LINEAR, LERP, METRIC, EQUALS } from "../signals/traits";
import { num, vec, Num, Vec, type VecValue } from "./define-value";

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

suite("Num via defineValue", () => {
  it("basic read/write", () => {
    const n = num(5);
    eq(n.value, 5);
    n.value = 10;
    eq(n.value, 10);
  });

  it("trait slots installed (LINEAR, LERP, METRIC, EQUALS)", () => {
    const n = num(0);
    // @ts-expect-error — accessing trait slots for the test
    if (!n[LINEAR]) throw new Error("no LINEAR");
    // @ts-expect-error
    if (!n[LERP]) throw new Error("no LERP");
    // @ts-expect-error
    if (!n[METRIC]) throw new Error("no METRIC");
    // @ts-expect-error
    if (!n[EQUALS]) throw new Error("no EQUALS");
  });

  it("instanceof Num", () => {
    const n = num(5);
    if (!(n instanceof Num)) throw new Error("not instanceof Num");
  });

  it("add() returns instanceof Num, writable", () => {
    const n = num(5);
    const a = n.add(3);
    if (!(a instanceof Num)) throw new Error(`expected Num, got ${a.constructor.name}`);
    eq(a.value, 8);
    a.value = 20;
    eq(n.value, 17);
  });

  it("fused 3-step chain via .derive", () => {
    const n = num(5);
    const a = n.derive((c) => c.add(3).scale(2).sub(1));
    eq(a.value, 15);  // (5+3)*2 - 1 = 15
    a.value = 99;     // bwd: 99+1=100, 100/2=50, 50-3=47
    eq(n.value, 47);
  });

  it("reactivity through chain methods", () => {
    const n = num(0);
    const a = n.add(3);
    let seen: number[] = [];
    const d = effect(() => { seen.push(a.value); });
    eq(seen, [3]);
    n.value = 5;
    eq(seen, [3, 8]);
    d();
  });
});

suite("Vec via defineValue", () => {
  it("basic read/write", () => {
    const v = vec(3, 4);
    eq(v.value, { x: 3, y: 4 });
    v.value = { x: 10, y: 20 };
    eq(v.value, { x: 10, y: 20 });
  });

  it("field accessors auto-generated (v.x, v.y)", () => {
    const v = vec(3, 4);
    eq(v.x.value, 3);
    eq(v.y.value, 4);
    v.x.value = 100;
    eq(v.value, { x: 100, y: 4 });
    v.y.value = 200;
    eq(v.value, { x: 100, y: 200 });
  });

  it("trait slots installed", () => {
    const v = vec(0, 0);
    // @ts-expect-error
    if (!v[LINEAR]) throw new Error("no LINEAR");
    // @ts-expect-error
    if (!v[LERP]) throw new Error("no LERP");
    // @ts-expect-error
    if (!v[METRIC]) throw new Error("no METRIC");
  });

  it("instanceof Vec preserved through derive", () => {
    const v = vec(1, 2);
    const a = v.add({ x: 10, y: 20 });
    if (!(a instanceof Vec)) throw new Error(`expected Vec, got ${a.constructor.name}`);
    eq(a.value, { x: 11, y: 22 });
  });

  it("eager methods writable through chain (perp + bwd)", () => {
    const v = vec(3, 4);
    const p = v.perp();
    eq(p.value, { x: 4, y: -3 });
    p.value = { x: -2, y: -1 };
    eq(v.value, { x: 1, y: -2 });  // perp⁻¹((-2,-1)) = (-y, x) = (1, -2)
  });

  it("field-axis lens writes propagate through equality short-circuit", () => {
    const v = vec(1, 2);
    let count = 0;
    const d = effect(() => { void v.x.value; count++; });
    eq(count, 1);
    v.x.value = 1;  // same value → no fire
    eq(count, 1);
    v.x.value = 5;
    eq(count, 2);
    d();
  });

  it("fused chain: add then scale, writable", () => {
    const v = vec(0, 0);
    const a = v.derive((c) => c.add({ x: 10, y: 20 }).scale(2));
    eq(a.value, { x: 20, y: 40 });
    a.value = { x: 100, y: 200 };
    eq(v.value, { x: 40, y: 80 });  // (100/2)-10=40, (200/2)-20=80
  });

  it("normalize() chains as read-only (downgrades W)", () => {
    const v = vec(3, 4);
    const u = v.derive((c) => c.normalize());
    eq(u.value, { x: 0.6, y: 0.8 });
    let threw = false;
    try { (u as unknown as { value: VecValue }).value = { x: 1, y: 0 }; }
    catch { threw = true; }
    if (!threw) throw new Error("normalize chain should be read-only");
  });
});

// Verify the perp test (matching test.ts:209)
suite("Sanity: perp matches main test", () => {
  it("perp behavior matches main prototype", () => {
    const v = vec(3, 4);
    const p = v.perp();
    eq(p.value, { x: 4, y: -3 });
    p.value = { x: -1, y: 2 };
    eq(v.value, { x: -2, y: -1 });
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
