// md-prop-types.ts — Hindley-Milner-style type inference, animated.
//
// The pitch: type inference is set narrowing on a structured lattice.
// Same machinery as the sudoku solver, applied to lambda calculus.
//
// Each AST node carries a `TypeNode` — a `SetCell<Tag>` plus
// optional child cells for function types. Constraints emit
// propagators:
//
//   literal n         → narrowTo(t, "int")
//   x + y             → narrowTo(left, "int"), narrowTo(right, "int"),
//                       narrowTo(result, "int")
//   λx. body          → narrowTo(t, "fn"); unify(t.dom, x_binding);
//                       unify(t.cod, body_t)
//   f arg             → narrowTo(f_t, "fn"); unify(f_t.dom, arg_t);
//                       unify(f_t.cod, result_t)
//   var x             → unify(t, x_binding)
//
// The network runs in MANUAL mode; one wave per ~0.45s lets you
// watch the type sets shrink across the AST. When two narrowings
// force a cell to ∅, the contradiction bubbles up — that's a type
// error, rendered red.

import { propagator, propagators, type SetCell } from "@minim/propagators";
import { Diagram, label, line, loop, Mount, rect, signal, vec } from "../../minim";

// ─── Type language ─────────────────────────────────────────────────

type Tag = "int" | "str" | "bool" | "fn";
const ALL_TAGS: ReadonlySet<Tag> = new Set<Tag>(["int", "str", "bool", "fn"]);

const eqTagSet = (a: ReadonlySet<Tag>, b: ReadonlySet<Tag>): boolean => {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
};

const tagCell = (init: Iterable<Tag>): SetCell<Tag> =>
  signal<ReadonlySet<Tag>>(new Set(init), { equals: eqTagSet });

interface TypeNode {
  tag: SetCell<Tag>;
  dom?: TypeNode;
  cod?: TypeNode;
}

const TYPE_DEPTH = 3;

function makeTypeFactory() {
  const allTypes: TypeNode[] = [];
  function make(depth = TYPE_DEPTH): TypeNode {
    const t: TypeNode = { tag: tagCell(ALL_TAGS) };
    allTypes.push(t);
    if (depth > 0) {
      t.dom = make(depth - 1);
      t.cod = make(depth - 1);
    }
    return t;
  }
  return { make, allTypes };
}

function intersect<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): Set<T> {
  const out = new Set<T>();
  for (const v of a) if (b.has(v)) out.add(v);
  return out;
}

// ─── Constraints as propagators ────────────────────────────────────

/** Narrow `t.tag` toward {tag}. If tag isn't in the cell, write ∅
 *  (contradiction). Self-reading propagator — fires whenever the
 *  cell changes; converges immediately to a fixed point. */
function narrowTo(t: TypeNode, tag: Tag) {
  return propagator([t.tag], [t.tag], () => {
    const v = t.tag.value;
    if (v.size === 1 && v.has(tag)) return;
    if (!v.has(tag)) {
      if (v.size === 0) return;
      t.tag.value = new Set();
      return;
    }
    t.tag.value = new Set([tag]);
  });
}

/** Symmetric unification: tags intersect both directions, and dom /
 *  cod sub-cells recursively unify when both nodes have them. */
function unify(a: TypeNode, b: TypeNode) {
  const props = [
    propagator([a.tag], [b.tag], () => {
      const next = intersect(a.tag.value, b.tag.value);
      if (!eqTagSet(next, b.tag.value)) b.tag.value = next;
    }),
    propagator([b.tag], [a.tag], () => {
      const next = intersect(a.tag.value, b.tag.value);
      if (!eqTagSet(next, a.tag.value)) a.tag.value = next;
    }),
  ];
  if (a.dom && b.dom) props.push(...unify(a.dom, b.dom));
  if (a.cod && b.cod) props.push(...unify(a.cod, b.cod));
  return props;
}

// ─── AST + inference walk ──────────────────────────────────────────

