// Hypothesis: a tiny "cell" primitive (~80 lines) plus a few opt-in
// helpers (axes, lift, lazy, withAlgebra) preserves struct's perf
// while collapsing ~half of struct.ts. Bench a hand-built Vec on the
// minimal primitive vs the framework-built Vec on the same operations.
//
// If the cell-built Vec is within ~1.2× of struct's Vec across these
// benches, the rework is safe. If it's significantly slower, the
// per-arity unrolling (or some other framework move) is paying for
// itself.

import { Signal, Computed, computed, lens } from "../core/signal";
import { Vec } from "../signals/vec";
import { bench, suite } from "./harness";

type V = { x: number; y: number };

// ── The minimal primitive ──────────────────────────────────────────

/** Toy cell — both methods AND descriptors via defineProperty, so
 *  axis getters install correctly. (See cell/cell.ts for the
 *  proper version with separate methods/descriptors slots.) */
function defineCell<T>(
  name: string,
  methods: object,
  descriptors: PropertyDescriptorMap = {},
) {
  const setup = (target: object) => {
    for (const key of Reflect.ownKeys(methods)) {
      const desc = Object.getOwnPropertyDescriptor(methods, key)!;
      Object.defineProperty(target, key, desc);
    }
    Object.defineProperties(target, descriptors);
  };

  const rwProto = Object.create(Signal.prototype);
  setup(rwProto);

  const roProto = Object.create(Computed.prototype);
  setup(roProto);

  const opts = { name };
  return {
    signal(v: T): any {
      const inst = Object.create(rwProto);
      Signal.call(inst, v, opts as any);
      return inst;
    },
    derived(fn: () => T): any {
      const inst = Object.create(roProto);
      Computed.call(inst, fn as () => unknown, opts as any);
      return inst;
    },
  };
}

// ── Opt-in helper: axis projections (lazy + cached on first read) ──

function axes<T>(
  fields: readonly (keyof T)[],
  write: (v: T, k: keyof T, n: any) => T,
): PropertyDescriptorMap {
  const out: PropertyDescriptorMap = {};
  for (const f of fields) {
    out[f as string] = {
      configurable: true,
      get(this: Signal<T>) {
        const self = this;
        const l = lens(
          () => (self.value as any)[f],
          (n) => {
            self.value = write(self.peek(), f, n);
          },
        );
        Object.defineProperty(self, f as PropertyKey, { value: l });
        return l;
      },
    };
  }
  return out;
}

// ── Opt-in helper: lift a pure op into a derived-returning method ──
//
// SIMPLE (non-per-arity-unrolled) version. The whole point of this
// bench: see whether the framework's per-arity unrolling matters.
// `derived` is the cell-type-specific derived factory (so `a.add(b)`
// returns a VecCell, not a raw Computed — chaining works).

function lift<T>(
  fn: (self: T, ...args: any[]) => T,
  derived: (fn: () => T) => unknown,
) {
  return function (this: Signal<T>, ...args: unknown[]) {
    const self = this;
    return derived(() => {
      const resolved = args.map((a) => {
        if (a instanceof Signal) return a.value;
        if (typeof a === "function") return (a as () => unknown)();
        return a;
      });
      return fn(self.value, ...resolved);
    });
  };
}

// ── Hand-built Vec via the cell primitive ──────────────────────────

// Forward declaration so methods can reference VecCell.derived.
let VecCellRef!: ReturnType<typeof defineCell<V>>;
const mkDerived = (fn: () => V) => VecCellRef.derived(fn);

const VecCellMethods = {
  add: lift((a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y }), mkDerived),
  sub: lift((a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y }), mkDerived),
  scale: lift(
    (a: V, k: number): V => ({ x: a.x * k, y: a.y * k }),
    mkDerived,
  ),
  lerp: lift(
    (a: V, b: V, t: number): V => ({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
    }),
    mkDerived,
  ),
};

const VecCellDescriptors = axes<V>(["x", "y"], (v, k, n) => ({ ...v, [k]: n }));

const VecCell = defineCell<V>("VecCell", VecCellMethods, VecCellDescriptors);
VecCellRef = VecCell;

// ── Benches: cell-built Vec vs framework Vec, head-to-head ─────────

suite("construction: cell Vec vs struct Vec", () => {
  bench("Vec.signal ({x,y})", () => Vec.signal({ x: 0, y: 0 }));
  bench("VecCell.signal ({x,y})", () => VecCell.signal({ x: 0, y: 0 }));
});

suite("axis write: cell Vec vs struct Vec", () => {
  const v: any = Vec.signal({ x: 0, y: 0 });
  const c: any = VecCell.signal({ x: 0, y: 0 });
  void v.x;
  void c.x;

  let i = 0;
  bench("Vec lens: v.x.value = ++i", () => {
    v.x.value = ++i;
  });
  bench("VecCell lens: c.x.value = ++i (spread fallback)", () => {
    c.x.value = ++i;
  });
});

suite("lifted op (add) round-trip: cell Vec vs struct Vec", () => {
  const v: any = Vec.signal({ x: 1, y: 2 });
  const v2 = Vec.signal({ x: 3, y: 4 });
  const c: any = VecCell.signal({ x: 1, y: 2 });
  const c2 = VecCell.signal({ x: 3, y: 4 });
  void v.x;
  void c.x;

  const sumV = v.add(v2);
  const sumC = c.add(c2);

  let i = 0;
  bench("Vec.add (per-arity unrolled lift)", () => {
    v.x.value = ++i;
    return sumV.value;
  });
  bench("VecCell.add (generic args.map lift)", () => {
    c.x.value = ++i;
    return sumC.value;
  });
});

suite("lifted chain: cell Vec vs struct Vec", () => {
  const va: any = Vec.signal({ x: 1, y: 2 });
  const vb = Vec.signal({ x: 3, y: 4 });
  const vc = Vec.signal({ x: 5, y: 6 });
  void va.x;
  const outV = va.add(vb).scale(2).add(vc);

  const ca: any = VecCell.signal({ x: 1, y: 2 });
  const cb = VecCell.signal({ x: 3, y: 4 });
  const cc = VecCell.signal({ x: 5, y: 6 });
  void ca.x;
  const outC = ca.add(cb).scale(2).add(cc);

  let i = 0;
  bench("Vec.add(b).scale(2).add(c).value", () => {
    va.x.value = ++i;
    return outV.value;
  });
  bench("VecCell.add(b).scale(2).add(c).value", () => {
    ca.x.value = ++i;
    return outC.value;
  });
});
