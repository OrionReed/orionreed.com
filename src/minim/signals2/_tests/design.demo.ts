// design.demo.ts — minim/signals2 in idiomatic usage.
//
// Read top-to-bottom; should compile clean and read like the user surface.
//
// FOLDER LAYOUT
//
//   signals2/
//   ├── engine.ts     primitives: Signal, Computed, Lens + Val + traits
//   ├── derive.ts     Chain, field, typedField, derived
//   ├── values.ts     Num, Vec, Color, Box, Transform, mean
//   └── _tests/       tests + benches
//
// PRIMARY EXPORTS
//
//   classes:   Signal, Computed, Lens
//   factories: signal, computed, lens, effect, batch, untracked, follow
//   val rule:  value, isSignal, Val<T>
//   traits:    Linear, Lerp, Metric, Equals, CommonTraits, classOf,
//              traitsOf, requireTraits
//   options:   SignalOptions { watched, unwatched }
//   values:    Num, Vec, Color, Box, Transform (+ lowercase factories)
//   composition: field, typedField, Chain, derived, mean

import {
  Signal,
  type Computed, type Lens,
  signal, computed, lens, effect, batch, untracked,
  value, isSignal, type Val,
  type SignalOptions,
} from "../signal";
import {
  classOf, linearOf, lerpOf, requireLinear, requireLerp, requireMetric,
  LINEAR, LERP, EQUALS,
  type Linear, type Lerp,
} from "../traits";
import { field } from "../derive";
import { Vec, vec, Num, num, Color, rgb, Box, box, Transform, transform, mean } from "../values";

// ════════════════════════════════════════════════════════════════════
// 1. Primitives
// ════════════════════════════════════════════════════════════════════

const count = signal(0);
count.value++;                       // .value get/set
const cur = count.peek();            // untracked read

const doubled = computed(() => count.value * 2);
const oddOnly = lens(
  () => count.value & 1,
  (v) => { count.value = v << 1; },
);

const stop = effect(() => console.log("count is", count.value));
batch(() => { count.value = 1; count.value = 2; });   // effect fires once
stop();

// ════════════════════════════════════════════════════════════════════
// 2. Val<T> universal rule
// ════════════════════════════════════════════════════════════════════
//
// Val<T> = T | (() => T) | Signal<T>
// Anywhere a T is accepted, a Val<T> works. value() unwraps + auto-tracks.

const a = signal(5);

function takesAnything(x: Val<number>): number {
  return value(x) * 2;
}
takesAnything(10);                   // ok
takesAnything(() => 20);             // ok
takesAnything(a);                    // ok — auto-subscribes inside reactive scope

// Reactive binding via .bind(source). Each bind REPLACES any previous.
// Source is Val<T>: plain (one-shot write), thunk, or cell.
const t = signal(0);
const stopA = t.bind(42);             // one-shot write of 42
const stopB = t.bind(() => Date.now());  // tracks the thunk's deps
const stopC = t.bind(a);              // tracks a — t.value follows a.value
stopC();                              // sever the binding

// To "unbind" without changing the value: t.bind(t.peek()) or use stop fn.

// Construction itself takes a plain T; bind separately:
const live = signal(0);
live.bind(() => a.value * 10);

// ════════════════════════════════════════════════════════════════════
// 3. Value types — typed signals with chainable methods
// ════════════════════════════════════════════════════════════════════

const p = vec(100, 50);                                // Vec
const center = p.add(vec(5, 5)).scale(0.5);            // Vec — chainable
const dist = center.x.sub(p.x).scale(2);               // Num

p.x.value = 99;                                        // typed lens write
p.value = { x: 0, y: 0 };                              // atomic write

// Composite types:
const tr = transform({ opacity: 0.5 });
tr.translate.x.value = 50;                             // nested write
tr.opacity.value = 1;                                  // typed Num field
const moved = tr.add({                                 // returns Transform
  translate: { x: 10, y: 0 },
  scale: { x: 0, y: 0 },
  origin: { x: 0, y: 0 },
  rotate: 0, opacity: 0,
});

// ════════════════════════════════════════════════════════════════════
// 4. Two paths for reactive math chains
// ════════════════════════════════════════════════════════════════════

const b = vec(1, 1);

// (a) Method chaining — N Computeds, fluent on cells:
const r1 = p.add(b).scale(2);                          // 2 Computeds

