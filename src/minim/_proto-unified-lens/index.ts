// _proto-unified-lens — exploratory replacement for fanin / lensTo /
// deriveTo / through / Cls.lens(g,s) / Cls.derive(fn).
//
// Public surface (proposed):
//   - lens(parent | parents, fwd, bwd)
//   - derive(parent | parents, fn)
//   - classLens(Cls, parent | parents, fwd, bwd)  // → Cls.lens(...)
//   - classDerive(Cls, parent | parents, fn)       // → Cls.derive(...)
//   - endoLens(parent, fwd, bwd)                   // → parent.lens(...)
//
// Aggregates re-implemented on top to A/B against the existing
// fanin-based versions.

export { classDerive, classLens, derive, endoLens, lens } from "./core";
export {
  argminNumLens,
  axesLens,
  centroidLens,
  maxLens,
  meanLens,
  midpointLens,
  minLens,
  polarCircular,
  sumLens,
} from "./aggregates";
