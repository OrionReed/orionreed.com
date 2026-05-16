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
  Signal, Computed, Lens,
  signal, computed, lens, effect, batch, untracked, follow,
  value, isSignal, type Val,
  classOf, traitsOf, requireTraits,
  type Linear, type Lerp, type CommonTraits, type SignalOptions,
} from "../engine";
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

// Construction with Val<T>:
const live = new Signal(() => a.value * 10);          // bound to thunk, auto-updates

// Re-bind via .bind() (NOT via .value =, that's plain write only):
const t = signal(0);
const dispose = t.bind(a);            // tracks a
t.value = 999;                        // plain write (overwritten on next a change)
t.unbind();                           // sever

// follow() is a free-function alternative to .bind:
follow(t, 42);                        // static
follow(t, () => Date.now());          // thunk
follow(t, a);                         // cell

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
// 5. Trait dispatch
// ════════════════════════════════════════════════════════════════════

// classOf returns the runtime class with its static traits typed:
const klass = classOf(p);                              // typeof Vec
const _lin: Linear<{ x: number; y: number }> | undefined = klass.traits?.linear;

// traitsOf returns the traits object with optional members:
const traits = traitsOf(p);
if (traits.linear) traits.linear.add(p.peek(), b.peek());

// requireTraits plucks specified traits + throws if missing:
const { linear, lerp, metric } = requireTraits(p, "linear", "lerp", "metric");
const mid = lerp({ x: 0, y: 0 }, { x: 10, y: 10 }, 0.5);
const sum = linear.add(p.peek(), b.peek());

// Generic ops over any T with a `linear` trait:
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
  static traits: CommonTraits<Quat> = {
    equals: (a, b) => a.x === b.x && a.y === b.y && a.z === b.z && a.w === b.w,
  };
  static multiply = qMul;

  constructor(v: Val<Quat> = { x: 0, y: 0, z: 0, w: 1 }) { super(v); }
  multiply(b: Val<Quat>): MyQuat {
    return new (this.constructor as typeof MyQuat)(() => qMul(this.value, value(b)));
  }
}

// ════════════════════════════════════════════════════════════════════
// 20-second user mental model
// ════════════════════════════════════════════════════════════════════
//
// 1. signal(v) → Signal. cell.value reads/writes. effect(fn) reacts.
// 2. Anywhere a value is accepted, a Val<T> works (literal/thunk/signal).
//    Use value(v) to unwrap; auto-tracks reactive forms in scope.
// 3. Value types (Vec/Num/Color) extend Signal. Methods return themselves —
//    vec.add(b).scale(2) chains. Fields are typed lenses.
// 4. Generic dispatch: classOf(s).traits or traitsOf(s) or requireTraits(s, ...).
// 5. Re-bind via .bind(source). .value = is plain write.
// 6. derive(c => c.foo()) for single-Computed chains; methods return same type
//    for fluent multi-Computed chains. Both are observationally equivalent.

console.log("design.demo.ts compiled clean.");
