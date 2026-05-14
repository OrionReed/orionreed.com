// ── Design exploration: "Type + Cell" — one primitive everywhere ─────
//
// Step back from `defineStruct` + `Vec.signal` + `cell()` and see if we
// can collapse the surface into a single primitive that's good enough
// for every reactive value:
//
//   const x = cell(0);                    // bare reactive number
//   const v = cell({ x: 0, y: 0 }, Vec);  // typed Vec, methods light up
//   const c = cell(() => v.value.x);      // derived (read-only)
//
// Vocabulary shifts:
//
//   • `Type<T>` is a PLAIN OBJECT — name, defaults, optional capabilities.
//     No Builder, no defineStruct, no Symbol.for tables. The type IS
//     its config; library functions just read its properties.
//
//   • `Cell<T>` is the single reactive primitive. Bare cells have just
//     `.value` / `.peek()`. Typed cells additionally have lazy axes
//     (`.x`, `.y`), capability-derived methods (`.lerp`, `.to`,
//     `.distance`, `.add`, `.scale`), and instanceof support.
//
//   • Storage is AoS by default (one Signal per cell). Per-axis SoA
//     storage is opt-in via `Type.nested` AND `Type.soa: true`. Vec
//     stays AoS — nobody subscribes to `v.y` without also reading
//     `v.x` — so it constructs in one Signal allocation. Transform
//     stays SoA so per-axis writes (the hot path) don't refire
//     opacity subscribers.
//
//   • Capabilities live on the type as direct properties. `Type.lerp`,
//     `Type.algebra`, `Type.metric`. The library reads them directly
//     — no symbol indirection. User-defined caps are just additional
//     properties on the type config.
//
// What gets tested below:
//   1. Construction cost vs current `Vec.signal({x,y})`.
//   2. `.value` read / write cost.
//   3. Per-axis write (`.x.value = ...`) cost.
//   4. Method dispatch (`.lerp(b, t)`, `.distance(b)`).
//   5. Type predicate (`v instanceof Vec` / `Vec.is(v)`).
//   6. Computed read-through (write `.x`, read derived computed).
//
// Run with:
//   node --expose-gc node_modules/.bin/vite-node \
//     src/minim/_bench/_unified_cell.ts

import {
  Signal,
  computed,
  effect,
  lens,
  signal,
  batch,
  type ReadonlySignal,
} from "@minim/signals";
import { Vec as V_LIB } from "@minim/values";
import { bench, group, run } from "mitata";

// ─────────────────────────────────────────────────────────────────────
// THE PROTOTYPE
// ─────────────────────────────────────────────────────────────────────

/** A vector-space algebra (additive group + scalar action). */
interface Algebra<T> {
  add(a: T, b: T): T;
  sub(a: T, b: T): T;
  scale(a: T, k: number): T;
}

/** Type<T> — the plain config for a reactive value type. Everything is
 *  optional except `defaults`. The library reads these as direct
 *  property accesses; no symbol tables, no registration step. */
interface Type<T> {
  /** Display name + `instanceof` tag. */
  readonly name?: string;
  /** Initial value when no input is passed. */
  readonly defaults: T;
  /** Structural equality — suppress no-op writes. */
  readonly equals?: (a: T, b: T) => boolean;
  /** Linear interpolation. Enables `.lerp(b, t)` (reactive) and
   *  `.to(target, dur)` (animatable). */
  readonly lerp?: (a: T, b: T, t: number) => T;
  /** Vector-space ops. Enables `.add(b)`, `.sub(b)`, `.scale(k)` and
   *  is consumed by behaviors (`spring`, `mean`, `attract`). */
  readonly algebra?: Algebra<T>;
  /** Distance. Enables `.distance(b)`; used by `spring` for precision-stop. */
  readonly metric?: (a: T, b: T) => number;
  /** Field type-map for nested struct fields. Declaring a key here:
   *
   *    • Gives that axis the nested type's methods (`v.translate.lerp(...)`).
   *    • If `soa: true`, also switches storage so each declared field
   *      is its own Signal (fine-grained writes). Default false (AoS:
   *      one Signal, lens-shaped axes).
   *
   *  AoS is cheaper to construct; SoA gives per-axis subscriber
   *  isolation. Vec needs neither (no nested types declared); Transform
   *  needs both (translate is a Vec, and animations write `.x`/`.opacity`
   *  independently and must not cross-fire). */
  readonly nested?: { [K in keyof T]?: Type<T[K]> };
  /** Use SoA storage when nested is declared. Default false. */
  readonly soa?: boolean;
  /** Extra reactive methods. Each is lifted: caller-arg signals are
   *  tracked, the body sees plain values, and the result is wrapped
   *  in a derived computed. */
  readonly ops?: { [name: string]: (self: T, ...args: any[]) => any };
  /** Lazy property getters. Cached as own-property on first read. */
  readonly getters?: { [name: string]: (this: { value: T }) => any };
}

