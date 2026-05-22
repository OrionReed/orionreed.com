// minim/assert — identity, recording, claims.
//
// One nominal data type (`Span`); everything else is a function over
// spans and signals. Three entry points:
//
//   scope(fn)       — give a factory identity (becomes traceable).
//   record(anim)    — start recording; spans flow into a Read<Span[]>.
//   claim(sig).…    — fluent builder over `latch` + predicates.
//
// Composition is signal algebra. Predicates, scopes, and claims are
// all `Read<boolean>` values; `and` / `or` / `not` / `during` are the
// only verbs. See `_test/assert.test.ts` for the full vocabulary.

export {
  always,
  firstOf,
  intervals,
  latch,
  type Scope,
} from "./algebra";
export {
  type Claim,
  claim,
  type Predicates,
  type SignalClaim,
} from "./claim";
export {
  above,
  below,
  equal,
  following,
  inRange,
  inside,
  isEqual,
  near,
} from "./predicates";
export { activeRecorder, authorOf, type Recorder, record } from "./record";
export {
  type Scoped,
  scope,
  scopeAll,
} from "./scope";
export {
  addSpanListener,
  closeSpan,
  currentSpan,
  notifySpanOpen,
  openSpan,
  type Span,
  type SpanStatus,
  withSpan,
} from "./span";

export {
  type TraceBatch,
  type TraceNode,
  type TraceTree,
  traceTree,
} from "./tree";
