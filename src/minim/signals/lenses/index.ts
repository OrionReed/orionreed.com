// =====================================================================
// signals/lenses/index.ts — N→M and 1→M bidirectional lens primitives.
//
// Three layers:
//   1. NUMERICAL — `factor`, `factorTuple`, `bundle`: generic
//      Jacobian-LSQ, the escape hatch when no closed-form policy fits.
//   2. CLOSED-FORM POLICIES — `rigidTranslate`, `rotateAbout`,
//      `scaleAbout`, `scaleAboutXY`: exact group-action primitives.
//   3. DECOMPOSITIONS — `procrustesLens`, `bboxLens`, `bestFitLine`,
//      etc.: composed M-output views over the policies and aggregates.
//
// See BIDIRECTIONAL-LENSES.md for the engine substrate.
// =====================================================================

// ─── Building-block group actions (trait-dispatched) ───────────────────
export {
  bestFitCircleLens,
  bestFitLineLens,
  pcaLens,
  procrustesViaBuildingBlocks,
  rigidTranslate,
  rotateAbout,
  scaleAbout,
  scaleAboutXY,
  totalLens,
} from "./closed-form-policies";
// ─── Trait-driven aggregates + domain primitives ───────────────────────
export {
  bezierGestaltLens,
  meanColor,
  meanOf,
  paletteLens,
  rigidTranslateOf,
  spreadOf,
  timeSeriesLens,
} from "./domain-aggregates";
// ─── Numerical Jacobian primitive ──────────────────────────────────────
// ─── Closed-form decompositions (Vec-specific monoliths) ───────────────
export {
  bboxLens,
  bundleLens,
  type FactorLensOpts,
  factorLens,
  meanDiffLens,
  procrustesJacobianLens,
  procrustesLens,
} from "./factor-lens";
export {
  bundle,
  type FactorOpts,
  type FactorResult,
  factor,
  factorTuple,
  type OutputSpec,
  type PackedInput,
  procrustesTyped,
} from "./typed-factor";
