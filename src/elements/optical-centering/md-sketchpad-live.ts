// md-sketchpad-live.ts — sketchpad with live add/remove of points and
// constraints.
//
// Two reactive collections drive the scene:
//
//   points:      Writable<Point[]>      — id, position, pinned flag
//   constraints: Writable<Constraint[]> — id, kind, Force, members
//
// `forEach(root, points, render)` and `forEach(root, constraints, render)`
// diff their respective signals on every write, mounting fresh shapes
// for new entries and disposing shapes for removed ones. The constraint
// solver is the same `Cluster` used by the static sketchpad — but the
// set of forces is now mutable: factories return `Force` handles whose
// `dispose()` deactivates them, and `cluster.update()` materialises
// the change before the next paint.
//
// Tool-mode dispatch: the active `tool` signal decides what each click
// does. Drags are universal — every point is always draggable.

import {
    type Constraints,
  constraints,
  distance,
  eq,
  pin,
  type Relation,
  rightAngle,
} from "@minim/constraints";
import {
  Anchor,
  type AnyShape,
  type Content,
  circle,
  computed,
  Diagram,
  drag,
  forEach,
  group,
  label,
  line,
  Mount,
  rect,
  type Signal,
  signal,
  type Val,
  type Vec,
  vec,
  type Writable,
} from "../../minim";

// ─── types ────────────────────────────────────────────────────────────

type ToolId = "point" | "distance" | "right-angle" | "horizontal" | "vertical" | "pin" | "delete";

interface PointInst {
  readonly id: number;
  readonly pos: Writable<Vec>;
  readonly pinned: Signal<boolean>;
}

interface ConstraintInst {
  readonly id: number;
  readonly kind: "distance" | "right-angle" | "horizontal" | "vertical";
  readonly force: Relation;
  readonly points: readonly PointInst[];
  readonly meta?: { rest?: number };
}

interface ToolSpec {
  id: ToolId;
  label: string;
  /** How many points the tool consumes per action; `0` = canvas-only. */
  picks: 0 | 1 | 2 | 3;
  hint: string;
}

const TOOLS: readonly ToolSpec[] = [
  { id: "point", label: "point", picks: 0, hint: "click empty canvas to add a point" },
  {
    id: "distance",
    label: "distance",
    picks: 2,
    hint: "click two points — locks current distance",
  },
  {
    id: "right-angle",
    label: "right ∠",
    picks: 3,
    hint: "click three points — middle one is the vertex",
  },
  { id: "horizontal", label: "horiz", picks: 2, hint: "click two points — locks A.y = B.y" },
  { id: "vertical", label: "vert", picks: 2, hint: "click two points — locks A.x = B.x" },
  { id: "pin", label: "pin", picks: 1, hint: "click a point to toggle pin" },
  { id: "delete", label: "delete", picks: 1, hint: "click point or constraint badge to remove" },
];

const TOOL_BY_ID = new Map(TOOLS.map(t => [t.id, t]));

// ─── layout ───────────────────────────────────────────────────────────

const W = 640;
const H = 500;
const PALETTE_Y = 12;
const PALETTE_H = 28;
const STATUS_Y = PALETTE_Y + PALETTE_H + 18;
const CANVAS_X = 16;
const CANVAS_Y = 70;
const CANVAS_W = W - 2 * CANVAS_X;
const CANVAS_H = 400;
const FOOTER_Y = H - 14;

const BTN_W = 64;
const BTN_GAP = 6;
const PALETTE_TOTAL = TOOLS.length * BTN_W + (TOOLS.length - 1) * BTN_GAP;
const PALETTE_X = (W - PALETTE_TOTAL) / 2;

const ACCENT = "#5b8def";
const ACCENT_TINT = "rgba(91, 141, 239, 0.12)";
const PIN_COLOR = "#f5a623";
const DELETE_COLOR = "#e25c5c";
const POINT_R = 7;

// ─── scene ────────────────────────────────────────────────────────────