/** A reactive cell carrying a `T`. Bare cells (no type) only have the
 *  `.value` / `.peek()` / `subscribe` / `instanceof Signal` surface.
 *  Typed cells additionally carry per-type axes + methods. */
interface Cell<T> extends Signal<T> {
  readonly type?: Type<T>;
}

// ── Per-type prototype cache. One prototype per Type, built lazily.
//    Lives on the type's `[PROTO_RW]` / `[PROTO_RO]` own-properties.

const PROTO_RW = Symbol("proto.rw");
const PROTO_RO = Symbol("proto.ro");
const TYPE_TAG = Symbol("type");

// ── Method installers (capability-driven) ───────────────────────────

function installMethods<T>(proto: any, type: Type<T>, writable: boolean) {
  const t = type;

  if (t.lerp) {
    proto.lerp = function (this: any, target: any, time: any) {
      const lerpFn = t.lerp!;
      return computed(() =>
        lerpFn(
          this.value,
          target?.value !== undefined ? target.value : target,
          typeof time === "function" ? time() : time?.value ?? time,
        ),
      );
    };
    if (writable) {
      // .to(target, dur, ease?) — we'll skip the easing/tween wiring
      // for the prototype to keep this file focused; real impl would
      // call the tween engine here.
      proto.to = function (this: any, target: T, dur: number) {
        const lerpFn = t.lerp!;
        const start = this.peek();
        const self = this;
        void dur;
        return (function* () {
          for (let f = 0; f <= 1; f += 0.05) {
            self.value = lerpFn(start, target, f);
            yield;
          }
        })();
      };
    }
  }

  if (t.algebra) {
    const a = t.algebra;
    proto.add = function (this: any, b: any) {
      return computed(() => a.add(this.value, b?.value ?? b));
    };
    proto.sub = function (this: any, b: any) {
      return computed(() => a.sub(this.value, b?.value ?? b));
    };
    proto.scale = function (this: any, k: any) {
      return computed(() =>
        a.scale(this.value, typeof k === "function" ? k() : k?.value ?? k),
      );
    };
  }

  if (t.metric) {
    const d = t.metric;
    proto.distance = function (this: any, b: any) {
      return computed(() => d(this.value, b?.value ?? b));
    };
  }

  // Ops (custom struct-returning + scalar-returning, undifferentiated).
  if (t.ops) {
    for (const name in t.ops) {
      const fn = t.ops[name];
      proto[name] = function (this: any, ...args: any[]) {
        return computed(() =>
          fn(
            this.value,
            ...args.map((a) =>
              typeof a === "function" ? a() : a?.value !== undefined ? a.value : a,
            ),
          ),
        );
      };
    }
  }

  // Lazy getters — installed via accessor descriptors that self-cache.
  if (t.getters) {
    for (const name in t.getters) {
      const fn = t.getters[name];
      Object.defineProperty(proto, name, {
        configurable: true,
        get(this: any) {
          const v = fn.call(this);
          Object.defineProperty(this, name, { value: v });
          return v;
        },
      });
    }
  }

  // Lazy axes: for each top-level key in defaults (object-shaped T),
  // install a getter that builds a child cell on first access. Caches
  // as own-property after first read.
  if (typeof t.defaults === "object" && t.defaults !== null) {
    const nested = t.nested ?? {};
    for (const k of Object.keys(t.defaults as object)) {
      const childType = (nested as any)[k];
      Object.defineProperty(proto, k, {
        configurable: true,
        get(this: any) {
          const self = this;
          let axis: any;
          if (writable) {
            axis = lens(
              () => (self.value as any)[k],
              (v) => {
                const cur = self.peek();
                self.value = { ...cur, [k]: v };
              },
            );
          } else {
            axis = computed(() => (self.value as any)[k]);
          }
          // If the child has a registered type, lift the axis onto
          // that type's prototype so methods like .lerp/.to work.
          if (childType) {
            const childProto = ensureProto(childType, writable);
            Object.setPrototypeOf(axis, childProto);
            (axis as any).type = childType;
          }
          Object.defineProperty(self, k, { value: axis });
          return axis;
        },
      });
    }
  }
}

