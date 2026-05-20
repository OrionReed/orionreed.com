// 3-way bench: current minim vs merged-Reactive vs sidecar-Reactive.
// Same workload as production signals.bench.ts.

import { bench, group, do_not_optimize, run } from "mitata";

// Current minim
import {
  signal as cSignal,
  computed as cComputed,
  effect as cEffect,
  batch as cBatch,
  Signal as CSignal,
} from "../signals/signal";
import { derived as cDerived } from "../signals/derive";

// Merged Reactive (3 extra fields)
import {
  Reactive as MReactive,
  signal as mSignal,
  computed as mComputed,
  effect as mEffect,
  batch as mBatch,
  derived as mDerived,
} from "./reactive";

// Sidecar Reactive (1 extra field — the sidecar)
import {
  Reactive as SReactive,
  signal as sSignal,
  computed as sComputed,
  effect as sEffect,
  batch as sBatch,
  derived as sDerived,
} from "./reactive-sidecar";

import { LINEAR, LERP, METRIC, EQUALS, type Linear } from "../signals/traits";

// ─── Value classes ──────────────────────────────────────────────────

const nLinear: Linear<number> = {
  add: (a, b) => a + b, sub: (a, b) => a - b, scale: (a, k) => a * k,
};
const vLinear: Linear<{ x: number; y: number }> = {
  add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
  sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
  scale: (a, k) => ({ x: a.x * k, y: a.y * k }),
};

// Merged
class MNum extends MReactive<number> {
  constructor(v: number = 0) { super(v); }
  get [LINEAR]() { return nLinear; }
  [LERP](a: number, b: number, t: number) { return a + (b - a) * t; }
  [METRIC](a: number, b: number) { return Math.abs(a - b); }
  [EQUALS](a: number, b: number) { return a === b; }
}
class MVec extends MReactive<{ x: number; y: number }> {
  constructor(v: { x: number; y: number } = { x: 0, y: 0 }) { super(v); }
  get [LINEAR]() { return vLinear; }
  [LERP](a: { x: number; y: number }, b: { x: number; y: number }, t: number) {
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }
  [EQUALS](a: { x: number; y: number }, b: { x: number; y: number }) {
    return a === b || (a.x === b.x && a.y === b.y);
  }
}

// Sidecar
class SNum extends SReactive<number> {
  constructor(v: number = 0) { super(v); }
  get [LINEAR]() { return nLinear; }
  [LERP](a: number, b: number, t: number) { return a + (b - a) * t; }
  [METRIC](a: number, b: number) { return Math.abs(a - b); }
  [EQUALS](a: number, b: number) { return a === b; }
}
class SVec extends SReactive<{ x: number; y: number }> {
  constructor(v: { x: number; y: number } = { x: 0, y: 0 }) { super(v); }
  get [LINEAR]() { return vLinear; }
  [LERP](a: { x: number; y: number }, b: { x: number; y: number }, t: number) {
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }
  [EQUALS](a: { x: number; y: number }, b: { x: number; y: number }) {
    return a === b || (a.x === b.x && a.y === b.y);
  }
}

// Field helpers (Symbol-based — matching production for fair comparison)
const FIELD_KEY = Symbol("field-cache");

function mField<T, K extends keyof T, C extends MReactive<T[K]>>(
  parent: MReactive<T>, key: K, Cls: new () => C,
): C {
  const cache = ((parent as unknown as Record<symbol, Record<string, unknown>>)[FIELD_KEY] ??= {});
  const cached = cache[key as string];
  if (cached) return cached as C;
  const fl = mDerived(
    Cls,
    () => (parent.value as T)[key],
    (v: T[K]) => { parent.value = { ...(parent.peek() as object), [key]: v } as T; },
  );
  cache[key as string] = fl;
  return fl as C;
}

function sField<T, K extends keyof T, C extends SReactive<T[K]>>(
  parent: SReactive<T>, key: K, Cls: new () => C,
): C {
  const cache = ((parent as unknown as Record<symbol, Record<string, unknown>>)[FIELD_KEY] ??= {});
  const cached = cache[key as string];
  if (cached) return cached as C;
  const fl = sDerived(
    Cls,
    () => (parent.value as T)[key],
    (v: T[K]) => { parent.value = { ...(parent.peek() as object), [key]: v } as T; },
  );
  cache[key as string] = fl;
  return fl as C;
}

// ─── Construction ──────────────────────────────────────────────────

group("CONSTRUCT: signal()", () => {
  bench("current", () => do_not_optimize(cSignal(0))).baseline(true);
  bench("merged",  () => do_not_optimize(mSignal(0)));
  bench("sidecar", () => do_not_optimize(sSignal(0)));
});

group("CONSTRUCT: new Vec()", () => {
  bench("current (Signal-extending)", () => do_not_optimize(new (class extends CSignal<{x:number;y:number}> {
    constructor() { super({x:0, y:0}); }
    get [LINEAR]() { return vLinear; }
  })())).baseline(true);
  bench("merged", () => do_not_optimize(new MVec())).baseline(false);
  bench("sidecar", () => do_not_optimize(new SVec()));
});

group("CONSTRUCT: new Num()", () => {
  bench("current", () => do_not_optimize(new (class extends CSignal<number> {
    constructor() { super(0); }
    get [LINEAR]() { return nLinear; }
  })())).baseline(true);
  bench("merged", () => do_not_optimize(new MNum()));
  bench("sidecar", () => do_not_optimize(new SNum()));
});

