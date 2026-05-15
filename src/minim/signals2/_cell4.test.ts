// _cell4.test.ts — tests for cell4 (fused storage + native lens).
//
// Critical test: per-field subscription via computed equality.
// Should fire ONLY for fields whose projected value changed.
//
// Run: npx tsx src/minim/signals2/_cell4.test.ts

import {
  signal, computed, lens, effect, batch,
  struct, typeOf,
  type Cell, type RO,
} from "./cell4";
import { Vec, Transform, type V, type Tr } from "./values4";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}
function section(name: string): void { console.log(`\n— ${name}`); }

// ─────────────────────────────────────────────────────────────────────
// 1. Bare primitives — signal/computed/lens
// ─────────────────────────────────────────────────────────────────────
section("Bare primitives");
{
  const a = signal(1);
  check("signal read", a() === 1);
  a(5);
  check("signal write", a() === 5);
  check("signal peek (from signalProto)", a.peek() === 5);

  const c = computed(() => a() * 2);
  check("computed read", c() === 10);
  a(7);
  check("computed re-eval", c() === 14);

  // Native lens — get/set primitive. Reads must go through signals
  // to be reactive (a plain variable getter wouldn't invalidate the
  // computed-side cache when the variable changes — that's by design).
  const s = signal(100);
  const l = lens(() => s(), v => s(v));
  check("lens read", l() === 100);
  l(50);
  check("lens write delegate", s() === 50);
  check("lens read after write", l() === 50);
}

// ─────────────────────────────────────────────────────────────────────
// 2. Vec — fused storage (single signal + field lenses) — uses values4
// ─────────────────────────────────────────────────────────────────────
section("Vec (fused)");

{
  const v = Vec({ x: 3, y: 4 });
  // Whole-value read/write — should be bare-alien fast.
  check("whole read", v().x === 3 && v().y === 4);
  v({ x: 10, y: 20 });
  check("whole write", v().x === 10);

  // Field access via lens.
  const vx = v.x;
  const vy = v.y;
  check("v.x lens read", vx() === 10);
  check("v.y lens read", vy() === 20);
  check("v.x identity stable", v.x === vx);

  // Field write goes through lens.setter → parent.signal(...spread).
  vx(99);
  check("v.x lens write", vx() === 99 && v().x === 99);

  // Type access via constructor (no cell.type).
  check("v.constructor === Vec", (v as any).constructor === Vec);
  check("typeOf(v) === Vec", typeOf(v) === Vec as any);
}

// ─────────────────────────────────────────────────────────────────────
// 3. THE KEY TEST — per-field subscription via computed equality
// ─────────────────────────────────────────────────────────────────────
section("Per-field subscription (the critical correctness test)");
{
  const v = Vec({ x: 0, y: 0 });

  let xFires = 0;
  let yFires = 0;
  const stopX = effect(() => { void v.x(); xFires++; });
  const stopY = effect(() => { void v.y(); yFires++; });

  check("effect on x: initial run", xFires === 1);
  check("effect on y: initial run", yFires === 1);

  // Write whole, BOTH changed.
  v({ x: 1, y: 1 });
  check("both change: x fires once", xFires === 2);
  check("both change: y fires once", yFires === 2);

  // Write whole, ONLY x changes (y stays at 1).
  v({ x: 5, y: 1 });
  check("only x changes: x fires", xFires === 3);
  check("only x changes: y DOES NOT FIRE", yFires === 2);

  // Write whole, ONLY y changes.
  v({ x: 5, y: 99 });
  check("only y changes: x DOES NOT FIRE", xFires === 3);
  check("only y changes: y fires", yFires === 3);

  // Write whole, NEITHER changes (same object content).
  v({ x: 5, y: 99 });
  check("no change: x doesn't fire", xFires === 3);
  check("no change: y doesn't fire", yFires === 3);

  // Write through field lens, only x.
  v.x(100);
  check("field write x: x fires", xFires === 4);
  check("field write x: y doesn't fire", yFires === 3);

  stopX();
  stopY();
}

// ─────────────────────────────────────────────────────────────────────
// 4. Methods — reactive Cell (lifted) AND plain static (on Vec)
// ─────────────────────────────────────────────────────────────────────
section("Methods — reactive (cell) and plain (Vec.method)");
{
  const v = Vec({ x: 3, y: 4 });
  // Reactive method: returns Cell.
  const sum = v.add({ x: 1, y: 1 });
  check("reactive v.add returns Cell", typeof sum === "function");
  check("reactive v.add value", sum().x === 4 && sum().y === 5);
  v({ x: 10, y: 20 });
  check("reactive v.add re-evals", sum().x === 11 && sum().y === 21);

  // Plain static: pure function, no allocation, no reactive cell.
  const plain = (Vec as any).add({ x: 1, y: 2 }, { x: 3, y: 4 });
  check("static Vec.add plain math", plain.x === 4 && plain.y === 6);

  // Trait dispatch.
  check("Vec.traits.linear.add", (Vec.traits as any).linear.add({ x: 1, y: 2 }, { x: 3, y: 4 }).x === 4);

  // "One big computation" pattern: user wraps plain statics in a single computed.
  const big = computed(() => {
    // Pure math inside a single computed; one allocation total.
    const p = v();
    return (Vec as any).right
      ? (Vec as any).right(p, 10)
      : (Vec as any).add(p, { x: 10, y: 0 });   // synthetic "right(10)"
  });
  check("single-computed plain chain", big().x === v().x + 10);
}

