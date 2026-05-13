// Entry point — imports each .bench.ts (which register benches by
// side-effect via mitata's global registry), then runs everything.
// Add new bench files to this list.
//
// Run with:
//   node --expose-gc node_modules/.bin/vite-node src/minim/_bench/index.ts

import "./construct.bench";
import "./access.bench";
import "./lift.bench";
import "./arity.bench";
import "./getter.bench";
import "./tween.bench";
import "./tree.bench";
import "./delegate.bench";
import "./nested.bench";
import "./shape.bench";
import { run } from "mitata";
import { printMemoryRows } from "./memory";

await run({ format: "mitata" });
printMemoryRows();