export class MdSketchpadLive extends Diagram {
  protected scene(s: Mount): void {
    this.view(W, H);

    const cluster = constraints({ iterations: 24 });

    // Identity counters for stable forEach keys.
    let nextPointId = 1;
    let nextConstraintId = 1;

    const points = signal<readonly PointInst[]>([]);
    const constraintList = signal<readonly ConstraintInst[]>([]);
    const tool = signal<ToolId>("point");
    const selection = signal<readonly PointInst[]>([]);

    /** Status hint: per-tool default, or "pick i of N" mid-selection. */
    const status = computed<Content>(() => {
      const t = TOOL_BY_ID.get(tool.value)!;
      const sel = selection.value;
      if (t.picks >= 2 && sel.length > 0) return `pick ${sel.length + 1} of ${t.picks}`;
      return t.hint;
    });

    // ─── mutators ────────────────────────────────────────────────────

    const addPoint = (at: { x: number; y: number }): PointInst => {
      const p: PointInst = {
        id: nextPointId++,
        pos: vec(at.x, at.y),
        pinned: signal(false),
      };
      points.value = [...points.peek(), p];
      return p;
    };

    /** Remove a point and every constraint it participates in. */
    const removePoint = (p: PointInst): void => {
      const survivors: ConstraintInst[] = [];
      for (const c of constraintList.peek()) {
        if (c.points.includes(p)) cluster.remove(c.force);
        else survivors.push(c);
      }
      constraintList.value = survivors;
      points.value = points.peek().filter(q => q !== p);
    };

    const removeConstraint = (c: ConstraintInst): void => {
      cluster.remove(c.force);
      constraintList.value = constraintList.peek().filter(x => x !== c);
    };

    /** Build a constraint of the given kind from `picks`, taking the
     *  rest-distance snapshot for `distance`. Returns the new entry or
     *  `undefined` for degenerate picks (e.g. duplicate cells). */
    const makeConstraint = (
      kind: ConstraintInst["kind"],
      picks: readonly PointInst[],
    ): ConstraintInst | undefined => {
      const id = nextConstraintId++;
      switch (kind) {
        case "distance": {
          const [a, b] = picks;
          const av = a.pos.peek();
          const bv = b.pos.peek();
          const rest = Math.hypot(bv.x - av.x, bv.y - av.y);
          if (rest < 1) return undefined;
          const force = cluster.add(distance(a.pos, b.pos, rest));
          return { id, kind, force, points: picks, meta: { rest } };
        }
        case "right-angle": {
          const [a, b, c] = picks;
          const force = cluster.add(rightAngle(a.pos, b.pos, c.pos));
          return { id, kind, force, points: picks };
        }
        case "horizontal": {
          const [a, b] = picks;
          const force = cluster.add(eq((a.pos as Writable<Vec>).y, (b.pos as Writable<Vec>).y));
          return { id, kind, force, points: picks };
        }
        case "vertical": {
          const [a, b] = picks;
          const force = cluster.add(eq((a.pos as Writable<Vec>).x, (b.pos as Writable<Vec>).x));
          return { id, kind, force, points: picks };
        }
      }
    };

    /** Try to consume `selection` for the active multi-pick tool. */
    const tryFinalizeSelection = (): void => {
      const t = TOOL_BY_ID.get(tool.peek())!;
      if (t.picks < 2) return;
      const sel = selection.peek();
      if (sel.length < t.picks) return;
      const kind = t.id as ConstraintInst["kind"];
      const c = makeConstraint(kind, sel);
      if (c) {
        constraintList.value = [...constraintList.peek(), c];
      }
      selection.value = [];
    };

    /** Click on point `p` — dispatch by current tool. */
    const onPointClick = (p: PointInst): void => {
      const id = tool.peek();
      switch (id) {
        case "point":
          break;
        case "delete":
          removePoint(p);
          selection.value = [];
          break;
        case "pin":
          p.pinned.value = !p.pinned.peek();
          break;
        case "distance":
        case "right-angle":
        case "horizontal":
        case "vertical": {
          const sel = selection.peek();
          // Re-clicking a selected point unselects it (escape hatch).
          if (sel.includes(p)) {
            selection.value = sel.filter(q => q !== p);
            return;
          }
          selection.value = [...sel, p];
          tryFinalizeSelection();
          break;
        }
      }
    };

    /** Click on the empty canvas — add a point in `point` tool, else
     *  cancel any in-progress selection. */
    const onCanvasClick = (at: { x: number; y: number }): void => {
      if (tool.peek() === "point") {
        addPoint(at);
        return;
      }
      if (selection.peek().length > 0) selection.value = [];
    };

    // ─── canvas backdrop ────────────────────────────────────────────

    const backdrop = s(
      rect(CANVAS_X, CANVAS_Y, CANVAS_W, CANVAS_H, {
        fill: "var(--minim-canvas, #fafafa)",
        stroke: "var(--minim-canvas-edge, #ececec)",
        thin: true,
        corner: 4,
      }),
    );
    backdrop.el.style.cursor = "crosshair";
    backdrop.on("click", e => {
      const local = backdrop.toLocal(e as PointerEvent);
      onCanvasClick(local);
    });

    // ─── tool palette ───────────────────────────────────────────────

    TOOLS.forEach((t, i) => {
      const x = PALETTE_X + i * (BTN_W + BTN_GAP);
      const isActive = computed(() => tool.value === t.id);
      const btn = group(
        { translate: vec(x, PALETTE_Y) },
        rect(0, 0, BTN_W, PALETTE_H, {
          fill: computed(() => (isActive.value ? ACCENT_TINT : "transparent")),
          stroke: computed(() => (isActive.value ? ACCENT : "var(--text-color, #222)")),
          thin: true,
          corner: 4,
        }),
        label(vec(BTN_W / 2, PALETTE_H / 2 + 1), t.label, {
          size: 11,
          align: Anchor.Center,
          fill: computed(() => (isActive.value ? ACCENT : "var(--text-color, #222)")),
        }),
      );
      btn.el.style.cursor = "pointer";
      btn.on("click", e => {
        e.stopPropagation();
        if (tool.peek() !== t.id) selection.value = [];
        tool.value = t.id;
      });
      s(btn);
    });

    // Status text — always reflects the current pick state.
    s(
      label(vec(W / 2, STATUS_Y), status, {
        size: 12,
        align: Anchor.Center,
        opacity: 0.7,
      }),
    );

    // ─── constraint rendering ──────────────────────────────────────

    forEach(s.root, constraintList, c => renderConstraint(c, tool, removeConstraint), {
      key: c => c.id,
    });

    // ─── point rendering ────────────────────────────────────────────

    forEach(s.root, points, p => renderPoint(p, cluster, selection, onPointClick), {
      key: p => p.id,
    });

    // ─── seed scene ─────────────────────────────────────────────────
    // Two pre-placed points + one distance, just so an empty canvas
    // doesn't read as broken on first visit.
    const a = addPoint({ x: CANVAS_X + 140, y: CANVAS_Y + 200 });
    const b = addPoint({ x: CANVAS_X + 320, y: CANVAS_Y + 200 });
    const seed = makeConstraint("distance", [a, b]);
    if (seed) constraintList.value = [seed];

    // ─── footer ─────────────────────────────────────────────────────

    s(
      label(
        vec(W / 2, FOOTER_Y),
        "drag any point — solver re-projects · structure mutates live (forEach over signal<T[]>)",
        { size: 10, align: Anchor.Center, opacity: 0.5 },
      ),
    );
  }
}

