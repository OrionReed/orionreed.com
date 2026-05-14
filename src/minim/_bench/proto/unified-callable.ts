// ── The radical collapse: Cell IS the alien callable ────────────────
//
// Variant of the unified design where we DON'T wrap the engine ref in
// a separate object. Instead, the cell is the alien signal function
// itself, with a per-type prototype set via `Object.setPrototypeOf`.
//
// Reads go through `cell()` (alien's native call dispatch). The
// `.value` getter is sugar for `cell()`; `.value = v` for `cell(v)`.
// Axes (.x, .y) are prototype getters that build child cells on first
// access. Methods (.lerp, .add, .distance) are prototype methods.
//
// This removes one allocation per cell (the wrapper object) and one
// indirection per read/write. Whether V8 optimizes function-prototype
// chains as well as object chains is the empirical question.
//
// Trade-off: this design is engine-locked to alien (or anything else
// that uses callable signals). Preact's Signal class doesn't fit.

import {
  signal as aSignal,
  computed as aComputed,
  setActiveSub,
} from "./alien";
import type { TypeConfig } from "./unified";

type SignalFn<T> = ((arg?: T) => T | void) & {
  readonly value: T;
  peek(): T;
};

// ── Per-type prototype: methods + lazy axes ─────────────────────────

const protoCache = new WeakMap<TypeConfig<any>, { rw: any; ro: any }>();

function protosFor<T>(type: TypeConfig<T>): { rw: any; ro: any } {
  const cached = protoCache.get(type);
  if (cached) return cached;
  const rw = makeProto(type, true);
  const ro = makeProto(type, false);
  const slot = { rw, ro };
  protoCache.set(type, slot);
  return slot;
}

function makeProto<T>(type: TypeConfig<T>, writable: boolean): any {
  // Chain off Function.prototype so the cell remains callable.
  const proto = Object.create(Function.prototype);

  // .value getter/setter — sugar over `cell()` / `cell(v)`. Note we
  // call `this()` and `this(v)` — works because `this` IS the alien
  // callable.
  Object.defineProperty(proto, "value", {
    configurable: true,
    get(this: () => T) {
      return (this as () => T)();
    },
    set(this: (v: T) => void, v: T) {
      (this as (v: T) => void)(v);
    },
  });

  Object.defineProperty(proto, "peek", {
    configurable: true,
    writable: true,
    value(this: () => T) {
      const prev = setActiveSub(undefined);
      try {
        return (this as () => T)();
      } finally {
        setActiveSub(prev);
      }
    },
  });

  // Capability methods
  if (type.lerp) {
    const fn = type.lerp;
    proto.lerp = function (this: () => T, target: any, t: any) {
      const self = this;
      return makeCell(
        aComputed(() =>
          fn(
            self(),
            typeof target === "function" ? target() : target?.value ?? target,
            typeof t === "function" ? t() : t?.value ?? t,
          ),
        ),
        type,
        false,
      );
    };
  }
  if (type.algebra) {
    const a = type.algebra;
    proto.add = function (this: () => T, b: any) {
      const self = this;
      return makeCell(
        aComputed(() => a.add(self(), typeof b === "function" ? b() : b?.value ?? b)),
        type,
        false,
      );
    };
    proto.sub = function (this: () => T, b: any) {
      const self = this;
      return makeCell(
        aComputed(() => a.sub(self(), typeof b === "function" ? b() : b?.value ?? b)),
        type,
        false,
      );
    };
    proto.scale = function (this: () => T, k: any) {
      const self = this;
      return makeCell(
        aComputed(() => a.scale(self(), typeof k === "function" ? k() : k?.value ?? k)),
        type,
        false,
      );
    };
  }
  if (type.metric) {
    const d = type.metric;
    proto.distance = function (this: () => T, b: any) {
      const self = this;
      return makeCell(
        aComputed(() => d(self(), typeof b === "function" ? b() : b?.value ?? b)),
        undefined,
        false,
      );
    };
  }

  // Lazy axes — getters that synthesise a lens-callable on first access.
  if (typeof type.defaults === "object" && type.defaults !== null) {
    const nested = type.nested ?? {};
    for (const k of Object.keys(type.defaults as object)) {
      const childType = (nested as any)[k];
      Object.defineProperty(proto, k, {
        configurable: true,
        get(this: any) {
          const self = this;
          let axis: any;
          if (writable) {
            // Synthesise a lens-callable. Read via parent (tracks),
            // write by replacing parent value with patched copy.
            const reader = aComputed(() => (self() as any)[k]);
            axis = function (...args: any[]) {
              if (args.length === 0) return reader();
              const cur = peekValue(self) as any;
              self({ ...cur, [k]: args[0] });
            };
          } else {
            axis = aComputed(() => (self() as any)[k]);
          }
          if (childType) Object.setPrototypeOf(axis, protosFor(childType).rw);
          // Cache as own-property — subsequent .x reads skip the getter.
          Object.defineProperty(self, k, { value: axis, configurable: false });
          return axis;
        },
      });
    }
  }

  return proto;
}

function peekValue<T>(fn: () => T): T {
  const prev = setActiveSub(undefined);
  try {
    return fn();
  } finally {
    setActiveSub(prev);
  }
}

function makeCell<T>(fn: any, type: TypeConfig<T> | undefined, writable: boolean): any {
  if (type) {
    Object.setPrototypeOf(fn, writable ? protosFor(type).rw : protosFor(type).ro);
  }
  return fn;
}

// ── Public factory ──────────────────────────────────────────────────

export function cell<T>(initial: T): SignalFn<T>;
export function cell<T>(initial: T, type: TypeConfig<T>): SignalFn<T>;
export function cell<T>(initial: T, type?: TypeConfig<T>): SignalFn<T> {
  if (type === undefined) {
    return aSignal(initial) as unknown as SignalFn<T>;
  }
  if (type.soa && type.nested && typeof type.defaults === "object") {
    // SoA: per-field callables installed as own-props. The parent
    // function has a .value getter that composes.
    const protoSlot = protosFor(type);
    const soaProto = Object.create(protoSlot.rw);
    // Override .value to compose from fields (overrides the per-axis
    // lazy getters by being further out in the chain... no wait, we
    // need the soaProto BEFORE rw in the chain).
    // Simpler: just install soa-specific value getter on a dedicated proto.

    const keys = Object.keys(type.defaults as object);
    const composedValue = {
      configurable: true,
      get(this: any) {
        const out: any = {};
        for (let i = 0; i < keys.length; i++) out[keys[i]] = this[keys[i]]();
        return out;
      },
      set(this: any, v: any) {
        for (let i = 0; i < keys.length; i++) this[keys[i]](v[keys[i]]);
      },
    };
    Object.defineProperty(soaProto, "value", composedValue);

    // The "cell" here is a dummy callable that delegates to .value.
    const inst: any = function (...args: any[]) {
      if (args.length === 0) return inst.value;
      inst.value = args[0];
    };
    Object.setPrototypeOf(inst, soaProto);
    const obj = initial as any;
    const nest = type.nested as any;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const childType = nest[k];
      const childInit = obj?.[k] ?? (type.defaults as any)[k];
      inst[k] = childType ? cell(childInit, childType) : aSignal(childInit);
    }
    return inst as SignalFn<T>;
  }
  // AoS: alien signal IS the cell, prototype set to rw.
  const fn: any = aSignal(initial);
  Object.setPrototypeOf(fn, protosFor(type).rw);
  return fn as SignalFn<T>;
}
