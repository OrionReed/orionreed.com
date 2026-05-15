// Bench: cell.ts (current) vs cell2.ts (flat + compose) vs cell3.ts (methods + traits) vs bare alien.
// Run: npx tsx src/minim/signals2/_proto.bench.ts

import { bench, group, run, do_not_optimize } from "mitata";

import { signal as aSig } from "./engine";

// ── cell.ts (current/legacy production prototype) ─────────────────
import { struct as struct1, cell as cell1 } from "./cell";
import { Vec as Vec1, Transform as Transform1 } from "./values";

// ── cell2.ts (v3: flat ops + compose synthesis) ───────────────────
import {
  signal as signal2,
  struct as struct2,
  typeOf as typeOf2,
} from "./cell2";

// ── cell3.ts (new: methods + traits split) ────────────────────────
import {
  signal as signal3,
  struct as struct3,
  typeOf as typeOf3,
} from "./cell3";

// ─── Set up Vec/Transform in each model ────────────────────────────

interface V { x: number; y: number }
interface Tr {
  translate: V; scale: V; rotate: number; opacity: number;
}

// cell2 Vec — flat ops on type
const Vec2 = struct2({
  tag: "Vec",
  value: { x: 0, y: 0 } as V,
  add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
  sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
  scale: (a, k) => ({ x: a.x * k, y: a.y * k }),
  lerp: (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }),
  metric: (a, b) => Math.hypot(a.x - b.x, a.y - b.y),
});
const Transform2 = struct2({
  tag: "Transform",
  value: { translate: Vec2, scale: Vec2({ x: 1, y: 1 }), rotate: 0, opacity: 1 },
  compose: ["add", "sub", "scale", "lerp", "metric", "equals"],
});

// cell3 Vec — methods + traits split
const v3add = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
const v3sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
const v3scale = (a: V, k: number): V => ({ x: a.x * k, y: a.y * k });
const v3lerp = (a: V, b: V, t: number): V => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const v3metric = (a: V, b: V): number => Math.hypot(a.x - b.x, a.y - b.y);

const Vec3 = struct3({
  tag: "Vec",
  value: { x: 0, y: 0 } as V,
  methods: { add: v3add, sub: v3sub, scale: v3scale, lerp: v3lerp },
  traits: { linear: { add: v3add, sub: v3sub, scale: v3scale }, lerp: v3lerp, metric: v3metric },
});

// cell3 Transform — manually composed traits (delegating to Vec3.traits)
const VLin = (Vec3.traits as any).linear;
const t3add = (a: Tr, b: Tr): Tr => ({
  translate: VLin.add(a.translate, b.translate),
  scale:     VLin.add(a.scale, b.scale),
  rotate:    a.rotate + b.rotate,
  opacity:   a.opacity + b.opacity,
});
const t3sub = (a: Tr, b: Tr): Tr => ({
  translate: VLin.sub(a.translate, b.translate),
  scale:     VLin.sub(a.scale, b.scale),
  rotate:    a.rotate - b.rotate,
  opacity:   a.opacity - b.opacity,
});
const t3scale = (a: Tr, k: number): Tr => ({
  translate: VLin.scale(a.translate, k),
  scale:     VLin.scale(a.scale, k),
  rotate:    a.rotate * k,
  opacity:   a.opacity * k,
});
const t3lerp = (a: Tr, b: Tr, t: number): Tr => ({
  translate: v3lerp(a.translate, b.translate, t),
  scale:     v3lerp(a.scale, b.scale, t),
  rotate:    a.rotate + (b.rotate - a.rotate) * t,
  opacity:   a.opacity + (b.opacity - a.opacity) * t,
});

const Transform3 = struct3({
  tag: "Transform",
  value: { translate: Vec3, scale: Vec3({ x: 1, y: 1 }), rotate: 0, opacity: 1 },
  traits: { linear: { add: t3add, sub: t3sub, scale: t3scale }, lerp: t3lerp },
});

// ── Construction ───────────────────────────────────────────────────

group("construct — Vec", () => {
  bench("bare alien aSig({x,y})", () => do_not_optimize(aSig({ x: 1, y: 2 }))).baseline(true);
  bench("cell.ts  Vec1({x,y})", () => do_not_optimize(Vec1({ x: 1, y: 2 })));
  bench("cell2.ts Vec2({x,y})", () => do_not_optimize(Vec2({ x: 1, y: 2 })));
  bench("cell3.ts Vec3({x,y})", () => do_not_optimize(Vec3({ x: 1, y: 2 })));
});

group("construct — Transform", () => {
  const init = { translate: { x: 0, y: 0 }, rotate: 0, scale: { x: 1, y: 1 }, opacity: 1 };
  const init3 = { translate: { x: 0, y: 0 }, rotate: 0, scale: { x: 1, y: 1 }, opacity: 1 };
  bench("bare alien aSig(tr)", () => do_not_optimize(aSig(init))).baseline(true);
  bench("cell.ts  Transform1(...)", () => do_not_optimize(Transform1({ ...init, origin: { x: 0, y: 0 } })));
  bench("cell2.ts Transform2(...)", () => do_not_optimize(Transform2(init)));
  bench("cell3.ts Transform3(...)", () => do_not_optimize(Transform3(init3)));
});

group("construct — bare cell", () => {
  bench("bare alien aSig(0)", () => do_not_optimize(aSig(0))).baseline(true);
  bench("cell.ts  cell1(0)", () => do_not_optimize(cell1(0)));
  bench("cell2.ts signal2(0)", () => do_not_optimize(signal2(0)));
  bench("cell3.ts signal3(0)", () => do_not_optimize(signal3(0)));
});

