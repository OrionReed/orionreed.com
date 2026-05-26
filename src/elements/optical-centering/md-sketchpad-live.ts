// md-sketchpad-live.ts — CAD-style live sketchpad.
//
// Selection-first model. Bare click replaces selection, shift-click
// adds, alt-click removes, click on empty canvas clears. Two
// creation tools (`+ pt`, `/ line`) toggle on/off; clicking the
// active tool button deactivates it. Constraint actions live in a
// second toolbar row whose buttons enable based on the current
// selection's shape — `[2 points]`, `[1 line]`, `[1 point, 1 line]`,
// `[3 points]`, etc. — and apply to the live selection.
//
// Three reactive primitive collections drive the scene:
//
//   points:      Writable<Point[]>            — id, pos, pinned flag
//   lines:       Writable<Line[]>             — id + two Point refs
//   constraints: Writable<Constraint[]>       — id, action, Relation, deps
//
// `forEach(root, signal, render, {key})` diffs each list on every
// write, so add/remove of any kind shows up immediately. Cascade
// rules: deleting a point disposes lines that touch it AND any
// constraint that references either; deleting a line disposes its
// constraints; deleting a constraint just removes its relation
// from the cluster.
//
// Every action is a single `ActionSpec`: `match(selection)` decides
// applicability and returns the ordered entity list, `apply(ents)`
// builds and returns the underlying `Relation`. Adding a new
// constraint shape = appending one entry to the `ACTIONS` array.

