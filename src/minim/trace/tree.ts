// Structural derivation over `Span[]`. The trace itself stays as
// flat data in `Anim`; this module turns that into a tree where the
// units that matter — parent-child, sibling batches, depth — are
// first-class. Both visual layouts (gantt, swim-lane) and assertions
// ("X always happens before Y", "Z is never more than 1") build on
// this view, so it's the right shared primitive.

import type { Span } from "./spans";

/** A yield-array's worth of siblings. All members share the same
 *  parent and the same `spawnedAt` (they're spawned in one synchronous
 *  block of `advance`). Sequential batches under the same parent are
 *  represented by separate `TraceBatch` entries on that parent. */
export type TraceBatch = {
  readonly spawnedAt: number;
  readonly members: readonly TraceNode[];
};

/** Tree node wrapping one `Span`. `children` is the flat list across
 *  all batches in spawn order; `batches` preserves yield-array
 *  groupings. `depth` is `parentId`-chain hops to root (0 for root). */
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
  /** Pre-order DFS: each parent visited before its children, batches
   *  in spawn-time order, siblings within a batch in spawn order. */
  dfs(visit: (node: TraceNode, depth: number) => void): void;
};

interface MutableNode {
  span: Span;
  parent?: TraceNode;
  depth: number;
  batches: TraceBatch[];
  children: TraceNode[];
}

/** Build a `TraceTree` snapshot from a flat list of spans. Pure;
 *  reads only the data passed in. Intended to be called from inside a
 *  `computed` (re-runs when `trace.version` bumps) or once at the
 *  end of a run for after-the-fact inspection.
 *
 *  Spans must be in spawn order (which `Trace.spans` already is — the
 *  runtime appends on spawn). Parent always precedes its children. */
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

  // Group children-of-each-parent by parent id, preserving spawn order
  // (`spans` is already spawn-ordered, so push order suffices).
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
      // Parent not in this span list (maybe trace started after parent
      // was spawned). Treat as root for layout purposes.
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
