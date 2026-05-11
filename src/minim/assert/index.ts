// Observability + verification. Both `trace` (spans, tree, tags) and
// `claim` (labeled bool-signal assertions) live here — independent
// imports, shared "observe/assert behaviour" flavor.

export { spans, type Span, type Trace } from "./spans";

export {
  traceTree,
  type TraceTree,
  type TraceNode,
  type TraceBatch,
} from "./tree";

export { tag, tagAll, tagOf } from "./tag";

export {
  claim,
  process,
  labelledProcess,
  held,
  any,
  not,
  track,
  verdictDot,
  SignalClaim,
  Predicates,
  type Claim,
  type Process,
} from "./claim";
