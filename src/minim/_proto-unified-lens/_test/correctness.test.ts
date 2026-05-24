// Correctness tests for the unified lens surface.
//
// Strategy: compare old vs new at the SHAPE-OF-VALUES level. Old
// path uses the existing through/lensTo/deriveTo/fanin/aggregates.
// New path uses the prototype lens/derive/classLens/classDerive.
// Both should produce identical reads and accept identical writes.

import { describe, expect, it } from "vitest";
import {
  centroidLens as centroidLensOld,
  fanin,
  meanLens as meanLensOld,
  midpointLens as midpointLensOld,
  Num,
  num,
  sumLens as sumLensOld,
  Vec,
  vec,
} from "../../signals";
import {
  centroidLens,
  classDerive,
  classLens,
  derive,
  lens,
  meanLens,
  midpointLens,
  sumLens,
} from "..";

describe("free lens — 1 input", () => {
  it("RO via derive(parent, fn): tracks parent updates", () => {
    const a = num(3);
    const d = derive(a, x => x * 2);
    expect(d.value).toBe(6);
    a.value = 5;
    expect(d.value).toBe(10);
  });

  it("RW via lens(parent, fwd, bwd): write inverts forward", () => {
    const a = num(0);
    const l = lens(
      a,
      x => x + 1,
      target => target - 1,
    );
    expect(l.value).toBe(1);
    l.value = 10;
    expect(a.value).toBe(9);
    expect(l.value).toBe(10);
  });

  it("RW with stateful bwd (2-arg): blends toward target", () => {
    const a = num(0);
    const l = lens(
      a,
      x => x,
      (target, current) => current + (target - current) * 0.5,
    );
    a.value = 10;
    expect(l.value).toBe(10);
    l.value = 20;
    // current=10, target=20 → 10 + (20-10)*0.5 = 15 → a=15
    expect(a.value).toBe(15);
    expect(l.value).toBe(15);
  });

  it("equivalent to parent.lensTo(Signal, ...) for cross-class", () => {
    const a = num(2);
    // Old: a.lensTo(Signal, x => x*3, target => target/3)
    // (Signal isn't directly exported as a class; use Num.)
    const lOld = a.lensTo(
      Num,
      x => x * 3,
      target => target / 3,
    );
    const lNew = lens(
      a,
      x => x * 3,
      target => target / 3,
    );
    expect(lOld.value).toBe(lNew.value);
    a.value = 10;
    expect(lOld.value).toBe(lNew.value);
  });
});

describe("free lens — N inputs (subsumes fanin)", () => {
  it("derive([a, b], fn) = fanin(Signal, [a, b], fn) for RO", () => {
    const a = num(3);
    const b = num(4);
    const d = derive([a, b], vals => vals[0] + vals[1]);
    expect(d.value).toBe(7);
    a.value = 10;
    expect(d.value).toBe(14);
  });

  it("lens([a, b], fwd, bwd) writes distribute via bwd", () => {
    const a = num(0);
    const b = num(0);
    const sum = lens(
      [a, b],
      vals => vals[0] + vals[1],
      target => [target / 2, target / 2],
    );
    sum.value = 10;
    expect(a.value).toBe(5);
    expect(b.value).toBe(5);
    expect(sum.value).toBe(10);
  });

  it("matches fanin output exactly (homogeneous parents)", () => {
    const a1 = num(1);
    const b1 = num(2);
    const c1 = num(3);
    const a2 = num(1);
    const b2 = num(2);
    const c2 = num(3);

    const oldOne = fanin(
      Num,
      [a1, b1, c1] as const,
      vals => vals[0] * vals[1] - vals[2],
    );
    const newOne = derive(
      [a2, b2, c2],
      vals => vals[0] * vals[1] - vals[2],
    );

    expect(newOne.value).toBe(oldOne.value);
    a1.value = 10;
    a2.value = 10;
    expect(newOne.value).toBe(oldOne.value);
  });
});

describe("classLens / classDerive — typed return", () => {
  it("classDerive(Vec, [a, b], …) returns a Vec", () => {
    const a = num(1);
    const b = num(2);
    const v = classDerive(Vec, [a, b], vals => ({ x: vals[0], y: vals[1] }));
    expect(v).toBeInstanceOf(Vec);
    expect(v.value).toEqual({ x: 1, y: 2 });
  });

  it("classLens(Vec, [a, b], fwd, bwd) is writable, distributes", () => {
    const a = num(0);
    const b = num(0);
    const v = classLens(
      Vec,
      [a, b],
      vals => ({ x: vals[0], y: vals[1] }),
      target => [target.x, target.y] as never,
    );
    expect(v).toBeInstanceOf(Vec);
    v.value = { x: 7, y: 9 };
    expect(a.value).toBe(7);
    expect(b.value).toBe(9);
  });

  it("classLens(Num, parent, fwd, bwd) for cross-class single input", () => {
    const v = vec(3, 4);
    // Vec → Num (length²)
    const len2 = classLens(
      Num,
      v,
      p => p.x * p.x + p.y * p.y,
      target => ({ x: Math.sqrt(target / 2), y: Math.sqrt(target / 2) }),
    );
    expect(len2).toBeInstanceOf(Num);
    expect(len2.value).toBeCloseTo(25);
  });
});

