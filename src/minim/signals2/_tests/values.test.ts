// values.test.ts — value-type tests: Vec, Num, Color, Box, Transform.
//
// Covers:
//   - Chainable methods (vec.add(b).scale(2) returns Vec all the way)
//   - Reactive method args (Val<T>)
//   - Field access (.x, .y as typed lenses)
//   - Per-field subscription correctness
//   - derive(c => c.foo().bar()) — single-Computed chains
//   - classOf + traits + requireTraits dispatch
//   - Composite Transform with typed nested fields

import { signal, effect, computed, value, classOf, requireTraits } from "../engine";
import { vec, Vec, num, Num, rgb, Color, box, Box, transform, Transform } from "../values";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, info?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${info ? ` — ${info}` : ""}`); }
}
function section(name: string): void { console.log(`\n── ${name}`); }

// ════════════════════════════════════════════════════════════════════
section("Vec construction + read/write");
// ════════════════════════════════════════════════════════════════════
{
  const v = vec(3, 4);
  check("read .value", v.value.x === 3 && v.value.y === 4);
  v.value = { x: 10, y: 20 };
  check("write .value", v.value.x === 10);
  check("peek()", v.peek().x === 10);
}

// ════════════════════════════════════════════════════════════════════
section("Vec methods return Vec — chainable");
// ════════════════════════════════════════════════════════════════════
{
  const v = vec(1, 2);
  const r2 = v.add({ x: 10, y: 20 }).scale(2);
  check("chained: (1+10)*2", r2.value.x === 22 && r2.value.y === 44);
  v.value = { x: 0, y: 0 };
  check("re-derives on v change", r2.value.x === 20);
}

// ════════════════════════════════════════════════════════════════════
section("Reactive method args (Val<T> through brand)");
// ════════════════════════════════════════════════════════════════════
{
  const a = vec(0, 0);
  const b = vec(1, 1);
  const sum = a.add(b);
  check("initial: 0+1 = 1", sum.value.x === 1);
  b.value = { x: 5, y: 5 };
  check("re-derives on b change", sum.value.x === 5);
  a.value = { x: 10, y: 10 };
  check("re-derives on a change", sum.value.x === 15);
}

// ════════════════════════════════════════════════════════════════════
section("Computed as arg — also auto-subscribes");
// ════════════════════════════════════════════════════════════════════
{
  const a = vec(0, 0);
  const seed = vec(1, 1);
  const scaled = seed.scale(10);  // Computed-backed Vec
  const sum = a.add(scaled);
  check("initial: 0 + 10 = 10", sum.value.x === 10);
  seed.value = { x: 5, y: 5 };
  check("re-derives on seed change", sum.value.x === 50);
}

// ════════════════════════════════════════════════════════════════════
section("Thunk arg — auto-tracks via the lambda");
// ════════════════════════════════════════════════════════════════════
{
  const a = vec(0, 0);
  const k = signal(2);
  const result = a.scale(() => k.value * 10);
  a.value = { x: 1, y: 1 };
  check("initial: 1 × 20", result.value.x === 20);
  k.value = 5;
  check("k change: 1 × 50", result.value.x === 50);
}

// ════════════════════════════════════════════════════════════════════
section("Field access: v.x is a typed Num lens");
// ════════════════════════════════════════════════════════════════════
{
  const v = vec(3, 4);
  check("v.x reads", v.x.value === 3);
  v.x.value = 99;
  check("v.x writes propagate to v", v.value.x === 99);
  check("v.x identity stable", v.x === v.x);
  check("v.y !== v.x", v.y !== v.x);
  // v.x is a Num — has Num methods:
  check("v.x.add(1) reactive", v.x.add(1).value === 100);
}

// ════════════════════════════════════════════════════════════════════
section("Per-field subscription correctness");
// ════════════════════════════════════════════════════════════════════
{
  const v = vec(0, 0);
  let xfires = 0, yfires = 0;
  const sx = effect(() => { void v.x.value; xfires++; });
  const sy = effect(() => { void v.y.value; yfires++; });
  v.value = { x: 5, y: 0 };
  check("x change: x fires, y doesn't", xfires === 2 && yfires === 1);
  v.value = { x: 5, y: 7 };
  check("y change: y fires, x doesn't", xfires === 2 && yfires === 2);
  sx(); sy();
}

// ════════════════════════════════════════════════════════════════════
section("derive(c => c.foo().bar()) — single Computed");
// ════════════════════════════════════════════════════════════════════
{
  const v = vec(0, 0);
  let fires = 0;
  const r = v.derive(c => c.add({ x: 1, y: 1 }).scale(2).add({ x: 0, y: 0 }).scale(1));
  const stop = effect(() => { void r.value; fires++; });
  v.value = { x: 5, y: 5 };
  check("4-op chain: single re-fire", fires === 2);
  stop();
}

// ════════════════════════════════════════════════════════════════════
section("Equivalence: method chain vs derive (same observable behavior)");
// ════════════════════════════════════════════════════════════════════
{
  const v = vec(1, 2);
  const b = vec(10, 20);
  const m = v.add(b).scale(2);
  const d = v.derive(c => c.add(b).scale(2));
  check("initial values agree", m.value.x === d.value.x);
  b.value = { x: 100, y: 200 };
  check("after b change", m.value.x === d.value.x);
  v.value = { x: 0, y: 0 };
  check("after v change", m.value.x === d.value.x);
}

// ════════════════════════════════════════════════════════════════════
section("classOf + traits");
// ════════════════════════════════════════════════════════════════════
{
  const v = vec(3, 4);
  const klass = classOf(v);
  check("classOf returns Vec", klass === Vec);
  check("Vec.traits.linear typed", !!klass.traits?.linear);
  const sum = klass.traits!.linear!.add({ x: 1, y: 1 }, { x: 2, y: 3 });
  check("trait linear.add works", sum.x === 3);
}

// ════════════════════════════════════════════════════════════════════
section("requireTraits(cell, ...keys) — ergonomic dispatch");
// ════════════════════════════════════════════════════════════════════
{
  const v = vec(0, 0);
  const { linear, lerp } = requireTraits(v, "linear", "lerp");
  check("linear destructured + typed", linear.add({ x: 1, y: 2 }, { x: 3, y: 4 }).x === 4);
  check("lerp destructured + typed", lerp({ x: 0, y: 0 }, { x: 10, y: 10 }, 0.5).x === 5);

  // Missing trait throws:
  let threw = false;
  try { (requireTraits as any)(v, "linear", "nonexistent"); } catch { threw = true; }
  check("throws on missing trait", threw);
}

// ════════════════════════════════════════════════════════════════════
section("Transform: composite with typed nested fields");
// ════════════════════════════════════════════════════════════════════
{
  const tr = transform();
  check("default translate.x = 0", tr.value.translate.x === 0);
  check("default scale.x = 1", tr.value.scale.x === 1);
  tr.translate.x.value = 50;
  check("nested write through translate.x", tr.value.translate.x === 50);

  const tr2 = transform({ opacity: 0.5 });
  check("partial init", tr2.value.opacity === 0.5);
  check("other fields default", tr2.value.translate.x === 0);
}

// ════════════════════════════════════════════════════════════════════
section("Num operations");
// ════════════════════════════════════════════════════════════════════
{
  const n = num(5);
  check("Num.add(3)", n.add(3).value === 8);
  check("Num.clamp(0, 4)", n.clamp(0, 4).value === 4);
  check("Num.scale(2)", n.scale(2).value === 10);
  check("Num.add static", Num.add(2, 3) === 5);
}

// ════════════════════════════════════════════════════════════════════
section("Color");
// ════════════════════════════════════════════════════════════════════
{
  const c = rgb(0.5, 0.25, 0.75);
  check("rgb()", c.value.r === 0.5 && c.value.a === 1);
  check("luminance derived", typeof c.luminance.value === "number");
  const c2 = c.scale(2);
  check("scale → Color", c2.value.r === 1);
}

// ════════════════════════════════════════════════════════════════════
section("Box");
// ════════════════════════════════════════════════════════════════════
{
  const b = box(10, 20, 30, 40);
  check("box construct", b.value.x === 10 && b.value.w === 30);
  check("Box.area", b.area.value === 1200);
  check("Box.expand(5)", b.expand(5).value.w === 40);
}

// ════════════════════════════════════════════════════════════════════
section("Footgun: function-typed T (rare; documented)");
// ════════════════════════════════════════════════════════════════════
{
  // signal(fn) where fn is intended as a value — but Val<T> rule says
  // function = thunk. The signal becomes bound to the thunk's return.
  // This is an inherent ambiguity of the Val<T> rule. For real value
  // types in minim (Vec/Num/Color/Box/Transform), T is never a function,
  // so this is purely hypothetical.
  const fn = () => 99;
  const s = signal(fn);
  check("signal(fn): treated as thunk-bound", s.isBound);
  check("its value is fn's return", s.value === 99);
  s.unbind();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