import {
  type Constraints,
  collinear,
  constraints,
  distance,
  eq,
  equalDist,
  midpoint as midpointRel,
  parallel,
  perpendicular,
  pin,
  type Relation,
  rightAngle,
} from "@minim/constraints";
import {
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

// ─── entity types ────────────────────────────────────────────────────

interface Point {
  readonly kind: "point";
  readonly id: number;
  readonly pos: Writable<Vec>;
  readonly pinned: Writable<Signal<boolean>>;
  readonly dragging: Writable<Signal<boolean>>;
  /** Disposers fired when the point is removed (currently the pin
   *  `addWhile` lifecycle). Lets us cleanly tear down per-point
   *  cluster bindings on delete. */
  readonly disposers: (() => void)[];
}

interface Line {
  readonly kind: "line";
  readonly id: number;
  readonly a: Point;
  readonly b: Point;
}

type Entity = Point | Line;
type EntKind = Entity["kind"];

interface Constraint {
  readonly id: number;
  readonly action: ActionId;
  readonly relation: Relation;
  readonly entities: readonly Entity[];
}

// ─── action ids ──────────────────────────────────────────────────────

type ActionId =
  | "coincide"
  | "horizontal"
  | "vertical"
  | "distance"
  | "right-angle"
  | "midpoint"
  | "parallel"
  | "perpendicular"
  | "equal-length"
  | "collinear";

type CreationTool = "point" | "line" | null;

// ─── action specs ────────────────────────────────────────────────────
//
// Each spec describes how a constraint binds to a selection. `match`
// inspects the selection (order matters — first pick is `entities[0]`)
// and returns the ordered entity list to pass into `apply`, or
// `undefined` if the spec doesn't apply.

interface ActionSpec {
  readonly id: ActionId;
  readonly label: string;
  readonly hint: string;
  readonly match: (sel: readonly Entity[]) => readonly Entity[] | undefined;
  readonly apply: (ents: readonly Entity[]) => Relation;
}

/** Strict ordered match: `sel.length == kinds.length`, types align by index. */
function ordered(sel: readonly Entity[], kinds: readonly EntKind[]): readonly Entity[] | undefined {
  if (sel.length !== kinds.length) return undefined;
  for (let i = 0; i < kinds.length; i++) if (sel[i].kind !== kinds[i]) return undefined;
  return sel;
}

const ACTIONS: readonly ActionSpec[] = [
  {
    id: "coincide",
    label: "≡",
    hint: "merge two points (eq on Vec)",
    match: s => ordered(s, ["point", "point"]),
    apply: ([a, b]) => eq((a as Point).pos, (b as Point).pos),
  },
  {
    id: "horizontal",
    label: "horiz",
    hint: "horizontal: 2 points · 1 line",
    match: s => ordered(s, ["point", "point"]) ?? ordered(s, ["line"]),
    apply: ents => {
      const [a, b] = endpoints(ents);
      return eq(a.pos.y, b.pos.y);
    },
  },
  {
    id: "vertical",
    label: "vert",
    hint: "vertical: 2 points · 1 line",
    match: s => ordered(s, ["point", "point"]) ?? ordered(s, ["line"]),
    apply: ents => {
      const [a, b] = endpoints(ents);
      return eq(a.pos.x, b.pos.x);
    },
  },
  {
    id: "distance",
    label: "dist",
    hint: "lock distance: 2 points · 1 line",
    match: s => ordered(s, ["point", "point"]) ?? ordered(s, ["line"]),
    apply: ents => {
      const [a, b] = endpoints(ents);
      const av = a.pos.peek();
      const bv = b.pos.peek();
      const rest = Math.max(1, Math.hypot(bv.x - av.x, bv.y - av.y));
      return distance(a.pos, b.pos, rest);
    },
  },
  {
    id: "right-angle",
    label: "90°",
    hint: "right angle (3 points · vertex = 2nd pick)",
    match: s => ordered(s, ["point", "point", "point"]),
    apply: ([a, b, cc]) => rightAngle((a as Point).pos, (b as Point).pos, (cc as Point).pos),
  },
  {
    id: "midpoint",
    label: "mid",
    hint: "midpoint (3 points · 1st = midpoint of 2nd–3rd)",
    match: s => ordered(s, ["point", "point", "point"]),
    apply: ([m, a, b]) => midpointRel((m as Point).pos, (a as Point).pos, (b as Point).pos),
  },
  {
    id: "parallel",
    label: "∥",
    hint: "parallel (2 lines)",
    match: s => ordered(s, ["line", "line"]),
    apply: ([l1, l2]) => parallel(...lineCells(l1 as Line, l2 as Line)),
  },
  {
    id: "perpendicular",
    label: "⊥",
    hint: "perpendicular (2 lines)",
    match: s => ordered(s, ["line", "line"]),
    apply: ([l1, l2]) => perpendicular(...lineCells(l1 as Line, l2 as Line)),
  },
  {
    id: "equal-length",
    label: "= len",
    hint: "equal length (2 lines)",
    match: s => ordered(s, ["line", "line"]),
    apply: ([l1, l2]) => equalDist(...lineCells(l1 as Line, l2 as Line)),
  },
  {
    id: "collinear",
    label: "on line",
    hint: "point on line (1 point + 1 line)",
    match: s => ordered(s, ["point", "line"]) ?? ordered(s, ["line", "point"]),
    apply: ents => {
      const p = (ents.find(e => e.kind === "point") as Point).pos;
      const ln = ents.find(e => e.kind === "line") as Line;
      return collinear(p, ln.a.pos, ln.b.pos);
    },
  },
];

const ACTION_BY_ID = new Map(ACTIONS.map(a => [a.id, a]));

/** Extract two endpoint Points from a `[P, P]` or `[L]` selection. */
function endpoints(ents: readonly Entity[]): readonly [Point, Point] {
  if (ents.length === 1) {
    const l = ents[0] as Line;
    return [l.a, l.b];
  }
  return [ents[0] as Point, ents[1] as Point];
}

/** Spread the 4 endpoint pos signals of two lines for `parallel`/`perpendicular`/`equalDist`. */
function lineCells(l1: Line, l2: Line) {
  return [l1.a.pos, l1.b.pos, l2.a.pos, l2.b.pos] as const;
}

// ─── layout ──────────────────────────────────────────────────────────

const W = 700;
const H = 540;
const PALETTE_Y = 12;
const PALETTE_H = 26;
const ACTIONS_Y = PALETTE_Y + PALETTE_H + 10;
const STATUS_Y = ACTIONS_Y + PALETTE_H + 16;
const CANVAS_X = 16;
const CANVAS_Y = 90;
const CANVAS_W = W - 2 * CANVAS_X;
const CANVAS_H = 410;
const FOOTER_Y = H - 14;

const ACCENT = "#5b8def";
const ACCENT_TINT = "rgba(91, 141, 239, 0.10)";
const SELECTED = "#e25c5c";
const SELECTED_TINT = "rgba(226, 92, 92, 0.18)";
const PIN_COLOR = "#f5a623";
const POINT_R = 6;
const POINT_HIT_R = 13;
const LINE_HIT_W = 14;
const BADGE_R = 8;
const BADGE_OFFSET = 18;

// ─── scene ───────────────────────────────────────────────────────────

export class MdSketchpadLive extends Diagram {
  protected scene(s: Mount): void {
    this.view(W, H);
    const cluster = constraints({ iterations: 24 });

    // Fresh ids per element — stable forEach keys across mutations.
    let nextPointId = 1;
    let nextLineId = 1;
    let nextConstraintId = 1;

    const points = signal<readonly Point[]>([]);
    const lines = signal<readonly Line[]>([]);
    const constraintList = signal<readonly Constraint[]>([]);
    const tool = signal<CreationTool>(null);
    const selection = signal<readonly Entity[]>([]);
    /** First endpoint of an in-progress `line` tool placement. */
    const linePending = signal<Point | null>(null);

    // ─── mutators ────────────────────────────────────────────────────

    const addPoint = (at: { x: number; y: number }): Point => {
      const p: Point = {
        kind: "point",
        id: nextPointId++,
        pos: vec(at.x, at.y),
        pinned: signal(false),
        dragging: signal(false),
        disposers: [],
      };
      // Pin while pinned-toggle is on OR the user is actively dragging
      // the point. Single relation, single derived condition, so the
      // mass save/restore stays consistent.
      const fixed = computed(() => p.pinned.value || p.dragging.value);
      const pinLc = cluster.addWhile(fixed, pin(p.pos));
      p.disposers.push(() => pinLc.dispose());
      points.value = [...points.peek(), p];
      return p;
    };

    const addLine = (a: Point, b: Point): Line | undefined => {
      if (a === b) return undefined;
      // Reject duplicate undirected line.
      const dup = lines.peek().find(l => (l.a === a && l.b === b) || (l.a === b && l.b === a));
      if (dup) return dup;
      const l: Line = { kind: "line", id: nextLineId++, a, b };
      lines.value = [...lines.peek(), l];
      return l;
    };

    /** Remove a constraint's relation and entry. */
    const removeConstraint = (c: Constraint): void => {
      cluster.remove(c.relation);
      constraintList.value = constraintList.peek().filter(x => x !== c);
    };

    /** Remove a line and any constraint that referenced it. */
    const removeLine = (l: Line): void => {
      const survivors: Constraint[] = [];
      for (const c of constraintList.peek()) {
        if (c.entities.includes(l)) cluster.remove(c.relation);
        else survivors.push(c);
      }
      constraintList.value = survivors;
      lines.value = lines.peek().filter(x => x !== l);
    };

    /** Remove a point, every line touching it, and every constraint
     *  that references either (transitively). */
    const removePoint = (p: Point): void => {
      const droppedLines = lines.peek().filter(l => l.a === p || l.b === p);
      const droppedSet = new Set<Entity>([p, ...droppedLines]);
      const survivors: Constraint[] = [];
      for (const c of constraintList.peek()) {
        if (c.entities.some(e => droppedSet.has(e))) cluster.remove(c.relation);
        else survivors.push(c);
      }
      constraintList.value = survivors;
      lines.value = lines.peek().filter(l => !droppedSet.has(l));
      points.value = points.peek().filter(q => q !== p);
      for (const d of p.disposers) d();
    };

    const removeEntity = (e: Entity): void => {
      if (e.kind === "point") removePoint(e);
      else removeLine(e);
    };

    /** Apply the action to the current selection, if it matches.
     *  Clears selection on success so the user can chain. */
    const applyAction = (id: ActionId): void => {
      const spec = ACTION_BY_ID.get(id);
      if (!spec) return;
      const sel = selection.peek();
      const ents = spec.match(sel);
      if (!ents) return;
      const relation = spec.apply(ents);
      cluster.add(relation);
      const c: Constraint = {
        id: nextConstraintId++,
        action: id,
        relation,
        entities: ents.slice(),
      };
      constraintList.value = [...constraintList.peek(), c];
      selection.value = [];
    };

    // ─── selection helpers ───────────────────────────────────────────

    /** Click-to-select with shift/alt modifiers. */
    const onEntityClick = (e: Entity, evt: PointerEvent): void => {
      const t = tool.peek();
      if (t === "point") return; // creation tool consumes; canvas handler runs
      if (t === "line") {
        if (e.kind !== "point") return;
        consumeLineClick(e);
        return;
      }
      const sel = selection.peek();
      if (evt.altKey) {
        selection.value = sel.filter(x => x !== e);
      } else if (evt.shiftKey) {
        if (sel.includes(e)) selection.value = sel.filter(x => x !== e);
        else selection.value = [...sel, e];
      } else {
        selection.value = sel.length === 1 && sel[0] === e ? [] : [e];
      }
    };

    const onCanvasClick = (at: { x: number; y: number }): void => {
      const t = tool.peek();
      if (t === "point") {
        addPoint(at);
        return;
      }
      if (t === "line") {
        consumeLineClick(addPoint(at));
        return;
      }
      // Bare click on empty canvas → clear selection.
      if (selection.peek().length > 0) selection.value = [];
    };

    /** Advance the line-creation state machine by one click. */
    const consumeLineClick = (p: Point): void => {
      const start = linePending.peek();
      if (!start) {
        linePending.value = p;
        return;
      }
      addLine(start, p);
      linePending.value = null;
    };

    // Tool button click — toggle off if clicking the active tool.
    const setTool = (t: CreationTool): void => {
      const cur = tool.peek();
      tool.value = cur === t ? null : t;
      linePending.value = null;
      selection.value = [];
    };

    // Keyboard: Escape cancels, Delete removes selection.
    const host = this;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        if (linePending.peek()) linePending.value = null;
        else if (tool.peek() !== null) tool.value = null;
        else selection.value = [];
        e.preventDefault();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        const sel = selection.peek();
        if (sel.length === 0) return;
        for (const ent of sel) removeEntity(ent);
        selection.value = [];
        e.preventDefault();
      }
    };
    host.addEventListener("keydown", onKey);
    host.tabIndex = 0;
    host.style.outline = "none";
    // Focus on pointer enter so keys dispatch without a manual click.
    const onEnter = () => host.focus({ preventScroll: true });
    host.addEventListener("pointerenter", onEnter);
    this.root.track(() => {
      host.removeEventListener("keydown", onKey);
      host.removeEventListener("pointerenter", onEnter);
    });

    // ─── canvas backdrop ─────────────────────────────────────────────

    const backdrop = s(
      rect(CANVAS_X, CANVAS_Y, CANVAS_W, CANVAS_H, {
        fill: "var(--minim-canvas, #fafafa)",
        stroke: "var(--minim-canvas-edge, #ececec)",
        thin: true,
        corner: 4,
      }),
    );
    backdrop.effect(() => {
      const t = tool.value;
      backdrop.el.style.cursor = t === null ? "default" : "crosshair";
    });
    backdrop.on("click", e => {
      const local = backdrop.toLocal(e as PointerEvent);
      onCanvasClick(local);
    });

    // ─── creation-tool palette ───────────────────────────────────────

    const creationTools: { id: CreationTool; label: string }[] = [
      { id: null, label: "select" },
      { id: "point", label: "+ pt" },
      { id: "line", label: "/ line" },
    ];
    layoutRow(creationTools, 70, 8, (item, x) => {
      const isActive = computed(() => tool.value === item.id);
      s(toolBtn(vec(x, PALETTE_Y), item.label, isActive, () => setTool(item.id), 70));
    });

    // ─── constraint-action palette ───────────────────────────────────

    const enabledFor = (a: ActionSpec) => computed(() => a.match(selection.value) !== undefined);
    layoutRow(ACTIONS, 56, 4, (item, x) => {
      const enabled = enabledFor(item);
      s(actionBtn(vec(x, ACTIONS_Y), item.label, enabled, () => applyAction(item.id), 56));
    });

    // ─── status text ─────────────────────────────────────────────────

    const status = computed<Content>(() => {
      const t = tool.value;
      if (t === "point") return "+ pt — click anywhere · click tool again to exit";
      if (t === "line") {
        const start = linePending.value;
        if (!start) return "/ line — click first endpoint (existing point or empty canvas)";
        return "/ line — click second endpoint · esc to cancel";
      }
      const sel = selection.value;
      if (sel.length === 0) {
        return "click to select · shift+click adds · alt+click removes · ⌫ deletes · dbl-click pins";
      }
      const pts = sel.filter(e => e.kind === "point").length;
      const lns = sel.filter(e => e.kind === "line").length;
      const matches = ACTIONS.filter(a => a.match(sel)).map(a => a.label);
      const head = `selection: ${pts} pt · ${lns} line`;
      return matches.length === 0
        ? `${head} — no constraint matches`
        : `${head} — ${matches.join(" / ")}`;
    });
    s(label(vec(W / 2, STATUS_Y), status));

    // ─── live primitive rendering (lines first → points on top) ─────

    forEach(s.root, lines, l => renderLine(l, selection, linePending, onEntityClick), {
      key: l => `L${l.id}`,
    });
    forEach(s.root, points, p => renderPoint(p, cluster, selection, linePending, onEntityClick), {
      key: p => `P${p.id}`,
    });
    forEach(s.root, constraintList, c => renderConstraint(c, removeConstraint), {
      key: c => `C${c.id}`,
    });

    // ─── seed scene ─────────────────────────────────────────────────
    const cx = CANVAS_X + CANVAS_W / 2;
    const cy = CANVAS_Y + CANVAS_H / 2;
    const a = addPoint({ x: cx - 110, y: cy + 30 });
    const b = addPoint({ x: cx, y: cy - 60 });
    const c = addPoint({ x: cx + 110, y: cy + 30 });
    addLine(a, b);
    addLine(b, c);

    // ─── footer ─────────────────────────────────────────────────────
    s(
      label(
        vec(W / 2, FOOTER_Y),
        "two reactive collections (Point[], Line[]) + Constraint[] · forEach renders · cluster reflows",
        { size: 10 },
      ),
    );
  }
}

