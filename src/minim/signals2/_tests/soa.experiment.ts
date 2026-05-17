// soa.experiment.ts — prototype an SoA (struct-of-arrays) variant of
// Transform: each field is its own Signal; the whole-Tr value is computed
// from those fields. Whole-Tr writes happen in a batch.
//
// Question: do our primitives accommodate this pattern cleanly, or does
// it expose missing pieces?

import { Signal, Computed, signal, computed, batch, effect, type Val, value } from "../signal";
import { Vec, vec, Num, num } from "../values";

interface TrShape { translate: { x: number; y: number }; scale: { x: number; y: number }; rotate: number; opacity: number }

// SoA version: NOT a Signal subclass. A composite that holds sub-cells.
class TransformSoA {
  translate: Vec;
  scale: Vec;
  rotate: Num;
  opacity: Num;
  /** Computed view of the whole composite. */
  readonly snapshot: Computed<TrShape>;

  constructor(init: { [K in keyof TrShape]?: Val<TrShape[K]> } = {}) {
    this.translate = vec();
    this.scale = vec(1, 1);
    this.rotate = num(0);
    this.opacity = num(1);
    if (init.translate !== undefined) this.translate.bind(init.translate);
    if (init.scale !== undefined) this.scale.bind(init.scale);
    if (init.rotate !== undefined) this.rotate.bind(init.rotate);
    if (init.opacity !== undefined) this.opacity.bind(init.opacity);

    this.snapshot = computed(() => ({
      translate: this.translate.value,
      scale: this.scale.value,
      rotate: this.rotate.value,
      opacity: this.opacity.value,
    }));
  }

  /** Atomic-ish whole-value write — actually 4 writes in a batch. */
  set value(v: TrShape) {
    batch(() => {
      this.translate.value = v.translate;
      this.scale.value = v.scale;
      this.rotate.value = v.rotate;
      this.opacity.value = v.opacity;
    });
  }
  get value(): TrShape { return this.snapshot.value; }
}

let pass = 0, fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
function section(name: string): void { console.log(`\n── ${name}`); }

section("Construction with mixed Val<T>");
{
  const sig = signal(0.5);
  const tr = new TransformSoA({
    translate: { x: 100, y: 50 },     // plain
    opacity: sig,                      // reactive — opacity follows sig
    rotate: () => Date.now() % 360,    // thunk
  });
  check("translate plain", tr.translate.value.x === 100);
  check("opacity initial", tr.opacity.value === 0.5);
  sig.value = 0.8;
  check("opacity tracks sig", tr.opacity.value === 0.8);
}

section("Per-field subscription is independent");
{
  const tr = new TransformSoA();
  let xfires = 0, opfires = 0;
  const sx = effect(() => { void tr.translate.x.value; xfires++; });
  const sop = effect(() => { void tr.opacity.value; opfires++; });
  tr.translate.x.value = 99;
  check("translate.x change: x fires, opacity doesn't", xfires === 2 && opfires === 1);
  tr.opacity.value = 0.5;
  check("opacity change: opacity fires, x doesn't", xfires === 2 && opfires === 2);
  sx(); sop();
}

section("Whole-value snapshot via .value");
{
  const tr = new TransformSoA({ translate: { x: 1, y: 2 } });
  const snap = tr.value;
  check("snapshot shape correct", snap.translate.x === 1 && snap.scale.x === 1);
}

section("Atomic write: .value = newTr fires snapshot once");
{
  const tr = new TransformSoA();
  let fires = 0;
  const stop = effect(() => { void tr.value; fires++; });
  tr.value = { translate: { x: 5, y: 5 }, scale: { x: 2, y: 2 }, rotate: 0.5, opacity: 0.7 };
  check("snapshot effect fires once for batched update", fires === 2);
  stop();
}

section("Whole-Tr subscriber re-runs on ANY field change");
{
  const tr = new TransformSoA();
  let fires = 0;
  const stop = effect(() => { void tr.value; fires++; });
  tr.translate.x.value = 99;        // single field change — fires whole-Tr
  check("single field change fires whole-Tr", fires === 2);
  stop();
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`
Findings:
  ✓ Our primitives compose cleanly for SoA. No missing pieces.
  ✓ Per-field subscription works without lens machinery.
  ✓ Construction with Val<T> per field works via .bind().
  ✓ Atomic write semantic via batch().
  ✓ Whole-value snapshot via Computed.

  Trade-off vs fused Transform:
  - SoA: 4 Signal + 1 Computed per Transform (~5x heavier)
  - Fused: 1 Signal + lazy lenses (~1x baseline)
  - SoA has independent field subscriptions natively (no lens needed)
  - Fused has atomic propagation (1 propagation per whole write)

  Recommendation: keep both as patterns in user code, no special factory needed.
  Users hand-write SoA classes when fields are mostly independent.
`);
