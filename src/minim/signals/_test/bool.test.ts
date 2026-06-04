// bool.test.ts — Bool runtime + lens laws.
//
// Coverage:
//   - bool() factory, reads / writes / equality
//   - not() — involution, double-fuse, writability propagation
//   - xor(b) — F₂ group operation, writability, dynamic `b`
//   - Derived RO surfaces (and/or/implies/eq/nand/nor)
//   - Cross-class via Cls.lens (Bool.lens from arbitrary parents)
//   - Lens-law verification: GetPut, PutGet, PutPut
//   - Effect tracking and dependency propagation
//   - Bridges: Num → Bool via threshold predicate (validates writability
//              across class boundaries; Bool participates in chains)
//   - Edge cases: many-deep fusion, xor with reactive b, xor identity

import { describe, expect, it } from "vitest";
import { cell, effect, isLens } from "../signal";
import { Bool, bool } from "../values/bool";
import { box } from "../values/box";
import { Num, num } from "../values/num";
import { range } from "../values/range";
import { vec } from "../values/vec";
import { verifyLensLaws } from "./_laws";

// ─── Factory ──────────────────────────────────────────────────────

describe("bool() factory", () => {
  it("seeds a fresh writable cell from a literal", () => {
    const b = bool(true);
    expect(b).toBeInstanceOf(Bool);
    expect(b.value).toBe(true);
    b.value = false;
    expect(b.value).toBe(false);
  });

  it("identity-passes an existing writable Bool", () => {
    const a = bool(true);
    const b = bool(a);
    expect(b).toBe(a);
  });

  it("default value is false", () => {
    expect(bool().value).toBe(false);
  });

  it("uses identity equality for change detection", () => {
    const b = bool(true);
    let fires = 0;
    const dispose = effect(() => {
      void b.value;
      fires++;
    });
    fires = 0;
    b.value = true; // no change
    expect(fires).toBe(0);
    b.value = false;
    expect(fires).toBe(1);
    dispose();
  });
});

// ─── not() — the canonical involution ─────────────────────────────

describe("Bool.not()", () => {
  it("reads the negation", () => {
    const b = bool(true);
    const n = b.not();
    expect(n.value).toBe(false);
    b.value = false;
    expect(n.value).toBe(true);
  });

  it("returns a writable lens — writes propagate to source", () => {
    const b = bool(false);
    const n = b.not();
    expect(isLens(n)).toBe(true);
    n.value = false; // → source becomes true
    expect(b.value).toBe(true);
    n.value = true; // → source becomes false
    expect(b.value).toBe(false);
  });

  it("double-not fuses to identity behaviour", () => {
    const b = bool(false);
    const nn = b.not().not();
    expect(nn.value).toBe(false);
    nn.value = true;
    expect(b.value).toBe(true);
  });

  it("triple-not is the same as single-not", () => {
    const b = bool(true);
    const nnn = b.not().not().not();
    expect(nnn.value).toBe(false);
    nnn.value = true;
    expect(b.value).toBe(false);
  });

  it("100-deep not chain still works (auto-fusion holds at depth)", () => {
    const b = bool(false);
    // biome-ignore lint/suspicious/noExplicitAny: arbitrary depth chain
    let chain: any = b;
    for (let i = 0; i < 100; i++) chain = chain.not();
    // 100 nots = identity (even count)
    expect(chain.value).toBe(false);
    chain.value = true;
    expect(b.value).toBe(true);
  });

  it("not().not() lens laws", () => {
    verifyLensLaws(
      () => {
        const b = bool(Math.random() < 0.5);
        return { source: b, lens: b.not().not() };
      },
      () => Math.random() < 0.5,
    );
  });

  it("not() lens laws", () => {
    verifyLensLaws(
      () => {
        const b = bool(Math.random() < 0.5);
        return { source: b, lens: b.not() };
      },
      () => Math.random() < 0.5,
    );
  });
});

// ─── xor() — F₂ group op ─────────────────────────────────────────