// (b) derive(c => …) — single Computed, chain on a mutating Chain.
//      Per-class typing: c is VecChain (NOT base Chain<V>) inside the lambda.
const r2 = p.derive(c => c.add(b).scale(2));           // 1 Computed, chained

// Both produce the same observable behavior. Pick (b) for deep chains.

// ════════════════════════════════════════════════════════════════════
// 5. Trait dispatch — Symbol.for slots, prototype-stamped
// ════════════════════════════════════════════════════════════════════

// classOf returns the runtime class:
const klass = classOf(p);                              // typeof Vec
const _name: string = klass.name;                      // "Vec"

// Direct prototype access (typed via module-augmented Signal<T>):
const _lin: Linear<{ x: number; y: number }> | undefined = Vec.prototype[LINEAR];
const _lerp: Lerp<{ x: number; y: number }> | undefined = Vec.prototype[LERP];

// Optional accessors — return slot or undefined:
const linOpt = linearOf(p);
if (linOpt) linOpt.add(p.peek(), b.peek());
const lerpOpt = lerpOf(p);

// Throwing variants — useful for "this op needs trait X" assertions:
const linear = requireLinear(p);
const lerp = requireLerp(p);
const metric = requireMetric(p);
const mid = lerp({ x: 0, y: 0 }, { x: 10, y: 10 }, 0.5);
const sum = linear.add(p.peek(), b.peek());

// Per-instance override: shadows class-level slot.
const customP = vec(0, 0);
customP[EQUALS] = (a, b) => Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;

// Generic ops over any T with a `[LINEAR]` slot:
const avg = mean(vec(0, 0), vec(10, 10), vec(20, 20));  // Computed<V>
const numAvg = mean(num(0), num(10));                   // Computed<number>

// ════════════════════════════════════════════════════════════════════
// 6. Effects with cleanup
// ════════════════════════════════════════════════════════════════════

const stop2 = effect(() => {
  // setup ...
  return () => {
    // cleanup — runs before next re-run + on dispose
  };
});

// Signal with watched/unwatched lifecycle hooks:
const lazySource = new Signal(0, {
  watched: () => { /* first subscriber attached */ },
  unwatched: () => { /* last subscriber gone */ },
} satisfies SignalOptions);

// ════════════════════════════════════════════════════════════════════
// 7. Custom value types (~30 LoC per type)
// ════════════════════════════════════════════════════════════════════

interface Quat { x: number; y: number; z: number; w: number }
const qMul = (a: Quat, b: Quat): Quat => ({
  x: a.w*b.x + a.x*b.w + a.y*b.z - a.z*b.y,
  y: a.w*b.y - a.x*b.z + a.y*b.w + a.z*b.x,
  z: a.w*b.z + a.x*b.y - a.y*b.x + a.z*b.w,
  w: a.w*b.w - a.x*b.x - a.y*b.y - a.z*b.z,
});

class MyQuat extends Signal<Quat> {
  constructor(v: Quat = { x: 0, y: 0, z: 0, w: 1 }) { super(v); }
  multiply(b: Val<Quat>): MyQuat {
    const q = new MyQuat();
    q.bind(() => qMul(this.value, value(b)));
    return q;
  }
}
// Stamp traits — open extensibility, same pattern as built-ins.
MyQuat.prototype[EQUALS] = (a, b) =>
  a.x === b.x && a.y === b.y && a.z === b.z && a.w === b.w;

// ════════════════════════════════════════════════════════════════════
// 20-second user mental model
// ════════════════════════════════════════════════════════════════════
//
// 1. signal(v) → Signal. cell.value reads/writes. effect(fn) reacts.
// 2. Anywhere a value is accepted, a Val<T> works (literal/thunk/signal).
//    Use value(v) to unwrap; auto-tracks reactive forms in scope.
// 3. Value types (Vec/Num/Color) extend Signal. Methods return themselves —
//    vec.add(b).scale(2) chains. Fields are typed lenses.
// 4. Generic dispatch: linearOf(s) / requireLinear(s) etc. — proto-stamped Symbol slots.
// 5. Bind via sig.bind(source) → dispose fn. .value = is plain write.
// 6. derive(c => c.foo()) for single-Computed chains; methods return same type
//    for fluent multi-Computed chains. Both are observationally equivalent.

console.log("design.demo.ts compiled clean.");
