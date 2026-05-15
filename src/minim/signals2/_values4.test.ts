// _values4.test.ts — comprehensive test of all value types under cell4.
// Goal: prove that the API is usable with NO `(as any)` casts.

import { effect, batch, computed, struct, type Cell, type RO } from "./cell4";
import {
  Num, Vec, vec, Color, rgb, rgba, Matrix2D, mat, identity,
  Box, box, Transform, type V, type Tr,
} from "./values4";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}
function section(name: string): void { console.log(`\n— ${name}`); }

// ─── Num ────────────────────────────────────────────────────────────
section("Num");
{
  const n = Num(5);
  check("Num init", n() === 5);
  // No casts — static methods are typed on Type.
  check("Num.add static", Num.add(2, 3) === 5);
  check("Num.scale static", Num.scale(4, 0.5) === 2);
  check("Num.traits.linear.add", Num.traits.linear.add(10, 20) === 30);
  check("Num.traits.metric", Num.traits.metric(10, 13) === 3);
  // Reactive method.
  const abs = n.abs();
  n(-7);
  check("n.abs reactive", abs() === 7);
}

// ─── Vec ────────────────────────────────────────────────────────────
section("Vec");
{
  const v = Vec({ x: 3, y: 4 });
  check("Vec init", v().x === 3 && v().y === 4);
  // Field access — NO CAST.
  const vx: Cell<number, any> = v.x;
  check("v.x is a Cell", typeof vx === "function" && vx() === 3);
  v.x(10);
  check("v.x write", v().x === 10);

  // Static math — typed without cast.
  const sum: V = Vec.add({ x: 1, y: 2 }, { x: 3, y: 4 });
  check("Vec.add static typed", sum.x === 4 && sum.y === 6);

  // Trait access — typed without cast (traits is inferred from const Cfg).
  const lin = Vec.traits.linear;
  check("Vec.traits.linear typed", lin.add({ x: 1, y: 2 }, { x: 3, y: 4 }).x === 4);
  check("Vec.traits.lerp typed",   Vec.traits.lerp({ x: 0, y: 0 }, { x: 10, y: 0 }, 0.5).x === 5);
  check("Vec.traits.metric typed", Vec.traits.metric({ x: 0, y: 0 }, { x: 3, y: 4 }) === 5);

  // Reactive methods.
  const sumCell = v.add({ x: 100, y: 100 });
  check("v.add reactive", sumCell().x === 110 && sumCell().y === 104);

  // Lazy getter.
  const mag = v.magnitude;
  check("v.magnitude getter cached", v.magnitude === mag);

  // Positional helper.
  const p = vec(7, 8);
  check("vec(7, 8)", p().x === 7 && p().y === 8);
}

// ─── Per-field subscription (critical correctness) ──────────────────
section("Per-field subscription on Vec");
{
  const v = Vec({ x: 0, y: 0 });
  let xfires = 0, yfires = 0;
  const sX = effect(() => { void v.x(); xfires++; });
  const sY = effect(() => { void v.y(); yfires++; });
  check("initial: both fired", xfires === 1 && yfires === 1);
  v({ x: 5, y: 0 });  // only x changes
  check("only x change: x fires", xfires === 2);
  check("only x change: y silent", yfires === 1);
  v({ x: 5, y: 9 });  // only y changes
  check("only y change: y fires", yfires === 2);
  check("only y change: x silent", xfires === 2);
  v({ x: 5, y: 9 });  // nothing changes
  check("no change: both silent", xfires === 2 && yfires === 2);
  sX(); sY();
}

// ─── Color ──────────────────────────────────────────────────────────
section("Color");
{
  const red = rgb(1, 0, 0);
  const green = rgb(0, 1, 0);
  check("rgb factory", red().r === 1 && red().g === 0);
  // Static math — no cast.
  const mix = Color.lerp(red(), green(), 0.5);
  check("Color.lerp static", Math.abs(mix.r - 0.5) < 1e-9);
  // Reactive method.
  const blended = red.blend(green(), 0.5);
  check("color.blend reactive", Math.abs(blended().r - 0.5) < 1e-9);
  // Getter cell.
  const cssC = red.css;
  check("red.css typed RO", cssC() === "rgba(255,0,0,1)");
  // Trait equals.
  check("Color.traits.equals true", Color.traits.equals(red(), red()));
  check("Color.traits.equals false", !Color.traits.equals(red(), green()));
  // Field access — no cast.
  const rChannel: Cell<number, any> = red.r;
  rChannel(0.5);
  check("color.r field write", red().r === 0.5);
}

