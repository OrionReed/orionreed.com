// Prototype exploration: can the struct framework be much smaller?
//
// Three contenders, each rebuilds Vec/Transform from scratch in <120 LOC
// and we bench them side-by-side against the current `defineStruct`.
//
// Goals each prototype tries to satisfy:
//   • single uniform implementation (no per-arity unrolling)
//   • capability lookup, but as a flat dispatch (no prototype slots)
//   • per-axis SoA storage for nested struct fields
//   • method surface for cells (`v.x`, `v.lerp(...)`) without
//     ahead-of-time prototype installation
//
// Run with:
//   node --expose-gc node_modules/.bin/vite-node src/minim/_bench/_struct_proto.bench.ts

import { Signal, computed, lens, signal, type ReadonlySignal } from "@minim/signals";
import { Vec as V_DS } from "@minim/values";
import { Vec as V_LIB } from "@minim/values"; // current production Vec, for comparison
import { bench, group, run } from "mitata";

type V = { x: number; y: number };
type Tr = { translate: V; rotate: number; scale: V; origin: V; opacity: number };

const VEC_LERP = (a: V, b: V, t: number): V => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});
const VEC_ALG = {
  add: (a: V, b: V) => ({ x: a.x + b.x, y: a.y + b.y }),
  sub: (a: V, b: V) => ({ x: a.x - b.x, y: a.y - b.y }),
  scale: (a: V, k: number) => ({ x: a.x * k, y: a.y * k }),
};

// ─────────────────────────────────────────────────────────────────────
// Prototype A — "registry-only" — no per-type prototype, no class.
// Cells are plain Signal/Computed; capabilities live in a side-table
// keyed by an interned `kind` string. Method calls go through the
// table.
//
// Trade: every method call hops through the registry. Wins on impl
// size (~40 LOC). Loses on monomorphism — calling `.lerp(...)` on a
// thousand different cells goes through one dispatch site.
// ─────────────────────────────────────────────────────────────────────
type RegEntry<T> = {
  algebra?: typeof VEC_ALG;
  lerp?: typeof VEC_LERP;
  metric?: (a: T, b: T) => number;
};
const Registry = new Map<string, RegEntry<unknown>>();

function regCell<T>(kind: string, init: T) {
  const s = signal(init);
  (s as any).kind = kind;
  return s as Signal<T> & { kind: string };
}

function regLerp<T>(self: Signal<T>, target: ReadonlySignal<T>, t: number): T {
  const entry = Registry.get((self as any).kind) as RegEntry<any> | undefined;
  return entry!.lerp!(self.value as any, target.value as any, t) as T;
}

Registry.set("Vec", { algebra: VEC_ALG, lerp: VEC_LERP, metric: (a, b) => Math.hypot((a as V).x - (b as V).x, (a as V).y - (b as V).y) } as RegEntry<unknown>);

// ─────────────────────────────────────────────────────────────────────
// Prototype B — "class-based" — Vec IS a class extending a thin
// ReactiveCell. Methods on the class. Capabilities are static props.
// Construction: `new Vec({x, y})` or `Vec.of(x, y)`.
//
// Pro: native ES sugar, `instanceof` works, methods are monomorphic.
// Con: more boilerplate per type (you write the methods yourself).
// ─────────────────────────────────────────────────────────────────────
class ReactiveBase<T> {
  protected sig: Signal<T>;
  constructor(initial: T) {
    this.sig = signal(initial);
  }
  get value(): T { return this.sig.value; }
  set value(v: T) { this.sig.value = v; }
  peek(): T { return this.sig.peek(); }
}

class VecCell extends ReactiveBase<V> {
  static lerp = VEC_LERP;
  static algebra = VEC_ALG;
  // Lazy axes: created on first access, then re-used.
  private _x?: Signal<number>;
  private _y?: Signal<number>;
  get x(): Signal<number> {
    return (this._x ??= lens(() => this.sig.value.x, (x) => { this.sig.value = { x, y: this.sig.peek().y }; }));
  }
  get y(): Signal<number> {
    return (this._y ??= lens(() => this.sig.value.y, (y) => { this.sig.value = { x: this.sig.peek().x, y }; }));
  }
  add(b: V) { return new VecCell(VEC_ALG.add(this.sig.peek(), b)); }
  scale(k: number) { return new VecCell(VEC_ALG.scale(this.sig.peek(), k)); }
  lerpTo(target: V, t: number): V { return VEC_LERP(this.sig.peek(), target, t); }
}

// ─────────────────────────────────────────────────────────────────────
// Prototype C — "config-only struct" — almost identical to current
// defineStruct, but stripped to <80 LOC. No ops/scalars/getters/methods
// distinction — caller passes a single `methods` bag that includes
// everything, and we wire all of them as `this`-bound prototype
// methods. Algebra/lerp/metric are stored as own-properties on the
// type singleton (not symbols).
//
// Capabilities are simple property lookups; no Symbol.for indirection.
// ─────────────────────────────────────────────────────────────────────
type CapBag<T> = {
  defaults: T;
  algebra?: { add: (a: T, b: T) => T; sub: (a: T, b: T) => T; scale: (a: T, k: number) => T };
  lerp?: (a: T, b: T, t: number) => T;
  metric?: (a: T, b: T) => number;
  nested?: Record<string, any>;
};

