// md-coreactive.ts — visualises §2 of `coreactive-programming.md`:
// edge-local bidirectionality.
//
// LEFT  (scene):    a small geometric construction. Drag any cell.
// RIGHT (topology): the same construction as a DAG of nodes the
//                   user can actually point at — shapes, named lens
//                   operators (midpoint, down), labels, lines.
//                   Primitive Vecs (A, B, H) collapse into their shape
//                   (no transformation, no separate identity).
//
// Edges:
//   forward — solid `path(from).to(to)` (parent → child)
//   reverse — dashed `curve(...)` arc (child → parent), opt-in
//
// Drag flow matches the engine: the dragged shape is the firing
// origin; phase 1 walks reverse edges UP through the lens(es) until
// it bottoms out at unlensed shapes (the "reached roots"); phase 2
// fans out FORWARD from those roots through every read.
//
// Layout: each non-root's x is the mean of its parents' x's; per-
// layer overlap balanced by a forward/backward sweep. All plain
// `propagator()` calls on `Num` signals.

import { propagate, propagator } from "@minim/propagators";
import {
  type CurveSegment,
  circle,
  curve,
  Diagram,
  derive,
  drag,
  easeIn,
  easeOut,
  effect,
  label,
  line,
  type Mount,
  midpointLens,
  Num,
  num,
  path,
  play,
  rect,
  signal,
  Vec,
  vec,
  type Writable,
} from "../../minim";

const RED = "#e25c5c";
const BLUE = "#5b8def";
const GREEN = "#86b966";
const ORANGE = "#f5a623";
const MUTED = "var(--text-color, #888)";
const INK = "var(--text-color, #333)";

// H slider — track is centred on the scene pane (cx = 200).
// `height = hKnob.x - SLIDER_OFFSET`, where SLIDER_OFFSET = TRACK_LO - H_MIN
// so the visible track endpoints map cleanly to the clamp bounds.
const H_MIN = 30;
const H_MAX = 180;
const H_INIT = 95;
const TRACK_LO = 125; // 200 − (H_MAX − H_MIN) / 2
const TRACK_HI = 275; // 200 + (H_MAX − H_MIN) / 2
const SLIDER_Y = 400;
const SLIDER_OFFSET = TRACK_LO - H_MIN; // 95

const SCENE_R = 14; // Filled cell circle in the scene (drag target).
const SHAPE_R = 12; // Filled cell circle in the topology — represents the cell.
const NODE_R = SHAPE_R; // Implicit anchor radius for every topology node — lines stop here.
const H_R = 6; // H is rendered as a smaller un-labelled dot in both panes.
const LENS_W = 76; // Structural lens box (midpoint / down).
const LENS_H = 24;
const LABEL_SIZE = 15; // Body font size in the topology.
const LINE_W = 24;

const ARC_BOW = 22;

// Edge animation: an `activity` Num signal per edge tweens 0 → 1 → 0
// during a fire. Re-firing cancels the in-flight tween and ramps back
// up from the current value, so continuous drags hold the line warm.
// Stroke colour is the only property that changes between rest and
// fire; width pulses slightly thicker for emphasis.
const REST_W = 2; // Default stroke width.
const ACTIVE_W = 3.4;
const FIRE_PEAK_DUR = 0.1;
const FIRE_FADE_DUR = 0.4;

const PHASE_GAP = 0.18;
const HOP_STAGGER = 0.06;
const EMIT_THROTTLE_MS = 200;

const PANE_X = 400;
const PANE_Y = 70;
const PANE_W = 480;
const PANE_H = 360;

// ─── Arc as a one-segment Curve ───────────────────────────────────
// Circular arc from `from` to `to` whose midpoint sits `bow` pixels
// perpendicular to the chord (sign flips to the other side). Yields
// a `CurveSegment` ready for `curve(() => [arcSegment(...)])`.
type V = { x: number; y: number };
function arcSegment(from: V, to: V, bow: number): CurveSegment {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const L = Math.hypot(dx, dy);
  const s = Math.abs(bow);
  const R = (L * L) / (8 * s) + s / 2;
  const ux = dx / (L || 1);
  const uy = dy / (L || 1);
  const px = -uy;
  const py = ux;
  const sgn = Math.sign(bow);
  const cx = (from.x + to.x) / 2 - sgn * px * (R - s);
  const cy = (from.y + to.y) / 2 - sgn * py * (R - s);
  const a0 = Math.atan2(from.y - cy, from.x - cx);
  let dθ = Math.atan2(to.y - cy, to.x - cx) - a0;
  while (dθ > Math.PI) dθ -= 2 * Math.PI;
  while (dθ < -Math.PI) dθ += 2 * Math.PI;
  return { kind: "ellipseArc", center: { x: cx, y: cy }, a: R, b: R, rotation: 0, a0, a1: a0 + dθ };
}

