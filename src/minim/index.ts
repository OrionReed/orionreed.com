// minim — generator-driven SVG diagrams with reactive primitives.
//
//   core/       signal-free generator runtime: Anim, drive, suspend,
//               race, all, rand, cut, scaled, withScale, attachRaf,
//               easings
//   signals/    reactive cells + signals→generators bridge: Signal/
//               Computed/Lens, traits, computed, lerp/Tween/spring/...,
//               Num/Vec/Color/Box/Transform/Matrix2D value types
//   shapes/     scene-graph (Shape) + intrinsics (rect/circle/line/...)
//               + transitions + choreographers + layout
//   tex/        Temml-backed math primitives with addressable Parts
//   web/        DOM scaffold (Diagram base class, custom elements)
//   ext/        opt-in extras (timeline, events, waapi, snapshot)
//   assert/     runtime-claim tooling for tutorials/tests

export * from "./core";
export * from "./signals";
export * from "./shapes";
export * from "./tex";
export * from "./web";
export * from "./ext";
export * from "./assert";