type Expr =
  | { kind: "int"; value: number }
  | { kind: "str"; value: string }
  | { kind: "var"; name: string }
  | { kind: "lam"; param: string; body: Expr }
  | { kind: "app"; fn: Expr; arg: Expr }
  | { kind: "plus"; left: Expr; right: Expr };

const Int = (v: number): Expr => ({ kind: "int", value: v });
const Str = (v: string): Expr => ({ kind: "str", value: v });
const V = (name: string): Expr => ({ kind: "var", name });
const Lam = (param: string, body: Expr): Expr => ({ kind: "lam", param, body });
const App = (fn: Expr, arg: Expr): Expr => ({ kind: "app", fn, arg });
const Plus = (left: Expr, right: Expr): Expr => ({ kind: "plus", left, right });

function childrenOf(e: Expr): Expr[] {
  switch (e.kind) {
    case "int":
    case "str":
    case "var":
      return [];
    case "lam":
      return [e.body];
    case "app":
      return [e.fn, e.arg];
    case "plus":
      return [e.left, e.right];
  }
}

interface Inference {
  rootType: TypeNode;
  allTypes: TypeNode[];
  annotations: Map<Expr, TypeNode>;
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous
  props: any[];
}

function infer(expr: Expr): Inference {
  const { make, allTypes } = makeTypeFactory();
  const annotations = new Map<Expr, TypeNode>();
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous propagator output
  const props: any[] = [];
  const scope = new Map<string, TypeNode>();

  function walk(e: Expr): TypeNode {
    const t = make();
    annotations.set(e, t);
    switch (e.kind) {
      case "int":
        props.push(narrowTo(t, "int"));
        break;
      case "str":
        props.push(narrowTo(t, "str"));
        break;
      case "var": {
        const binding = scope.get(e.name);
        if (binding) props.push(...unify(t, binding));
        break;
      }
      case "lam": {
        props.push(narrowTo(t, "fn"));
        const paramT = make();
        scope.set(e.param, paramT);
        const bodyT = walk(e.body);
        scope.delete(e.param);
        if (t.dom) props.push(...unify(t.dom, paramT));
        if (t.cod) props.push(...unify(t.cod, bodyT));
        break;
      }
      case "app": {
        const fnT = walk(e.fn);
        const argT = walk(e.arg);
        props.push(narrowTo(fnT, "fn"));
        if (fnT.dom) props.push(...unify(fnT.dom, argT));
        if (fnT.cod) props.push(...unify(fnT.cod, t));
        break;
      }
      case "plus": {
        const lT = walk(e.left);
        const rT = walk(e.right);
        props.push(narrowTo(lT, "int"));
        props.push(narrowTo(rT, "int"));
        props.push(narrowTo(t, "int"));
        break;
      }
    }
    return t;
  }

  const rootType = walk(expr);
  return { rootType, allTypes, annotations, props };
}

// ─── Display helpers ───────────────────────────────────────────────

function showType(t: TypeNode | undefined): string {
  if (!t) return "?";
  const v = t.tag.value;
  if (v.size === 0) return "⊥";
  if (v.size > 1) return `{${[...v].map(x => x[0]!.toUpperCase()).join("")}}`;
  const tag = [...v][0]!;
  if (tag === "int") return "Int";
  if (tag === "str") return "Str";
  if (tag === "bool") return "Bool";
  return `${showType(t.dom)} → ${showType(t.cod)}`;
}

function cellStatus(t: TypeNode): "solved" | "narrowing" | "error" {
  const v = t.tag.value;
  if (v.size === 0) return "error";
  if (v.size > 1) return "narrowing";
  const tag = [...v][0]!;
  if (tag !== "fn") return "solved";
  if (!t.dom || !t.cod) return "narrowing";
  const d = cellStatus(t.dom);
  const c = cellStatus(t.cod);
  if (d === "error" || c === "error") return "error";
  if (d === "solved" && c === "solved") return "solved";
  return "narrowing";
}