function tinyStruct<T extends Record<string, any>>(name: string, cfg: CapBag<T>) {
  const keys = Object.keys(cfg.defaults);
  // Per-type prototype carrying axis getters.
  const proto: any = {};
  for (const k of keys) {
    Object.defineProperty(proto, k, {
      configurable: true,
      get(this: any) {
        const ax = lens(
          () => this.sig.value[k],
          (v) => {
            const cur = this.sig.peek();
            this.sig.value = { ...cur, [k]: v };
          },
        );
        Object.defineProperty(this, k, { value: ax, enumerable: false });
        return ax;
      },
    });
  }
  if (cfg.lerp) {
    proto.lerp = function (this: any, target: ReadonlySignal<T>, t: number): T {
      return cfg.lerp!(this.sig.peek(), target.value, t);
    };
  }
  function factory(init: T) {
    const obj: any = Object.create(proto);
    obj.sig = signal(init);
    Object.defineProperty(obj, "value", {
      get() { return this.sig.value; },
      set(v: T) { this.sig.value = v; },
    });
    obj.peek = function () { return this.sig.peek(); };
    obj.kind = name;
    return obj;
  }
  factory.algebra = cfg.algebra;
  factory.lerp = cfg.lerp;
  factory.metric = cfg.metric;
  return factory;
}

const V_TINY = tinyStruct<V>("Vec", {
  defaults: { x: 0, y: 0 },
  algebra: VEC_ALG,
  lerp: VEC_LERP,
  metric: (a, b) => Math.hypot(a.x - b.x, a.y - b.y),
});

// ─────────────────────────────────────────────────────────────────────
// Benchmark: construction, per-axis write, whole-value lerp
// ─────────────────────────────────────────────────────────────────────

group("construction (1 Vec cell)", () => {
  bench("current defineStruct (lib Vec.signal)", () => {
    return V_LIB.signal({ x: 1, y: 2 });
  }).baseline(true);
  bench("Prototype A — registry signal()", () => {
    return regCell("Vec", { x: 1, y: 2 });
  });
  bench("Prototype B — new VecCell()", () => {
    return new VecCell({ x: 1, y: 2 });
  });
  bench("Prototype C — tinyStruct factory", () => {
    return V_TINY({ x: 1, y: 2 });
  });
});

group("per-axis write (subscribe + many writes)", () => {
  const libV: any = V_LIB.signal({ x: 0, y: 0 });
  const protoA: any = regCell("Vec", { x: 0, y: 0 });
  const protoB = new VecCell({ x: 0, y: 0 });
  const protoC: any = V_TINY({ x: 0, y: 0 });
  // Warm up axes
  void libV.x; void protoB.x; void protoC.x;
  let i = 0;
  bench("current defineStruct: lib.x.value = i", () => { libV.x.value = ++i; }).baseline(true);
  bench("Prototype A: whole replace (no lens)", () => {
    const cur = (protoA as Signal<V>).peek();
    (protoA as Signal<V>).value = { x: ++i, y: cur.y };
  });
  bench("Prototype B: class lens .x.value = i", () => { protoB.x.value = ++i; });
  bench("Prototype C: tinyStruct .x.value = i", () => { protoC.x.value = ++i; });
});

group("lerp (whole-value, hot path)", () => {
  const libA: any = V_LIB.signal({ x: 0, y: 0 });
  const libB: any = V_LIB.signal({ x: 100, y: 100 });
  const aA: any = regCell("Vec", { x: 0, y: 0 });
  const aB: any = regCell("Vec", { x: 100, y: 100 });
  const bA = new VecCell({ x: 0, y: 0 });
  const bB = new VecCell({ x: 100, y: 100 });
  const cA: any = V_TINY({ x: 0, y: 0 });
  const cB: any = V_TINY({ x: 100, y: 100 });
  let t = 0;
  bench("current: libA.lerp(libB, t)", () => {
    t = (t + 0.01) % 1; return (libA as any).lerp(libB, t).value;
  }).baseline(true);
  bench("Prototype A: regLerp(aA, aB, t)", () => {
    t = (t + 0.01) % 1; return regLerp(aA, aB, t);
  });
  bench("Prototype B: bA.lerpTo(bB.peek(), t)", () => {
    t = (t + 0.01) % 1; return bA.lerpTo(bB.peek(), t);
  });
  bench("Prototype C: cA.lerp(cB, t)", () => {
    t = (t + 0.01) % 1; return cA.lerp(cB, t);
  });
});

group("computed read (subscribe to .x)", () => {
  const libV: any = V_LIB.signal({ x: 0, y: 0 });
  const protoB = new VecCell({ x: 0, y: 0 });
  const protoC: any = V_TINY({ x: 0, y: 0 });

  const c1 = computed(() => libV.x.value * 2);
  const c2 = computed(() => protoB.x.value * 2);
  const c3 = computed(() => protoC.x.value * 2);
  // prime
  void c1.value; void c2.value; void c3.value;
  let i = 0;
  bench("current: write libV.x; read c1", () => { libV.x.value = ++i; return c1.value; }).baseline(true);
  bench("Prototype B: write protoB.x; read c2", () => { protoB.x.value = ++i; return c2.value; });
  bench("Prototype C: write protoC.x; read c3", () => { protoC.x.value = ++i; return c3.value; });
});

await run({ format: "mitata" });

console.log("\nLines of impl (rough):");
console.log("  current defineStruct + Builder removed:    986 (signals/struct.ts)");
console.log("  Prototype A — registry-only:                ~40");
console.log("  Prototype B — class-based:                  ~30 per value type");
console.log("  Prototype C — config-only minimal:          ~50");
console.log("");
console.log("Note: prototypes implement Vec-flavored cells only — they do");
console.log("not yet handle nested SoA storage, instanceof checks, smart");
console.log("adoption, or .derived/.lens flavors. Numbers measure the");
console.log("hot-path cost of the basic surface.");

void V_DS; // keep imports used
