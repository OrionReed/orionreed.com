// Structural view over `Span[]`. The flat data is canonical; this
// module groups it as a tree where parent-child, sibling batches, and
// depth are first-class. Used by gantt layouts and assertions alike.

import type {Span} from "./spans";

/** A yield-array's worth of siblings — same parent, same `spawnedAt`.
 *  Sequential batches under one parent are separate entries. */
export type TraceBatch = {
  readonly spawnedAt: number;
  readonly members: readonly TraceNode[];
};

/** Tree node. `children` is the flat list across all batches in spawn
 *  order; `batches` preserves yield-array groupings. */
export type TraceNode = {
  readonly span: Span;
  readonly parent?: TraceNode;
  readonly depth: number;
  readonly batches: readonly TraceBatch[];
  readonly children: readonly TraceNode[];
};

export type TraceTree = {
  readonly roots: readonly TraceNode[];
  readonly byId: ReadonlyMap<number, TraceNode>;
  readonly size: number;
  /** Pre-order DFS: parent before children, batches in spawn-time
   *  order, siblings within a batch in spawn order. */
  dfs(visit: (node: TraceNode, depth: number) => void): void;
};

interface MutableNode {
  span: Span;
  parent?: TraceNode;
  depth: number;
  batches: TraceBatch[];
  children: TraceNode[];
}

/** Build a `TraceTree` snapshot. Pure — call from inside a `computed`
 *  (re-runs on trace changes) or once at the end of a run. Spans must
 *  be in spawn order (Trace.spans always is). */
export function traceTree(spans: readonly Span[]): TraceTree {
  // First pass: skeletal nodes so parent/child references can resolve.
  const byId = new Map<number, MutableNode>();
  for (const s of spans) {
    byId.set(s.id, {
      span: s,
      depth: 0,
      batches: [],
      children: [],
    });
  }

  // Group children by parent id, preserving spawn order.
  const childrenOf = new Map<number, MutableNode[]>();
  const roots: MutableNode[] = [];
  for (const s of spans) {
    const node = byId.get(s.id)!;
    if (s.parentId === undefined) {
      roots.push(node);
      continue;
    }
    const parent = byId.get(s.parentId);
    if (!parent) {
      // Parent not in this span list (trace started mid-run). Treat
      // as root for layout purposes.
      roots.push(node);
      continue;
    }
    node.parent = parent as TraceNode;
    node.depth = parent.depth + 1;
    const arr = childrenOf.get(s.parentId);
    if (arr) arr.push(node);
    else childrenOf.set(s.parentId, [node]);
  }

  // Second pass: build batches and flat children list per node.
  for (const [parentId, kids] of childrenOf) {
    const parent = byId.get(parentId)!;
    parent.children = kids as TraceNode[];
    let i = 0;
    while (i < kids.length) {
      const t = kids[i].span.spawnedAt;
      const members: TraceNode[] = [];
      while (i < kids.length && kids[i].span.spawnedAt === t) {
        members.push(kids[i] as TraceNode);
        i++;
      }
      parent.batches.push({ spawnedAt: t, members });
    }
  }

  const rootsRO = roots as readonly TraceNode[];
  const byIdRO = byId as ReadonlyMap<number, TraceNode>;

  return {
    roots: rootsRO,
    byId: byIdRO,
    size: spans.length,
    dfs(visit) {
      const walk = (n: TraceNode): void => {
        visit(n, n.depth);
        for (const c of n.children) walk(c);
      };
      for (const r of rootsRO) walk(r);
    },
  };
}
