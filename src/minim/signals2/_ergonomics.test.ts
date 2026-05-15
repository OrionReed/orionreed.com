// _ergonomics.test.ts — exercise the full surface as a realistic user
// would. Goal: zero `(as any)` casts, no friction. If inference is
// missing somewhere, that's a finding.

import {
  signal,
  computed,
  effect,
  batch,
  struct,
  typeOf,
  type Cell,
  type RO,
  type Linear,
  type Lerp,
  type Type,
} from "./core";

// ─── Values: define types like a normal user ────────────────────────

interface V { x: number; y: number }

// Pure-fn implementations declared once, referenced from `methods`
// (lifted reactive + static plain) AND `traits` (generic dispatch).
const vAdd:   Linear<V>["add"]   = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const vSub:   Linear<V>["sub"]   = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const vScale: Linear<V>["scale"] = (a, k) => ({ x: a.x * k, y: a.y * k });
const vLerp:  Lerp<V>  = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const vPerp = (a: V): V => ({ x: -a.y, y: a.x });

const Vec = struct({
  tag: "Vec",
  value: { x: 0, y: 0 } as V,
  methods: { add: vAdd, sub: vSub, scale: vScale, lerp: vLerp, perp: vPerp },
  getters: {
    magnitude(this: Cell<V>) {
      const self = this;
      return computed(() => Math.hypot(self().x, self().y));
    },
  },
  traits: {
    linear: { add: vAdd, sub: vSub, scale: vScale } satisfies Linear<V>,
    lerp: vLerp,
    metric: (a: V, b: V) => Math.hypot(a.x - b.x, a.y - b.y),
  },
});

// ─── Common usage shapes ────────────────────────────────────────────

let assertCount = 0;
function expect<T>(name: string, value: T, want: T): void {
  const equal = JSON.stringify(value) === JSON.stringify(want);
  if (equal) { console.log(`  ✓ ${name}`); assertCount++; }
  else { console.error(`  ✗ ${name}: got ${JSON.stringify(value)}, want ${JSON.stringify(want)}`); process.exit(1); }
}

console.log("\n— Construction & whole reads/writes\n");
{
  const p: Cell<V, any> = Vec({ x: 1, y: 2 });
  expect("Vec({x,y}) construct", p(), { x: 1, y: 2 });
  p({ x: 5, y: 5 });
  expect("p({...}) whole write", p(), { x: 5, y: 5 });
}

console.log("\n— Field access (lens) — types should infer\n");
{
  const p = Vec({ x: 3, y: 4 });
  // Inferred: p.x is Cell<number>. No cast needed.
  const x: Cell<number, any> = p.x;
  const y: Cell<number, any> = p.y;
  expect("p.x()", x(), 3);
  expect("p.y()", y(), 4);
  p.x(10);
  expect("p.x(10) write", p().x, 10);
}

console.log("\n— Lifted reactive methods (return RO<R>)\n");
{
  const p = Vec({ x: 1, y: 2 });
  // Inferred: p.add returns RO<V>
  const sum: RO<V> = p.add({ x: 3, y: 4 });
  expect("p.add(b) returns Cell-of-V", sum(), { x: 4, y: 6 });
  p({ x: 10, y: 20 });
  expect("reactive — re-reads updated parent", sum(), { x: 13, y: 24 });
}

console.log("\n— Static plain math on Type (zero allocation)\n");
{
  // Inferred: Vec.add is (a: V, b: V) => V — same signature as user wrote.
  const out: V = Vec.add({ x: 1, y: 2 }, { x: 3, y: 4 });
  expect("Vec.add(a, b) plain", out, { x: 4, y: 6 });
}

console.log("\n— Trait dispatch (well-typed via CommonTraits<T>)\n");
{
  // Vec.traits.linear is typed as Linear<V> because of CommonTraits<T>
  // declaration on the struct config. The `satisfies Linear<V>` above
  // also enforces conformance.
  const r1: V = Vec.traits.linear.add({ x: 1, y: 2 }, { x: 3, y: 4 });
  expect("Vec.traits.linear.add typed", r1, { x: 4, y: 6 });
  const r2: number = Vec.traits.metric!({ x: 0, y: 0 }, { x: 3, y: 4 });
  expect("Vec.traits.metric typed number", r2, 5);
}