// ─── per-point rendering ──────────────────────────────────────────────

function renderPoint(
  p: PointInst,
  cluster: Constraints,
  selection: Signal<readonly PointInst[]>,
  onClick: (p: PointInst) => void,
): AnyShape {
  // Selected when the current selection array references this point.
  const selected = computed(() => selection.value.includes(p));
  const fill = computed(() => (p.pinned.value ? PIN_COLOR : ACCENT));

  const dot = circle(p.pos, POINT_R, {
    fill,
    stroke: "var(--bg-color, white)",
    strokeWidth: 2,
  });

  // Selection ring — appears as a halo around the point when picked
  // mid-way through a multi-point tool.
  const ring = circle(p.pos, POINT_R + 5, {
    thin: true,
    stroke: ACCENT,
    opacity: computed(() => (selected.value ? 0.9 : 0)),
  });

  // Pin marker — small inner dot when pinned.
  const pinDot = circle(p.pos, 2, {
    fill: "white",
    opacity: computed(() => (p.pinned.value ? 1 : 0)),
  });

  // Drag is universal: every point can be dragged regardless of tool.
  // While the user is dragging a pinned point, the pin holds it fixed
  // in solver space; we additionally pin it in cluster space so the
  // drag is the explicit override (matches md-graph's idiom).
  dot.track(drag(dot, p.pos));

  // Cluster pin while pinned.
  cluster.addWhile(p.pinned, pin(p.pos));

  dot.el.style.cursor = "grab";

  // Click dispatches to the active tool. `click` (not pointerdown) so
  // drag gestures don't trigger a tool action — the browser only fires
  // `click` when pointerdown/up land within a few pixels.
  dot.on("click", e => {
    e.stopPropagation();
    onClick(p);
  });

  return group({ translate: vec(0, 0) }, ring, dot, pinDot);
}

