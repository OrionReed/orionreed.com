// Public surface for r5. Aim: small, composable, no per-value-class
// type aliases. Writability is a generic modifier (`Writable<R>`).

// ─── Engine ───────────────────────────────────────────────────────
export {
  Signal,
  signal, computed, lens,
  effect, batch, untracked,
  isSignal, isComputed, isLens,
  value,
  type Read, type Val, type Of,
  type SignalOptions,
} from "./signal";

// ─── Traits ───────────────────────────────────────────────────────
export {
  type Linear, type Lerp, type Metric, type Equals,
  type Traits,
  requireLinear, requireLerp, requireMetric, requireEquals,
} from "./traits";

// ─── Ops (for value-class authors) ────────────────────────────────
export { type Op, applyOp1, applyOp2 } from "./ops";

// ─── Writable modifier ────────────────────────────────────────────
export {
  type Writable,
  type WritableOf,
} from "./writable";

// ─── Value classes ────────────────────────────────────────────────
export { Num, num } from "./values/num";
export { Vec, vec } from "./values/vec";