describe("Bool.xor()", () => {
  it("reads symmetric difference", () => {
    const b = bool(true);
    expect(b.xor(false).value).toBe(true);
    expect(b.xor(true).value).toBe(false);
  });

  it("xor with literal is invertible (writes propagate)", () => {
    const b = bool(false);
    const x = b.xor(true);
    expect(x.value).toBe(true);
    x.value = false; // a ^ true = false ↔ a = true
    expect(b.value).toBe(true);
    x.value = true; // a ^ true = true ↔ a = false
    expect(b.value).toBe(false);
  });

  it("xor with reactive `b` tracks `b` changes", () => {
    const a = bool(true);
    const b = bool(false);
    const x = a.xor(b);
    expect(x.value).toBe(true);
    b.value = true;
    expect(x.value).toBe(false);
    a.value = false;
    expect(x.value).toBe(true);
  });

  it("xor laws hold under random b", () => {
    verifyLensLaws(
      () => {
        const a = bool(Math.random() < 0.5);
        return { source: a, lens: a.xor(Math.random() < 0.5) };
      },
      () => Math.random() < 0.5,
    );
  });

  it("xor with self produces a constant false (Linear identity)", () => {
    const a = bool(true);
    const x = a.xor(a);
    expect(x.value).toBe(false);
    a.value = false;
    expect(x.value).toBe(false);
  });

  it("chained xors: a.xor(b).xor(c) reads correctly", () => {
    const a = bool(true);
    const b = bool(true);
    const c = bool(false);
    const x = a.xor(b).xor(c);
    expect(x.value).toBe(false); // true ^ true ^ false
    c.value = true;
    expect(x.value).toBe(true);
    b.value = false;
    expect(x.value).toBe(false); // true ^ false ^ true
  });

  it("chained xors are writable; writes invert through both literals", () => {
    const a = bool(true);
    const x = a.xor(true).xor(false); // a ^ true ^ false = !a
    expect(x.value).toBe(false);
    x.value = false;
    expect(a.value).toBe(true);
    x.value = true;
    expect(a.value).toBe(false);
  });

  it("not() and xor(true) coincide", () => {
    const a = bool(false);
    const viaNot = a.not();
    const viaXor = a.xor(true);
    expect(viaNot.value).toBe(viaXor.value);
    viaNot.value = false;
    expect(a.value).toBe(true);
    viaXor.value = true;
    expect(a.value).toBe(false);
  });
});

// ─── Derived RO (and/or/implies/eq/nand/nor) ──────────────────────

describe("Bool RO derivations", () => {
  it("and tracks both inputs", () => {
    const a = bool(true);
    const b = bool(true);
    const ab = a.and(b);
    expect(ab.value).toBe(true);
    b.value = false;
    expect(ab.value).toBe(false);
    a.value = false;
    expect(ab.value).toBe(false);
  });

  it("or tracks both inputs", () => {
    const a = bool(false);
    const b = bool(false);
    expect(a.or(b).value).toBe(false);
    b.value = true;
    expect(a.or(b).value).toBe(true);
  });

  it("implies", () => {
    const a = bool(true);
    const b = bool(false);
    expect(a.implies(b).value).toBe(false);
    b.value = true;
    expect(a.implies(b).value).toBe(true);
    a.value = false;
    b.value = false;
    expect(a.implies(b).value).toBe(true); // false → anything
  });

  it("eq, nand, nor", () => {
    const a = bool(true);
    const b = bool(true);
    expect(a.eq(b).value).toBe(true);
    expect(a.nand(b).value).toBe(false);
    expect(a.nor(b).value).toBe(false);
    b.value = false;
    expect(a.eq(b).value).toBe(false);
    expect(a.nand(b).value).toBe(true);
    expect(a.nor(b).value).toBe(false);
  });

  it("RO derivations reject writes", () => {
    const a = bool(true);
    const b = bool(true);
    const d = a.and(b);
    // RO type — but check the runtime catches an attempted write too.
    expect(() => {
      (d as unknown as { value: boolean }).value = false;
    }).toThrow();
  });
});

// ─── Bool.lens — cross-class bridges ──────────────────────────────

