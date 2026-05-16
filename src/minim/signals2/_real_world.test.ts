// _real_world.test.ts — real-world correctness scenarios we haven't tested.

import { signal, computed, effect, batch, struct, type Cell, follow, mirror, lens } from "./signals";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}
function section(name: string): void { console.log(`\n— ${name}`); }

interface V { x: number; y: number }
const vAdd = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
const vSub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
const vScale = (a: V, k: number): V => ({ x: a.x * k, y: a.y * k });
const vLerp = (a: V, b: V, t: number): V => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

const Vec = struct({
  tag: "Vec", value: { x: 0, y: 0 } as V,
  methods: { add: vAdd, sub: vSub, scale: vScale, lerp: vLerp },
});

// ─────────────────────────────────────────────────────────────────
section("Cycle detection — effect that writes to its own dep");
// ─────────────────────────────────────────────────────────────────
{
  const s = signal(0);
  // alien's algorithm should detect / handle this
  let iterations = 0;
  let blew = false;
  try {
    const stop = effect(() => {
      iterations++;
      if (s.value < 5 && iterations < 100) s.value = s.value + 1;
    });
    stop();
  } catch (e) {
    blew = true;
  }
  check("doesn't infinite-loop", !blew && iterations < 100);
  // We don't make claims about exact behavior — just that it terminates.
}

// ─────────────────────────────────────────────────────────────────
section("Untracked reads via peek()");
// ─────────────────────────────────────────────────────────────────
{
  const s1 = signal(1);
  const s2 = signal(10);
  let fires = 0;
  const stop = effect(() => {
    fires++;
    s1.value;       // tracked
    s2.peek();      // NOT tracked
  });
  check("initial run", fires === 1);
  s1.value = 2;
  check("s1 change fires (tracked)", fires === 2);
  s2.value = 20;
  check("s2 change does NOT fire (peeked)", fires === 2);
  stop();
}

// ─────────────────────────────────────────────────────────────────
section("Conditional dep tracking — flip-flopping");
// ─────────────────────────────────────────────────────────────────
{
  const which = signal(true);
  const a = signal(1);
  const b = signal(10);
  let result = 0;
  const stop = effect(() => {
    result = which.value ? a.value : b.value;
  });
  check("initial result = a", result === 1);
  a.value = 5;
  check("a change tracked", result === 5);
  b.value = 100;
  check("b change ignored (not tracked)", result === 5);
  which.value = false;
  check("flip: now uses b", result === 100);
  a.value = 999;
  check("a no longer tracked", result === 100);
  b.value = 200;
  check("b now tracked", result === 200);
  stop();
}

// ─────────────────────────────────────────────────────────────────
section("Computed chain depth");
// ─────────────────────────────────────────────────────────────────
{
  const root = signal(1);
  const c1 = computed(() => root.value + 1);
  const c2 = computed(() => c1.value * 2);
  const c3 = computed(() => c2.value - 5);
  const c4 = computed(() => c3.value * c3.value);
  check("c4 initial", c4.value === ((1 + 1) * 2 - 5) ** 2);
  root.value = 10;
  check("c4 after root change", c4.value === ((10 + 1) * 2 - 5) ** 2);
}

// ─────────────────────────────────────────────────────────────────
section("Effect cleanup is called");
// ─────────────────────────────────────────────────────────────────
{
  const s = signal(0);
  let setupCount = 0, teardownCount = 0;
  const stop = effect(() => {
    setupCount++;
    s.value;
    return () => { teardownCount++; };
  });
  check("setup once on initial", setupCount === 1);
  check("no teardown yet", teardownCount === 0);
  s.value = 1;
  check("re-run: teardown of previous", teardownCount === 1);
  check("setup of new", setupCount === 2);
  s.value = 2;
  check("teardown of 2nd", teardownCount === 2);
  stop();
  check("final teardown on dispose", teardownCount === 3);
}

// ─────────────────────────────────────────────────────────────────
section("Many cells — independent subscription");
// ─────────────────────────────────────────────────────────────────
{
  const cells = Array.from({ length: 100 }, (_, i) => Vec({ x: i, y: i }));
  const fires = new Array(100).fill(0);
  const disposers = cells.map((c, i) => effect(() => { void c.value; fires[i]++; }));
  check("all 100 effects fired once initially", fires.every(f => f === 1));
  // Write to cell 42 only
  cells[42].value = { x: 99, y: 99 };
  check("only cell-42 effect fired (per-cell isolation)", fires[42] === 2);
  check("others still at 1", fires[41] === 1 && fires[43] === 1);
  disposers.forEach(d => d());
}

// ─────────────────────────────────────────────────────────────────
section("Per-field subscription across composite types");
// ─────────────────────────────────────────────────────────────────
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
    value: { translate: Vec, scale: Vec.with({ x: 1, y: 1 }), rotate: 0, opacity: 1 },
    methods: { add: trAdd },
  });

  const tr = Transform();
  let transFires = 0, scaleFires = 0, opFires = 0;
  const sT = effect(() => { void (tr.translate as Cell<V>).value; transFires++; });
  const sS = effect(() => { void (tr.scale as Cell<V>).value; scaleFires++; });
  const sO = effect(() => { void (tr.opacity as Cell<number>).value; opFires++; });

  tr.value = { ...tr.value, opacity: 0.5 };
  check("opacity change fires opacity", opFires === 2);
  check("opacity change does NOT fire translate", transFires === 1);
  check("opacity change does NOT fire scale", scaleFires === 1);

  // Drill in: write through nested sub-lens
  (tr.translate as Cell<V>).x.value = 50;
  check("translate.x write fires translate", transFires === 2);
  check("translate.x write does NOT fire opacity", opFires === 2);

  sT(); sS(); sO();
}

