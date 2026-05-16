// types.test.ts — type-inference audit.
//
// Compile-only test: every line below should type-check WITHOUT casts
// at the user surface. If TypeScript catches an error, the test fails.

import {
  signal, computed, effect, batch, untracked, follow, value,
  classOf, requireTraits, isSignal,
  Signal, Computed, Lens,
  type Val, type Linear, type Lerp, type Metric, type Equals, type CommonTraits,
  type SignalOptions,
} from "../engine";
import { Vec, vec, Num, num, Color, rgb, Box, box, Transform, transform } from "../values";
import { meanOf } from "../derive";


// ── 1. Val<T> brand: only these match the reactive form ──────────

const _v1: Val<number> = 5;                          // plain
const _v2: Val<number> = () => 10;                   // thunk
const _v3: Val<number> = signal(15);                 // Signal
const _v4: Val<number> = computed(() => 20);         // Computed
// const _v5: Val<number> = { value: 5, name: "alice" };  // ERROR ✓
//   — plain objects with .value field do NOT structurally match

// ── 2. Vec methods return Vec, chainable ─────────────────────────

const v1: Vec = vec(1, 2);
const _v6: Vec = v1.add({ x: 10, y: 20 });           // chains
const _v7: Vec = v1.add({ x: 1, y: 1 }).scale(2);    // chains deeply
const _v8: Vec = v1.lerp(v1, 0.5);

// Field access — typed Num lens (extends Signal<number> + has Num methods)
const x1: Num = v1.x;
const _y1: Num = v1.y;
const _x2: Num = x1.add(5);
const _mag: Num = v1.magnitude;

// ── 3. Method args accept Val<T> ─────────────────────────────────

const offset = vec(5, 5);
const _r1: Vec = v1.add(offset);                     // Vec/Signal
const _r2: Vec = v1.add(() => ({ x: 1, y: 1 }));     // thunk
const _r3: Vec = v1.add({ x: 1, y: 1 });             // plain

const numK = num(2);
const _s1: Vec = v1.scale(numK);                     // Num
const _s2: Vec = v1.scale(() => 3);                  // thunk
const _s3: Vec = v1.scale(2);                        // plain

// ── 4. classOf + traits typed access ─────────────────────────────

const klass = classOf(v1);                            // typeof Vec
const _lin: Linear<{ x: number; y: number }> | undefined = klass.traits?.linear;
const _lerp: Lerp<{ x: number; y: number }> | undefined = klass.traits?.lerp;

// ── 5. requireTraits — ergonomic trait pluck ──────────────────────────

const { linear, lerp, metric } = requireTraits(v1, "linear", "lerp", "metric");
const _sum = linear.add({ x: 1, y: 1 }, { x: 2, y: 2 });
const _mid = lerp({ x: 0, y: 0 }, { x: 10, y: 10 }, 0.5);
const _dist = metric({ x: 0, y: 0 }, { x: 3, y: 4 });

// ── 6. Generic ops via requireTraits ──────────────────────────────────

function mean<T>(...cells: Signal<T>[]): Computed<T> {
  const { linear } = requireTraits(cells[0], "linear");
  const invN = 1 / cells.length;
  return computed(() => {
    let acc = cells[0].value;
    for (let i = 1; i < cells.length; i++) acc = linear.add(acc, cells[i].value);
    return linear.scale(acc, invN);
  });
}
const _avg: Computed<{ x: number; y: number }> = mean(vec(0, 0), vec(10, 10));

// ── 7. Composite types: Transform with typed nested fields ───────

const tr: Transform = transform({ opacity: 0.5 });
const _trans: Vec = tr.translate;
const _sc: Vec = tr.scale;
const _rot: Num = tr.rotate;
const _op: Num = tr.opacity;
const _trMove: Vec = tr.translate.add({ x: 10, y: 0 });

// ── 8. follow accepts Val<T> ─────────────────────────────────────

const target = signal(0);
const _stop1: () => void = follow(target, 5);
const _stop2: () => void = follow(target, () => Date.now());
const _stop3: () => void = follow(target, numK);

// ── 9. value() handles every Val form ───────────────────────────

const _u1: number = value(5);
const _u2: number = value(() => 10);
const _u3: number = value(signal(15));
const _u4: { x: number; y: number } = value(vec(1, 2));

// ── 10. isSignal narrows the type guard ───────────────────────────

function _test(v: unknown) {
  if (isSignal(v)) {
    void v.value;  // narrows to a "has .value" shape
  }
  if (v instanceof Vec) {
    void v.add({ x: 1, y: 1 });  // narrows to Vec
  }
}

// ── 11. SignalOptions: watched/unwatched hooks ──────────────────

const _opts: SignalOptions = {
  watched: () => console.log("first subscriber"),
  unwatched: () => console.log("last subscriber gone"),
};
const _sig = new Signal(0, _opts);

// ── 12. bind() — explicit re-bind ───────────────────────────────

const target2 = signal(0);
const _stop4: () => void = target2.bind(numK);  // Signal.bind() returns dispose
target2.unbind();

console.log("Type audit compiled clean.");