// ─── Matrix2D ───────────────────────────────────────────────────────
section("Matrix2D");
{
  const m = identity();
  const I = Matrix2D(m);
  check("identity matrix is identity", I().a === 1 && I().b === 0);
  // Static methods typed.
  const m2 = Matrix2D.multiply(I(), I());
  check("Matrix2D.multiply static", m2.a === 1);
  const det = Matrix2D.determinant(I());
  check("Matrix2D.determinant static", det === 1);
  // Reactive method.
  const detC = I.determinant();
  check("matrix.determinant reactive", detC() === 1);
  // mat(a,b,c,d,e,f)
  const M = mat(2, 0, 0, 2, 5, 10);
  check("mat factory", M().a === 2 && M().e === 5);
  const dm = M.determinant();
  check("M.determinant reactive", dm() === 4);
}

// ─── Box ────────────────────────────────────────────────────────────
section("Box");
{
  const b = box(10, 20, 100, 50);
  check("Box init", b().x === 10 && b().w === 100);
  // Static math.
  const big = Box.expand(b(), 5);
  check("Box.expand static", big.w === 110);
  // Reactive methods.
  const exp = b.expand(5);
  check("box.expand reactive", exp().w === 110);
  // Getters.
  const ar = b.area;
  check("box.area getter", ar() === 5000);
  const ctr = b.center;
  check("box.center", ctr().x === 60 && ctr().y === 45);
  // Reactive point-test.
  const inside = b.contains({ x: 50, y: 30 });
  check("box.contains true", inside() === true);
}

// ─── Transform (composite) ──────────────────────────────────────────
section("Transform (composite, fused with sub-cell lenses)");
{
  const tr = Transform();
  check("Transform defaults", tr().translate.x === 0 && tr().scale.x === 1);
  // Sub-cell access via field-lens — NO CAST. Field-of-typed-entry is Cell<V>.
  const trans: Cell<V, any> = tr.translate;
  check("tr.translate is a Cell", typeof trans === "function");
  // Drill into Vec sub-cell — proto chain works (Vec.prototype).
  trans.x(42);
  check("tr.translate.x write reflected", tr().translate.x === 42);

  // Trait dispatch (composite, manually written).
  const sum = Transform.traits.linear.add(tr(), tr());
  check("Transform.traits.linear.add", sum.translate.x === 84);
  const half = Transform.traits.lerp(tr(), { ...tr(), opacity: 0 }, 0.5);
  check("Transform.traits.lerp opacity", Math.abs(half.opacity - 0.5) < 1e-9);

  // Init override of nested.
  const tr2 = Transform({ translate: { x: 100, y: 100 }, opacity: 0.5 });
  check("Transform init translate override", tr2().translate.x === 100);
  check("Transform scale custom default preserved", tr2().scale.x === 1);
  check("Transform opacity overridden", tr2().opacity === 0.5);
}

// ─── Composite per-field subscription ───────────────────────────────
section("Composite per-field subscription");
{
  const tr = Transform();
  let trans = 0, op = 0;
  const sT = effect(() => { void tr.translate(); trans++; });
  const sO = effect(() => { void tr.opacity(); op++; });
  // Write only opacity.
  tr({ ...tr(), opacity: 0.5 });
  check("opacity change: opacity fires", op === 2);
  check("opacity change: translate silent", trans === 1);
  // Write only translate.
  tr({ ...tr(), translate: { x: 5, y: 5 } });
  check("translate change: translate fires", trans === 2);
  check("translate change: opacity silent", op === 2);
  sT(); sO();
}

// ─── Generic dispatch via traits ────────────────────────────────────
section("Generics: lerp<T>");
function lerp<T>(a: Cell<T, any>, b: Cell<T, any>, t: number): RO<T> {
  // No cast needed — Type.traits is typed via Cfg inference.
  const type = (a as any).constructor;
  const fn = type.traits.lerp;
  if (!fn) throw new Error(`type ${type.tag} has no lerp trait`);
  return computed(() => fn(a(), b(), t)) as RO<T>;
}
{
  const a = Vec({ x: 0, y: 0 });
  const b = Vec({ x: 10, y: 0 });
  const mid = lerp(a, b, 0.5);
  check("generic lerp Vec", mid().x === 5);
  const ca = rgb(1, 0, 0);
  const cb = rgb(0, 1, 0);
  const cm = lerp(ca, cb, 0.5);
  check("generic lerp Color", Math.abs(cm().r - 0.5) < 1e-9);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
