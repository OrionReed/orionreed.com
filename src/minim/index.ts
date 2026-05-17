// minim — generator-driven SVG diagrams with reactive primitives.
//
//   core/       signal-free generator runtime: Anim, drive, suspend,
//               race, all, rand, mapDt, withTimeout, attachRaf, easings
//   signals/    reactive cells + signals→generators bridge: Signal/
//               Computed/Lens, traits, derive, lerp/Tween/spring/...,
//               Num/Vec/Color/Box/Transform value types
//
// Sub-folders below are mid-migration off the prior reactive surface
// and not re-exported here yet:
//   values/     prod value types (Matrix2D, Anchor/Dir, behaviors,
//               aggregates) — to be ported into signals/values/
//   shapes/     scene-graph + transitions/choreographers
//   tex/, web/, ext/, assert/  layered features

export * from "./core";
export * from "./signals";
