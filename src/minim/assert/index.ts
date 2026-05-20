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
  type Span,
  type SpanStatus,
  currentSpan,
  withSpan,
  openSpan,
  closeSpan,
  notifySpanOpen,
  addSpanListener,
} from "./span";

export {
  scope,
  scopeAll,
  type Scoped,
} from "./scope";

export { record, authorOf, activeRecorder, type Recorder } from "./record";

export {
  intervals,
  latch,
  firstOf,
  always,
  type Scope,
} from "./algebra";

export {
  inRange,
  equal,
  above,
  below,
  near,
  inside,
  following,
  isEqual,
} from "./predicates";

export {
  claim,
  type Claim,
  type SignalClaim,
  type Predicates,
} from "./claim";

export {
  traceTree,
  type TraceTree,
  type TraceNode,
  type TraceBatch,
} from "./tree";
