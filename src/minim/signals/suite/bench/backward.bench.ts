// Backward bench — edit-settle time when the edit enters through a view,
// placed next to its forward dual on the same topology. minim commits
// backward via the forward path, so a write-through's cost is the
// backward walk plus the forward cascade it induces; the dual pairing
// makes that overhead legible.

import { group } from "mitata";
import { minim } from "../adapters/minim";
import { reg } from "./runner";
import { bwdChain, bwdFan, fwdChain, fwdFan } from "./workloads";

group("chain depth 50: source-edit vs view-edit", () => {
  reg("forward (write source)", fwdChain(minim, 50));
  reg("backward (write top view)", bwdChain(minim, 50));
});

group("fan width 50: source-edit vs view-edit", () => {
  reg("forward (write 1 source)", fwdFan(minim, 50));
  reg("backward (write fan-in view)", bwdFan(minim, 50));
});