// ─── Stroke colour interpolated by `activity ∈ [0, 1]` ────────────
// Browser-side CSS `color-mix()` does the work; resolves cleanly
// against `var(--text-color)` so dark/light themes both look right.
function mixColor(activity: number, fireColor: string): string {
  if (activity <= 1e-3) return MUTED;
  if (activity >= 1 - 1e-3) return fireColor;
  const a = Math.round(activity * 100);
  return `color-mix(in srgb, ${MUTED} ${100 - a}%, ${fireColor} ${a}%)`;
}

/** Reactive Vec sitting on the segment `from → to`, pulled back
 *  toward `from` by `r` pixels — i.e. the implicit anchor where a
 *  line into `from` should terminate. Endpoints collapse to `from`
 *  if the segment is shorter than `2r`. */
function shrink(from: Vec, to: Vec, r: number): Vec {
  return Vec.derive(() => {
    const f = from.value;
    const t = to.value;
    const dx = t.x - f.x;
    const dy = t.y - f.y;
    const L = Math.hypot(dx, dy);
    if (L < 2 * r) return f;
    return { x: f.x + (dx / L) * r, y: f.y + (dy / L) * r };
  });
}

// ─── Layer assignment (longest-path topological) ──────────────────

function layersOf(ns: readonly Vec[], parents: Map<Vec, Vec[]>): Map<Vec, number> {
  const layer = new Map<Vec, number>(ns.map(n => [n, 0]));
  let changed = true;
  let safety = ns.length + 1;
  while (changed && safety-- > 0) {
    changed = false;
    for (const n of ns) {
      let m = 0;
      for (const p of parents.get(n) ?? []) m = Math.max(m, layer.get(p)! + 1);
      if (m > layer.get(n)!) {
        layer.set(n, m);
        changed = true;
      }
    }
  }
  return layer;
}

// ─── Firings ──────────────────────────────────────────────────────

type Edge = readonly [Vec, Vec, boolean?];

/** Edges fired during the engine's response to a write at `origin`. */
function firingsFor(origin: Vec, edges: readonly Edge[]) {
  const reverseFromTo = new Map<Vec, Map<Vec, Edge>>();
  const fwdFrom = new Map<Vec, Edge[]>();
  const parentsOf = new Map<Vec, Vec[]>();
  for (const e of edges) {
    const [from, to, rev] = e;
    if (rev) {
      let inner = reverseFromTo.get(from);
      if (!inner) reverseFromTo.set(from, (inner = new Map()));
      inner.set(to, e);
    }
    let fb = fwdFrom.get(from);
    if (!fb) fwdFrom.set(from, (fb = []));
    fb.push(e);
    let pb = parentsOf.get(to);
    if (!pb) parentsOf.set(to, (pb = []));
    pb.push(from);
  }

  // Phase 1: walk reverse-capable parents from origin upstream;
  // collect fired edges and the "reached roots" (nodes with no
  // further reverse-edge upstream) in a single BFS.
  const phase1: { edge: Edge; hop: number }[] = [];
  const reached: Vec[] = [];
  const visited = new Set<Vec>([origin]);
  const q1: { node: Vec; hop: number }[] = [{ node: origin, hop: 0 }];
  while (q1.length > 0) {
    const { node: cur, hop } = q1.shift()!;
    let hasUp = false;
    for (const p of parentsOf.get(cur) ?? []) {
      const e = reverseFromTo.get(p)?.get(cur);
      if (!e) continue;
      hasUp = true;
      phase1.push({ edge: e, hop });
      if (!visited.has(p)) {
        visited.add(p);
        q1.push({ node: p, hop: hop + 1 });
      }
    }
    if (!hasUp) reached.push(cur);
  }

  // Phase 2: BFS forward from each reached root through every edge.
  const phase2: { edge: Edge; hop: number }[] = [];
  const v2 = new Set<Vec>();
  for (const root of reached) {
    const q2: { node: Vec; hop: number }[] = [{ node: root, hop: 0 }];
    while (q2.length > 0) {
      const { node: cur, hop } = q2.shift()!;
      if (v2.has(cur)) continue;
      v2.add(cur);
      for (const e of fwdFrom.get(cur) ?? []) {
        phase2.push({ edge: e, hop });
        q2.push({ node: e[1], hop: hop + 1 });
      }
    }
  }

  return { phase1, phase2 };
}