function nodeLabel(e: Expr): string {
  switch (e.kind) {
    case "int":
      return `${e.value}`;
    case "str":
      return `"${e.value}"`;
    case "var":
      return e.name;
    case "lam":
      return `λ${e.param}`;
    case "app":
      return "@";
    case "plus":
      return "+";
  }
}

function prettyExpr(e: Expr, parens = false): string {
  switch (e.kind) {
    case "int":
      return `${e.value}`;
    case "str":
      return `"${e.value}"`;
    case "var":
      return e.name;
    case "lam": {
      const s = `λ${e.param}. ${prettyExpr(e.body)}`;
      return parens ? `(${s})` : s;
    }
    case "app":
      return `${prettyExpr(e.fn, e.fn.kind === "lam")} ${prettyExpr(e.arg, e.arg.kind === "plus" || e.arg.kind === "lam")}`;
    case "plus": {
      const s = `${prettyExpr(e.left, e.left.kind === "lam")} + ${prettyExpr(e.right, e.right.kind === "lam")}`;
      return parens ? `(${s})` : s;
    }
  }
}

// ─── AST tree layout ───────────────────────────────────────────────

const CELL_W = 72;
const CELL_H = 36;
const H_GAP = 18;
const V_GAP = 64;

interface NodeLayout {
  node: Expr;
  x: number;
  y: number;
  subtreeWidth: number;
  children: NodeLayout[];
}

function computeLayout(expr: Expr, y: number): NodeLayout {
  const kids = childrenOf(expr).map(c => computeLayout(c, y + V_GAP));
  const subWidth =
    kids.length === 0
      ? CELL_W
      : kids.reduce((s, k) => s + k.subtreeWidth, 0) + (kids.length - 1) * H_GAP;
  return { node: expr, x: 0, y, subtreeWidth: Math.max(CELL_W, subWidth), children: kids };
}

function placeLayout(layout: NodeLayout, leftX: number): void {
  layout.x = leftX + layout.subtreeWidth / 2;
  let cursor = leftX;
  for (const c of layout.children) {
    placeLayout(c, cursor);
    cursor += c.subtreeWidth + H_GAP;
  }
}

function* walkLayout(layout: NodeLayout): Generator<NodeLayout> {
  yield layout;
  for (const c of layout.children) yield* walkLayout(c);
}

// ─── Demo ──────────────────────────────────────────────────────────

const EXPRESSIONS: Expr[] = [
  // 1) Trivial — warm-up.
  Plus(Int(1), Int(2)),
  // 2) Polymorphic identity. (λx. x) "hello" infers x : Str, result : Str.
  App(Lam("x", V("x")), Str("hello")),
  // 3) Lambda application. (λx. x + 1) 5 infers x : Int → Int → Int.
  App(Lam("x", Plus(V("x"), Int(1))), Int(5)),
  // 4) Type ERROR. (λx. x + 1) "hi" — x is forced Int by + AND Str by app.
  App(Lam("x", Plus(V("x"), Int(1))), Str("hi")),
];

const TITLES = [
  "warm-up · all cells narrow to Int",
  "polymorphism · x's type follows the argument",
  "lambda · body forces x : Int via the + constraint",
  "type error · x can't be both Int (from +) and Str (from app)",
];

const SOLVED_COLOR = "#5b8def";
const NARROWING_COLOR = "var(--text-muted, #888)";
const ERROR_COLOR = "#e25c5c";
const CARD_BG = "var(--bg-color, white)";

