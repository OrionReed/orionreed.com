// Bench entry — registers every group, then runs once.
//
//   node --expose-gc node_modules/.bin/vite-node \
//        src/minim/signals/suite/bench/index.ts

import { run } from "mitata";
import "./forward.bench";
import "./backward.bench";
import "./mixed.bench";

await run({ format: "mitata" });
