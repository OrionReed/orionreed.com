// Verify the callable signal with attached methods + traits works correctly.

import { signal, computed, effect, batch, isReactive } from "./signal";
import { vec, num, type Vec } from "./vec";
import { LINEAR, LERP } from "../signals/traits";

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

suite("Basic callable signal", () => {
  it("signal(0) is callable", () => {
    const s = signal(5);
    eq(s(), 5);
    s(10);
    eq(s(), 10);
  });
  it("computed is callable", () => {
    const s = signal(5);
    const c = computed(() => s() * 2);
    eq(c(), 10);
    s(7);
    eq(c(), 14);
  });
  it("effect fires on signal change", () => {
    const s = signal(0);
    let count = 0;
    const dispose = effect(() => { void s(); count++; });
    eq(count, 1);
    s(1);
    eq(count, 2);
    dispose();
  });
});

suite("Vec callable with methods + traits", () => {
  it("vec(x, y) reads/writes via callable", () => {
    const v = vec(3, 4);
    eq(v(), { x: 3, y: 4 });
    v({ x: 10, y: 20 });
    eq(v(), { x: 10, y: 20 });
  });
  it("v.x and v.y are sub-signals (callable)", () => {
    const v = vec(3, 4);
    eq(v.x(), 3);
    eq(v.y(), 4);
    v.x(100);
    eq(v(), { x: 100, y: 4 });
  });
  it("vec.add(b) returns a Vec callable", () => {
    const v = vec(1, 2);
    const a = v.add({ x: 10, y: 20 });
    eq(a(), { x: 11, y: 22 });
  });
  it("trait slots accessible on Vec", () => {
    const v = vec(0, 0);
    if (!v[LINEAR]) throw new Error("no LINEAR");
    if (!v[LERP]) throw new Error("no LERP");
  });
  it("isReactive type guard works", () => {
    const v = vec(0, 0);
    if (!isReactive(v)) throw new Error("vec not reactive");
    if (!isReactive(v.x)) throw new Error("vec.x not reactive");
    if (isReactive({})) throw new Error("plain object passes");
    if (isReactive(42)) throw new Error("number passes");
  });
  it("chained methods", () => {
    const v = vec(1, 2);
    const a = v.add({ x: 10, y: 20 }).perp();
    eq(a(), { x: 22, y: -11 });
  });
  it("reactivity through derived Vec", () => {
    const v = vec(1, 2);
    const a = v.add({ x: 10, y: 20 });
    let seen: { x: number; y: number }[] = [];
    const dispose = effect(() => { seen.push({ ...a() }); });
    eq(seen.length, 1);
    v({ x: 100, y: 200 });
    eq(seen.length, 2);
    eq(seen[1], { x: 110, y: 220 });
    dispose();
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
