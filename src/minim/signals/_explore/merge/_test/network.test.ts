// network.test.ts — `.merge()` interaction with the engine's
// `network()` construct (sub-DAG with self-exclusion). A network
// body that writes through a merge must:
//   - NOT re-fire itself due to its own writes (self-exclusion holds
//     because the merge threads activeNetwork through its commit).
//   - See the COMMITTED merge value when it reads downstream.
//
// Networks aren't slot identities themselves — they're not lens
// cells. When a network body writes via `lens.value = …`, it's the
// lens (not the network) that becomes the active bwd writer, so
// the merge slots normally.

import { describe, expect, it } from "vitest";
import { network, num, sumPolicy } from "../index";

describe("network body writing through a merge", () => {
  it("the network doesn't re-fire from its own merge-mediated writes (self-exclusion)", () => {
    const trigger = num(0);
    const merged = num(0).merge(sumPolicy);
    let fires = 0;
    const handle = network([trigger, merged], () => {
      fires++;
      // Read merged (subscribes); read trigger (subscribes); on
      // trigger > 0, write to merged via its own setter. Self-
      // exclusion should prevent re-fire from the merged write.
      const t = trigger.value;
      const m = merged.value;
      void m;
      if (t > 0) merged.value = t * 10;
    });
    const baseline = fires;
    trigger.value = 1;
    // Network fires due to trigger change; writes merged; self-
    // exclusion suppresses re-fire from the merged commit.
    // Total fires from this turn: 1 (the trigger-driven one).
    expect(fires - baseline).toBe(1);
    handle.dispose();
  });

  it("network body sees the committed merge value on its next fire", () => {
    const trigger = num(0);
    const merged = num(0).merge(sumPolicy);
    let lastSeen = 0;
    const handle = network([trigger, merged], () => {
      lastSeen = merged.value;
      const t = trigger.value;
      if (t > 0) merged.value = t * 10;
    });
    trigger.value = 5;
    // Body wrote merged.value = 50 on this fire. Self-excluded
    // from re-firing. Next external trigger will let it see the
    // committed value.
    trigger.value = 6;
    expect(lastSeen).toBe(50); // committed by the previous fire
    handle.dispose();
  });

  it("a network downstream of a merge sees committed values like any other subscriber", () => {
    const merged = num(0).merge(sumPolicy);
    const a = merged.add(1);
    let lastSeen = 0;
    const handle = network([merged], () => {
      lastSeen = merged.value;
    });
    a.value = 7; // merged via a.bwd = 6
    expect(lastSeen).toBe(6);
    handle.dispose();
  });
});