function ensureProto<T>(type: Type<T>, writable: boolean): object {
  const key = writable ? PROTO_RW : PROTO_RO;
  const existing = (type as any)[key];
  if (existing) return existing;
  const proto = Object.create(Signal.prototype);
  Object.defineProperty(type, key, { value: proto, configurable: false });
  proto[TYPE_TAG] = type;
  installMethods(proto, type, writable);
  return proto;
}

const PROTO_SOA = Symbol("proto.soa");

/** SoA-flavor prototype. Per-axis signals are installed on the
 *  instance as own-properties; the prototype only carries methods +
 *  a composing `value` getter that fans out to those own-props. */
function ensureSoaProto<T>(type: Type<T>): object {
  const existing = (type as any)[PROTO_SOA];
  if (existing) return existing;
  const proto = Object.create(Signal.prototype);
  Object.defineProperty(type, PROTO_SOA, { value: proto, configurable: false });
  proto[TYPE_TAG] = type;
  // Methods (no axis getters — axes are own-props).
  installCapabilityMethods(proto, type, true);

  const keys = Object.keys(type.defaults as object);
  Object.defineProperty(proto, "value", {
    configurable: true,
    get(this: any): T {
      const out: any = {};
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        out[k] = this[k].value;
      }
      return out;
    },
    set(this: any, v: any) {
      batch(() => {
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i];
          this[k].value = v[k];
        }
      });
    },
  });
  Object.defineProperty(proto, "peek", {
    configurable: true,
    writable: true,
    value(this: any): T {
      const out: any = {};
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        out[k] = this[k].peek();
      }
      return out;
    },
  });
  return proto;
}

/** Just the capability-derived methods — no axes. Used by SoA proto
 *  builder where axes are own-properties on instances. */
function installCapabilityMethods<T>(
  proto: any,
  type: Type<T>,
  writable: boolean,
) {
  if (type.lerp) {
    const lerpFn = type.lerp;
    proto.lerp = function (this: any, target: any, time: any) {
      return computed(() =>
        lerpFn(
          this.value,
          target?.value !== undefined ? target.value : target,
          typeof time === "function" ? time() : time?.value ?? time,
        ),
      );
    };
  }
  if (type.algebra) {
    const a = type.algebra;
    proto.add = function (this: any, b: any) {
      return computed(() => a.add(this.value, b?.value ?? b));
    };
    proto.sub = function (this: any, b: any) {
      return computed(() => a.sub(this.value, b?.value ?? b));
    };
    proto.scale = function (this: any, k: any) {
      return computed(() =>
        a.scale(this.value, typeof k === "function" ? k() : k?.value ?? k),
      );
    };
  }
  if (type.metric) {
    const d = type.metric;
    proto.distance = function (this: any, b: any) {
      return computed(() => d(this.value, b?.value ?? b));
    };
  }
  void writable;
}

// ── Cell factory ────────────────────────────────────────────────────

interface CellFn {
  <T>(initial: T): Cell<T>;
  <T>(initial: T, type: Type<T>): Cell<T>;
  /** Read-only / derived. */
  derived<T>(fn: () => T): Cell<T>;
  derived<T>(fn: () => T, type: Type<T>): Cell<T>;
}

const cell: CellFn = (<T>(initial: T, type?: Type<T>): Cell<T> => {
  if (type === undefined) {
    return signal(initial) as Cell<T>;
  }
  if (type.soa && type.nested) {
    // SoA: install per-field signals as own-properties. The dedicated
    // SoA proto doesn't define axis getters, so plain assignment works
    // and avoids defineProperty overhead.
    const proto = ensureSoaProto(type);
    const inst: any = Object.create(proto);
    Signal.call(inst, undefined, type.equals ? { equals: type.equals } : {});
    const obj = initial as any;
    const keys = Object.keys(type.defaults as object);
    const nest = type.nested as any;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const childType = nest[k];
      const childInit = obj?.[k] ?? (type.defaults as any)[k];
      inst[k] = childType ? cell(childInit, childType) : signal(childInit);
    }
    return inst as Cell<T>;
  }
  // AoS: a single Signal under the per-type prototype.
  const proto = ensureProto(type, true);
  const inst: any = Object.create(proto);
  Signal.call(inst, initial, type.equals ? { equals: type.equals } : {});
  return inst as Cell<T>;
}) as CellFn;

