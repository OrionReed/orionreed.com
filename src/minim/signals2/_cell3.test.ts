// Test cell3.ts — methods + traits split, no synthesis.
// Run: tsx src/minim/signals2/_cell3.test.ts

import {
  signal, computed, derived, effect, batch,
  struct, typeOf,
  type Cell, type RO,
} from "./cell3";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}
function section(name: string): void { console.log(`\n— ${name}`); }

// ─────────────────────────────────────────────────────────────────────
// 1. Vec — methods AND traits, same functions referenced twice
// ─────────────────────────────────────────────────────────────────────
section("Vec — methods + traits split");

interface V { x: number; y: number }

// User declares once, references in both bags.
const Vadd   = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
const Vsub   = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
const Vscale = (a: V, k: number): V => ({ x: a.x * k, y: a.y * k });
const Vlerp  = (a: V, b: V, t: number): V => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const Vmetric = (a: V, b: V): number => Math.hypot(a.x - b.x, a.y - b.y);
const Vperp  = (a: V): V => ({ x: -a.y, y: a.x });

const Vec = struct({
  tag: "Vec",
  value: { x: 0, y: 0 } as V,
  methods: { add: Vadd, sub: Vsub, scale: Vscale, lerp: Vlerp, perp: Vperp },
  traits:  { linear: { add: Vadd, sub: Vsub, scale: Vscale }, lerp: Vlerp, metric: Vmetric },
});

{
  const v = Vec({ x: 3, y: 4 });
  check("Vec construction", v().x === 3);
  // Lifted method — reactive.
  const sum = v.add({ x: 1, y: 1 });
  check("v.add reactive", sum().x === 4 && sum().y === 5);
  v({ x: 10, y: 20 });
  check("v.add tracks", sum().x === 11);
  // Trait dispatch — plain math on Type.
  check("Vec.traits.linear.add", (Vec.traits as any).linear.add({ x: 1, y: 2 }, { x: 3, y: 4 }).x === 4);
  check("Vec.traits.metric", Math.abs((Vec.traits as any).metric({ x: 0, y: 0 }, { x: 3, y: 4 }) - 5) < 1e-9);
  // typeOf
  check("typeOf(v) === Vec", typeOf(v) === Vec as any);
  check("v.constructor === Vec", (v as any).constructor === Vec);
}

// ─────────────────────────────────────────────────────────────────────
// 2. Num — scalar struct
// ─────────────────────────────────────────────────────────────────────
section("Num — scalar struct");

const Nadd = (a: number, b: number) => a + b;
const Nsub = (a: number, b: number) => a - b;
const Nscale = (a: number, k: number) => a * k;
const Nlerp = (a: number, b: number, t: number) => a + (b - a) * t;
const Nmetric = (a: number, b: number) => Math.abs(a - b);

const Num = struct({
  tag: "Num",
  value: 0 as number,
  methods: { add: Nadd, abs: (a: number) => Math.abs(a) },
  traits: { linear: { add: Nadd, sub: Nsub, scale: Nscale }, lerp: Nlerp, metric: Nmetric },
});

{
  const n = Num(5);
  check("Num read", n() === 5);
  n(-7);
  check("Num.abs reactive", n.abs()() === 7);
  check("Num.traits.linear.scale", (Num.traits as any).linear.scale(3, 4) === 12);
}

// ─────────────────────────────────────────────────────────────────────
// 3. Transform — composite, traits written by hand (delegating to Vec)
// ─────────────────────────────────────────────────────────────────────
section("Transform — manually composed traits");

interface Tr {
  translate: V; scale: V; rotate: number; opacity: number;
}

const TRlin = (Vec.traits as any).linear;

const Tadd = (a: Tr, b: Tr): Tr => ({
  translate: TRlin.add(a.translate, b.translate),
  scale:     TRlin.add(a.scale, b.scale),
  rotate:    a.rotate + b.rotate,
  opacity:   a.opacity + b.opacity,
});
const Tsub = (a: Tr, b: Tr): Tr => ({
  translate: TRlin.sub(a.translate, b.translate),
  scale:     TRlin.sub(a.scale, b.scale),
  rotate:    a.rotate - b.rotate,
  opacity:   a.opacity - b.opacity,
});
const Tscale = (a: Tr, k: number): Tr => ({
  translate: TRlin.scale(a.translate, k),
  scale:     TRlin.scale(a.scale, k),
  rotate:    a.rotate * k,
  opacity:   a.opacity * k,
});
const Tlerp = (a: Tr, b: Tr, t: number): Tr => ({
  translate: Vlerp(a.translate, b.translate, t),
  scale:     Vlerp(a.scale, b.scale, t),
  rotate:    a.rotate + (b.rotate - a.rotate) * t,
  opacity:   a.opacity + (b.opacity - a.opacity) * t,
});

const Transform = struct({
  tag: "Transform",
  value: {
    translate: Vec,                     // typed, default = {x:0,y:0}
    scale:     Vec({ x: 1, y: 1 }),     // cell-as-default: override
    rotate:    0,
    opacity:   1,
  },
  traits: { linear: { add: Tadd, sub: Tsub, scale: Tscale }, lerp: Tlerp },
});

