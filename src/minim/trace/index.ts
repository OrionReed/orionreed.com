// `trace/` — derivations and helpers built on top of `Anim.observe`.
// Pure consumers: nothing here participates in the runtime hot path.

export { spans, type Span, type Trace } from "./spans";

export {
  traceTree,
  type TraceTree,
  type TraceNode,
  type TraceBatch,
} from "./tree";

export { tag, tagAll, tagOf } from "./tag";
