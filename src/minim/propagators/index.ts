// Propagator network — PROTOTYPE.
//
// Layered as `Constraints` is in `../constraints/`:
//
//   network() — primitive (in ../signals/signal.ts)
//     ↓
//   Propagators — class holding propagators, fixpoint loop with
//                 fuel cap. One internal `network()` runs the body.
//     ↓
//   Combinators — propagator factories (adder, eq, distribute, …).
//
// Crucial property: propagators do NOT introduce a new signal type.
// Existing `Writable<Num>`, `Writable<Vec>`, lensed signals, etc.
// are passed in directly — no Cell wrapper, no lattice attached at
// the signal level. Merging / narrowing semantics are encoded in
// the propagator's step body when needed (e.g. set-narrowing for
// sudoku); for plain numerical cases, propagators just write
// signals normally and the network's freshness propagation +
// signals' built-in `===` short-circuit + the fuel cap together
// guarantee termination.

export {
  adder,
  align,
  allDifferent,
  allEqual,
  aspectRatio,
  chainSum,
  constant,
  distributeH,
  eq,
  multiplier,
  type SetCell,
} from "./combinators";
export { type PropagatorsOpts, Propagators, PropagatorDivergedError, propagators } from "./network";
export { type Propagator, propagator } from "./propagator";
export {
  constrain,
  intervalAdd,
  intervalAdder,
  intervalEq,
  intervalSub,
  intervalSum,
  type Range,
  type RangeCell,
  rangeCell,
  RangeContradiction,
  rangeEq,
  rangeIsContradiction,
  rangeIsExact,
  rangeMeet,
  rangeMerge,
  RANGE_TOP,
  rangeWidth,
  snap,
} from "./range";
export { flexH, type FlexHItem, type FlexHOpts, stack } from "./layout";
export { type Box, box } from "./box";
export { grid, type GridOpts, hstack, inset, type StackOpts, vstack } from "./stacks";
export {
  attach,
  centerInside,
  follow,
  lockSize,
  pinEdge,
  type Side,
} from "./box-ops";
export {
  keepDistance,
  onLine,
  vAdd,
  vBetween,
  vCentroid,
  vMidpoint,
  vOnCircle,
  vReflect,
  vSub,
} from "./vec-ops";
