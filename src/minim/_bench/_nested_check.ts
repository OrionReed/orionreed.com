// Sanity check for `.nested()` SoA storage. Verifies:
//
//   1. Per-axis writes only re-run subscribers of that axis (not the
//      whole-transform consumers).
//   2. Whole-value reads compose correctly across AoS + nested parts.
//   3. Whole-value writes decompose correctly (and short-circuit when
//      nested parts equal under their `equals`).
//   4. `.derived()` and `.lens()` flavors expose nested-struct typed
//      projections on nested keys.
//   5. `instanceof` works across all flavors.

import { effect, signal } from "../core/signal";
import { struct } from "../signals/struct";
import { Vec, type V } from "../signals/vec";

type Tr = {
  translate: V;
  rotate: number;
  scale: V;
  origin: V;
  opacity: number;
};

const Transform = struct<Tr>("Transform", {
  translate: { x: 0, y: 0 },
  rotate: 0,
  scale: { x: 1, y: 1 },
  origin: { x: 0, y: 0 },
  opacity: 1,
})
  .nested({ translate: Vec, scale: Vec, origin: Vec })
  .ops({
    lerp: (a, b: Tr, t: number): Tr => ({
      translate: {
        x: a.translate.x + (b.translate.x - a.translate.x) * t,
        y: a.translate.y + (b.translate.y - a.translate.y) * t,
      },
      rotate: a.rotate + (b.rotate - a.rotate) * t,
      scale: {
        x: a.scale.x + (b.scale.x - a.scale.x) * t,
        y: a.scale.y + (b.scale.y - a.scale.y) * t,
      },
      origin: {
        x: a.origin.x + (b.origin.x - a.origin.x) * t,
        y: a.origin.y + (b.origin.y - a.origin.y) * t,
      },
      opacity: a.opacity + (b.opacity - a.opacity) * t,
    }),
  })
  .build();

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, extra?: unknown) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}`, extra ?? "");
  }
}

console.log("── nested() sanity ──────────────────────────────────────");

// 1. Construction
const tr = Transform.signal({
  translate: { x: 10, y: 20 },
  rotate: 0.5,
  scale: { x: 2, y: 3 },
  origin: { x: 5, y: 5 },
  opacity: 0.8,
});

check("Transform.is(tr)", Transform.is(tr));
check("tr instanceof Transform", tr instanceof Transform);
check("tr.translate is a Vec", Vec.is(tr.translate));
check("tr.scale is a Vec", Vec.is(tr.scale));
check("tr.origin is a Vec", Vec.is(tr.origin));

// 2. Whole-value read composes
const v = tr.value;
check("whole read composes translate.x", v.translate.x === 10);
check("whole read composes scale.y", v.scale.y === 3);
check("whole read composes rotate", v.rotate === 0.5);
check("whole read composes opacity", v.opacity === 0.8);

// 3. Per-axis read on nested field
check("tr.translate.x.value", tr.translate.x.value === 10);
check("tr.translate.y.value", tr.translate.y.value === 20);
check("tr.translate.length.value (lifted scalar)",
  Math.abs(tr.translate.length.value - Math.hypot(10, 20)) < 1e-9);

// 4. Per-axis read on AoS field (rotate, opacity)
check("tr.rotate.value (AoS axis)", tr.rotate.value === 0.5);
check("tr.opacity.value (AoS axis)", tr.opacity.value === 0.8);

// 5. Per-axis write on nested field — subscribers of OTHER nested
//    fields must NOT fire.
let translateRuns = 0;
let scaleRuns = 0;
let rotateRuns = 0;
const d1 = effect(() => { translateRuns++; void tr.translate.value; });
const d2 = effect(() => { scaleRuns++; void tr.scale.value; });
const d3 = effect(() => { rotateRuns++; void tr.rotate.value; });
// Reset counters after initial run.
translateRuns = 0; scaleRuns = 0; rotateRuns = 0;

tr.translate.x.value = 100;
check("per-axis nested write — translate effect fired", translateRuns === 1);
check("per-axis nested write — scale effect did NOT fire", scaleRuns === 0);
check("per-axis nested write — rotate effect did NOT fire", rotateRuns === 0);

// 6. Per-axis write on AoS field — only that AoS field's effect fires.
translateRuns = 0; scaleRuns = 0; rotateRuns = 0;
tr.rotate.value = 1.0;
check("per-axis AoS write — rotate effect fired", rotateRuns === 1);
check("per-axis AoS write — translate effect did NOT fire", translateRuns === 0);
check("per-axis AoS write — scale effect did NOT fire", scaleRuns === 0);

// 7. Whole-value write decomposes — nested signals get the new values.
translateRuns = 0; scaleRuns = 0; rotateRuns = 0;
tr.value = {
  translate: { x: 1, y: 2 },
  rotate: 1.5,
  scale: { x: 4, y: 5 },
  origin: { x: 0, y: 0 },
  opacity: 1,
};
check("whole write — translate fired", translateRuns === 1);
check("whole write — scale fired", scaleRuns === 1);
check("whole write — rotate fired", rotateRuns === 1);
check("whole write — translate.x.value updated", tr.translate.x.value === 1);
check("whole write — scale.y.value updated", tr.scale.y.value === 5);
check("whole write — rotate.value updated", tr.rotate.value === 1.5);

// 8. Whole-value write SHORT-CIRCUITS unchanged nested via Vec.equals.
translateRuns = 0; scaleRuns = 0; rotateRuns = 0;
tr.value = {
  translate: { x: 1, y: 2 },          // same
  rotate: 1.5,                         // same
  scale: { x: 999, y: 999 },          // change
  origin: { x: 0, y: 0 },             // same
  opacity: 1,                          // same
};
check("partial write — only scale fired", scaleRuns === 1 && translateRuns === 0 && rotateRuns === 0);

d1(); d2(); d3();

// 9. Nested-field writes propagate to whole-value reads.
let lastWhole: Tr | null = null;
const d4 = effect(() => { lastWhole = tr.value; });
tr.translate.x.value = 7;
check("nested write propagates to whole-value reader",
  lastWhole !== null && (lastWhole as Tr).translate.x === 7);
d4();

// 10. Derived flavor — same surface, AoS storage.
const trd = Transform.derived(() => tr.value);
check("Transform.is(trd)", Transform.is(trd));
check("trd.translate is a Vec (derived)", Vec.is(trd.translate));
check("trd.translate.x.value reads through", trd.translate.x.value === 7);

// 11. Lens flavor — writable, AoS storage with nested-typed projections.
const src = signal<Tr>({
  translate: { x: 0, y: 0 },
  rotate: 0,
  scale: { x: 1, y: 1 },
  origin: { x: 0, y: 0 },
  opacity: 1,
});
const trl = Transform.lens(
  () => src.value,
  (v) => { src.value = v; },
);
check("Transform.is(trl)", Transform.is(trl));
check("trl.translate is a Vec (lens)", Vec.is(trl.translate));
trl.translate.x.value = 42;
check("lens-flavor nested write round-trips through src.value",
  src.value.translate.x === 42);

// 12. Tween available because lerp was provided.
check("trl.to is installed (lerp present)", typeof (trl as any).to === "function");

console.log(`\n${pass} passed / ${fail} failed`);
if (fail > 0) process.exit(1);