describe("Bool.lens (cross-class bridges)", () => {
  it("Bool.derive from a Num threshold", () => {
    const x = num(0.4);
    const above = Bool.derive(() => x.value > 0.5);
    expect(above.value).toBe(false);
    x.value = 0.6;
    expect(above.value).toBe(true);
    x.value = 0.4;
    expect(above.value).toBe(false);
  });

  it("Bool.lens — bidirectional Num threshold (writes clamp source past threshold)", () => {
    const x = num(0.3);
    const EPS = 1e-6;
    const above = Bool.lens(
      x,
      v => v > 0.5,
      // Stateful bwd: when writing true with current ≤ 0.5, bump source
      // to 0.5 + EPS. When writing false with current > 0.5, bump source
      // to 0.5 − EPS. Otherwise leave source unchanged.
      (target, current) => {
        if (target) return current > 0.5 ? current : 0.5 + EPS;
        return current <= 0.5 ? current : 0.5 - EPS;
      },
    );
    expect(above.value).toBe(false);
    above.value = true;
    expect(x.value).toBeGreaterThan(0.5);
    expect(above.value).toBe(true);
    above.value = false;
    expect(x.value).toBeLessThanOrEqual(0.5);
    expect(above.value).toBe(false);
  });

  it("Bool.lens — N-input fan-in (writable AND with policy: 'set both')", () => {
    const a = bool(false);
    const b = bool(false);
    // Policy: writing true forces both true; writing false forces both
    // false. PutGet holds. The "absorb-both" fan-in policy.
    const both = Bool.lens(
      [a, b] as const,
      vs => vs[0] && vs[1],
      target => [target, target] as never,
    );
    expect(both.value).toBe(false);
    both.value = true;
    expect(a.value).toBe(true);
    expect(b.value).toBe(true);
    expect(both.value).toBe(true);
    both.value = false;
    expect(a.value).toBe(false);
    expect(b.value).toBe(false);
  });
});

// ─── Linear trait — xor is the F₂ group operation ─────────────────

describe("Bool — Linear trait", () => {
  it("trait dictionary is exposed at class level", () => {
    expect(Bool.traits.linear).toBeDefined();
    expect(Bool.traits.linear!.add(true, false)).toBe(true);
    expect(Bool.traits.linear!.add(true, true)).toBe(false);
    expect(Bool.traits.linear!.sub(true, true)).toBe(false);
    expect(Bool.traits.linear!.scale(true, 1)).toBe(true);
    expect(Bool.traits.linear!.scale(true, 2)).toBe(false);
    expect(Bool.traits.linear!.scale(true, 0)).toBe(false);
  });
});

// ─── Effect tracking ──────────────────────────────────────────────

describe("Bool — effect tracking", () => {
  it("effect fires when source flips", () => {
    const b = bool(false);
    let last = b.value;
    let fires = 0;
    const dispose = effect(() => {
      last = b.value;
      fires++;
    });
    fires = 0;
    b.value = true;
    expect(last).toBe(true);
    expect(fires).toBe(1);
    b.value = false;
    expect(fires).toBe(2);
    dispose();
  });

  it("effect tracks not() lens output", () => {
    const b = bool(false);
    const n = b.not();
    let last = n.value;
    let fires = 0;
    const dispose = effect(() => {
      last = n.value;
      fires++;
    });
    fires = 0;
    b.value = true;
    expect(last).toBe(false);
    expect(fires).toBe(1);
    dispose();
  });

  it("effect tracks chained boolean logic (RO derivations)", () => {
    const a = bool(true);
    const b = bool(true);
    const c = bool(true);
    const all = a.and(b).and(c);
    let last = all.value;
    let fires = 0;
    const dispose = effect(() => {
      last = all.value;
      fires++;
    });
    fires = 0;
    c.value = false;
    expect(last).toBe(false);
    expect(fires).toBe(1);
    c.value = true;
    expect(last).toBe(true);
    dispose();
  });
});

// ─── Stress: deep chains, signal sharing ──────────────────────────

