// Cell vs current-framework comparison across the FULL surface:
// construction, axis read/write, lifted ops (single + chain), lazy
// getters, lifted scalars, instanceof. If cell matches or beats
// current across all of these, the simplification thesis holds.

import { signal } from "../core/signal";
import { Vec as VStruct } from "../signals/vec";
import { Box as BStruct } from "../signals/aabb";
import { Vec as VCell } from "./cell/vec";
import { Box as BCell } from "./cell/box";
import { bench, suite, memory } from "./harness";

// ── Vec construction ──────────────────────────────────────────────

suite("Vec construction (struct vs cell)", () => {
  bench("VStruct.signal({x,y})", () => VStruct.signal({ x: 0, y: 0 }));
  bench("VCell.signal({x,y})", () => VCell.signal({ x: 0, y: 0 }));
});

suite("Vec memory per-instance", () => {
  memory("VStruct.signal({x,y})", (i) => VStruct.signal({ x: i, y: i }));
  memory("VCell.signal({x,y})", (i) => VCell.signal({ x: i, y: i }));
});

// ── Vec axis ops ──────────────────────────────────────────────────

suite("Vec axis read (cached)", () => {
  const vs: any = VStruct.signal({ x: 1, y: 2 });
  const vc: any = VCell.signal({ x: 1, y: 2 });
  void vs.x;
  void vc.x;

  bench("VStruct: vs.x.value", () => vs.x.value);
  bench("VCell:   vc.x.value", () => vc.x.value);
});

suite("Vec axis write (no subscribers)", () => {
  const vs: any = VStruct.signal({ x: 1, y: 2 });
  const vc: any = VCell.signal({ x: 1, y: 2 });
  void vs.x;
  void vc.x;
  let i = 0;
  bench("VStruct: vs.x.value = ++i", () => {
    vs.x.value = ++i;
  });
  bench("VCell:   vc.x.value = ++i", () => {
    vc.x.value = ++i;
  });
});

// ── Vec lifted ops ────────────────────────────────────────────────

suite("Vec single lifted op (add) round-trip", () => {
  const as: any = VStruct.signal({ x: 1, y: 2 });
  const bs = VStruct.signal({ x: 3, y: 4 });
  void as.x;
  const sumS = as.add(bs);

  const ac: any = VCell.signal({ x: 1, y: 2 });
  const bc = VCell.signal({ x: 3, y: 4 });
  void ac.x;
  const sumC = ac.add(bc);

  let i = 0;
  bench("VStruct: write a.x → sum.value", () => {
    as.x.value = ++i;
    return sumS.value;
  });
  bench("VCell:   write a.x → sum.value", () => {
    ac.x.value = ++i;
    return sumC.value;
  });
});

suite("Vec chained lifted ops (add.scale.add)", () => {
  const as: any = VStruct.signal({ x: 1, y: 2 });
  const bs = VStruct.signal({ x: 3, y: 4 });
  const cs = VStruct.signal({ x: 5, y: 6 });
  void as.x;
  const outS = as.add(bs).scale(2).add(cs);

  const ac: any = VCell.signal({ x: 1, y: 2 });
  const bc = VCell.signal({ x: 3, y: 4 });
  const cc = VCell.signal({ x: 5, y: 6 });
  void ac.x;
  const outC = ac.add(bc).scale(2).add(cc);

  let i = 0;
  bench("VStruct: write a.x → out.value", () => {
    as.x.value = ++i;
    return outS.value;
  });
  bench("VCell:   write a.x → out.value", () => {
    ac.x.value = ++i;
    return outC.value;
  });
});

suite("Vec lifted scalar (distance) round-trip", () => {
  const as: any = VStruct.signal({ x: 1, y: 2 });
  const bs = VStruct.signal({ x: 4, y: 6 });
  void as.x;
  const dS = as.distance(bs);

  const ac: any = VCell.signal({ x: 1, y: 2 });
  const bc = VCell.signal({ x: 4, y: 6 });
  void ac.x;
  const dC = ac.distance(bc);

  let i = 0;
  bench("VStruct: write a.x → distance.value", () => {
    as.x.value = ++i;
    return dS.value;
  });
  bench("VCell:   write a.x → distance.value", () => {
    ac.x.value = ++i;
    return dC.value;
  });
});

// ── Vec lazy getter ───────────────────────────────────────────────

suite("Vec lazy getter (.length cached)", () => {
  const vs: any = VStruct.signal({ x: 3, y: 4 });
  const vc: any = VCell.signal({ x: 3, y: 4 });
  void vs.length;
  void vc.length;
  bench("VStruct: vs.length", () => vs.length);
  bench("VCell:   vc.length", () => vc.length);
});

suite("Vec lazy getter first-access (build cost)", () => {
  bench("VStruct: fresh + .length", () => {
    const v: any = VStruct.signal({ x: 3, y: 4 });
    return v.length;
  });
  bench("VCell:   fresh + .length", () => {
    const v: any = VCell.signal({ x: 3, y: 4 });
    return v.length;
  });
});

// ── Vec tween throughput ──────────────────────────────────────────