export class MdPropTypes extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(720, 480);
    const { x: cx, y: cy } = view.center.value;

    // Pre-build each expression. They coexist; visibility gates which
    // is on screen this cycle.
    const current = signal(0);
    const stepCount = signal(0);

    const stages = EXPRESSIONS.map((expr, exprIdx) => {
      const inf = infer(expr);
      const net = propagators({ manual: true }).add(...inf.props);

      // Layout: tree centered at view-center horizontally, top at y0.
      const layout = computeLayout(expr, 0);
      placeLayout(layout, 0);
      const treeOffsetX = cx - layout.subtreeWidth / 2;
      // Root sits ~90px below the top of the view (below the title /
      // status bar); tree drops down from there.
      const treeTop = 90;
      // Offset every node by (treeOffsetX, treeTop).
      for (const n of walkLayout(layout)) {
        n.x += treeOffsetX;
        n.y += treeTop;
      }

      const visible = signal(exprIdx === 0);
      const opacity = () => (visible.value ? 1 : 0);

      // Render each AST node as a small card: label + type below.
      for (const n of walkLayout(layout)) {
        const t = inf.annotations.get(n.node)!;
        const colorFor = (): string => {
          const st = cellStatus(t);
          if (st === "error") return ERROR_COLOR;
          if (st === "solved") return SOLVED_COLOR;
          return NARROWING_COLOR;
        };

        // Card backing.
        s(
          rect(n.x - CELL_W / 2, n.y - CELL_H / 2, CELL_W, CELL_H, {
            fill: CARD_BG,
            stroke: () => (cellStatus(t) === "error" ? ERROR_COLOR : "#aaa"),
            thin: true,
            corner: 6,
            opacity,
          }),
          // Node label (top half).
          label(vec(n.x, n.y - 5), nodeLabel(n.node), {
            size: 13,
            bold: true,
            opacity,
          }),
          // Type display (bottom half).
          label(vec(n.x, n.y + 11), () => showType(t), {
            size: 10,
            fill: colorFor,
            opacity,
          }),
        );

        // Edges to children.
        for (const c of n.children) {
          s(
            line(
              vec(n.x, n.y + CELL_H / 2),
              vec(c.x, c.y - CELL_H / 2),
              { stroke: "#bbb", thin: true, opacity },
            ),
          );
        }
      }

      return { inf, net, visible, layout };
    });

    // Title bar: expression + inferred result + flavor text.
    s(
      label(view.top.down(20), () => {
        const i = current.value;
        return `${prettyExpr(EXPRESSIONS[i]!)}`;
      }, { size: 16, bold: true }),
      label(view.top.down(44), () => {
        const i = current.value;
        const root = stages[i]!.inf.rootType;
        const status = cellStatus(root);
        if (status === "error") return `▸ type error · cannot infer a consistent type`;
        if (status === "solved") return `▸ inferred · ${showType(root)}`;
        return `▸ narrowing · wave ${stepCount.value}`;
      }, {
        size: 12,
        fill: () => {
          const i = current.value;
          const status = cellStatus(stages[i]!.inf.rootType);
          if (status === "error") return ERROR_COLOR;
          if (status === "solved") return SOLVED_COLOR;
          return NARROWING_COLOR;
        },
      }),
      label(view.bottom.up(14), () => TITLES[current.value]!, { size: 10 }),
    );

    // ─── Animation: cycle expressions, animate narrowing ──────────
    const totalTags = (allTypes: TypeNode[]): number =>
      allTypes.reduce((acc, t) => acc + t.tag.value.size, 0);
    const hasError = (allTypes: TypeNode[]): boolean =>
      allTypes.some(t => t.tag.value.size === 0);

    this.anim.start(
      loop(function* () {
        for (let i = 0; i < stages.length; i++) {
          // Hide all, show this one.
          for (let j = 0; j < stages.length; j++) stages[j]!.visible.value = j === i;
          current.value = i;

          // Reset all cells in this stage to ALL_TAGS.
          for (const t of stages[i]!.inf.allTypes) t.tag.value = ALL_TAGS;
          stepCount.value = 0;

          // Show initial state briefly.
          yield 0.6;

          // Step until stable or error.
          let prev = totalTags(stages[i]!.inf.allTypes);
          while (prev > stages[i]!.inf.allTypes.length && !hasError(stages[i]!.inf.allTypes)) {
            yield 0.45;
            stages[i]!.net.step(1);
            stepCount.value++;
            const cur = totalTags(stages[i]!.inf.allTypes);
            if (cur === prev) break;
            prev = cur;
          }

          // Hold the result.
          yield hasError(stages[i]!.inf.allTypes) ? 2.5 : 1.6;
        }
      }),
    );
  }
}
