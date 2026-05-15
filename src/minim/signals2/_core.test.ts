// Quick smoke for core.ts (merged engine + struct).
import { signal, computed, effect, struct, type Cell } from "./core";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

// Bare
const s = signal(5);
check("signal read", s() === 5);
s(10);
check("signal write", s() === 10);
check("signal.peek", s.peek() === 10);

// Struct
interface V { x: number; y: number }
const Vec = struct({
  tag: "Vec",
  value: { x: 0, y: 0 } as V,
  methods: {
    add: (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y }),
    scale: (a: V, k: number): V => ({ x: a.x * k, y: a.y * k }),
  },
  traits: {
    linear: { add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }), sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y }), scale: (a, k) => ({ x: a.x * k, y: a.y * k }) },
  },
});

const v = Vec({ x: 3, y: 4 });
check("Vec init", v().x === 3);
check("v.x lens", v.x() === 3);
v.x(99);
check("v.x write", v().x === 99);

const sum = v.add({ x: 1, y: 1 });
check("v.add reactive", sum().x === 100);

const chain: V = v.raw().add({ x: 1, y: 1 }).scale(2).value;
check("raw chain", chain.x === 200 && chain.y === 10);

check("Vec.traits.linear.add", Vec.traits.linear.add({ x: 1, y: 2 }, { x: 3, y: 4 }).x === 4);

// Per-field subscription
let xfires = 0, yfires = 0;
const v2 = Vec({ x: 0, y: 0 });
const sX = effect(() => { void v2.x(); xfires++; });
const sY = effect(() => { void v2.y(); yfires++; });
v2({ x: 5, y: 0 });
check("only x change: y silent", yfires === 1 && xfires === 2);
sX(); sY();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
