// _cell4.bench.ts — compare cell4 (fused + native lens) against bare alien,
// cell.ts (current prod), cell3 (per-field signals).
// Run: npx tsx src/minim/signals2/_cell4.bench.ts

import { bench, group, run, do_not_optimize } from "mitata";

// Bare alien (production engine, no struct layer)
import { signal as aSig } from "./engine";

// cell.ts — current production prototype with linear/lerp grouping
import { Vec as Vec1, Transform as Transform1 } from "./values";
import { cell as cell1 } from "./cell";

// cell3 — per-field signals, methods+traits split
import {
  signal as signal3,
  struct as struct3,
  typeOf as typeOf3,
} from "./cell3";

// cell4 — fused storage + native lens (this PR)
import {
  signal as signal4,
  computed as computed4,
  struct as struct4,
  typeOf as typeOf4,
} from "./cell4";

// ─── Set up Vec/Transform in cell3 and cell4 ───────────────────────

interface V { x: number; y: number }
interface Tr {
  translate: V; scale: V; rotate: number; opacity: number;
}

const add = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
const scale = (a: V, k: number): V => ({ x: a.x * k, y: a.y * k });
const lerp = (a: V, b: V, t: number): V => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const metric = (a: V, b: V): number => Math.hypot(a.x - b.x, a.y - b.y);

const Vec3 = struct3({
  tag: "Vec", value: { x: 0, y: 0 } as V,
  methods: { add, sub, scale, lerp },
  traits: { linear: { add, sub, scale }, lerp, metric },
});
const Vec4 = struct4({
  tag: "Vec", value: { x: 0, y: 0 } as V,
  methods: { add, sub, scale, lerp },
  traits: { linear: { add, sub, scale }, lerp, metric },
});

const TLin3 = (Vec3.traits as any).linear;
const tAdd = (a: Tr, b: Tr): Tr => ({
  translate: TLin3.add(a.translate, b.translate),
  scale:     TLin3.add(a.scale, b.scale),
  rotate:    a.rotate + b.rotate, opacity:   a.opacity + b.opacity,
});
const tSub = (a: Tr, b: Tr): Tr => ({
  translate: TLin3.sub(a.translate, b.translate),
  scale:     TLin3.sub(a.scale, b.scale),
  rotate:    a.rotate - b.rotate, opacity:   a.opacity - b.opacity,
});
const tScale = (a: Tr, k: number): Tr => ({
  translate: TLin3.scale(a.translate, k),
  scale:     TLin3.scale(a.scale, k),
  rotate:    a.rotate * k, opacity:   a.opacity * k,
});

const Transform3 = struct3({
  tag: "Transform",
  value: { translate: Vec3, scale: Vec3({ x: 1, y: 1 }), rotate: 0, opacity: 1 },
  traits: { linear: { add: tAdd, sub: tSub, scale: tScale } },
});
const Transform4 = struct4({
  tag: "Transform",
  value: { translate: Vec4, scale: Vec4({ x: 1, y: 1 }), rotate: 0, opacity: 1 },
  traits: { linear: { add: tAdd, sub: tSub, scale: tScale } },
});

// ─── Bench groups ──────────────────────────────────────────────────

group("construct — Vec", () => {
  bench("bare alien aSig({x,y})", () => do_not_optimize(aSig({ x: 1, y: 2 }))).baseline(true);
  bench("cell.ts  Vec1({x,y})", () => do_not_optimize(Vec1({ x: 1, y: 2 })));
  bench("cell3    Vec3({x,y})", () => do_not_optimize(Vec3({ x: 1, y: 2 })));
  bench("cell4    Vec4({x,y})", () => do_not_optimize(Vec4({ x: 1, y: 2 })));
});

group("construct — Transform", () => {
  const init = { translate: { x: 0, y: 0 }, rotate: 0, scale: { x: 1, y: 1 }, opacity: 1 };
  bench("bare alien aSig(tr)", () => do_not_optimize(aSig(init))).baseline(true);
  bench("cell.ts  Transform1", () => do_not_optimize(Transform1({ ...init, origin: { x: 0, y: 0 } })));
  bench("cell3    Transform3", () => do_not_optimize(Transform3(init)));
  bench("cell4    Transform4", () => do_not_optimize(Transform4(init)));
});

group("construct — bare cell", () => {
  bench("bare alien aSig(0)", () => do_not_optimize(aSig(0))).baseline(true);
  bench("cell.ts  cell1(0)", () => do_not_optimize(cell1(0)));
  bench("cell3    signal3(0)", () => do_not_optimize(signal3(0)));
  bench("cell4    signal4(0)", () => do_not_optimize(signal4(0)));
});

group("read — Vec whole", () => {
  const a = aSig({ x: 5, y: 10 });
  const v1: any = Vec1({ x: 5, y: 10 });
  const v3 = Vec3({ x: 5, y: 10 });
  const v4 = Vec4({ x: 5, y: 10 });
  bench("bare alien a()", () => do_not_optimize(a())).baseline(true);
  bench("cell.ts  v1()", () => do_not_optimize(v1()));
  bench("cell3    v3()", () => do_not_optimize(v3()));
  bench("cell4    v4()", () => do_not_optimize(v4()));
});