// ─── point rendering ─────────────────────────────────────────────────

function renderPoint(
  p: Point,
  _cluster: Constraints,
  selection: Signal<readonly Entity[]>,
  linePending: Signal<Point | null>,
  onClick: (e: Entity, evt: PointerEvent) => void,
): AnyShape {
  const selected = computed(() => selection.value.includes(p));
  const pending = computed(() => linePending.value === p);
  const fill = computed(() => (p.pinned.value ? PIN_COLOR : selected.value ? SELECTED : ACCENT));

  const visible = circle(p.pos, POINT_R, {
    fill,
    stroke: "var(--bg-color, white)",
    strokeWidth: 2,
  });
  // Pending-endpoint ring (line tool, first pick).
  const pendingRing = circle(p.pos, POINT_R + 4, {
    thin: true,
    stroke: ACCENT,
    dashed: true,
    opacity: computed(() => (pending.value ? 1 : 0)),
  });
  // Selection halo.
  const selRing = circle(p.pos, POINT_R + 4, {
    thin: true,
    stroke: SELECTED,
    opacity: computed(() => (selected.value && !pending.value ? 0.9 : 0)),
  });

  // Pin dot.
  const pinDot = circle(p.pos, 2, {
    fill: "white",
    opacity: computed(() => (p.pinned.value ? 1 : 0)),
  });

  // Generously sized invisible hit target — sits on top of `visible`
  // so it intercepts clicks first. `pointer-events: all` so the SVG
  // hit test treats it as solid even with no fill.
  const hit = circle(p.pos, POINT_HIT_R, { fill: "transparent" });
  hit.attr("pointer-events", "all");
  hit.el.style.cursor = "pointer";

  // Drag the visible point. Drags update `p.pos` and flip `dragging`,
  // which the cluster sees via the (pinned || dragging) gate.
  hit.track(drag(hit, p.pos, p.dragging));
  hit.on("click", e => {
    e.stopPropagation();
    onClick(p, e as PointerEvent);
  });
  hit.on("dblclick", e => {
    e.stopPropagation();
    p.pinned.value = !p.pinned.peek();
  });

  return group({ translate: vec(0, 0) }, pendingRing, selRing, visible, pinDot, hit);
}

