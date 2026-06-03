// lossy.bench.test.ts — the workload the backward equality check targets:
// dragging a quantized slider whose source is observed by sibling rows
// (the md-clamp-quantize shape). Within-bucket jitter is the common case
// during a drag; the check should make it nearly free (early-stop at the
// lossy lens, no source write, no sibling re-fire), while genuine
// cross-bucket moves pay the full cascade + propagation.
//
// Also compares `iso` (source-independent put, relies on the engine
// equality check = Route B) vs `lens` (in-put GetPut short-circuit that
// reads the source = Route A).

import { describe, it } from "vitest";
import { iso, lens, effect, signal } from "../index";

const N = 50_000;
const step = 0.1;
const q = (v: number) => Math.round(v / step) * step;

function timed(label: string, fn: () => void): number {
  for (let w = 0; w < 5; w++) fn();
  let ms = Number.POSITIVE_INFINITY;
  for (let r = 0; r < 8; r++) {
    const t0 = performance.now();
    fn();
    const t1 = performance.now();
    if (t1 - t0 < ms) ms = t1 - t0;
  }
  console.info(
    `  ${label.padEnd(56)}  ${ms.toFixed(2).padStart(8)}ms  ${((ms * 1e6) / N).toFixed(0).padStart(4)} ns/op`,
  );
  return ms;
}

/** Build the md scene: t → clamp → quantize, with sibling effects on t
 *  and the clamp row (the readouts that re-fire on a snap). */
function scene(routeA: boolean) {
  const t = signal(0.53);
  const clamp = (x: number) => (x < 0.2 ? 0.2 : x > 0.8 ? 0.8 : x);
  const tC = routeA
    ? lens(t, clamp, (target: number, src: number) =>
        clamp(target) === clamp(src) ? src : clamp(target),
      )
    : iso(t, clamp, (target: number) => clamp(target));
  const tQ = routeA
    ? lens(tC, q, (target: number, src: number) => (q(target) === q(src) ? src : q(target)))
    : iso(tC, q, q);
  let sink = 0;
  effect(() => {
    sink += t.value;
  });
  effect(() => {
    sink += tC.value;
  });
  void tQ.value;
  return { t, tQ, sink: () => sink };
}

describe("drag loop: within-bucket (equality check should early-stop)", () => {
  it("iso + engine equality check (Route B)", () => {
    const { tQ } = scene(false);
    timed("within-bucket  iso (Route B) ×N", () => {
      for (let i = 0; i < N; i++) {
        // jitter inside the 0.5 bucket: [0.45, 0.55)
        (tQ as { value: number }).value = 0.45 + (i % 9) * 0.01;
      }
    });
  });

  it("lens in-put GetPut short-circuit (Route A)", () => {
    const { tQ } = scene(true);
    timed("within-bucket  lens (Route A) ×N", () => {
      for (let i = 0; i < N; i++) {
        (tQ as { value: number }).value = 0.45 + (i % 9) * 0.01;
      }
    });
  });
});

describe("drag loop: cross-bucket (genuine moves, full cascade + fires)", () => {
  it("iso + engine equality check (Route B)", () => {
    const { tQ } = scene(false);
    timed("cross-bucket   iso (Route B) ×N", () => {
      for (let i = 0; i < N; i++) {
        // walk across detents 0.2..0.8
        (tQ as { value: number }).value = 0.2 + (i % 7) * 0.1;
      }
    });
  });

  it("lens in-put GetPut short-circuit (Route A)", () => {
    const { tQ } = scene(true);
    timed("cross-bucket   lens (Route A) ×N", () => {
      for (let i = 0; i < N; i++) {
        (tQ as { value: number }).value = 0.2 + (i % 7) * 0.1;
      }
    });
  });
});