group("read — Vec.x field", () => {
  const v1: any = Vec1({ x: 5, y: 10 });
  const v3 = Vec3({ x: 5, y: 10 });
  const v4 = Vec4({ x: 5, y: 10 });
  void v1.x; void (v3 as any).x; void (v4 as any).x;
  bench("cell.ts  v1.x()", () => do_not_optimize(v1.x())).baseline(true);
  bench("cell3    v3.x()", () => do_not_optimize((v3 as any).x()));
  bench("cell4    v4.x() (lens)", () => do_not_optimize((v4 as any).x()));
});

group("write — Vec.x field", () => {
  const v1: any = Vec1({ x: 5, y: 10 });
  const v3 = Vec3({ x: 5, y: 10 });
  const v4 = Vec4({ x: 5, y: 10 });
  void v1.x; void (v3 as any).x; void (v4 as any).x;
  let n = 0;
  bench("cell.ts  v1.x(n)", () => v1.x(++n)).baseline(true);
  bench("cell3    v3.x(n)", () => (v3 as any).x(++n));
  bench("cell4    v4.x(n) (lens)", () => (v4 as any).x(++n));
});

group("write — Vec whole", () => {
  const v1: any = Vec1({ x: 5, y: 10 });
  const v3 = Vec3({ x: 5, y: 10 });
  const v4 = Vec4({ x: 5, y: 10 });
  let n = 0;
  bench("cell.ts  v1({x,y})", () => v1({ x: ++n, y: n })).baseline(true);
  bench("cell3    v3({x,y})", () => v3({ x: ++n, y: n }));
  bench("cell4    v4({x,y})", () => v4({ x: ++n, y: n }));
});

group("read — Transform.translate.x deep", () => {
  const init = { translate: { x: 5, y: 10 }, rotate: 0, scale: { x: 1, y: 1 }, opacity: 1 };
  const t1: any = Transform1({ ...init, origin: { x: 0, y: 0 } });
  const t3 = Transform3(init);
  const t4 = Transform4(init);
  void t1.translate; void (t3 as any).translate; void (t4 as any).translate;
  bench("cell.ts  t1.translate.x()", () => do_not_optimize(t1.translate.x())).baseline(true);
  bench("cell3    t3.translate.x()", () => do_not_optimize(((t3 as any).translate as any).x()));
  bench("cell4    t4.translate.x()", () => do_not_optimize(((t4 as any).translate as any).x()));
});

group("lifted method — Vec.add(b) (reactive)", () => {
  const v1: any = Vec1({ x: 5, y: 10 });
  const v3 = Vec3({ x: 5, y: 10 });
  const v4 = Vec4({ x: 5, y: 10 });
  bench("cell.ts  v1.add(...)", () => do_not_optimize(v1.add({ x: 1, y: 1 }))).baseline(true);
  bench("cell3    v3.add(...)", () => do_not_optimize(v3.add({ x: 1, y: 1 })));
  bench("cell4    v4.add(...)", () => do_not_optimize(v4.add({ x: 1, y: 1 })));
});

group("static method (plain math) — Vec.add(a, b)", () => {
  bench("cell3    Vec3.add(a,b)", () => do_not_optimize((Vec3 as any).add({ x: 1, y: 2 }, { x: 3, y: 4 }))).baseline(true);
  bench("cell4    Vec4.add(a,b)", () => do_not_optimize((Vec4 as any).add({ x: 1, y: 2 }, { x: 3, y: 4 })));
});

group("generic dispatch — Type.traits.linear.add", () => {
  const v1: any = Vec1({ x: 0, y: 0 });
  const v3 = Vec3({ x: 0, y: 0 });
  const v4 = Vec4({ x: 0, y: 0 });
  bench("cell.ts  v1.type.linear.add", () => do_not_optimize(v1.type.linear.add({ x: 1, y: 2 }, { x: 3, y: 4 }))).baseline(true);
  bench("cell3    typeOf(v3).traits.linear.add", () => do_not_optimize((typeOf3(v3) as any).traits.linear.add({ x: 1, y: 2 }, { x: 3, y: 4 })));
  bench("cell4    typeOf(v4).traits.linear.add", () => do_not_optimize((typeOf4(v4) as any).traits.linear.add({ x: 1, y: 2 }, { x: 3, y: 4 })));
});

group("chain — point.up(10).right(10) as one computed (plain math)", () => {
  // The "single big computed" pattern user asked about.
  const p4 = Vec4({ x: 5, y: 5 });
  const up = (v: V, n: number): V => ({ x: v.x, y: v.y - n });
  const right = (v: V, n: number): V => ({ x: v.x + n, y: v.y });
  let setup: any;
  bench("cell4 single computed", () => {
    setup = computed4(() => right(up(p4(), 10), 10));
    do_not_optimize(setup());
  }).baseline(true);
  bench("cell4 chained lifted methods", () => {
    const Vec4x = Vec4 as any;
    // Synthesize two reactive cells via lifted methods (each allocates computed).
    const c1 = computed4(() => up(p4(), 10));
    const c2 = computed4(() => right(c1(), 10));
    do_not_optimize(c2());
  });
});

await run();