// ─── line rendering ──────────────────────────────────────────────────

function renderLine(
  l: Line,
  selection: Signal<readonly Entity[]>,
  linePending: Signal<Point | null>,
  onClick: (e: Entity, evt: PointerEvent) => void,
): AnyShape {
  const selected = computed(() => selection.value.includes(l));
  const stroke = computed(() => (selected.value ? SELECTED : "var(--text-color, #222)"));
  const opacity = computed(() => (selected.value ? 1 : 0.55));

  const vis = line(l.a.pos, l.b.pos, {
    thin: true,
    stroke,
    opacity,
  });

  // Fat invisible stroke for hit testing — same geometry, much wider
  // hit area. Rendered first (under the visible line).
  const hit = line(l.a.pos, l.b.pos, { stroke: "transparent", strokeWidth: LINE_HIT_W });
  hit.attr("pointer-events", "stroke");
  hit.el.style.cursor = "pointer";
  hit.on("click", e => {
    e.stopPropagation();
    if (linePending.peek() !== null) return;
    onClick(l, e as PointerEvent);
  });

  return group({ translate: vec(0, 0) }, hit, vis);
}

// ─── constraint rendering ────────────────────────────────────────────

function renderConstraint(c: Constraint, onRemove: (c: Constraint) => void): AnyShape {
  switch (c.action) {
    case "right-angle":
      return rightAngleBadge(c, onRemove);
    case "midpoint":
      return midpointBadge(c, onRemove);
    case "collinear":
      return collinearBadge(c, onRemove);
    case "coincide":
      return coincideBadge(c, onRemove);
    case "horizontal":
    case "vertical":
    case "distance":
      return endpointPairBadge(c, onRemove);
    case "parallel":
    case "perpendicular":
    case "equal-length":
      return twoLineBadges(c, onRemove);
  }
}

