// Test cell2 v3 (post-notes.md cleanup). Validates:
//
//   1. Bare signal/computed/derived primitives.
//   2. Struct with primitive value (Num).
//   3. Struct with literal record value (Vec, flat ops, no grouping).
//   4. Composite struct (Transform with `compose: [...]`).
//   5. Function-form value (Temp, mutual constraint).
//   6. follow / sync (renamed from mirror).
//   7. Opacity-chain — the hard glitch case.
//   8. typeOf(cell) === cell.constructor === Vec (no cell.type).
//   9. Reserved-name guards.
//  10. Effects + batching.
//
// Run: tsx src/minim/signals2/_cell2.test.ts

import {
  signal, computed, derived, effect, batch,
  struct, typeOf,
  type Cell,
} from "./cell2";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}
function section(name: string): void { console.log(`\n— ${name}`); }

// ── 1. Bare primitives ─────────────────────────────────────────────
section("Bare signal / computed / derived");
{
  const a = signal(1);
  check("signal read", a() === 1);
  a(5);
  check("signal write", a() === 5);
  check("signal peek", a.peek() === 5);

  const b = signal(3);
  const c = computed(() => a() + b());
  check("computed read", c() === 8);
  a(10);
  check("computed re-eval", c() === 13);
  check("computed peek", c.peek() === 13);

  let cTemp = 100;
  const f = derived(
    () => cTemp * 9 / 5 + 32,
    (fv) => { cTemp = (fv - 32) * 5 / 9; },
  );
  check("derived read", Math.abs(f() - 212) < 1e-9);
  f(32);
  check("derived write", cTemp === 0);
}

// ── 2. Num — scalar struct ─────────────────────────────────────────
section("Num (scalar struct, flat ops)");
const Num = struct({
  tag: "Num",
  value: 0 as number,
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  scale: (a, k) => a * k,
  lerp: (a, b, t) => a + (b - a) * t,
  metric: (a, b) => Math.abs(a - b),
  methods: { abs: (a) => Math.abs(a) },
});
{
  const n = Num(5);
  check("Num default", Num().peek() === 0);
  check("Num init", n() === 5);
  n(10);
  check("Num write", n() === 10);
  // No cell.type — use cell.constructor or typeOf().
  check("typeOf returns Num", typeOf(n) === Num);
  check("cell.constructor === Num", (n as any).constructor === Num);
  check("Num.tag", Num.tag === "Num");
  check("Num.is true on instance", Num.is(n));
  check("Num.is false on bare signal", !Num.is(signal(1)));
  // Flat ops on Type — plain math.
  check("Num.add (flat, no .linear)", Num.add!(2, 3) === 5);
  // Lifted method — reactive.
  n(-7);
  const ab = n.abs();
  check("Num.abs reactive", ab() === 7);
  n(3);
  check("Num.abs after write", ab() === 3);
}

// ── 3. Vec — literal record, fields-as-real-signals ────────────────
section("Vec (record value, flat ops)");
const Vec = struct({
  tag: "Vec",
  value: { x: 0, y: 0 } as { x: number; y: number },
  add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
  sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
  scale: (a, k) => ({ x: a.x * k, y: a.y * k }),
  lerp: (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }),
  metric: (a, b) => Math.hypot(a.x - b.x, a.y - b.y),
});
{
  const v = Vec({ x: 3, y: 4 });
  check("Vec read whole", v().x === 3 && v().y === 4);
  check("Vec.x callable", typeof (v as any).x === "function");
  check("Vec.x read", ((v as any).x as Cell<number>)() === 3);
  check("Vec.x identity stable", (v as any).x === (v as any).x);
  ((v as any).x as Cell<number>)(10);
  check("Vec.x write", ((v as any).x as Cell<number>)() === 10);
  v({ x: 100, y: 200 });
  check("Vec whole write", ((v as any).x as Cell<number>)() === 100);
  check("Vec.add flat", Vec.add!({ x: 1, y: 1 }, { x: 2, y: 3 }).x === 3);
  check("Vec.metric flat", Math.abs(Vec.metric!({ x: 0, y: 0 }, { x: 3, y: 4 }) - 5) < 1e-9);
  // No trait lifting: cell.add doesn't exist (TS prevents at compile time;
  // at runtime cells DO inherit static add through prototype, which is
  // a known JS pattern footgun — see notes.md). Verify TS-level absence
  // by NOT calling it. We just assert the lifted method (abs above) and
  // the static flat op work, which is the contract.
}

// ── 4. Composite struct — Transform with `compose: [...]` ──────────
section("Transform (composite, compose: [...])");

interface Tr {
  translate: { x: number; y: number };
  scale: { x: number; y: number };
  rotate: number;
  opacity: number;
}