describe("Bool — stress", () => {
  it("not().xor(b).not().xor(c).not() compositions write through", () => {
    const a = bool(false);
    // !( !( !a xor true) xor false ) = !(!(a xor false) xor false)
    //                               = !(!a xor false) = !!a xor true = a xor true = !a... walk it:
    //   a=false: !false=true, true^true=false, !false=true, true^false=true, !true=false → chain=false
    //   a=true:  !true=false, false^true=true, !true=false, false^false=false, !false=true → chain=true
    // So chain ≡ a (identity by accident). Use it anyway to exercise the
    // 5-deep fused setter path.
    const chain = a.not().xor(true).not().xor(false).not();
    expect(chain.value).toBe(false);
    chain.value = true;
    expect(a.value).toBe(true);
    chain.value = false;
    expect(a.value).toBe(false);
  });

  it("two lenses sharing a source stay independent", () => {
    const a = bool(false);
    const n1 = a.not();
    const n2 = a.not();
    n1.value = false; // a := true
    expect(a.value).toBe(true);
    expect(n2.value).toBe(false);
    n2.value = true; // a := false
    expect(a.value).toBe(false);
    expect(n1.value).toBe(true);
  });

  it("self-write inside an effect bounded by the engine", () => {
    const b = bool(false);
    let fires = 0;
    const dispose = effect(() => {
      fires++;
      if (fires < 50 && b.value) {
        // Toggle off when on. Bounded by engine guard.
        b.value = false;
      }
    });
    b.value = true;
    expect(fires).toBeLessThan(100);
    expect(b.value).toBe(false);
    dispose();
  });

  it("signal<boolean> can still be wrapped in derive — back-compat with the loose use", () => {
    // Confirms Bool doesn't break the pre-existing Signal<boolean> usage
    // that the codebase already has in many places.
    const raw = cell(false);
    const b = Bool.derive(() => raw.value);
    expect(b).toBeInstanceOf(Bool);
    expect(b.value).toBe(false);
    raw.value = true;
    expect(b.value).toBe(true);
  });
});

// ─── Predicate bridges (upstreamed methods) ─────────────────────────
//
// `Num.greaterThan`, `Num.lessThan`, `Num.divisibleBy`, `Num.isEven`,
// `Num.isOdd`, `Box.contains(p)`, `Range.contains(v)` — the bridge
// family. Each is a quotient lens with ≈_S = "same boolean class". The
// laws verified below:
//
//   - Forward reads track source changes.
//   - Writing the predicate flips source via the bwd's policy.
//   - GetPut: writing back the read value is a no-op on source.
//   - PutPut: only the last write counts.
//   - Writability propagates: a writable receiver yields Writable<Bool>.

describe("Num.greaterThan(t) — predicate bridge", () => {
  it("reads `v > t` reactively", () => {
    const n = num(0.3);
    const above = n.greaterThan(0.5);
    expect(above.value).toBe(false);
    n.value = 0.7;
    expect(above.value).toBe(true);
    n.value = 0.4;
    expect(above.value).toBe(false);
  });

  it("writing `true` bumps source past threshold by eps", () => {
    const n = num(0.3);
    const above = n.greaterThan(0.5, 0.05);
    above.value = true;
    expect(n.value).toBeCloseTo(0.55);
    expect(above.value).toBe(true);
  });

  it("writing `false` bumps source below threshold", () => {
    const n = num(0.9);
    const above = n.greaterThan(0.5, 0.05);
    above.value = false;
    expect(n.value).toBeCloseTo(0.45);
    expect(above.value).toBe(false);
  });

  it("identity write — no source change when target matches current state", () => {
    const n = num(0.7);
    const above = n.greaterThan(0.5);
    above.value = true; // already true
    expect(n.value).toBe(0.7);
  });

  it("GetPut over random thresholds and sources", () => {
    for (let i = 0; i < 50; i++) {
      const v = Math.random() * 2 - 1;
      const t = Math.random() * 2 - 1;
      const n = num(v);
      const above = n.greaterThan(t);
      above.value = above.peek();
      expect(n.value).toBe(v);
    }
  });

  it("reactive threshold tracks", () => {
    const n = num(0.7);
    const t = num(0.5);
    const above = n.greaterThan(t);
    expect(above.value).toBe(true);
    t.value = 0.8;
    expect(above.value).toBe(false);
  });

  it("PutPut: only the last write survives", () => {
    const n = num(0.1);
    const above = n.greaterThan(0.5);
    above.value = true;
    above.value = false;
    expect(above.value).toBe(false);
    expect(n.value).toBeLessThan(0.5);
  });
});

