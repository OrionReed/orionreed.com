// Three-way comparison: current struct vs cell vs newstruct.
// All three implement the same Vec/Box surface; cells go straight
// through `defineCell`; newstruct uses the Builder facade on top of
// the same primitive.

import { Vec as VStruct } from "../signals/vec";
import { Box as BStruct } from "../signals/aabb";
import { Vec as VCell } from "./cell/vec";
import { Box as BCell } from "./cell/box";
import { Vec as VNew } from "./newstruct/vec";
import { Box as BNew } from "./newstruct/box";
import { bench, suite } from "./harness";

// ── Vec construction (3-way) ───────────────────────────────────────

suite("3-way: Vec construction", () => {
  bench("CURRENT struct  Vec.signal", () => VStruct.signal({ x: 0, y: 0 }));
  bench("CELL primitive  Vec.signal", () => VCell.signal({ x: 0, y: 0 }));
  bench("NEW Builder     Vec.signal", () => VNew.signal({ x: 0, y: 0 }));
});

suite("3-way: Vec axis write", () => {
  const a: any = VStruct.signal({ x: 1, y: 2 });
  const b: any = VCell.signal({ x: 1, y: 2 });
  const c: any = VNew.signal({ x: 1, y: 2 });
  void a.x;
  void b.x;
  void c.x;
  let i = 0;
  bench("CURRENT struct  a.x.value = ++i", () => {
    a.x.value = ++i;
  });
  bench("CELL primitive  b.x.value = ++i", () => {
    b.x.value = ++i;
  });
  bench("NEW Builder     c.x.value = ++i", () => {
    c.x.value = ++i;
  });
});

suite("3-way: Vec single lifted op (add) round-trip", () => {
  const aS: any = VStruct.signal({ x: 1, y: 2 });
  const bS = VStruct.signal({ x: 3, y: 4 });
  void aS.x;
  const sumS = aS.add(bS);

  const aC: any = VCell.signal({ x: 1, y: 2 });
  const bC = VCell.signal({ x: 3, y: 4 });
  void aC.x;
  const sumC = aC.add(bC);

  const aN: any = VNew.signal({ x: 1, y: 2 });
  const bN = VNew.signal({ x: 3, y: 4 });
  void aN.x;
  const sumN = aN.add(bN);

  let i = 0;
  bench("CURRENT struct  write a.x → sum.value", () => {
    aS.x.value = ++i;
    return sumS.value;
  });
  bench("CELL primitive  write a.x → sum.value", () => {
    aC.x.value = ++i;
    return sumC.value;
  });
  bench("NEW Builder     write a.x → sum.value", () => {
    aN.x.value = ++i;
    return sumN.value;
  });
});

suite("3-way: Vec chained lifted ops (add.scale.add)", () => {
  const aS: any = VStruct.signal({ x: 1, y: 2 });
  const bS = VStruct.signal({ x: 3, y: 4 });
  const cS = VStruct.signal({ x: 5, y: 6 });
  void aS.x;
  const outS = aS.add(bS).scale(2).add(cS);

  const aC: any = VCell.signal({ x: 1, y: 2 });
  const bC = VCell.signal({ x: 3, y: 4 });
  const cC = VCell.signal({ x: 5, y: 6 });
  void aC.x;
  const outC = aC.add(bC).scale(2).add(cC);

  const aN: any = VNew.signal({ x: 1, y: 2 });
  const bN = VNew.signal({ x: 3, y: 4 });
  const cN = VNew.signal({ x: 5, y: 6 });
  void aN.x;
  const outN = aN.add(bN).scale(2).add(cN);

  let i = 0;
  bench("CURRENT struct  write a.x → out.value", () => {
    aS.x.value = ++i;
    return outS.value;
  });
  bench("CELL primitive  write a.x → out.value", () => {
    aC.x.value = ++i;
    return outC.value;
  });
  bench("NEW Builder     write a.x → out.value", () => {
    aN.x.value = ++i;
    return outN.value;
  });
});

