// _cell5.test.ts — smoke test for cell5/values5
import { signal, computed, effect, batch, struct, type Cell } from "./cell5";
import { Vec, Transform, Num, Color, rgb, type V, type Tr } from "./values5";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

// Bare primitives — methods NOT on bare signals; use free fns
{
  const s = signal(5);
  check("signal read/write", s() === 5 && (s(10), s() === 10));
  check("peek method", s.peek() === 10);
  const c = computed(() => s() * 2);
  s(3);
  check("computed reactive", c() === 6);
}

// Vec — fused, field lenses, methods
{
  const v = Vec({ x: 3, y: 4 });
  check("Vec init", v().x === 3);
  check("v.x field", v.x() === 3);
  v.x(99);
  check("v.x write", v().x === 99);
  // Static math
  check("Vec.add static", Vec.add({ x: 1, y: 2 }, { x: 3, y: 4 }).x === 4);
  // Reactive method
  const sum = v.add({ x: 1, y: 1 });
  check("v.add reactive", sum().x === 100 && sum().y === 5);
  // Trait
  check("Vec.traits.linear.add", Vec.traits.linear.add({ x: 1, y: 2 }, { x: 3, y: 4 }).x === 4);
  // typeOf via constructor
  check("v.constructor === Vec", (v as any).constructor === Vec);
}

// Per-field subscription
{
  const v = Vec({ x: 0, y: 0 });
  let xfires = 0, yfires = 0;
  const sX = effect(() => { void v.x(); xfires++; });
  const sY = effect(() => { void v.y(); yfires++; });
  v({ x: 1, y: 0 });  // only x changes
  check("only x change: y silent", yfires === 1 && xfires === 2);
  v({ x: 1, y: 99 });  // only y changes
  check("only y change: x silent", xfires === 2 && yfires === 2);
  sX(); sY();
}

// Transform composite
{
  const tr = Transform();
  check("Transform translate default", tr().translate.x === 0);
  check("Transform scale custom default via Type.with", tr().scale.x === 1);
  (tr.translate as Cell<V>).x(50);
  check("nested write", tr().translate.x === 50);
  check("Transform.traits.linear.add", Transform.traits.linear.add(tr(), tr()).translate.x === 100);
}

// raw() chainable plain math
{
  const v = Vec({ x: 5, y: 5 });
  // Mutates the chain handle. Calling .value extracts.
  const result: V = v.raw().add({ x: 1, y: 1 }).sub({ x: 2, y: 0 }).value;
  check("raw() chain produces plain V", result.x === 4 && result.y === 6);
  // From the Type:
  const result2: V = Vec.chain({ x: 0, y: 0 }).add({ x: 3, y: 4 }).value;
  check("Vec.chain(v) static", result2.x === 3 && result2.y === 4);
}

// follow + reactive composition — methods on every signal
{
  const a = signal(1);
  const b = signal(2);
  const d = a.follow(b);
  check("follow initial", a() === 2);
  b(99);
  check("follow live", a() === 99);
  d();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
