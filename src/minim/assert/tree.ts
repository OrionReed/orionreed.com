// Structural view over `Span[]`. Pure; wrap in `derive()` to stay reactive.
//
// `parent` is a back-link on Span; this module produces forward links
// (children) and groups siblings into `batches` — same-`start` siblings
// (spawned together via `yield [a, b, c]`) share a batch.

import type { Span } from "./span";

export interface TraceBatch {
  readonly start: number;
  readonly members: readonly TraceNode[];
}

export interface TraceNode {
  readonly span: Span;
  readonly parent?: TraceNode;
  readonly depth: number;
  readonly batches: readonly TraceBatch[];
  readonly children: readonly TraceNode[];
}

export interface TraceTree {
  readonly roots: readonly TraceNode[];
  readonly byId: ReadonlyMap<number, TraceNode>;
  readonly size: number;
  /** Pre-order DFS: parent first, then batches in start-time order,
   *  then siblings within a batch in start order. */
  dfs(visit: (node: TraceNode, depth: number) => void): void;
}

interface MutableNode {
  span: Span;
  parent?: TraceNode;
  depth: number;
  batches: TraceBatch[];
  children: TraceNode[];
}

/** Build a `TraceTree`. Spans must be in start-time order (recorder is). */
export function traceTree(spans: readonly Span[]): TraceTree {
  const byId = new Map<number, MutableNode>();
  for (const s of spans) {
    byId.set(s.id, { span: s, depth: 0, batches: [], children: [] });
  }

  const childrenOf = new Map<number, MutableNode[]>();
  const roots: MutableNode[] = [];
  for (const s of spans) {
    const node = byId.get(s.id)!;
    const parentId = s.parent?.id;
    if (parentId === undefined) {
      roots.push(node);
      continue;
    }
    const parent = byId.get(parentId);
    if (!parent) {
      // Parent outside this list (trace started mid-run): treat as root.
      roots.push(node);
      continue;
    }
    node.parent = parent as TraceNode;
    node.depth = parent.depth + 1;
    const arr = childrenOf.get(parentId);
    if (arr) arr.push(node);
    else childrenOf.set(parentId, [node]);
  }

  for (const [parentId, kids] of childrenOf) {
    const parent = byId.get(parentId)!;
    parent.children = kids as TraceNode[];
    let i = 0;
    while (i < kids.length) {
      const t = kids[i].span.start;
      const members: TraceNode[] = [];
      while (i < kids.length && kids[i].span.start === t) {
        members.push(kids[i] as TraceNode);
        i++;
      }
      parent.batches.push({ start: t, members });
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