suite("Vec tween (60-frame .to)", () => {
  bench("VStruct: v.to({x:100,y:50}, 1)", () => {
    const v = VStruct.signal({ x: 0, y: 0 });
    const t = v.to({ x: 100, y: 50 }, 1);
    for (let f = 0; f < 60; f++) t.next(1 / 60);
  });
  bench("VCell:   v.to({x:100,y:50}, 1)", () => {
    const v: any = VCell.signal({ x: 0, y: 0 });
    const t = v.to({ x: 100, y: 50 }, 1);
    for (let f = 0; f < 60; f++) t.next(1 / 60);
  });
});

// ── Vec instanceof ────────────────────────────────────────────────

suite("Vec instanceof / .is narrowing", () => {
  const vs: any = VStruct.signal({ x: 0, y: 0 });
  const vc: any = VCell.signal({ x: 0, y: 0 });
  bench("VStruct.is(vs)", () => VStruct.is(vs));
  bench("VCell.is(vc)", () => VCell.is(vc));
  bench("vs instanceof VStruct", () => vs instanceof VStruct);
  bench("vc instanceof (cell has no Symbol.hasInstance — skipping)", () =>
    VCell.is(vc),
  );
});

// ── Box (validates the lazy-getter / nested-getter pattern) ───────

suite("Box construction", () => {
  bench("BStruct.signal({x,y,w,h})", () =>
    BStruct.signal({ x: 0, y: 0, w: 1, h: 1 }),
  );
  bench("BCell.signal({x,y,w,h})", () =>
    BCell.signal({ x: 0, y: 0, w: 1, h: 1 }),
  );
});

suite("Box memory per-instance", () => {
  memory("BStruct.signal", (i) => BStruct.signal({ x: i, y: i, w: 1, h: 1 }));
  memory("BCell.signal", (i) => BCell.signal({ x: i, y: i, w: 1, h: 1 }));
});

suite("Box axis write (arity-4, construct-based)", () => {
  const bs: any = BStruct.signal({ x: 0, y: 0, w: 10, h: 10 });
  const bc: any = BCell.signal({ x: 0, y: 0, w: 10, h: 10 });
  void bs.x;
  void bc.x;
  let i = 0;
  bench("BStruct: bs.x.value = ++i", () => {
    bs.x.value = ++i;
  });
  bench("BCell:   bc.x.value = ++i", () => {
    bc.x.value = ++i;
  });
});

suite("Box lazy getter (.center cached)", () => {
  const bs: any = BStruct.signal({ x: 0, y: 0, w: 10, h: 10 });
  const bc: any = BCell.signal({ x: 0, y: 0, w: 10, h: 10 });
  void bs.center;
  void bc.center;
  bench("BStruct: bs.center", () => bs.center);
  bench("BCell:   bc.center", () => bc.center);
});

suite("Box lazy getter first-access (.center build)", () => {
  bench("BStruct: fresh + .center", () => {
    const b: any = BStruct.signal({ x: 0, y: 0, w: 10, h: 10 });
    return b.center;
  });
  bench("BCell:   fresh + .center", () => {
    const b: any = BCell.signal({ x: 0, y: 0, w: 10, h: 10 });
    return b.center;
  });
});

suite("Box .center.value (cached + read)", () => {
  const bs: any = BStruct.signal({ x: 0, y: 0, w: 10, h: 10 });
  const bc: any = BCell.signal({ x: 0, y: 0, w: 10, h: 10 });
  void bs.center;
  void bc.center;
  bench("BStruct: bs.center.value", () => bs.center.value);
  bench("BCell:   bc.center.value", () => bc.center.value);
});

suite("Box write x → .center.value re-eval", () => {
  const bs: any = BStruct.signal({ x: 0, y: 0, w: 10, h: 10 });
  const bc: any = BCell.signal({ x: 0, y: 0, w: 10, h: 10 });
  const cs = bs.center;
  const cc = bc.center;
  void bs.x;
  void bc.x;
  let i = 0;
  bench("BStruct: write x → center.value", () => {
    bs.x.value = ++i;
    return cs.value;
  });
  bench("BCell:   write x → center.value", () => {
    bc.x.value = ++i;
    return cc.value;
  });
});

// ── Aggregate score: integrated workload ─────────────────────────

suite("Integrated: drag-step (write x → re-eval 3 derives)", () => {
  // Common pattern: a drag-handle write to .x, with (a) center derived,
  // (b) a sum-vec derived, (c) a length scalar.
  function setupStruct() {
    const v: any = VStruct.signal({ x: 1, y: 2 });
    const u = VStruct.signal({ x: 3, y: 4 });
    void v.x;
    return {
      v,
      sum: v.add(u),
      len: v.length,
      mid: v.lerp(u, 0.5),
    };
  }
  function setupCell() {
    const v: any = VCell.signal({ x: 1, y: 2 });
    const u = VCell.signal({ x: 3, y: 4 });
    void v.x;
    return {
      v,
      sum: v.add(u),
      len: v.length,
      mid: v.lerp(u, 0.5),
    };
  }
  const s = setupStruct();
  const c = setupCell();

  let i = 0;
  bench("VStruct: write x → read sum/len/mid", () => {
    s.v.x.value = ++i;
    return s.sum.value.x + s.len.value + s.mid.value.x;
  });
  bench("VCell:   write x → read sum/len/mid", () => {
    c.v.x.value = ++i;
    return c.sum.value.x + c.len.value + c.mid.value.x;
  });
});