/** Badge offset perpendicular to segment AB by `BADGE_OFFSET`. */
function offsetMid(
  a: Writable<Vec>,
  b: Writable<Vec>,
  side: 1 | -1 = 1,
): Signal<{ x: number; y: number }> {
  return computed(() => {
    const av = a.value;
    const bv = b.value;
    const mx = (av.x + bv.x) / 2;
    const my = (av.y + bv.y) / 2;
    const dx = bv.x - av.x;
    const dy = bv.y - av.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * BADGE_OFFSET * side;
    const ny = (dx / len) * BADGE_OFFSET * side;
    return { x: mx + nx, y: my + ny };
  });
}

/** Right-angle vertex badge: offset along the bisector of (A→B, C→B)
 *  so it sits *off* the vertex point and doesn't intercept point clicks. */
function rightAngleBadge(c: Constraint, onRemove: (c: Constraint) => void): AnyShape {
  const [A, B, C] = c.entities as Point[];
  const pos = computed(() => {
    const av = A.pos.value;
    const bv = B.pos.value;
    const cv = C.pos.value;
    const ux = av.x - bv.x;
    const uy = av.y - bv.y;
    const vx = cv.x - bv.x;
    const vy = cv.y - bv.y;
    const lu = Math.hypot(ux, uy) || 1;
    const lv = Math.hypot(vx, vy) || 1;
    const bx = ux / lu + vx / lv;
    const by = uy / lu + vy / lv;
    const lb = Math.hypot(bx, by) || 1;
    return { x: bv.x + (bx / lb) * BADGE_OFFSET, y: bv.y + (by / lb) * BADGE_OFFSET };
  });
  return badge(pos, "⌐", c, onRemove);
}

