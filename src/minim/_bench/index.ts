// Entry — runs every `.bench.ts` together. Each file calls
// `run({ format: "mitata" })` itself; this module just imports them
// so they all execute when this file is run.
//
//   node --expose-gc node_modules/.bin/vite-node src/minim/_bench/index.ts

import "./signals.bench";
import "./anim.bench";