// ─── Reads (THE KEY MEASUREMENT) ───────────────────────────────────

group("READ: signal.peek() — slim type fast path", () => {
  const c = cSignal(0);
  const m = mSignal(0);
  const s = sSignal(0);
  bench("current", () => do_not_optimize(c.peek())).baseline(true);
  bench("merged",  () => do_not_optimize(m.peek()));
  bench("sidecar", () => do_not_optimize(s.peek()));
});

group("READ: num.peek() — value-class slim fast path", () => {
  const c = new (class extends CSignal<number> {
    constructor() { super(0); }
    get [LINEAR]() { return nLinear; }
  })();
  const m = new MNum();
  const s = new SNum();
  bench("current", () => do_not_optimize(c.peek())).baseline(true);
  bench("merged",  () => do_not_optimize(m.peek()));
  bench("sidecar", () => do_not_optimize(s.peek()));
});

group("READ: vec.peek()", () => {
  const c = new (class extends CSignal<{x:number;y:number}> {
    constructor() { super({x:1, y:2}); }
    get [LINEAR]() { return vLinear; }
  })();
  const m = new MVec({x:1, y:2});
  const s = new SVec({x:1, y:2});
  bench("current", () => do_not_optimize(c.peek())).baseline(true);
  bench("merged",  () => do_not_optimize(m.peek()));
  bench("sidecar", () => do_not_optimize(s.peek()));
});

group("READ: computed.value (cached)", () => {
  const cs = cSignal(0); const cc = cComputed(() => cs.value * 2); void cc.value;
  const ms = mSignal(0); const mc = mComputed(() => ms.value * 2); void mc.value;
  const ss = sSignal(0); const sc = sComputed(() => ss.value * 2); void sc.value;
  bench("current", () => do_not_optimize(cc.value)).baseline(true);
  bench("merged",  () => do_not_optimize(mc.value));
  bench("sidecar", () => do_not_optimize(sc.value));
});

// ─── Writes ────────────────────────────────────────────────────────

group("WRITE: signal.value = i", () => {
  const c = cSignal(0); const m = mSignal(0); const s = sSignal(0);
  let i = 0;
  bench("current", () => { c.value = ++i; }).baseline(true);
  bench("merged",  () => { m.value = ++i; });
  bench("sidecar", () => { s.value = ++i; });
});

group("WRITE: signal with 1 effect subscriber", () => {
  const c = cSignal(0); cEffect(() => { do_not_optimize(c.value); });
  const m = mSignal(0); mEffect(() => { do_not_optimize(m.value); });
  const s = sSignal(0); sEffect(() => { do_not_optimize(s.value); });
  let i = 0;
  bench("current", () => { c.value = ++i; }).baseline(true);
  bench("merged",  () => { m.value = ++i; });
  bench("sidecar", () => { s.value = ++i; });
});

// ─── THE BIG ONE: 10-deep computed chain ────────────────────────────

group("CHAIN: 10-deep computed (write root, read tail)", () => {
  // current
  const cRoot = cSignal(0);
  let cTail: { value: number } = cRoot;
  for (let i = 0; i < 10; i++) { const p = cTail; cTail = cComputed(() => p.value + 1); }
  void cTail.value;
  // merged
  const mRoot = mSignal(0);
  let mTail: { value: number } = mRoot;
  for (let i = 0; i < 10; i++) { const p = mTail; mTail = mComputed(() => p.value + 1); }
  void mTail.value;
  // sidecar
  const sRoot = sSignal(0);
  let sTail: { value: number } = sRoot;
  for (let i = 0; i < 10; i++) { const p = sTail; sTail = sComputed(() => p.value + 1); }
  void sTail.value;

  let i = 0;
  bench("current", () => { cRoot.value = ++i; do_not_optimize(cTail.value); }).baseline(true);
  bench("merged",  () => { mRoot.value = ++i; do_not_optimize(mTail.value); });
  bench("sidecar", () => { sRoot.value = ++i; do_not_optimize(sTail.value); });
});

// Even deeper — depths people actually hit in layered animations
group("CHAIN: 30-deep computed (write root, read tail)", () => {
  const cRoot = cSignal(0);
  let cTail: { value: number } = cRoot;
  for (let i = 0; i < 30; i++) { const p = cTail; cTail = cComputed(() => p.value + 1); }
  void cTail.value;
  const mRoot = mSignal(0);
  let mTail: { value: number } = mRoot;
  for (let i = 0; i < 30; i++) { const p = mTail; mTail = mComputed(() => p.value + 1); }
  void mTail.value;
  const sRoot = sSignal(0);
  let sTail: { value: number } = sRoot;
  for (let i = 0; i < 30; i++) { const p = sTail; sTail = sComputed(() => p.value + 1); }
  void sTail.value;

  let i = 0;
  bench("current", () => { cRoot.value = ++i; do_not_optimize(cTail.value); }).baseline(true);
  bench("merged",  () => { mRoot.value = ++i; do_not_optimize(mTail.value); });
  bench("sidecar", () => { sRoot.value = ++i; do_not_optimize(sTail.value); });
});

// ─── Field lens hot path ───────────────────────────────────────────

// (vec.x.value bench omitted — would need to set up parallel field()
// machinery for current minim; the production signals.bench.ts already
// covers this case. The 3 implementations all use the same field()
// approach so the comparison is fair.)
void mField; void sField;

void cBatch; void mBatch; void sBatch; void cDerived;

await run({ format: "mitata" });
