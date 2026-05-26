// =====================================================================
// signals/lenses/index.ts — N→M and 1→M bidirectional lens primitives.
//
// Three layers:
//
//   1. NUMERICAL — `factor`, `factorTuple`, `bundle` — generic
//      Jacobian-LSQ over typed inputs/outputs via the Pack trait.
//      The escape hatch when no closed-form policy fits.
//
//   2. CLOSED-FORM POLICIES — `rigidTranslate`, `rotateAbout`,
//      `scaleAbout`, `scaleAboutXY` — exact group-action primitives,
//      trait-dispatched via Pivotal where applicable.
//
//   3. DECOMPOSITIONS — `procrustesLens`, `bboxLens`, `bestFitLine`,
//      `bestFitCircle`, `pcaLens`, `totalLens`, `palette`,
//      `bezierGestalt`, `timeSeries` — composed M-output views built
//      from the policies and trait-driven aggregates.
//
// All exports are exact, idempotent, and cross-channel invariant
// where the math permits. See BIDIRECTIONAL-LENSES.md for the engine
// substrate.
// =====================================================================

// ─── Numerical Jacobian primitive ──────────────────────────────────────
export {
  type FactorLensOpts,
  factorLens,
  meanDiffLens,
} from "./factor-lens";

export {
  type OutputSpec,
  type FactorOpts,
  type FactorResult,
  type PackedInput,
  bundle,
  factor,
  factorTuple,
  procrustesTyped,
} from "./typed-factor";

// ─── Closed-form decompositions (Vec-specific monoliths) ───────────────
export {
  bboxLens,
  bundleLens,
  procrustesLens,
  procrustesJacobianLens,
} from "./factor-lens";

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
