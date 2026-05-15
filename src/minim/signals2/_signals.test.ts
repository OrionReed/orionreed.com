// _signals.test.ts — verify merged signals.ts works.
import { signal, computed, effect, struct, type Cell, Lens, Signal, Computed } from "./signals";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

// Bare primitives
const s = signal(5);
check("signal.value", s.value === 5);
s.value = 10;
check("signal write", s.value === 10);

// Computed
const c = computed(() => s.value * 2);
check("computed", c.value === 20);

// Effect
let fires = 0;
const stop = effect(() => { void s.value; fires++; });
s.value = 1;
check("effect fires", fires === 2);
stop();

// Struct
interface V { x: number; y: number }
const Vec = struct({
  tag: "Vec",
  value: { x: 0, y: 0 } as V,
  methods: {
    add: (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y }),
    scale: (a: V, k: number): V => ({ x: a.x * k, y: a.y * k }),
  },
  traits: { linear: { add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }), sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y }), scale: (a, k) => ({ x: a.x * k, y: a.y * k }) } },
});

const v = Vec({ x: 3, y: 4 });
check("Vec construct", v.value.x === 3);
check("v instanceof Signal", v instanceof Signal);
check("v.x is Lens", v.x instanceof Lens);
check("v.x.value", v.x.value === 3);
v.x.value = 99;
check("v.x write", v.value.x === 99);

const sum = v.add({ x: 1, y: 1 });
check("v.add returns Computed", sum instanceof Computed);
check("v.add.value", sum.value.x === 100);

// Static
check("Vec.add static", Vec.add({ x: 1, y: 2 }, { x: 3, y: 4 }).x === 4);

// Chain
check("Vec.chain", Vec.chain({ x: 0, y: 0 }).add({ x: 1, y: 2 }).value.x === 1);
check("v.raw", v.raw().scale(2).value.x === 198);

// Composite
interface Tr { translate: V; scale: V; rotate: number; opacity: number }
const trAdd = (a: Tr, b: Tr): Tr => ({
  translate: { x: a.translate.x + b.translate.x, y: a.translate.y + b.translate.y },
  scale: { x: a.scale.x + b.scale.x, y: a.scale.y + b.scale.y },
  rotate: a.rotate + b.rotate,
  opacity: a.opacity + b.opacity,
});
const Transform = struct({
  tag: "Transform",
  value: { translate: Vec, scale: Vec.with({ x: 1, y: 1 }), rotate: 0, opacity: 1 },
  methods: { add: trAdd },
});
const tr = Transform();
check("Transform defaults", tr.value.translate.x === 0 && tr.value.scale.x === 1);
(tr.translate as Cell<V>).x.value = 50;
check("nested write", tr.value.translate.x === 50);

// Type guard
check("Vec.is(v) true", Vec.is(v));
check("Vec.is(tr) false", !Vec.is(tr as any));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