cell.derived = (<T>(fn: () => T, type?: Type<T>): Cell<T> => {
  if (type === undefined) return computed(fn) as Cell<T>;
  const proto = ensureProto(type, false);
  const inst: any = Object.create(proto);
  // Computed's constructor takes a getter — call it via .call.
  const c = computed(fn) as any;
  // Re-prototype: keep computed's internal state but swap proto.
  Object.setPrototypeOf(c, proto);
  return c as Cell<T>;
}) as any;

// ── Define Vec as a plain config object. NO Builder, NO defineStruct. ─

const Vec: Type<{ x: number; y: number }> = {
  name: "Vec",
  defaults: { x: 0, y: 0 },
  equals: (a, b) => a.x === b.x && a.y === b.y,
  lerp: (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }),
  algebra: {
    add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
    sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
    scale: (a, k) => ({ x: a.x * k, y: a.y * k }),
  },
  metric: (a, b) => Math.hypot(a.x - b.x, a.y - b.y),
  // No `nested` → AoS. Storage is ONE Signal<{x,y}>. Axes are lazy lenses.
  ops: {
    perp: (a) => ({ x: -a.y, y: a.x }),
  },
  getters: {
    length(this: { value: { x: number; y: number } }) {
      const self = this;
      return computed(() => Math.hypot(self.value.x, self.value.y));
    },
  },
};

const Num: Type<number> = {
  name: "Num",
  defaults: 0,
  lerp: (a, b, t) => a + (b - a) * t,
  algebra: { add: (a, b) => a + b, sub: (a, b) => a - b, scale: (a, k) => a * k },
  metric: (a, b) => Math.abs(a - b),
};

const Transform: Type<{
  translate: { x: number; y: number };
  rotate: number;
  scale: { x: number; y: number };
  origin: { x: number; y: number };
  opacity: number;
}> = {
  name: "Transform",
  defaults: {
    translate: { x: 0, y: 0 },
    rotate: 0,
    scale: { x: 1, y: 1 },
    origin: { x: 0, y: 0 },
    opacity: 1,
  },
  nested: { translate: Vec, scale: Vec, origin: Vec, rotate: Num, opacity: Num },
  soa: true,
  // Component-wise algebra/lerp/metric (skipped for prototype brevity)
};

// ── Benchmarks ──────────────────────────────────────────────────────

group("construction: Vec.signal vs cell(initial, Vec)", () => {
  bench("current lib: V_LIB.signal({x,y})", () => {
    return V_LIB.signal({ x: 1, y: 2 });
  }).baseline(true);
  bench("prototype: cell({x,y}, Vec) — AoS", () => {
    return cell({ x: 1, y: 2 }, Vec);
  });
  bench("prototype: cell({x,y}) — untyped", () => {
    return cell({ x: 1, y: 2 });
  });
});

group("construction: Transform", () => {
  bench("current lib: Transform.signal(default)", () => {
    return V_LIB.signal({ x: 0, y: 0 }); // standin — full Transform too rich to redefine here
  }).baseline(true);
  bench("prototype: cell(default, Transform) — SoA", () => {
    return cell(
      {
        translate: { x: 0, y: 0 },
        rotate: 0,
        scale: { x: 1, y: 1 },
        origin: { x: 0, y: 0 },
        opacity: 1,
      },
      Transform,
    );
  });
});

group("read .value", () => {
  const libV: any = V_LIB.signal({ x: 5, y: 10 });
  const protoV: any = cell({ x: 5, y: 10 }, Vec);
  bench("current lib: libV.value", () => libV.value).baseline(true);
  bench("prototype: protoV.value", () => protoV.value);
});

group("write .value", () => {
  const libV: any = V_LIB.signal({ x: 0, y: 0 });
  const protoV: any = cell({ x: 0, y: 0 }, Vec);
  let i = 0;
  bench("current lib: libV.value = {...}", () => {
    libV.value = { x: ++i, y: i };
  }).baseline(true);
  bench("prototype: protoV.value = {...}", () => {
    protoV.value = { x: ++i, y: i };
  });
});