const Transform = struct({
  tag: "Transform",
  value: {
    translate: Vec,                       // typed, default = {x:0,y:0}
    scale: Vec({ x: 1, y: 1 }),           // cell-as-default-spec
    rotate: 0,                            // primitive
    opacity: 1,                           // primitive
  },
  compose: ["add", "sub", "scale", "lerp", "metric", "equals"],
});
{
  const tr = Transform();
  const v = tr();
  check("Transform translate default", v.translate.x === 0);
  check("Transform scale custom default", v.scale.x === 1 && v.scale.y === 1);
  check("Transform rotate default", v.rotate === 0);
  check("Transform opacity default", v.opacity === 1);

  check("tr.translate is a Vec cell", Vec.is((tr as any).translate));
  check("tr.scale is a Vec cell", Vec.is((tr as any).scale));

  ((tr as any).translate as Cell<{ x: number; y: number }>).x(50);
  check("nested field write reflected in whole", tr().translate.x === 50);

  const tr2 = Transform({ translate: { x: 100, y: 50 }, opacity: 0.5 });
  const v2 = tr2();
  check("Transform init translate", v2.translate.x === 100);
  check("Transform init opacity", v2.opacity === 0.5);
  check("Transform init scale default still 1", v2.scale.x === 1);

  // Composite ops synthesized from `compose`.
  const sum = Transform.add!(v2, v2);
  check("Transform.add translate", sum.translate.x === 200);
  check("Transform.add rotate", sum.rotate === 0);
  check("Transform.add opacity", sum.opacity === 1);
  const half = Transform.lerp!(v2, { ...v2, scale: { x: 3, y: 3 } }, 0.5);
  check("Transform.lerp scale", half.scale.x === 2);
  check("Transform.metric translate-only diff", Transform.metric!(v2, { ...v2 }) === 0);
}

// ── 5. Function-form value (Temp, mutual constraint) ───────────────
section("Temp (function-form value)");
const Temp = struct({
  tag: "Temp",
  value: () => {
    const c = signal(0);
    const f = derived(
      () => c() * 9 / 5 + 32,
      (v) => c((v - 32) * 5 / 9),
    );
    return { c, f };
  },
});
{
  const t = Temp();
  check("Temp.c reads 0", ((t as any).c as Cell<number>)() === 0);
  check("Temp.f reads 32", Math.abs(((t as any).f as Cell<number>)() - 32) < 1e-9);
  ((t as any).c as Cell<number>)(100);
  check("Temp.c→f", Math.abs(((t as any).f as Cell<number>)() - 212) < 1e-9);
  ((t as any).f as Cell<number>)(32);
  check("Temp.f→c", Math.abs(((t as any).c as Cell<number>)() - 0) < 1e-9);
}

// ── 6. follow / sync ──────────────────────────────────────────────
section("follow / sync");
{
  const a = signal(1);
  const b = signal(99);
  const dispose = a.follow(b);
  check("follow initial copy", a() === 99);
  b(5);
  check("follow propagates", a() === 5);
  dispose();
  b(100);
  check("follow disposes", a() === 5);

  const x = signal(0);
  const src1 = signal(10);
  const src2 = signal(20);
  let d1 = x.follow(src1);
  check("follow #1", x() === 10);
  d1();
  d1 = x.follow(src2);
  check("re-follow installs new", x() === 20);
  src1(99);
  check("old source ignored after re-follow", x() === 20);
  src2(30);
  check("new source live", x() === 30);

  // sync — two-way.
  const m1 = signal("a");
  const m2 = signal("b");
  const ds = m1.sync(m2);
  check("sync initial: m1 wins", m2() === "a");
  m1("c");
  check("sync m1→m2", m2() === "c");
  m2("d");
  check("sync m2→m1", m1() === "d");
  ds();
  m1("e");
  check("sync disposes", m2() === "d");
}

// ── 7. Opacity chain — the glitch case ─────────────────────────────
section("Opacity chain (per-field signals, no glitch)");
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
  check("B = A/2 = 0.5", Math.abs(bOp() - 0.5) < 1e-9);

  const dA = aOp.follow(cOp);
  check("A follows C (=1)", Math.abs(aOp() - 1) < 1e-9);
  check("B reflects: 0.5", Math.abs(bOp() - 0.5) < 1e-9);

  cOp(0.6);
  check("A = 0.6 after C=0.6", Math.abs(aOp() - 0.6) < 1e-9);
  check("B = 0.3 after C=0.6 (NO GLITCH)", Math.abs(bOp() - 0.3) < 1e-9);

  const D = Shape();
  const dOp = (D as any).opacity as Cell<number>;
  dOp(0.4);
  dA();
  const dA2 = aOp.follow(dOp);
  check("A follows D (=0.4)", Math.abs(aOp() - 0.4) < 1e-9);
  check("B = 0.2", Math.abs(bOp() - 0.2) < 1e-9);
  cOp(0.9);
  check("C writes ignored", Math.abs(aOp() - 0.4) < 1e-9);
  check("B still 0.2", Math.abs(bOp() - 0.2) < 1e-9);
  dA2(); dB();
}

// ── 8. Reserved-name guard ─────────────────────────────────────────
section("Reserved names");
{
  let threw = false;
  try {
    struct({
      tag: "Bad",
      value: { x: 0 },
      methods: { length: (a: any) => a.x },
    });
  } catch { threw = true; }
  check("method `length` rejected", threw);

  threw = false;
  try {
    struct({ tag: "BadG", value: { x: 0 }, getters: { name(this: any) { return 0; } } });
  } catch { threw = true; }
  check("getter `name` rejected", threw);

  threw = false;
  try {
    struct({ tag: "BadF", value: { length: 0 } as any })();
  } catch { threw = true; }
  check("field `length` rejected at construction", threw);
}

// ── 9. Effects & batching ──────────────────────────────────────────
section("Effects & batching");
{
  const v = Vec({ x: 0, y: 0 });
  const log: string[] = [];
  const vx = (v as any).x as Cell<number>;
  const vy = (v as any).y as Cell<number>;
  const stop = effect(() => { log.push(`${vx()},${vy()}`); });
  check("effect initial", log.length === 1 && log[0] === "0,0");
  vx(1);
  check("effect on x", log.length === 2 && log[1] === "1,0");
  batch(() => { vx(10); vy(20); });
  check("batch coalesces", log.length === 3 && log[2] === "10,20");
  stop();
  vx(99);
  check("effect disposes", log.length === 3);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