describe("aggregates: A/B old vs new", () => {
  it("meanLens — same outputs", () => {
    const a1 = num(1);
    const b1 = num(2);
    const c1 = num(3);
    const a2 = num(1);
    const b2 = num(2);
    const c2 = num(3);

    const oldM = meanLensOld(Num, [a1, b1, c1]);
    const newM = meanLens(Num, [a2, b2, c2]);

    expect(newM.value).toBe(oldM.value);

    // delta-even on write
    oldM.value = 6;
    newM.value = 6;
    expect(a1.value).toBe(a2.value);
    expect(b1.value).toBe(b2.value);
    expect(c1.value).toBe(c2.value);
  });

  it("sumLens — same outputs", () => {
    const a1 = num(1);
    const b1 = num(2);
    const a2 = num(1);
    const b2 = num(2);

    const oldS = sumLensOld(Num, [a1, b1]);
    const newS = sumLens(Num, [a2, b2]);
    expect(newS.value).toBe(oldS.value);
    a1.value = 10;
    a2.value = 10;
    expect(newS.value).toBe(oldS.value);
  });

  it("centroidLens — same outputs (Vec)", () => {
    const a1 = vec(0, 0);
    const b1 = vec(2, 0);
    const c1 = vec(1, 3);
    const a2 = vec(0, 0);
    const b2 = vec(2, 0);
    const c2 = vec(1, 3);

    const oldC = centroidLensOld([a1, b1, c1]);
    const newC = centroidLens([a2, b2, c2]);
    expect(newC.value).toEqual(oldC.value);

    // drag-translate
    oldC.value = { x: 10, y: 10 };
    newC.value = { x: 10, y: 10 };
    expect(a1.value).toEqual(a2.value);
    expect(b1.value).toEqual(b2.value);
    expect(c1.value).toEqual(c2.value);
  });

  it("midpointLens — same outputs", () => {
    const a1 = vec(0, 0);
    const b1 = vec(4, 4);
    const a2 = vec(0, 0);
    const b2 = vec(4, 4);

    const oldM = midpointLensOld(a1, b1);
    const newM = midpointLens(a2, b2);
    expect(newM.value).toEqual(oldM.value);

    oldM.value = { x: 5, y: 5 };
    newM.value = { x: 5, y: 5 };
    expect(a1.value).toEqual(a2.value);
    expect(b1.value).toEqual(b2.value);
  });
});

describe("batching", () => {
  it("write to N-input lens fires downstream effects once, not N times", async () => {
    const { effect } = await import("../../signals");
    const a = num(0);
    const b = num(0);
    const c = num(0);
    const sum = lens(
      [a, b, c],
      vals => vals[0]! + vals[1]! + vals[2]!,
      target => [target / 3, target / 3, target / 3],
    );

    let fires = 0;
    // Effect depends on all three parents.
    const dispose = effect(() => {
      a.value;
      b.value;
      c.value;
      fires++;
    });
    fires = 0;
    sum.value = 9;
    expect(fires).toBe(1); // ONE flush, not three
    dispose();
  });
});

describe("real-usage patterns from the codebase", () => {
  it("HSL → R/G/B 3-input bijection (md-color shape)", () => {
    // Today: fanin(Num, [hue, sat, lit], fwd, bwd)
    // New:   classLens(Num, [hue, sat, lit], fwd, bwd)
    const hue = num(0);
    const sat = num(0.5);
    const lit = num(0.5);
    const r = classLens(
      Num,
      [hue, sat, lit],
      vals => vals[0] * 0.3 + vals[1] * 0.59 + vals[2] * 0.11, // pretend HSL→R
      (target, vals) => [target / 0.3, vals[1], vals[2]] as never,
    );
    expect(r.value).toBeCloseTo(0 + 0.295 + 0.055);
    r.value = 1;
    expect(hue.value).toBeCloseTo(1 / 0.3);
  });

  it("argmin pattern: Newton step on weighted scalar (handle.ts shape)", () => {
    // Today: fanin with a Newton-step bwd that mutates vals scratch
    // in-place. Same pattern works on classLens.
    const a = num(3);
    const b = num(4);
    const eps = 1e-4;
    const f = (vals: readonly number[]) => vals[0]! * vals[0]! + vals[1]! * vals[1]!;

    const root = classLens(
      Num,
      [a, b],
      vals => f(vals),
      (target, vals) => {
        const xs = vals as number[];
        const y0 = f(xs);
        const dy = target - y0;
        const J = new Array<number>(2);
        for (let i = 0; i < 2; i++) {
          const saved = xs[i]!;
          xs[i] = saved + eps;
          J[i] = (f(xs) - y0) / eps;
          xs[i] = saved;
        }
        const denom = J[0]! * J[0]! + J[1]! * J[1]! + 1e-6;
        const k = dy / denom;
        return [xs[0]! + J[0]! * k, xs[1]! + J[1]! * k] as never;
      },
    );
    expect(root.value).toBe(25);
    // pull toward 50 — should move both inputs along gradient
    const before = { a: a.value, b: b.value };
    root.value = 50;
    expect(a.value).not.toBe(before.a);
    expect(b.value).not.toBe(before.b);
  });

  it("vec.x field access via 1-input classLens (alternative to field())", () => {
    const v = vec(3, 7);
    const x = classLens(
      Num,
      v,
      p => p.x,
      (target, p) => ({ x: target, y: p.y }),
    );
    expect(x.value).toBe(3);
    x.value = 99;
    expect(v.value).toEqual({ x: 99, y: 7 });
  });
});