// ─── Component ─────────────────────────────────────────────────────

export class MdCoreactive extends Diagram {
  protected scene(s: Mount): void {
    this.view(900, 480);

    // Reactive primitives in the scene.
    const A = vec(90, 150);
    const B = vec(290, 150);
    const M = midpointLens(A, B);
    // H: slider knob on a horizontal track at SLIDER_Y. `Num.pin`
    // absorbs y-writes, so standard `drag(knob, vec)` is axis-locked.
    // The knob's x is clamped to the track range; `height = knob.x −
    // SLIDER_OFFSET` exposes the writable height in px (clamped to
    // [H_MIN, H_MAX]). `D = M.down(height)` propagates forward into D.
    const hKnob = vec(
      num(SLIDER_OFFSET + H_INIT).clamp(TRACK_LO, TRACK_HI),
      Num.pin(SLIDER_Y),
    );
    const height = hKnob.x.sub(SLIDER_OFFSET);
    const D = M.down(height);

    // Each cell has one topology position (its draggable shape).
    // Primitive Vecs (A, B, H) collapse into their shape — they have
    // no transformation of their own. Lens cells (M, D) keep an
    // explicit named operator node above their shape: `midpoint(A,B)`
    // produces M, `M.down(H)` produces D.
    const cells = [
      { cell: A, color: BLUE, text: "A", shape: vec() },
      { cell: B, color: GREEN, text: "B", shape: vec() },
      { cell: hKnob, color: INK, text: "H", shape: vec() },
      { cell: M, color: ORANGE, text: "M", shape: vec() },
      { cell: D, color: RED, text: "D", shape: vec() },
    ] as const;
    const [cA, cB, cH, cM, cD] = cells;

    // Topology positions for the lens operators and shape leaves.
    const tMidpoint = vec(),
      tDown = vec();
    const tLineAB = vec(),
      tLineMD = vec();
    const tLabA = vec(),
      tLabB = vec(),
      tLabM = vec(),
      tLabD = vec();

    // Edges: [from, to] forward only, [from, to, true] also reverse.
    //
    //   shape ↔ lens / lens ↔ shape  bidirectional (lens get/put).
    //   shape → label / line          forward-only subscriber.
    //
    // From the user's POV: dragging a shape walks reverse edges UP
    // through the lens(es), bottoms out at the unlensed shapes, then
    // forward-propagates DOWN through every read.
    const edges: Edge[] = [
      [cA.shape, tMidpoint, true],
      [cB.shape, tMidpoint, true],
      [tMidpoint, cM.shape, true],
      // H feeds into `down(...)` but doesn't receive writebacks from D
      // (height has weight 0; D-drag is absorbed entirely by M). Forward-
      // only edge matches that asymmetry: a black line, no red arc.
      [cH.shape, tDown],
      [cM.shape, tDown, true],
      [tDown, cD.shape, true],
      [cA.shape, tLabA],
      [cB.shape, tLabB],
      [cM.shape, tLabM],
      [cD.shape, tLabD],
      [cA.shape, tLineAB],
      [cB.shape, tLineAB],
      [cM.shape, tLineMD],
      [cD.shape, tLineMD],
    ];

    // Drag origin: the topology Vec being driven (or null).
    const origin = signal<Vec | null>(null);
    const anim = this.anim;

    // ─── Mount order matters (no z-order, no groups) ─────────────
    // 1. Frames + pane titles (back).
    s(
      rect(20, 70, 360, 360, { thin: true, opacity: 0.12, corner: 4 }),
      rect(PANE_X, PANE_Y, PANE_W, PANE_H, { thin: true, opacity: 0.12, corner: 4 }),
      label(vec(200, 58), "scene", { size: 13, bold: true, fill: MUTED, opacity: 0.7 }),
      label(vec(PANE_X + PANE_W / 2, 58), "coreactive signals graph", {
        size: 13,
        bold: true,
        fill: MUTED,
        opacity: 0.7,
      }),
    );

    // 2. Scene visuals: lines first (default style), then draggable
    //    cells on top. The slider track spans [TRACK_LO, TRACK_HI] —
    //    horizontally centred on the scene pane.
    s(
      line(A, B),
      line(M, D),
      line(vec(TRACK_LO, SLIDER_Y), vec(TRACK_HI, SLIDER_Y), {
        thin: true,
        opacity: 0.3,
        cap: "round",
      }),
    );
    for (const c of cells) {
      const small = c === cH;
      const ch = s(
        circle(c.cell, small ? H_R + 1 : SCENE_R, {
          fill: c.color,
          stroke: "var(--bg-color, white)",
          strokeWidth: small ? 0 : 2,
        }),
      );
      drag(ch, c.cell);
      ch.on("pointerdown", () => {
        origin.value = c.shape;
      });
      if (!small) {
        s(
          label(c.text === "D" ? c.cell.down(24) : c.cell.up(24), c.text, {
            size: LABEL_SIZE,
            bold: true,
          }),
        );
      }
    }

    // 3. Topology edges (under topology nodes). Forward = `path`,
    //    reverse = `curve` with one circular `ellipseArc` segment.
    //    Endpoints are pulled back by NODE_R (each node has an
    //    implicit anchor circle) so lines stop at the node boundary
    //    instead of crossing into label / lens-box text. Each edge
    //    owns an `activity` Num signal — stroke colour and width
    //    interpolate off it; everything else uses defaults.
    function fireProps(activity: Writable<Num>, fireColor: string) {
      return {
        stroke: derive(() => mixColor(activity.value, fireColor)),
        strokeWidth: derive(() => REST_W + (ACTIVE_W - REST_W) * activity.value),
        cap: "round" as const,
      };
    }
    const edgeAct = new Map<Edge, { fwd: Writable<Num>; rev?: Writable<Num> }>();
    const anchorR = (n: Vec): number => (n === cH.shape ? H_R : NODE_R);
    for (const e of edges) {
      const [from, to, rev] = e;
      const start = shrink(from, to, anchorR(from));
      const end = shrink(to, from, anchorR(to));
      const fwdAct = num(0);
      s(path(start, fireProps(fwdAct, BLUE)).to(end));
      const revAct = rev ? num(0) : undefined;
      if (revAct) {
        s(
          curve(() => [arcSegment(end.value, start.value, ARC_BOW)], {
            ...fireProps(revAct, RED),
            dashed: true,
          }),
        );
      }
      edgeAct.set(e, { fwd: fwdAct, rev: revAct });
    }

    // 4. Topology nodes — shape circles, structural lens boxes,
    //    line icons, and bare quoted-letter labels.
    for (const c of cells) {
      s(circle(c.shape, c === cH ? H_R : SHAPE_R, { fill: c.color }));
    }
    const lenses: [Writable<Vec>, string][] = [
      [tMidpoint, "midpoint"],
      [tDown, "down"],
    ];
    for (const [p, text] of lenses) {
      const tl = p.left(LENS_W / 2).up(LENS_H / 2);
      s(
        rect(tl.x, tl.y, LENS_W, LENS_H, {
          fill: "var(--bg-color, white)",
          stroke: MUTED,
          strokeWidth: 1.2,
          corner: 3,
        }),
        label(p, text, { size: LABEL_SIZE, bold: true, fill: MUTED }),
      );
    }
    for (const p of [tLineAB, tLineMD]) {
      s(
        line(p.left(LINE_W / 2), p.right(LINE_W / 2), {
          stroke: MUTED,
          strokeWidth: 1.6,
          cap: "round",
        }),
        circle(p.left(LINE_W / 2), 2, { fill: MUTED }),
        circle(p.right(LINE_W / 2), 2, { fill: MUTED }),
      );
    }
    const labelLeaves: [Writable<Vec>, string, string][] = [
      [tLabA, BLUE, "A"],
      [tLabB, GREEN, "B"],
      [tLabM, ORANGE, "M"],
      [tLabD, RED, "D"],
    ];
    for (const [p, color, text] of labelLeaves) {
      s(label(p, `"${text}"`, { size: LABEL_SIZE, bold: true, fill: color }));
    }

    // ─── Layout: derive parents from edges, run propagators ──────
    const allNodes = [...new Set(edges.flatMap(([f, t]) => [f, t]))];
    const parents = new Map<Vec, Vec[]>();
    for (const [from, to] of edges) {
      let p = parents.get(to);
      if (!p) parents.set(to, (p = []));
      p.push(from);
    }
    const layer = layersOf(allNodes, parents);
    const numLayers = Math.max(...layer.values()) + 1;
    const byLayer: Vec[][] = Array.from({ length: numLayers }, () => []);
    for (const n of allNodes) byLayer[layer.get(n)!]!.push(n);
    const xOf = (n: Vec) => n.x as Writable<Num>;

    propagate(
      // y: each node's y is its layer's centerline.
      propagator(
        [],
        allNodes.map(n => n.y as Writable<Num>),
        () => {
          const slot = PANE_H / numLayers;
          for (const n of allNodes) {
            (n.y as Writable<Num>).value = PANE_Y + (layer.get(n)! + 0.5) * slot;
          }
        },
      ),
      // x: each layer is sorted by parent-barycenter (so visual
      // ordering follows the DAG) then evenly distributed across
      // the full pane width — so layers with siblings actually use
      // the available horizontal space instead of clustering at
      // their parents' midpoint.
      ...byLayer.map(nodes =>
        propagator(
          nodes.flatMap(n => (parents.get(n) ?? []).map(p => p.x)),
          nodes.map(xOf),
          () => {
            const bary = (n: Vec): number => {
              const ps = parents.get(n) ?? [];
              return ps.length ? ps.reduce((s, p) => s + p.x.value, 0) / ps.length : 0;
            };
            const sorted = [...nodes].sort((a, b) => bary(a) - bary(b));
            const lo = PANE_X + 30;
            const hi = PANE_X + PANE_W - 30;
            const step = (hi - lo) / (sorted.length + 1);
            sorted.forEach((n, i) => {
              xOf(n).value = lo + (i + 1) * step;
            });
          },
        ),
      ),
    );

    // ─── Animation: tween each fired edge's `activity` 0 → 1 → 0 ─
    // Re-fire cancels any in-flight tween and ramps back up to 1
    // from the current value — continuous drags hold the line warm
    // until the user lets go.
    const cancelFire = new Map<Writable<Num>, () => void>();
    function fire(activity: Writable<Num>, delay: number): void {
      cancelFire.get(activity)?.();
      const flight = activity.to(1, FIRE_PEAK_DUR, easeOut).to(0, FIRE_FADE_DUR, easeIn);
      cancelFire.set(activity, anim.start(delay > 0 ? play(delay).then(flight) : flight));
    }

    const cellSigs = cells.map(c => c.cell) as Writable<Vec>[];
    const prev = new Map<Writable<Vec>, V>();
    for (const c of cellSigs) prev.set(c, { ...c.peek() });
    let initialised = false;
    let lastEmit = 0;

    this.root.track(
      effect(() => {
        let changed = false;
        for (const c of cellSigs) {
          const v = c.value;
          const p = prev.get(c)!;
          if (Math.abs(v.x - p.x) > 1e-6 || Math.abs(v.y - p.y) > 1e-6) {
            prev.set(c, { x: v.x, y: v.y });
            changed = true;
          }
        }
        if (!initialised) {
          initialised = true;
          return;
        }
        if (!changed) return;
        const o = origin.peek();
        if (o === null) return;
        const now = performance.now();
        if (now - lastEmit < EMIT_THROTTLE_MS) return;
        lastEmit = now;

        const f = firingsFor(o, edges);
        for (const { edge: e, hop } of f.phase1) {
          fire(edgeAct.get(e)!.rev!, hop * HOP_STAGGER);
        }
        const totalFire = FIRE_PEAK_DUR + FIRE_FADE_DUR;
        const phase2Start = f.phase1.length > 0 ? totalFire * 0.65 + PHASE_GAP : 0;
        for (const { edge: e, hop } of f.phase2) {
          fire(edgeAct.get(e)!.fwd, phase2Start + hop * HOP_STAGGER);
        }
      }),
    );
  }
}
