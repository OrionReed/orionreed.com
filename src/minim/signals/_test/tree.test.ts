// tree.test.ts — TreeNode container + traversal helpers.
//
// The primitive itself is purely structural — it holds cells and
// provides traversal. The reactive behaviour (aggregate, propagate)
// lives in user code that wraps `TreeNode` with `Cls.lens` /
// `Cls.derive`. This test file covers the structural side.

import { describe, expect, it } from "vitest";
import { allNodes, atPath, isLeaf, leavesOf, nodeCount, treeNode, walkTree } from "../index";
import { Bool, bool } from "../values/bool";
import { num } from "../values/num";

// ─── node() constructor ──────────────────────────────────────────

describe("treeNode()", () => {
  it("leaf has no children by default", () => {
    const n = treeNode(num(1));
    expect(n.value.value).toBe(1);
    expect(n.children).toEqual([]);
  });

  it("internal node holds its child refs", () => {
    const a = treeNode(num(1));
    const b = treeNode(num(2));
    const parent = treeNode(num(0), [a, b]);
    expect(parent.children).toEqual([a, b]);
    expect(parent.children[0]).toBe(a);
    expect(parent.children[1]).toBe(b);
  });
});

// ─── walkTree ────────────────────────────────────────────────────

describe("walkTree", () => {
  it("visits all nodes depth-first", () => {
    const tree = treeNode(num(0), [
      treeNode(num(1), [treeNode(num(3)), treeNode(num(4))]),
      treeNode(num(2)),
    ]);
    const visited: number[] = [];
    walkTree(tree, n => visited.push(n.value.value));
    expect(visited).toEqual([0, 1, 3, 4, 2]);
  });

  it("threads depth correctly", () => {
    const tree = treeNode(num(0), [treeNode(num(1), [treeNode(num(2), [treeNode(num(3))])])]);
    const depths: Array<[number, number]> = [];
    walkTree(tree, (n, d) => depths.push([n.value.value, d]));
    expect(depths).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
  });

  it("threads path correctly", () => {
    const tree = treeNode(num(0), [
      treeNode(num(1), [treeNode(num(11)), treeNode(num(12))]),
      treeNode(num(2)),
    ]);
    const paths: Array<[number, readonly number[]]> = [];
    walkTree(tree, (n, _d, p) => paths.push([n.value.value, p]));
    expect(paths).toEqual([
      [0, []],
      [1, [0]],
      [11, [0, 0]],
      [12, [0, 1]],
      [2, [1]],
    ]);
  });
});

// ─── leavesOf / allNodes ──────────────────────────────────────────

describe("leavesOf", () => {
  it("returns only nodes with no children", () => {
    const a = treeNode(num(1));
    const b = treeNode(num(2));
    const c = treeNode(num(3));
    const tree = treeNode(num(0), [treeNode(num(10), [a, b]), c]);
    expect(leavesOf(tree)).toEqual([a, b, c]);
  });

  it("a single-node tree IS its own leaf", () => {
    const n = treeNode(num(42));
    expect(leavesOf(n)).toEqual([n]);
  });
});

describe("allNodes", () => {
  it("returns every node depth-first", () => {
    const tree = treeNode(num(0), [
      treeNode(num(1), [treeNode(num(11)), treeNode(num(12))]),
      treeNode(num(2)),
    ]);
    const vals = allNodes(tree).map(n => n.value.value);
    expect(vals).toEqual([0, 1, 11, 12, 2]);
  });
});

// ─── atPath ──────────────────────────────────────────────────────

describe("atPath", () => {
  it("empty path returns root", () => {
    const root = treeNode(num(0));
    expect(atPath(root, [])).toBe(root);
  });

  it("indexes children correctly", () => {
    const inner = treeNode(num(99));
    const tree = treeNode(num(0), [
      treeNode(num(1), [treeNode(num(11)), inner]),
      treeNode(num(2)),
    ]);
    expect(atPath(tree, [0, 1])).toBe(inner);
    expect(atPath(tree, [0, 1]).value.value).toBe(99);
  });
});

// ─── isLeaf / nodeCount ──────────────────────────────────────────

describe("isLeaf and nodeCount", () => {
  it("isLeaf is true for childless nodes only", () => {
    const a = treeNode(num(1));
    const b = treeNode(num(2), [a]);
    expect(isLeaf(a)).toBe(true);
    expect(isLeaf(b)).toBe(false);
  });

  it("nodeCount counts every node", () => {
    const tree = treeNode(num(0), [
      treeNode(num(1), [treeNode(num(11)), treeNode(num(12))]),
      treeNode(num(2)),
    ]);
    expect(nodeCount(tree)).toBe(5);
  });
});

// ─── Works across different cell types ──────────────────────────

describe("works across value-class cell types", () => {
  it("Tree<Bool>: leaves + traversal use the cell's value type", () => {
    const tree = treeNode(bool(false), [
      treeNode(bool(true)),
      treeNode(bool(false), [treeNode(bool(true))]),
    ]);
    const leafValues = leavesOf(tree).map(n => n.value.value);
    expect(leafValues).toEqual([true, true]);
  });

  it("structural cells are independent — writes don't cascade automatically", () => {
    // TreeNode is just a structural container. To get aggregate
    // behavior you'd wrap with Tri.allOf or similar. Without that,
    // writing a leaf doesn't change its siblings or ancestors.
    const a = bool(false);
    const b = bool(false);
    const root = bool(false);
    const tree = treeNode(root, [treeNode(a), treeNode(b)]);
    void tree;
    a.value = true;
    expect(b.value).toBe(false);
    expect(root.value).toBe(false);
  });
});

void Bool;
