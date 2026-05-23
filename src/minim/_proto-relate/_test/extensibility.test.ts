// extensibility.test.ts — confirm Writable<R> works for USER-DEFINED
// value classes with ZERO library changes. This is the property the
// hand-maintained `LiftField` registry was blocking.

import { describe, expect, it } from "vitest";
import {
  invertibles,
  type Linear,
  lazy,
  Num,
  Signal,
  type SignalOptions,
  traits,
  type Val,
  valFn,
  type Writable,
} from "../index";

// ─── A user-defined value class ──────────────────────────────────
//
// Made of three numeric fields (h, s, l). The library doesn't know
// about this class; we just declare it in user-space and Writable<Hsl>
// should "just work" — invertible methods lift, field lenses lift to
// Writable<Num>, brand applied via factory cast.

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
  static invertibles = invertibles<Hsl>()("add", "scale");

  // (derive / lens / is inherited from Signal — the whole point of
  // this test is to demonstrate user value classes get the static
  // surface for free, no per-class boilerplate.)

  constructor(v: V = { h: 0, s: 0, l: 0 }, opts?: SignalOptions<V>) {
    super(v, opts);
  }

  add(b: Val<V>): Hsl {
    const bf = valFn(b);
    return this.through(
      v => hslAdd(v, bf()),
      n => hslSub(n, bf()),
    );
  }
  scale(k: Val<number>): Hsl {
    const kf = valFn(k);
    return this.through(
      v => hslScale(v, kf()),
      n => hslScale(n, 1 / kf()),
    );
  }

  get h(): Num {
    return lazy(this, "h", () =>
      this.lensTo(
        Num,
        s => s.h,
        (v, s) => ({ ...s, h: v }),
      ),
    );
  }
  get s(): Num {
    return lazy(this, "s", () =>
      this.lensTo(
        Num,
        s => s.s,
        (v, s) => ({ ...s, s: v }),
      ),
    );
  }
  get l(): Num {
    return lazy(this, "l", () =>
      this.lensTo(
        Num,
        s => s.l,
        (v, s) => ({ ...s, l: v }),
      ),
    );
  }
}
interface Hsl {
  readonly constructor: typeof Hsl;
  get value(): V;
}

function hsl(h = 0, s = 0, l = 0): Writable<Hsl> {
  const x = new Hsl({ h, s, l }) as unknown as Writable<Hsl>;
  return x;
}

describe("Extensibility — Writable<UserClass> works without library changes", () => {
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
