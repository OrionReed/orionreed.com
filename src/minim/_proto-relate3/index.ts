// _proto-relate3 — write-attribution constraint cluster.
//
// The constraint engine is a plain `effect()` whose writebacks
// go through `signal.writeBack(value)`, a new method on Signal
// that propagates to subscribers EXCEPT the currently-active
// effect. Termination is structural — the effect can't re-trigger
// itself.
//
// Compared to:
//   - `_proto-avbd` (preEffect): no special phase or self-mute
//     logic, no signal-layer primitives beyond the small
//     `writeBack` addition.
//   - `_proto-relate2` (lazy via getter): doesn't replace any
//     Signal internals, lens-compatible.
//
// Signal-layer footprint:
//   - `propagate(start, innerWrite, excluding?)` — one new optional
//     param.
//   - `Signal.writeBack(next)` — new method, ~1 line of body
//     (defers to a private `_setWithExclusion`).
//
// See `cluster.ts` for the design notes.

export { Cluster } from "./cluster";
export {
  type Bindable,
  clamp,
  distance,
  eq,
  generic,
  geq,
  leq,
  lensNum,
  softTarget,
  spring,
} from "./constraints";