suite("3-way: Vec lifted scalar (distance)", () => {
  const aS: any = VStruct.signal({ x: 1, y: 2 });
  const bS = VStruct.signal({ x: 4, y: 6 });
  void aS.x;
  const dS = aS.distance(bS);

  const aC: any = VCell.signal({ x: 1, y: 2 });
  const bC = VCell.signal({ x: 4, y: 6 });
  void aC.x;
  const dC = aC.distance(bC);

  const aN: any = VNew.signal({ x: 1, y: 2 });
  const bN = VNew.signal({ x: 4, y: 6 });
  void aN.x;
  const dN = aN.distance(bN);

  let i = 0;
  bench("CURRENT struct  distance.value", () => {
    aS.x.value = ++i;
    return dS.value;
  });
  bench("CELL primitive  distance.value", () => {
    aC.x.value = ++i;
    return dC.value;
  });
  bench("NEW Builder     distance.value", () => {
    aN.x.value = ++i;
    return dN.value;
  });
});

suite("3-way: Vec lazy getter (.length cached)", () => {
  const aS: any = VStruct.signal({ x: 3, y: 4 });
  const aC: any = VCell.signal({ x: 3, y: 4 });
  const aN: any = VNew.signal({ x: 3, y: 4 });
  void aS.length;
  void aC.length;
  void aN.length;
  bench("CURRENT struct  length", () => aS.length);
  bench("CELL primitive  length", () => aC.length);
  bench("NEW Builder     length", () => aN.length);
});

suite("3-way: Box write x → center.value re-eval", () => {
  const bS: any = BStruct.signal({ x: 0, y: 0, w: 10, h: 10 });
  const bC: any = BCell.signal({ x: 0, y: 0, w: 10, h: 10 });
  const bN: any = BNew.signal({ x: 0, y: 0, w: 10, h: 10 });
  void bS.x;
  void bC.x;
  void bN.x;
  const cS = bS.center;
  const cC = bC.center;
  const cN = bN.center;

  let i = 0;
  bench("CURRENT struct  write x → center.value", () => {
    bS.x.value = ++i;
    return cS.value;
  });
  bench("CELL primitive  write x → center.value", () => {
    bC.x.value = ++i;
    return cC.value;
  });
  bench("NEW Builder     write x → center.value", () => {
    bN.x.value = ++i;
    return cN.value;
  });
});

suite("3-way: integrated drag-step (write x → 3 derives)", () => {
  function setupS() {
    const v: any = VStruct.signal({ x: 1, y: 2 });
    const u = VStruct.signal({ x: 3, y: 4 });
    void v.x;
    return { v, sum: v.add(u), len: v.length, mid: v.lerp(u, 0.5) };
  }
  function setupC() {
    const v: any = VCell.signal({ x: 1, y: 2 });
    const u = VCell.signal({ x: 3, y: 4 });
    void v.x;
    return { v, sum: v.add(u), len: v.length, mid: v.lerp(u, 0.5) };
  }
  function setupN() {
    const v: any = VNew.signal({ x: 1, y: 2 });
    const u = VNew.signal({ x: 3, y: 4 });
    void v.x;
    return { v, sum: v.add(u), len: v.length, mid: v.lerp(u, 0.5) };
  }
  const s = setupS();
  const c = setupC();
  const n = setupN();

  let i = 0;
  bench("CURRENT struct  write x → 3 reads", () => {
    s.v.x.value = ++i;
    return s.sum.value.x + s.len.value + s.mid.value.x;
  });
  bench("CELL primitive  write x → 3 reads", () => {
    c.v.x.value = ++i;
    return c.sum.value.x + c.len.value + c.mid.value.x;
  });
  bench("NEW Builder     write x → 3 reads", () => {
    n.v.x.value = ++i;
    return n.sum.value.x + n.len.value + n.mid.value.x;
  });
});

suite("3-way: Vec tween 60-frame", () => {
  bench("CURRENT struct  v.to(target, 1)", () => {
    const v = VStruct.signal({ x: 0, y: 0 });
    const t = v.to({ x: 100, y: 50 }, 1);
    for (let f = 0; f < 60; f++) t.next(1 / 60);
  });
  bench("CELL primitive  v.to(target, 1)", () => {
    const v: any = VCell.signal({ x: 0, y: 0 });
    const t = v.to({ x: 100, y: 50 }, 1);
    for (let f = 0; f < 60; f++) t.next(1 / 60);
  });
  bench("NEW Builder     v.to(target, 1)", () => {
    const v: any = VNew.signal({ x: 0, y: 0 });
    const t = v.to({ x: 100, y: 50 }, 1);
    for (let f = 0; f < 60; f++) t.next(1 / 60);
  });
});
