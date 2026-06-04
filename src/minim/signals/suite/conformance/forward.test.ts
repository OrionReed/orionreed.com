// Forward conformance — the full reactive-framework-test-suite against
// minim's engine. minim's forward path is alien-signals verbatim, so
// this is table-stakes correctness (glitch-freedom, minimal recompute,
// laziness, dynamic deps, batching, untracked). Subsumes the old
// `src/minim/_test/conformance.test.ts`.

import { type ReactiveFramework, setExpect, testSuite } from "reactive-framework-test-suite";
import { describe, expect, it } from "vitest";
import { minim } from "../adapters/minim";
import { forwardFramework } from "../adapters/rfts";

setExpect(<T>(actual: T) => expect(actual) as never);

const fw: ReactiveFramework = forwardFramework(minim);

// minim's `effect()` does not track parent-child relationships — nested
// effects are independent scopes owned by the call site's disposer (as
// in alien-signals v2, Solid 2.0, Vue's effectScope, the TC39 proposal).
// RFTS tests asserting the older auto-parent-cleanup model are skipped.
const DIVERGED = new Set<string>([
  "#209 three-level nested effect: cascading disposal",
  "#210 multiple inner effects all cleaned when outer re-runs",
]);

describe("forward conformance (RFTS)", () => {
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
