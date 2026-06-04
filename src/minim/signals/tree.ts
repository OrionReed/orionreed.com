// tree.ts — hierarchical structure of (typically reactive) values.
//
// A `TreeNode<T>` is the structural relationship between values, not a
// single big `Cell<TreeShape>`. Each node's value is typically a
// Cell subclass or a compound of cells; writes flow through the
// individual cells with the engine's usual O(1) incrementality.
//
// Two bidirectional patterns layer on top (as free factory functions):
//   1. AGGREGATE (bottom-up): an internal node lenses over its leaves —
//      merge on read, redistribute on write (sum-trees, mean-trees, …).
//   2. PROPAGATE (top-down): each node carries a local value; its
//      "world" view composes the parent's with its own. The classical
//      scene-graph / armature shape, parametrised by compose/decompose.

/** Recursive container: a value plus zero-or-more children of the same
 *  shape. Value is unconstrained — a single cell or a compound record
 *  (e.g. a bone with local + world poses). Structural edits go through
 *  `network()`. */
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
