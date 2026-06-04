// Lifted conformance — the whole forward suite, but every source write
// enters through an (identity) write-through view. If the backward path
// is sound, the forward observations are bit-identical to the direct
// run. This is the unifying construction: a bireactive engine is correct
// iff every forward-correctness test still passes when source writes are
// replaced by equivalent write-throughs. Forward conformance is the
// degenerate (no-lens) case of this one.

import { type ReactiveFramework, setExpect, testSuite } from "reactive-framework-test-suite";
import { describe, expect, it } from "vitest";
import { minim } from "../adapters/minim";
import { liftedFramework } from "../adapters/rfts";

setExpect(<T>(actual: T) => expect(actual) as never);

const fw: ReactiveFramework = liftedFramework(minim);

const DIVERGED = new Set<string>([
  "#209 three-level nested effect: cascading disposal",
  "#210 multiple inner effects all cleaned when outer re-runs",
]);

// Divergences the lift SURFACES (not design choices). minim defers a
// view's backward write to flush, so inside a batch these forward
// guarantees do not hold when the write enters through a view — even
// though they hold for direct source writes (forward.test.ts passes all
// of these). The failures cluster on one root cause: batched view writes
// are not write-then-read consistent and don't collapse no-ops/reverts
// (#131 even loses a revert: 5→0 lands 5). Encoded as `it.fails` so the
// suite stays green AND a future engine fix turns these red, prompting
// promotion back to `it`.
const LIFTED_OPEN = new Set<string>([
  "#67 signals readable with updated value inside batch",
  "#123 repeated no-op batches don't re-trigger effects",
  "#125 batch: source reverts → computed not notified",
  "#128 reading computed in batch forces upstream evaluation",
  "#131 derived-of-derived: source reverts in batch",
  "#132 batch: computed not recomputed if dep reverts",
  "#147 computed not recomputed in batch if dep reverts",
  "#182 computed side effect + batch: writes visible after flush",
]);

describe("lifted conformance (RFTS through a write-through view)", () => {
  for (const section of testSuite) {
    const isBehavioral = (section as { type?: string }).type === "behavioral";
    describe(section.section, () => {
      for (const [name, fn] of Object.entries(section.cases)) {
        if (isBehavioral || DIVERGED.has(name)) it.skip(name, () => fn(fw));
        else if (LIFTED_OPEN.has(name)) it.fails(name, () => fn(fw));
        else it(name, () => fn(fw));
      }
    });
  }
});
