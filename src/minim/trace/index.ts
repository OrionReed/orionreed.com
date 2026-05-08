// `trace/` — derivations and helpers built on top of `Anim.trace()`.
// Pure consumers: nothing here participates in the runtime hot path.

export {
  traceTree,
  type TraceTree,
  type TraceNode,
  type TraceBatch,
} from "./tree";

export { tag, tagAll } from "./tag";