// ─────────────────────────────────────────────────────────────────
section("Batching across many writes");
// ─────────────────────────────────────────────────────────────────
{
  const cells = Array.from({ length: 10 }, () => signal(0));
  const sums: number[] = [];
  const stop = effect(() => {
    sums.push(cells.reduce((acc, c) => acc + c.value, 0));
  });
  check("initial: sum = 0", sums.length === 1 && sums[0] === 0);
  batch(() => {
    for (let i = 0; i < 10; i++) cells[i].value = i + 1;
  });
  check("batched: ran effect ONCE", sums.length === 2);
  check("batched: final sum = 55", sums[1] === 55);
  stop();
}

// ─────────────────────────────────────────────────────────────────
section("follow / mirror lifecycle");
// ─────────────────────────────────────────────────────────────────
{
  const a = signal(1);
  const b = signal(2);
  // a follows b
  const dispose1 = follow(a, b);
  check("a takes b's value", a.value === 2);
  b.value = 5;
  check("a updates on b's change", a.value === 5);
  // Dispose, then verify decoupled
  dispose1();
  b.value = 999;
  check("after dispose: a no longer follows", a.value === 5);

  // Mirror
  const c = signal("hi");
  const d = signal("bye");
  const dispose2 = mirror(c, d);
  check("mirror: c wins initially", d.value === "hi");
  d.value = "yes";
  check("d → c", c.value === "yes");
  c.value = "no";
  check("c → d", d.value === "no");
  dispose2();
}

// ─────────────────────────────────────────────────────────────────
section("Computed: lazy evaluation — unread = no run");
// ─────────────────────────────────────────────────────────────────
{
  const s = signal(0);
  let runs = 0;
  const c = computed(() => { runs++; return s.value * 2; });
  check("computed not run yet", runs === 0);
  c.value;
  check("computed run once on first read", runs === 1);
  c.value;
  check("computed cached on second read (same deps)", runs === 1);
  s.value = 5;
  check("write triggers no eager re-eval", runs === 1);  // alien is pull-based
  c.value;
  check("read after write re-evals", runs === 2);
}

// ─────────────────────────────────────────────────────────────────
section("Lens — bidirectional value flow");
// ─────────────────────────────────────────────────────────────────
{
  const c = signal(20);
  const f = lens(
    () => c.value * 9 / 5 + 32,           // celsius → fahrenheit
    (fv) => { c.value = (fv - 32) * 5 / 9; },
  );
  check("lens read: 68°F", Math.abs(f.value - 68) < 1e-9);
  f.value = 32;  // set fahrenheit
  check("lens write: c becomes 0°C", Math.abs(c.value - 0) < 1e-9);
  c.value = 100;
  check("c write reflects in lens: 212°F", Math.abs(f.value - 212) < 1e-9);
}

// ─────────────────────────────────────────────────────────────────
section("Generic functions across Cell<T> with traits");
// ─────────────────────────────────────────────────────────────────
{
  // A real generic — mean of N cells given a Linear trait on the type.
  function mean<T>(...cells: Cell<T, any>[]): Cell<T, any> {
    if (cells.length === 0) throw new Error("mean needs cells");
    const type = (cells[0] as any).constructor;
    const lin = type.traits.linear;
    const n = cells.length;
    const inv = 1 / n;
    return computed(() => {
      let acc = cells[0].value;
      for (let i = 1; i < n; i++) acc = lin.add(acc, cells[i].value);
      return lin.scale(acc, inv);
    }) as any;
  }

  // We need Vec to have traits for this. Re-construct:
  const VecT = struct({
    tag: "Vec",
    value: { x: 0, y: 0 } as V,
    methods: { add: vAdd, sub: vSub, scale: vScale, lerp: vLerp },
    traits: { linear: { add: vAdd, sub: vSub, scale: vScale } satisfies any },
  });
  const a = VecT({ x: 1, y: 2 });
  const b = VecT({ x: 3, y: 4 });
  const c = VecT({ x: 5, y: 6 });
  const avg = mean(a, b, c);
  check("mean of 3 Vecs", Math.abs(avg.value.x - 3) < 1e-9 && Math.abs(avg.value.y - 4) < 1e-9);
  b.value = { x: 30, y: 40 };
  check("mean reactive on member write", Math.abs(avg.value.x - 12) < 1e-9 && Math.abs(avg.value.y - 16) < 1e-9);
}

// ─────────────────────────────────────────────────────────────────
section("Type inference quality (compile-time)");
// ─────────────────────────────────────────────────────────────────
{
  const v = Vec({ x: 1, y: 2 });
  // These should all infer without `as` casts:
  const vVal: V = v.value;                                                   // { x: number, y: number }
  const xLens: Cell<number> = v.x;                                           // Cell<number>
  const xVal: number = v.x.value;                                            // number
  const sumCell = v.add({ x: 1, y: 1 });                                     // Computed<V>
  const sumVal: V = sumCell.value;
  const chain = Vec.chain({ x: 0, y: 0 }).add({ x: 1, y: 2 }).value;         // V
  const stat: V = Vec.add({ x: 1, y: 2 }, { x: 3, y: 4 });                   // V (Vec method static)

  void vVal; void xLens; void xVal; void sumCell; void sumVal; void chain; void stat;
  check("type inference compiles clean", true);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