describe("Num.lessThan(t) — predicate bridge", () => {
  it("reads `v < t`", () => {
    const n = num(0.3);
    const below = n.lessThan(0.5);
    expect(below.value).toBe(true);
    n.value = 0.7;
    expect(below.value).toBe(false);
  });

  it("writes flip source across the threshold", () => {
    const n = num(0.7);
    const below = n.lessThan(0.5, 0.05);
    below.value = true;
    expect(n.value).toBeCloseTo(0.45);
    below.value = false;
    expect(n.value).toBeCloseTo(0.55);
  });
});

describe("Num.divisibleBy(d) — discrete classifier", () => {
  it("reads divisibility under round()", () => {
    const n = num(6);
    const by3 = n.divisibleBy(3);
    expect(by3.value).toBe(true);
    n.value = 7;
    expect(by3.value).toBe(false);
    n.value = 0;
    expect(by3.value).toBe(true);
  });

  it("write `true` snaps to NEAREST multiple", () => {
    const n = num(7);
    const by3 = n.divisibleBy(3);
    by3.value = true;
    // Closer to 6 than to 9.
    expect(n.value).toBe(6);
    expect(by3.value).toBe(true);
  });

  it("write `true` on equidistant target prefers the lower multiple", () => {
    // For r=7.5, |down=6|=1.5, |up=9|=1.5 — tie. Math.abs(<=) tiebreaks
    // toward `down` (the if-branch evaluates lhs first).
    const n = num(7.5);
    const by3 = n.divisibleBy(3);
    by3.value = true;
    expect(n.value).toBe(6);
  });

  it("write `false` bumps by +1", () => {
    const n = num(6);
    const by3 = n.divisibleBy(3);
    by3.value = false;
    expect(n.value).toBe(7);
    expect(by3.value).toBe(false);
  });

  it("identity write — no change when target matches", () => {
    const n = num(6);
    const by3 = n.divisibleBy(3);
    by3.value = true;
    expect(n.value).toBe(6);
  });

  it("handles negative numbers correctly", () => {
    const n = num(-7);
    const by3 = n.divisibleBy(3);
    // -7 mod 3 = (-7 % 3 + 3) % 3 = (-1 + 3) % 3 = 2 → not divisible.
    expect(by3.value).toBe(false);
    by3.value = true;
    // Nearest multiple to -7: -6 (dist 1) or -9 (dist 2) → -6.
    expect(n.value).toBe(-6);
  });

  it("GetPut over random ints", () => {
    for (let i = 0; i < 50; i++) {
      const v = Math.floor(Math.random() * 40 - 20);
      const d = 1 + Math.floor(Math.random() * 9);
      const n = num(v);
      const by = n.divisibleBy(d);
      by.value = by.peek();
      expect(n.value).toBe(v);
    }
  });
});

describe("Num.isEven / Num.isOdd — getters", () => {
  it("isEven reads parity", () => {
    const n = num(4);
    expect(n.isEven.value).toBe(true);
    n.value = 5;
    expect(n.isEven.value).toBe(false);
  });

  it("isOdd is the negation", () => {
    const n = num(4);
    expect(n.isOdd.value).toBe(false);
    n.value = 5;
    expect(n.isOdd.value).toBe(true);
  });

  it("isEven write flips parity by ±1", () => {
    const n = num(5);
    n.isEven.value = true;
    // Nearest even integer: 4 or 6 (tie) → snap-to-nearer picks 4.
    expect([4, 6]).toContain(n.value);
    expect(n.value % 2).toBe(0);
  });

  it("isEven and isOdd are cached lazy getters (identity-stable)", () => {
    const n = num(4);
    expect(n.isEven).toBe(n.isEven);
    expect(n.isOdd).toBe(n.isOdd);
  });
});

