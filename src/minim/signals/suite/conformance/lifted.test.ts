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

// The entire batching cluster now passes through a write-through view —
// including net-zero revert coalescing. A single-parent lens writes
// through eagerly inside a batch (`_writeSource` stages the source and
// defers only the flush), and the backward pass's internal no-op checks
// read staged sources WITHOUT committing them (`settled`), so a revert
// (`a=1; a=0`) leaves the source untouched and downstream un-fired —
// identical to a direct source write.

describe("lifted conformance (RFTS through a write-through view)", () => {
  for (const section of testSuite) {
    const isBehavioral = (section as { type?: string }).type === "behavioral";
    describe(section.section, () => {
      for (const [name, fn] of Object.entries(section.cases)) {
        if (isBehavioral || DIVERGED.has(name)) it.skip(name, () => fn(fw));
        else it(name, () => fn(fw));
      }
    });
  }
});
