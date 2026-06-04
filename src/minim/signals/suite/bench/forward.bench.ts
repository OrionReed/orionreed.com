// Forward bench — the "bireactive tax". minim's forward path is
// alien-signals verbatim, but every cell carries the backward machinery
// (_put / _bwdParent / pendingValue dual-keying). The gap between minim
// and raw alien/preact on identical forward graphs is the cost of being
// bidirectional on a workload that never writes backward.

import { group } from "mitata";
import { alien, preact } from "../adapters/forward";
import { minim } from "../adapters/minim";
import { reg } from "./runner";
import { fwdChain, fwdFan } from "./workloads";

const engines = [minim, alien, preact] as const;

group("forward chain (depth 50)", () => {
  for (const rx of engines) reg(rx.name, fwdChain(rx, 50));
});

group("forward fan-in (width 50)", () => {
  for (const rx of engines) reg(rx.name, fwdFan(rx, 50));
});
