// _values_new.test.ts — verify migrated values work.
import { Vec, Num, Color, Transform, vec, rgb, mean, lerp, distance } from "./values_new";
import { effect, typeOf } from "./signals";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

// ── Num ──
const n = Num(5);
check("Num value", n.value === 5);
check("Num.add reactive", (n as any).add(3).value === 8);
check("Num.clamp", (n as any).clamp(0, 4).value === 4);
check("Num.add static", Num.add(2, 3) === 5);
check("Num.traits.linear", (Num as any).traits.linear.add(1, 2) === 3);

// ── Vec ──
const v = vec(3, 4);
check("Vec field x", (v as any).x.value === 3);
check("Vec field y", (v as any).y.value === 4);
check("Vec.add reactive", (v as any).add({ x: 1, y: 1 }).value.x === 4);
check("Vec getter magnitude", (v as any).magnitude === 5);
check("Vec.add static", Vec.add({ x: 1, y: 2 }, { x: 3, y: 4 }).x === 4);

// Field-lens write
(v as any).x.value = 10;
check("Vec.x write", v.value.x === 10);

// ── Color ──
const c = rgb(0.5, 0.25, 0.75);
check("Color luminance", typeof (c as any).luminance === "number");
check("Color css", typeof (c as any).css === "string");

// ── Transform composite ──
const tr = Transform();
check("Transform defaults", tr.value.translate.x === 0 && tr.value.scale.x === 1);
(tr as any).translate.x.value = 50;
check("nested write", tr.value.translate.x === 50);

const tr2 = (tr as any).add({ translate: { x: 10, y: 0 }, scale: { x: 0, y: 0 }, origin: { x: 0, y: 0 }, rotate: 0, opacity: 0 });
check("Transform.add reactive", tr2.value.translate.x === 60);

// ── Reactive effects ──
let fires = 0;
const stop = effect(() => { void v.value; fires++; });
v.value = { x: 99, y: 0 };
check("effect fires", fires === 2);
stop();

// ── Generic mean ──
const a = vec(0, 0), b = vec(10, 10), d = vec(20, 20);
const m = mean(a, b, d);
check("mean reads", m.value.x === 10);

// ── typeOf dispatch ──
check("typeOf(v).traits.linear", (typeOf(v) as any).traits.linear.add({ x: 1, y: 1 }, { x: 2, y: 3 }).x === 3);
check("typeOf(n).traits.lerp", (typeOf(n) as any).traits.lerp(0, 10, 0.5) === 5);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
