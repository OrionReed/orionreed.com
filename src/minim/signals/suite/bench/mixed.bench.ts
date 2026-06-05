// Mixed bench — direct manipulation. A fan-in view is written every tick
// while a live effect observes the reconverged total: the "drag the
// midpoint while the UI watches" workload that the forward-only suites
// have no shape for. This is where a write-driven graph and an induced
// forward cascade meet under one edit.

import { group } from "mitata";
import { minim } from "../adapters/minim";
import { reconcile } from "../adapters/reconcile";
import { reg } from "./runner";
import { dragFan } from "./workloads";

group("drag fan-in view (live observer): minim", () => {
  for (const w of [4, 16, 64]) reg(`width ${w}`, dragFan(minim, w));
});

group("drag fan-in view (live observer): reconcile", () => {
  for (const w of [4, 16, 64]) reg(`width ${w}`, dragFan(reconcile, w));
});
