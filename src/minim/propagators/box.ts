// box.ts — propagator-friendly Box constructor.
//
// Re-exports the canonical `Box` value type (with all its field
// lenses, edges, and traits) and adds an object-args factory for
// terse, partial-spec construction:
//
//   box({ w: 300 })           // x=0, y=0, w=300, h=0
//   box({ x: 16, y: 16, w: 200, h: 100 })
//
// The signal-level `box(x, y, w, h)` factory (positional args) is
// available from `@minim/signals` directly; this is sugar for the
// "just specify what matters" call sites that propagator demos and
// layout combinators want.

import { type Box, box as boxPositional } from "../signals/values/box";
import type { Writable } from "../signals";

export type { Box } from "../signals/values/box";

export function box(init: { x?: number; y?: number; w?: number; h?: number } = {}): Writable<Box> {
  return boxPositional(init.x ?? 0, init.y ?? 0, init.w ?? 0, init.h ?? 0);
}