// ─────────────────────────────────────────────────────────────────────
// 5. Composite — Transform with hand-written traits (imported)
// ─────────────────────────────────────────────────────────────────────
section("Composite (Transform with manual trait composition)");
{
  const tr = Transform();
  const v = tr();
  check("Transform translate default", v.translate.x === 0);
  check("Transform scale custom default", v.scale.x === 1);
  check("Transform rotate default", v.rotate === 0);
  check("Transform opacity default", v.opacity === 1);

  // Field access — sub-fields are lenses themselves... wait, the
  // sub-cell is a *Vec lens* with Vec.prototype, so tr.translate.x is
  // also a lens. Verify the chain works.
  const trTrans = tr.translate as Cell<V>;
  check("tr.translate is a Cell", typeof trTrans === "function");
  check("tr.translate.x as field-lens", (trTrans as any).x() === 0);
  (trTrans as any).x(50);
  check("write through nested lens", tr().translate.x === 50);

  // Trait dispatch on composite.
  const sum = (Transform.traits as any).linear.add(v, v);
  check("Transform.traits.linear.add translate", sum.translate.x === 0);
}

// ─────────────────────────────────────────────────────────────────────
// 6. Generic dispatch via traits
// ─────────────────────────────────────────────────────────────────────
section("Generic via cell.constructor.traits");
function selfPlusSelf<T>(c: Cell<T, any>): T {
  const t = typeOf(c) as any;
  const lin = t.traits.linear;
  const v = c();
  return lin.add(v, v);
}

{
  const v = Vec({ x: 1, y: 2 });
  const sum = selfPlusSelf(v);
  check("generic Vec", (sum as V).x === 2 && (sum as V).y === 4);
}

// ─────────────────────────────────────────────────────────────────────
// 7. follow / sync — opacity-chain glitch case
// ─────────────────────────────────────────────────────────────────────
section("follow / sync — opacity chain");
{
  const Shape = struct({ tag: "Shape", value: { opacity: 1 } });
  const A = Shape();
  const B = Shape();
  const C = Shape();
  const aOp = (A as any).opacity as Cell<number>;
  const bOp = (B as any).opacity as Cell<number>;
  const cOp = (C as any).opacity as Cell<number>;

  const half = computed(() => aOp() / 2);
  const dB = bOp.follow(half);
  check("B initial = 0.5", Math.abs(bOp() - 0.5) < 1e-9);
  const dA = aOp.follow(cOp);
  check("A = C = 1", Math.abs(aOp() - 1) < 1e-9);
  check("B reflects A: 0.5", Math.abs(bOp() - 0.5) < 1e-9);
  cOp(0.6);
  check("A = 0.6", Math.abs(aOp() - 0.6) < 1e-9);
  check("B = 0.3 (no glitch)", Math.abs(bOp() - 0.3) < 1e-9);
  dA(); dB();
}

// ─────────────────────────────────────────────────────────────────────
// 8. Split storage (function-form value)
// ─────────────────────────────────────────────────────────────────────
section("Split storage (function-form value)");
{
  const Temp = struct({
    tag: "Temp",
    value: () => {
      const c = signal(0);
      const f = lens(
        () => c() * 9 / 5 + 32,
        (v: number) => c((v - 32) * 5 / 9),
      );
      return { c, f };
    },
  });
  const t = Temp();
  check("Temp.c reads 0", ((t as any).c as Cell<number>)() === 0);
  check("Temp.f reads 32", Math.abs(((t as any).f as Cell<number>)() - 32) < 1e-9);
  ((t as any).c as Cell<number>)(100);
  check("Temp.c→f via lens", Math.abs(((t as any).f as Cell<number>)() - 212) < 1e-9);
  ((t as any).f as Cell<number>)(32);
  check("Temp.f→c via lens.setter", Math.abs(((t as any).c as Cell<number>)() - 0) < 1e-9);
}

// ─────────────────────────────────────────────────────────────────────
// 9. Effects + batching + type inference
// ─────────────────────────────────────────────────────────────────────
section("Misc — effects, batching, type inference");
{
  const v = Vec({ x: 0, y: 0 });
  const log: string[] = [];
  const stop = effect(() => { log.push(`${v.x()},${v.y()}`); });
  check("effect initial", log.length === 1 && log[0] === "0,0");
  v.x(1);
  check("effect on x write", log.length === 2 && log[1] === "1,0");
  batch(() => { v.x(10); v.y(20); });
  check("batch coalesces", log.length === 3 && log[2] === "10,20");
  stop();

  // Type-level (compile-time)
  const _v: V = v();
  const _vx: Cell<number, any> = v.x;
  const _sum: RO<V> = v.add({ x: 1, y: 1 });
  void _v; void _vx; void _sum;
  check("type-level inference", true);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
