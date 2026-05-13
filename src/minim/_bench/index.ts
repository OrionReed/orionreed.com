// Entry point — imports each .bench.ts (which register suites by
// side-effect), then runs everything. Add new bench files to this
// list.

import "./construct.bench";
import "./access.bench";
import "./lift.bench";
import "./arity.bench";
import "./getter.bench";
import "./tween.bench";
import "./tree.bench";
import "./cell.bench";
import "./cell-full.bench";
import "./three-way.bench";
import { runAll, sinkVal } from "./harness";

runAll();
// Force the JIT to keep the sink — printed at the end, never optimized away.
console.log(`(final sink value: ${sinkVal()})`);