/** Midpoint badge — placed near M, perpendicular to A–B for clarity. */
function midpointBadge(c: Constraint, onRemove: (c: Constraint) => void): AnyShape {
  const [, A, B] = c.entities as Point[];
  return badge(offsetMid(A.pos, B.pos), "•", c, onRemove);
}

/** "Point on line" — badge near the midpoint of the line, offset. */
function collinearBadge(c: Constraint, onRemove: (c: Constraint) => void): AnyShape {
  const ln = c.entities.find(e => e.kind === "line") as Line;
  return badge(offsetMid(ln.a.pos, ln.b.pos), "→·", c, onRemove);
}

/** "Coincide" — between two co-located points, badge sits offset. */
function coincideBadge(c: Constraint, onRemove: (c: Constraint) => void): AnyShape {
  const [a, b] = c.entities as Point[];
  const pos = computed(() => {
    const av = a.pos.value;
    const bv = b.pos.value;
    return { x: (av.x + bv.x) / 2 + BADGE_OFFSET, y: (av.y + bv.y) / 2 };
  });
  return badge(pos, "≡", c, onRemove);
}

/** Single badge for actions over a 2-point or 1-line selection
 *  (horiz / vert / distance). Badge offsets perpendicular to the
 *  underlying segment. */
function endpointPairBadge(c: Constraint, onRemove: (c: Constraint) => void): AnyShape {
  const [A, B] = endpoints(c.entities);
  const glyph = c.action === "horizontal" ? "↔" : c.action === "vertical" ? "↕" : "—";
  return badge(offsetMid(A.pos, B.pos), glyph, c, onRemove);
}

