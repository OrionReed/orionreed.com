// tree.ts — hierarchical structure of (typically reactive) values.
//
// A `TreeNode<T>` is a graph node holding a value of type `T` plus a
// list of child nodes. The "tree" is the structural relationship
// between values, NOT a single big `Signal<TreeShape>`. Each node's
// value is typically a Signal subclass instance (Num, Pose, Bool, …)
// or a compound object containing cells; either way, writes flow
// through the individual cells with the same O(1) incrementality the
// engine already provides for field lenses and aggregates.
//
// Two canonical bidirectional patterns over a tree-of-cells:
//
//   1. AGGREGATE (bottom-up): an internal node's value is a lens
//      over its descendant leaves — `merge` on read, `redistribute`
//      on write. Used for sum-trees, AND-trees (via Tri.allOf),
//      mean-trees, etc.
//
//   2. PROPAGATE (top-down): each node carries a LOCAL value; a
//      derived "world" view at each node is the composition of its
//      parent's world view with its own local. Writes go to the
//      local cell. The classical scene-graph / skeletal-armature
//      shape, parametrised by `compose` / `decompose` for the value
//      type.
//
// `TreeNode<T>` is just the structural container — it has no opinion
// about which pattern you use. Aggregate / propagate helpers live as
// free factory functions that wrap the existing `Cls.lens` /
// `Cls.derive` primitives.

/** Recursive container: a value of type `T` and zero-or-more children
 *  of the same shape. The value is unconstrained — typically a single
 *  reactive cell, but compound records carrying multiple cells (e.g.,
 *  a bone with both local and world poses) work just as well.
 *  Construction is static; runtime structural edits go through
 *  `network()` (same pattern as `addWhile` for conditional cluster
 *  membership). */
export interface TreeNode<T> {
  readonly value: T;
  readonly children: readonly TreeNode<T>[];
}

/** Construct a tree node. */
export function node<T>(value: T, children: readonly TreeNode<T>[] = []): TreeNode<T> {
  return { value, children };
}

/** Depth-first traversal. `visit` receives the node, its depth from
 *  the root, and the path of child-indices from the root. */
export function walkTree<T>(
  root: TreeNode<T>,
  visit: (n: TreeNode<T>, depth: number, path: readonly number[]) => void,
): void {
  const inner = (n: TreeNode<T>, depth: number, path: readonly number[]): void => {
    visit(n, depth, path);
    for (let i = 0; i < n.children.length; i++) {
      inner(n.children[i]!, depth + 1, [...path, i]);
    }
  };
  inner(root, 0, []);
}

/** Collect every leaf (a node with no children) in depth-first order. */
export function leavesOf<T>(root: TreeNode<T>): TreeNode<T>[] {
  const out: TreeNode<T>[] = [];
  walkTree(root, n => {
    if (n.children.length === 0) out.push(n);
  });
  return out;
}

/** Collect every node (leaf and internal) in depth-first order. */
export function allNodes<T>(root: TreeNode<T>): TreeNode<T>[] {
  const out: TreeNode<T>[] = [];
  walkTree(root, n => out.push(n));
  return out;
}

/** Index a node by path from root. Empty path returns root. */
export function atPath<T>(root: TreeNode<T>, path: readonly number[]): TreeNode<T> {
  let n: TreeNode<T> = root;
  for (const i of path) n = n.children[i]!;
  return n;
}

/** True iff `n` is a leaf (no children). */
export function isLeaf<T>(n: TreeNode<T>): boolean {
  return n.children.length === 0;
}

/** Count nodes in the tree. */
export function nodeCount<T>(root: TreeNode<T>): number {
  let c = 0;
  walkTree(root, () => {
    c++;
  });
  return c;
}
