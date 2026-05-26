// box.ts — Box value-type re-export for the propagator surface.
//
// The canonical `Box` and `box(x, y, w, h)` factory live in
// `signals/values/box.ts`. We re-export them here so users of the
// propagators package have a single import for spatial primitives.

export { Box, box } from "../signals/values/box";