// ── Reads ──────────────────────────────────────────────────────────

group("read — Vec whole", () => {
  const a = aSig({ x: 5, y: 10 });
  const v1: any = Vec1({ x: 5, y: 10 });
  const v2: any = Vec2({ x: 5, y: 10 });
  const v3: any = Vec3({ x: 5, y: 10 });
  bench("bare alien a()", () => do_not_optimize(a())).baseline(true);
  bench("cell.ts  v1()", () => do_not_optimize(v1()));
  bench("cell2.ts v2()", () => do_not_optimize(v2()));
  bench("cell3.ts v3()", () => do_not_optimize(v3()));
});

group("read — Vec.x field", () => {
  const v1: any = Vec1({ x: 5, y: 10 });
  const v2: any = Vec2({ x: 5, y: 10 });
  const v3: any = Vec3({ x: 5, y: 10 });
  // Touch x to lazy-build for cell.ts/cell2.ts; cell3 already eager.
  void v1.x; void v2.x;
  bench("cell.ts  v1.x()", () => do_not_optimize(v1.x())).baseline(true);
  bench("cell2.ts v2.x()", () => do_not_optimize(v2.x()));
  bench("cell3.ts v3.x()", () => do_not_optimize(v3.x()));
});

group("read — Transform.translate.x deep", () => {
  const init = { translate: { x: 5, y: 10 }, rotate: 0, scale: { x: 1, y: 1 }, opacity: 1 };
  const t1: any = Transform1({ ...init, origin: { x: 0, y: 0 } });
  const t2: any = Transform2(init);
  const t3: any = Transform3(init);
  void t1.translate; void t2.translate; void t3.translate;
  bench("cell.ts  t1.translate.x()", () => do_not_optimize(t1.translate.x())).baseline(true);
  bench("cell2.ts t2.translate.x()", () => do_not_optimize(t2.translate.x()));
  bench("cell3.ts t3.translate.x()", () => do_not_optimize(t3.translate.x()));
});

// ── Writes ─────────────────────────────────────────────────────────

group("write — Vec.x field", () => {
  const v1: any = Vec1({ x: 5, y: 10 });
  const v2: any = Vec2({ x: 5, y: 10 });
  const v3: any = Vec3({ x: 5, y: 10 });
  void v1.x; void v2.x;
  let n = 0;
  bench("cell.ts  v1.x(n)", () => v1.x(++n)).baseline(true);
  bench("cell2.ts v2.x(n)", () => v2.x(++n));
  bench("cell3.ts v3.x(n)", () => v3.x(++n));
});

group("write — Vec whole", () => {
  const v1: any = Vec1({ x: 5, y: 10 });
  const v2: any = Vec2({ x: 5, y: 10 });
  const v3: any = Vec3({ x: 5, y: 10 });
  let n = 0;
  bench("cell.ts  v1({x:n,y:n})", () => v1({ x: ++n, y: n })).baseline(true);
  bench("cell2.ts v2({x:n,y:n})", () => v2({ x: ++n, y: n }));
  bench("cell3.ts v3({x:n,y:n})", () => v3({ x: ++n, y: n }));
});

// ── Method dispatch (lifted method → reactive cell) ────────────────

group("lifted method — Vec.add(b)", () => {
  const v1: any = Vec1({ x: 5, y: 10 });
  const v3: any = Vec3({ x: 5, y: 10 });
  // cell2.ts dropped trait lifting — no .add on cells. Skip.
  bench("cell.ts  v1.add({x:1,y:1})", () => do_not_optimize(v1.add({ x: 1, y: 1 }))).baseline(true);
  bench("cell3.ts v3.add({x:1,y:1})", () => do_not_optimize(v3.add({ x: 1, y: 1 })));
});

// ── Generic via trait/static dispatch ──────────────────────────────

group("generic dispatch — read type.add", () => {
  const v1: any = Vec1({ x: 0, y: 0 });
  const v2 = Vec2({ x: 0, y: 0 });
  const v3 = Vec3({ x: 0, y: 0 });
  // cell.ts uses cell.type.linear.add
  bench("cell.ts  v1.type.linear.add", () => do_not_optimize(v1.type.linear.add({ x: 1, y: 2 }, { x: 3, y: 4 }))).baseline(true);
  // cell2.ts uses typeOf(cell).add (flat)
  bench("cell2.ts typeOf(v2).add", () => do_not_optimize(typeOf2(v2)!.add!({ x: 1, y: 2 }, { x: 3, y: 4 })));
  // cell3.ts uses typeOf(cell).traits.linear.add
  bench("cell3.ts typeOf(v3).traits.linear.add", () => do_not_optimize((typeOf3(v3) as any).traits.linear.add({ x: 1, y: 2 }, { x: 3, y: 4 })));
});

// ── Subscription / effect ─────────────────────────────────────────

group("subscribe — effect on Vec.x", () => {
  // Build fresh each iter to avoid cumulative subscriber list.
  bench("cell.ts  effect on v1.x", () => {
    const v: any = Vec1({ x: 0, y: 0 });
    let x = 0;
    void v.x;
    // No `effect` in cell.ts public — use the engine import.
    do_not_optimize(v.x);
    x++;
  }).baseline(true);
  bench("cell3.ts effect on v3.x", () => {
    const v: any = Vec3({ x: 0, y: 0 });
    void v.x;
    do_not_optimize(v.x);
  });
});

// ── Run ───────────────────────────────────────────────────────────

await run();