// ─── per-constraint rendering ─────────────────────────────────────────

function renderConstraint(
  c: ConstraintInst,
  tool: Signal<ToolId>,
  onRemove: (c: ConstraintInst) => void,
): AnyShape {
  switch (c.kind) {
    case "distance":
      return distanceShape(c, tool, onRemove);
    case "horizontal":
      return axisShape(c, tool, onRemove, "horizontal");
    case "vertical":
      return axisShape(c, tool, onRemove, "vertical");
    case "right-angle":
      return rightAngleShape(c, tool, onRemove);
  }
}

/** Distance — solid line + tiny midpoint badge (delete target). */
function distanceShape(
  c: ConstraintInst,
  tool: Signal<ToolId>,
  onRemove: (c: ConstraintInst) => void,
): AnyShape {
  const [a, b] = c.points;
  const mid = computed(() => {
    const av = a.pos.value;
    const bv = b.pos.value;
    return { x: (av.x + bv.x) / 2, y: (av.y + bv.y) / 2 };
  });

  const ln = line(a.pos, b.pos, { thin: true, opacity: 0.55 });
  const badge = badgeMarker(mid, "·", "var(--text-color, #222)", c, tool, onRemove);
  return group({ translate: vec(0, 0) }, ln, badge);
}

/** Horizontal / vertical — dashed guide line + arrow glyph badge. */
function axisShape(
  c: ConstraintInst,
  tool: Signal<ToolId>,
  onRemove: (c: ConstraintInst) => void,
  axis: "horizontal" | "vertical",
): AnyShape {
  const [a, b] = c.points;
  const mid = computed(() => {
    const av = a.pos.value;
    const bv = b.pos.value;
    return { x: (av.x + bv.x) / 2, y: (av.y + bv.y) / 2 };
  });

  const ln = line(a.pos, b.pos, {
    thin: true,
    dashed: true,
    opacity: 0.4,
    stroke: ACCENT,
  });
  const glyph = axis === "horizontal" ? "↔" : "↕";
  const badge = badgeMarker(mid, glyph, ACCENT, c, tool, onRemove);
  return group({ translate: vec(0, 0) }, ln, badge);
}

/** Right-angle — small square at the vertex, oriented along the
 *  bisector of the two outgoing edges. Filled badge IS the click
 *  target for delete-mode. */
function rightAngleShape(
  c: ConstraintInst,
  tool: Signal<ToolId>,
  onRemove: (c: ConstraintInst) => void,
): AnyShape {
  const [, B] = c.points;
  const badge = badgeMarker(B.pos, "⌐", DELETE_COLOR, c, tool, onRemove, 13);
  return group({ translate: vec(0, 0) }, badge);
}

/** Tiny clickable badge with a glyph. Hit area expands in delete mode
 *  and the visual punch increases so the click target is obvious. */
function badgeMarker(
  pos: Val<{ x: number; y: number }>,
  glyph: string,
  color: string,
  c: ConstraintInst,
  tool: Signal<ToolId>,
  onRemove: (c: ConstraintInst) => void,
  size = 11,
): AnyShape {
  const isDelete = computed(() => tool.value === "delete");
  const fill = computed(() => (isDelete.value ? DELETE_COLOR : "var(--bg-color, white)"));
  const opacity = computed(() => (isDelete.value ? 1 : 0.85));
  const r = computed(() => (isDelete.value ? 9 : 6));

  const badge = group(
    { translate: pos },
    circle(vec(0, 0), r, {
      fill,
      stroke: color,
      thin: true,
      opacity,
    }),
    label(vec(0, 0.5), glyph, {
      size,
      align: Anchor.Center,
      fill: computed(() => (isDelete.value ? "white" : color)),
    }),
  );

  badge.el.style.cursor = "pointer";
  badge.on("click", e => {
    e.stopPropagation();
    if (tool.peek() === "delete") onRemove(c);
  });
  return badge;
}