console.log("\n— Chain handle: fluent plain math (no allocations per step)\n");
{
  const p = Vec({ x: 5, y: 5 });
  // `p.raw()` returns Chain<V, ...> — methods typed.
  const r1: V = p.raw().add({ x: 1, y: 1 }).sub({ x: 2, y: 0 }).value;
  expect("p.raw().add().sub().value", r1, { x: 4, y: 6 });
  // `Vec.chain(v)` for explicit plain values.
  const r2: V = Vec.chain({ x: 0, y: 0 }).add({ x: 3, y: 4 }).value;
  expect("Vec.chain(v).add(b).value", r2, { x: 3, y: 4 });
}

console.log("\n— Generic functions over Cell<T, any> with typed traits\n");
{
  // A real generic: lerp between two same-typed cells, returns reactive RO<T>.
  function lerp<T>(a: Cell<T, any>, b: Cell<T, any>, t: number): RO<T> {
    const type = typeOf(a) as any;   // Type<T, any> — the one place where users still need a cast
    const fn = type.traits.lerp as ((a: T, b: T, t: number) => T) | undefined;
    if (!fn) throw new Error(`type ${type.tag} has no lerp`);
    return computed(() => fn(a(), b(), t)) as unknown as RO<T>;
  }
  const a = Vec({ x: 0, y: 0 });
  const b = Vec({ x: 10, y: 10 });
  const mid = lerp(a, b, 0.5);
  expect("generic lerp", mid(), { x: 5, y: 5 });
}

console.log("\n— Composite struct: Transform (Vec sub-cells via field-lens)\n");
{
  interface Tr { translate: V; scale: V; rotate: number; opacity: number }

  const trAdd = (a: Tr, b: Tr): Tr => ({
    translate: vAdd(a.translate, b.translate),
    scale:     vAdd(a.scale, b.scale),
    rotate:    a.rotate + b.rotate,
    opacity:   a.opacity + b.opacity,
  });

  const Transform = struct({
    tag: "Transform",
    value: {
      translate: Vec,                       // Vec sub-cell via field-lens
      scale:     Vec.with({ x: 1, y: 1 }),  // override default
      rotate:    0,
      opacity:   1,
    },
    methods: { add: trAdd },
    traits: {
      linear: { add: trAdd, sub: (_a, _b) => _a, scale: (a, k) => ({ ...a, rotate: a.rotate * k, opacity: a.opacity * k }) } satisfies Linear<Tr>,
    },
  });

  const tr = Transform();
  expect("Transform defaults", tr(), { translate: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotate: 0, opacity: 1 });

  // Drill into sub-cell. tr.translate is Cell<V> — inherits Vec.prototype methods.
  // Sub-lens nesting: tr.translate.x is also a Cell<number>.
  const tx: Cell<number, any> = tr.translate.x;
  tx(50);
  expect("tr.translate.x(50) writes through", tr().translate.x, 50);

  // Type guard.
  expect("Vec.is(tr.translate)", Vec.is(tr.translate as any), true);
  expect("Vec.is(tr)", Vec.is(tr as any), false);
}

console.log("\n— Animation loop pattern (effect + writes)\n");
{
  const v = Vec({ x: 0, y: 0 });
  const log: V[] = [];
  const stop = effect(() => { log.push(v()); });
  // Tween 5 frames, batched per step
  for (let i = 1; i <= 5; i++) {
    batch(() => {
      v({ x: i, y: i * 2 });
    });
  }
  stop();
  expect("effect captured 6 states (initial + 5)", log.length, 6);
  expect("final value", log[5], { x: 5, y: 10 });
}

console.log("\n— Composition: cell.follow(other) one-way binding\n");
{
  const a = signal({ x: 0, y: 0 });
  const b = signal({ x: 99, y: 99 });
  const stop = a.follow(b);
  expect("follow initial copy", a(), { x: 99, y: 99 });
  b({ x: 1, y: 2 });
  expect("follow live update", a(), { x: 1, y: 2 });
  stop();
}

console.log("\n— Two-way: cell.mirror(other)\n");
{
  const a = signal("a");
  const b = signal("b");
  const stop = a.mirror(b);
  expect("mirror initial: a wins", b(), "a");
  b("d");
  expect("mirror b→a", a(), "d");
  stop();
}

console.log(`\n${assertCount} assertions passed`);