describe("Box.contains(p) — spatial bridge", () => {
  type BoxV = { x: number; y: number; w: number; h: number };
  const BOX: BoxV = { x: 0, y: 0, w: 10, h: 10 };

  it("reads `p in box` reactively", () => {
    const b = box(BOX.x, BOX.y, BOX.w, BOX.h);
    const p = vec(5, 5);
    const inside = b.contains(p);
    expect(inside.value).toBe(true);
    p.value = { x: 20, y: 5 };
    expect(inside.value).toBe(false);
    p.value = { x: 0, y: 5 }; // boundary
    expect(inside.value).toBe(true);
  });

  it("writing `true` (currently outside) clamps to the nearest in-box point", () => {
    const b = box(BOX.x, BOX.y, BOX.w, BOX.h);
    const p = vec(20, 5);
    const inside = b.contains(p);
    inside.value = true;
    // Nearest in-box: clamp x to [0, 10] → x=10.
    expect(p.value).toEqual({ x: 10, y: 5 });
    expect(inside.value).toBe(true);
  });

  it("writing `false` (currently inside) ejects past nearest edge by eps", () => {
    const b = box(BOX.x, BOX.y, BOX.w, BOX.h);
    const p = vec(7, 5);
    const inside = b.contains(p);
    inside.value = false;
    // Nearest edge: right (10 - 7 = 3) vs bottom (10 - 5 = 5). Right wins.
    expect(p.value.x).toBeGreaterThan(10);
    expect(p.value.y).toBe(5);
    expect(inside.value).toBe(false);
  });

  it("identity write — no source change when target matches", () => {
    const b = box(BOX.x, BOX.y, BOX.w, BOX.h);
    const p = vec(5, 5);
    const inside = b.contains(p);
    inside.value = true;
    expect(p.value).toEqual({ x: 5, y: 5 });
  });

  it("RO branch: literal `p` yields a bare Bool (no write capability)", () => {
    const b = box(BOX.x, BOX.y, BOX.w, BOX.h);
    const inside = b.contains({ x: 5, y: 5 });
    expect(inside.value).toBe(true);
    // RO at the type level; runtime write throws via the underlying
    // computed (no setter installed).
    expect(() => {
      (inside as unknown as { value: boolean }).value = false;
    }).toThrow();
  });

  it("GetPut: writing back the read value is a no-op", () => {
    for (let i = 0; i < 50; i++) {
      const px = Math.random() * 20 - 5;
      const py = Math.random() * 20 - 5;
      const b = box(BOX.x, BOX.y, BOX.w, BOX.h);
      const p = vec(px, py);
      const inside = b.contains(p);
      inside.value = inside.peek();
      expect(p.value).toEqual({ x: px, y: py });
    }
  });

  it("box and p both tracked: moving box and writing predicate both work", () => {
    const b = box(0, 0, 10, 10);
    const p = vec(15, 5);
    const inside = b.contains(p);
    expect(inside.value).toBe(false);
    // Move box to contain p without moving p.
    b.value = { x: 10, y: 0, w: 10, h: 10 };
    expect(inside.value).toBe(true);
    // Now move p back outside.
    inside.value = false;
    expect(inside.value).toBe(false);
  });
});

describe("Range.contains(v) — 1D spatial bridge", () => {
  it("reads membership", () => {
    const r = range(0, 1);
    const v = num(0.5);
    const inside = r.contains(v);
    expect(inside.value).toBe(true);
    v.value = 2;
    expect(inside.value).toBe(false);
  });

  it("writing `true` (currently outside) clamps into range", () => {
    const r = range(0, 1);
    const v = num(2);
    const inside = r.contains(v);
    inside.value = true;
    expect(v.value).toBe(1);
    expect(inside.value).toBe(true);
  });

  it("writing `false` (currently inside) ejects past nearest endpoint", () => {
    const r = range(0, 1);
    const v = num(0.7);
    const inside = r.contains(v);
    inside.value = false;
    // hi=1 distance 0.3, lo=0 distance 0.7 → eject past hi.
    expect(v.value).toBeGreaterThan(1);
    expect(inside.value).toBe(false);
  });

  it("RO branch: literal value yields a bare Bool", () => {
    const r = range(0, 1);
    const inside = r.contains(0.5);
    expect(inside.value).toBe(true);
    expect(() => {
      (inside as unknown as { value: boolean }).value = false;
    }).toThrow();
  });
});

// Touch unused imports to satisfy strict TS.
void Num;
