// _struct3.test.ts — verify class-based struct.

import { signal, computed, effect, batch, struct, type Cell, Lens } from "./signals";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

interface V { x: number; y: number }
const vAdd = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
const vSub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
const vScale = (a: V, k: number): V => ({ x: a.x * k, y: a.y * k });
const vLerp = (a: V, b: V, t: number): V => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

const Vec = struct({
  tag: "Vec",
  value: { x: 0, y: 0 } as V,
  methods: { add: vAdd, sub: vSub, scale: vScale, lerp: vLerp },
  traits: { linear: { add: vAdd, sub: vSub, scale: vScale } satisfies any, lerp: vLerp },
});

console.log("\n— Construction & whole reads/writes");
{
  const v = Vec({ x: 3, y: 4 });
  check("Vec construct", v.value.x === 3 && v.value.y === 4);
  v.value = { x: 10, y: 20 };
  check("v.value = ...", v.value.x === 10);
  check("v.peek()", v.peek().x === 10);
}

console.log("\n— Field lens");
{
  const v = Vec({ x: 3, y: 4 });
  const x = v.x;
  check("v.x is Lens", x instanceof Lens);
  check("v.x.value read", x.value === 3);
  check("v.x identity stable", v.x === x);
  x.value = 99;
  check("v.x.value = ... writes through", v.value.x === 99);
}

console.log("\n— Per-field subscription");
{
  const v = Vec({ x: 0, y: 0 });
  let xfires = 0, yfires = 0;
  const sX = effect(() => { void v.x.value; xfires++; });
  const sY = effect(() => { void v.y.value; yfires++; });
  check("initial both fire", xfires === 1 && yfires === 1);
  v.value = { x: 5, y: 0 };  // only x changes
  check("only x change: x fires", xfires === 2);
  check("only x change: y silent", yfires === 1);
  v.value = { x: 5, y: 9 };  // only y changes
  check("only y change: y fires", yfires === 2);
  check("only y change: x silent", xfires === 2);
  sX(); sY();
}

console.log("\n— Reactive methods");
{
  const v = Vec({ x: 1, y: 2 });
  const sum = v.add({ x: 3, y: 4 });
  check("v.add returns Computed", sum.value.x === 4 && sum.value.y === 6);
  v.value = { x: 10, y: 20 };
  check("v.add re-evals", sum.value.x === 13 && sum.value.y === 24);
}

console.log("\n— Static math + chain");
{
  check("Vec.add static", Vec.add({ x: 1, y: 2 }, { x: 3, y: 4 }).x === 4);
  const v = Vec({ x: 5, y: 5 });
  const r = v.raw().add({ x: 1, y: 1 }).sub({ x: 2, y: 0 }).value;
  check("v.raw().add().sub().value", r.x === 4 && r.y === 6);
  const r2 = Vec.chain({ x: 0, y: 0 }).add({ x: 3, y: 4 }).value;
  check("Vec.chain(v).add(b)", r2.x === 3 && r2.y === 4);
}

console.log("\n— Type guard & traits");
{
  const v = Vec({ x: 1, y: 2 });
  const s = signal(0);
  check("Vec.is(v) true", Vec.is(v));
  check("Vec.is(signal) false", !Vec.is(s as any));
  check("Vec.traits.linear.add", (Vec.traits as any).linear.add({ x: 1, y: 2 }, { x: 3, y: 4 }).x === 4);
}

console.log("\n— Composite struct (Transform with Vec sub-cells)");
{
  interface Tr { translate: V; scale: V; rotate: number; opacity: number }
  const trAdd = (a: Tr, b: Tr): Tr => ({
    translate: vAdd(a.translate, b.translate),
    scale: vAdd(a.scale, b.scale),
    rotate: a.rotate + b.rotate,
    opacity: a.opacity + b.opacity,
  });
  const Transform = struct({
    tag: "Transform",
    value: {
      translate: Vec,
      scale: Vec.with({ x: 1, y: 1 }),
      rotate: 0,
      opacity: 1,
    },
    methods: { add: trAdd },
  });

  const tr = Transform();
  check("Transform defaults", tr.value.translate.x === 0 && tr.value.scale.x === 1);
  // tr.translate is a Vec-typed Lens with Vec methods copied onto it.
  // `Vec.is` is instanceof-based so returns false (a known trade);
  // but the API surface and behavior are Vec-shaped.
  check("tr.translate has Vec.add", typeof (tr.translate as any).add === "function");
  const txLens = (tr.translate as Cell<V>).x;
  txLens.value = 50;
  check("nested write through tr.translate.x", tr.value.translate.x === 50);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