/** Two-line constraints — render twin badges, one per line, with a
 *  matching glyph. Visual cue that the constraint relates the two. */
function twoLineBadges(c: Constraint, onRemove: (c: Constraint) => void): AnyShape {
  const [l1, l2] = c.entities as Line[];
  const glyph = c.action === "parallel" ? "∥" : c.action === "perpendicular" ? "⊥" : "=";
  return group(
    { translate: vec(0, 0) },
    badge(offsetMid(l1.a.pos, l1.b.pos), glyph, c, onRemove),
    badge(offsetMid(l2.a.pos, l2.b.pos, -1), glyph, c, onRemove),
  );
}

/** Small clickable badge with a glyph; click removes the constraint.
 *  Hover swaps the glyph to `×` so the action is unambiguous. */
function badge(
  pos: Signal<{ x: number; y: number }>,
  glyph: string,
  c: Constraint,
  onRemove: (c: Constraint) => void,
): AnyShape {
  const hovered = signal(false);
  const fill = computed(() => (hovered.value ? SELECTED : "var(--bg-color, white)"));
  const fg = computed(() => (hovered.value ? "white" : "var(--text-color, #222)"));
  const text = computed(() => (hovered.value ? "×" : glyph));

  const g = group(
    { translate: pos as unknown as Val<{ x: number; y: number }> },
    circle(vec(0, 0), BADGE_R, {
      fill,
      stroke: "var(--text-color, #222)",
      thin: true,
    }),
    label(vec(0, 0.5), text, { fill: fg }),
  );
  g.el.style.cursor = "pointer";
  g.on("pointerenter", () => {
    hovered.value = true;
  });
  g.on("pointerleave", () => {
    hovered.value = false;
  });
  g.on("click", e => {
    e.stopPropagation();
    onRemove(c);
  });
  return g;
}

// ─── toolbar buttons ─────────────────────────────────────────────────

/** Layout an array of items in a row centered on `W / 2`. */
function layoutRow<T>(
  items: readonly T[],
  itemW: number,
  gap: number,
  cb: (item: T, x: number, i: number) => void,
): void {
  const total = items.length * itemW + (items.length - 1) * gap;
  const x0 = (W - total) / 2;
  items.forEach((it, i) => cb(it, x0 + i * (itemW + gap), i));
}

function toolBtn(
  pos: Vec,
  text: string,
  active: Signal<boolean>,
  onClick: () => void,
  width: number,
): AnyShape {
  const g = group(
    { translate: pos },
    rect(0, 0, width, PALETTE_H, {
      fill: computed(() => (active.value ? ACCENT_TINT : "transparent")),
      stroke: computed(() => (active.value ? ACCENT : "var(--text-color, #222)")),
      thin: true,
      corner: 4,
    }),
    label(vec(width / 2, PALETTE_H / 2 + 1), text, {
      fill: computed(() => (active.value ? ACCENT : "var(--text-color, #222)")),
    }),
  );
  g.el.style.cursor = "pointer";
  g.on("click", e => {
    e.stopPropagation();
    onClick();
  });
  return g;
}

function actionBtn(
  pos: Vec,
  text: string,
  enabled: Signal<boolean>,
  onClick: () => void,
  width: number,
): AnyShape {
  const g = group(
    { translate: pos },
    rect(0, 0, width, PALETTE_H, {
      fill: computed(() => (enabled.value ? SELECTED_TINT : "transparent")),
      stroke: computed(() => (enabled.value ? SELECTED : "var(--text-color, #222)")),
      thin: true,
      corner: 4,
      opacity: computed(() => (enabled.value ? 1 : 0.35)),
    }),
    label(vec(width / 2, PALETTE_H / 2 + 1), text, {
      fill: computed(() => (enabled.value ? SELECTED : "var(--text-color, #222)")),
      opacity: computed(() => (enabled.value ? 1 : 0.55)),
    }),
  );
  g.effect(() => {
    g.el.style.cursor = enabled.value ? "pointer" : "default";
    g.el.style.pointerEvents = enabled.value ? "all" : "none";
  });
  g.on("click", e => {
    e.stopPropagation();
    if (enabled.peek()) onClick();
  });
  return g;
}