{
  const tr = Transform();
  const v = tr();
  check("Transform translate default", v.translate.x === 0);
  check("Transform scale custom default", v.scale.x === 1);
  check("Transform rotate default", v.rotate === 0);
  check("Transform opacity default", v.opacity === 1);

  // Sub-cells.
  check("tr.translate is Vec cell", Vec.is(tr.translate as any));
  (tr.translate as Cell<V>).x(50);
  check("nested write reflected in whole", tr().translate.x === 50);

  // Composite trait dispatch.
  const sum = (Transform.traits as any).linear.add(v, v);
  check("Transform.traits.linear.add translate", sum.translate.x === 0);
  // Half-way between v and double-scale.
  const mid = (Transform.traits as any).lerp(v, { ...v, scale: { x: 3, y: 3 } }, 0.5);
  check("Transform.traits.lerp", mid.scale.x === 2);

  // Init with overrides.
  const tr2 = Transform({ translate: { x: 100, y: 50 }, opacity: 0.5 });
  check("Transform init translate", tr2().translate.x === 100);
  check("Transform init opacity", tr2().opacity === 0.5);
  check("Transform init scale unchanged from custom default", tr2().scale.x === 1);
}

// ─────────────────────────────────────────────────────────────────────
// 4. Generic operating across types via traits
// ─────────────────────────────────────────────────────────────────────
section("Generic dispatch via traits");

// Toy generic: takes ANY typed cell with a linear trait, returns the
// type's add of self with itself. Verifies polymorphism over Num/Vec/Transform.
function selfPlusSelf<T>(c: Cell<T, any>): T {
  const t = typeOf(c) as any;
  const linear = t.traits.linear;
  if (!linear) throw new Error(`type ${t.tag} has no linear trait`);
  const v = c();
  return linear.add(v, v);
}

{
  const n = Num(3);
  check("generic: Num", selfPlusSelf(n) === 6);
  const v = Vec({ x: 1, y: 2 });
  const sv = selfPlusSelf(v);
  check("generic: Vec", (sv as V).x === 2 && (sv as V).y === 4);
  const tr = Transform({ translate: { x: 5, y: 5 }, rotate: 1, scale: { x: 2, y: 2 } });
  const st = selfPlusSelf(tr);
  check("generic: Transform", (st as Tr).translate.x === 10 && (st as Tr).rotate === 2);
}

// ─────────────────────────────────────────────────────────────────────
// 5. follow / sync — opacity-chain glitch case
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

  // Re-follow.
  const D = Shape();
  const dOp = (D as any).opacity as Cell<number>;
  dOp(0.4);
  dA();
  const dA2 = aOp.follow(dOp);
  check("A follows D", Math.abs(aOp() - 0.4) < 1e-9);
  check("B = 0.2", Math.abs(bOp() - 0.2) < 1e-9);
  cOp(0.9);
  check("C writes ignored", Math.abs(aOp() - 0.4) < 1e-9);
  dA2(); dB();

  // sync
  const m1 = signal("a");
  const m2 = signal("b");
  const ds = m1.sync(m2);
  check("sync initial: m1 wins", m2() === "a");
  m2("d");
  check("sync m2→m1", m1() === "d");
  ds();
}

// ─────────────────────────────────────────────────────────────────────
// 6. Function-form value (Temp, mutual constraint)
// ─────────────────────────────────────────────────────────────────────
section("Function-form value");
{
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
  const t = Temp();
  check("Temp.c reads 0", ((t as any).c as Cell<number>)() === 0);
  check("Temp.f reads 32", Math.abs(((t as any).f as Cell<number>)() - 32) < 1e-9);
  ((t as any).c as Cell<number>)(100);
  check("Temp.c→f", Math.abs(((t as any).f as Cell<number>)() - 212) < 1e-9);
}

// ─────────────────────────────────────────────────────────────────────
// 7. Reserved names + effects + batching
// ─────────────────────────────────────────────────────────────────────
section("Misc");
{
  let threw = false;
  try { struct({ tag: "Bad", value: { x: 0 }, methods: { length: (a: any) => a.x } }); }
  catch { threw = true; }
  check("method `length` rejected", threw);

  const v = Vec({ x: 0, y: 0 });
  const log: number[] = [];
  const stop = effect(() => { log.push(v.x()); });
  check("effect initial", log.length === 1);
  v.x(1);
  check("effect on field write", log[1] === 1);
  batch(() => { v.x(10); v.y(20); });
  check("batch coalesces", log.length === 3 && log[2] === 10);
  stop();
}

// ─────────────────────────────────────────────────────────────────────
// 8. Type-level sanity (compile-time)
// ─────────────────────────────────────────────────────────────────────
{
  const v = Vec({ x: 1, y: 2 });
  // Field types should be inferred without casts.
  const _x: Cell<number, any> = v.x;
  const _read: V = v();
  // Method should return RO<V>.
  const _add: RO<V> = v.add({ x: 1, y: 1 });
  // Num field is the cell itself; scalar value reads as number.
  const n = Num(5);
  const _n: number = n();
  void _x; void _read; void _add; void _n;
  check("type-level inference (compile-time)", true);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
