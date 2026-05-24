// extensibility.test.ts — confirm the value-class authoring story
// works end-to-end for USER-DEFINED classes with ZERO library
// changes. The pattern: extend Signal<V>, declare `_writable: Wr<R>`
// for the registry brand, declare invertibles with `: this` returns,
// and use the `field()` / `derived()` helpers for getter bodies.

import { describe, expect, it } from "vitest";
import {
  field,
  type Linear,
  Num,
  Signal,
  type SignalOptions,
  traits,
  type Val,
  valFn,
  type Wr,
  type Writable,
} from "../index";

// ─── A user-defined value class ──────────────────────────────────
//
// Made of three numeric fields (h, s, l). Authoring template:
//   1. pure value-space functions
//   2. class extends Signal<V>
//   3. static traits dict
//   4. declare _writable: Wr<R>  (registry brand, 1 line)
//   5. invertible methods return `: this` (no list to maintain)
//   6. field-lens getters call `field(this, "k", Cls)`
//   7. interface merge for RO `value`
//   8. factory casts `as Writable<Hsl>` (one cast)

type V = { h: number; s: number; l: number };

const hslAdd = (a: V, b: V): V => ({ h: a.h + b.h, s: a.s + b.s, l: a.l + b.l });
const hslSub = (a: V, b: V): V => ({ h: a.h - b.h, s: a.s - b.s, l: a.l - b.l });
const hslScale = (a: V, k: number): V => ({ h: a.h * k, s: a.s * k, l: a.l * k });
const hslLerp = (a: V, b: V, t: number): V => ({
  h: a.h + (b.h - a.h) * t,
  s: a.s + (b.s - a.s) * t,
  l: a.l + (b.l - a.l) * t,
});

const linearImpl: Linear<V> = { add: hslAdd, sub: hslSub, scale: hslScale };

class Hsl extends Signal<V> {
  static traits = traits<V>()({
    linear: linearImpl,
    lerp: hslLerp,
    metric: (a: V, b: V) => Math.abs(a.h - b.h) + Math.abs(a.s - b.s) + Math.abs(a.l - b.l),
    equals: (a: V, b: V) => a.h === b.h && a.s === b.s && a.l === b.l,
  });

  declare readonly _writable: Wr<Hsl>;

  constructor(v: V = { h: 0, s: 0, l: 0 }, opts?: SignalOptions<V>) {
    super(v, opts);
  }

  add(b: Val<V>): this {
    const bf = valFn(b);
    return this.lens(
      v => hslAdd(v, bf()),
      n => hslSub(n, bf()),
    );
  }
  scale(k: Val<number>): this {
    const kf = valFn(k);
    return this.lens(
      v => hslScale(v, kf()),
      n => hslScale(n, 1 / kf()),
    );
  }

  get h() {
    return field(this, "h", Num);
  }
  get s() {
    return field(this, "s", Num);
  }
  get l() {
    return field(this, "l", Num);
  }
}
interface Hsl {
  readonly constructor: typeof Hsl;
  get value(): V;
}

function hsl(h = 0, s = 0, l = 0): Writable<Hsl> {
  return new Hsl({ h, s, l }) as Writable<Hsl>;
}

describe("Extensibility — user-defined value classes work without library changes", () => {
  it("Writable<Hsl> exposes writable value + invertibles + field lenses", () => {
    const c = hsl(0.5, 0.7, 0.3);
    expect(c.value).toEqual({ h: 0.5, s: 0.7, l: 0.3 });
    c.value = { h: 0.1, s: 0.2, l: 0.3 };
    expect(c.value.h).toBeCloseTo(0.1);
  });

  it("field-lens auto-lifts to Writable<Num> on Writable<Hsl>", () => {
    const c = hsl(0, 0, 0);
    c.h.value = 0.42;
    expect(c.value.h).toBeCloseTo(0.42);
  });

  it("invertible chain stays writable", () => {
    const c = hsl(0, 0, 0);
    const chained = c.add({ h: 0.1, s: 0.2, l: 0.3 }).scale(2);
    chained.value = { h: 1, s: 1, l: 1 };
    // bwd: ( 1,1,1 ) / 2 = (0.5, 0.5, 0.5); then sub {0.1,0.2,0.3}
    expect(c.value.h).toBeCloseTo(0.4);
    expect(c.value.s).toBeCloseTo(0.3);
    expect(c.value.l).toBeCloseTo(0.2);
  });

  it("Hsl.derive returns RO Hsl (no brand)", () => {
    const c = hsl(0, 0, 0);
    const d = Hsl.derive(() => ({ h: c.value.h * 2, s: 0, l: 0 }));
    expect(Hsl.is(d)).toBe(true);
    expect(() => {
      (d as unknown as { value: V }).value = { h: 0, s: 0, l: 0 };
    }).toThrow();
  });
});

// Compile-time probes — gated to never run.
function _typeProbes(): void {
  // @ts-expect-error — bare Hsl is RO at the public type level
  Hsl.derive(() => ({ h: 0, s: 0, l: 0 })).value = { h: 1, s: 1, l: 1 };

  // @ts-expect-error — bare Hsl's .h is RO Num
  Hsl.derive(() => ({ h: 0, s: 0, l: 0 })).h.value = 5;
}
_typeProbes;
if (Math.random() < -1) _typeProbes();