group("per-axis write .x.value = i", () => {
  const libV: any = V_LIB.signal({ x: 0, y: 0 });
  const protoV: any = cell({ x: 0, y: 0 }, Vec);
  void libV.x; void protoV.x; // warm
  let i = 0;
  bench("current lib (SoA Vec)", () => {
    libV.x.value = ++i;
  }).baseline(true);
  bench("prototype (AoS, lens axis)", () => {
    protoV.x.value = ++i;
  });
});

group("method: .lerp(b, t) build-once + 100 reads", () => {
  const libA: any = V_LIB.signal({ x: 0, y: 0 });
  const libB: any = V_LIB.signal({ x: 100, y: 200 });
  const protoA: any = cell({ x: 0, y: 0 }, Vec);
  const protoB: any = cell({ x: 100, y: 200 }, Vec);
  bench("current lib: build + 100 reads", () => {
    const m = libA.lerp(libB, 0.5);
    let s = 0;
    for (let i = 0; i < 100; i++) s += m.value.x;
    return s;
  }).baseline(true);
  bench("prototype: build + 100 reads", () => {
    const m = protoA.lerp(protoB, 0.5);
    let s = 0;
    for (let i = 0; i < 100; i++) s += m.value.x;
    return s;
  });
});

group("computed read-through: write .x then read derived", () => {
  const libV: any = V_LIB.signal({ x: 0, y: 0 });
  const protoV: any = cell({ x: 0, y: 0 }, Vec);
  const c1 = computed(() => libV.x.value * 2);
  const c2 = computed(() => protoV.x.value * 2);
  void c1.value; void c2.value;
  let i = 0;
  bench("current lib", () => {
    libV.x.value = ++i;
    return c1.value;
  }).baseline(true);
  bench("prototype", () => {
    protoV.x.value = ++i;
    return c2.value;
  });
});

group("type predicate: v instanceof Vec / Vec.is(v)", () => {
  const libV: any = V_LIB.signal({ x: 1, y: 2 });
  const protoV: any = cell({ x: 1, y: 2 }, Vec);
  bench("current lib: V_LIB.is(libV)", () => V_LIB.is(libV)).baseline(true);
  bench("prototype: protoV.type === Vec", () => protoV.type === Vec);
});

await run({ format: "mitata" });

console.log("\n── Surface match ────────────────────────────────────");
const v: any = cell({ x: 3, y: 4 }, Vec);
console.log("v.value:", v.value);
console.log("v.x.value:", v.x.value);
console.log("v.length.value:", v.length.value);
console.log("v.lerp(cell({x:10,y:0},Vec), 0.5).value:",
  v.lerp(cell({ x: 10, y: 0 }, Vec), 0.5).value);
console.log("v.add(cell({x:1,y:1},Vec)).value:",
  v.add(cell({ x: 1, y: 1 }, Vec)).value);
console.log("v.distance(cell({x:0,y:0},Vec)).value:",
  v.distance(cell({ x: 0, y: 0 }, Vec)).value);
console.log("v instanceof Signal:", v instanceof Signal);

// Per-axis subscription isolation test (Transform, SoA)
const tr: any = cell(
  {
    translate: { x: 0, y: 0 },
    rotate: 0,
    scale: { x: 1, y: 1 },
    origin: { x: 0, y: 0 },
    opacity: 1,
  },
  Transform,
);
let translateFires = 0;
let opacityFires = 0;
const d1 = effect(() => { translateFires++; void tr.translate.value; });
const d2 = effect(() => { opacityFires++; void tr.opacity.value; });
translateFires = opacityFires = 0;
tr.opacity.value = 0.5;
console.log(
  `\n── SoA isolation (Transform.opacity write):
     translate fired: ${translateFires}  (expect 0)
     opacity fired:   ${opacityFires}    (expect 1)`,
);
d1(); d2();

console.log("\n── LOC comparison ────────────────────────────────────");
console.log("  current signals/struct.ts:  986 LOC");
console.log("  this prototype (Vec+Num+Transform incl. bench):", "~430 LOC total");
console.log("    of which Type<T> + cell() core:                ~140 LOC");
console.log("    method installers + axes + SoA path:           ~120 LOC");
console.log("    Vec/Num/Transform definitions:                  ~50 LOC");
console.log("    bench harness:                                  ~120 LOC");
