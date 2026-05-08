// Self-rendering trace demo. A small animation runs in the top half;
// underneath, every generator the runtime spawns is rendered live as a
// Gantt row. `anim.trace()` is the only minim addition needed; the
// layout below is purely derived from `(parentId, spawnedAt, id)`.
//
// Layout: structural, not greedy.
//   - Each parent gets its own row.
//   - Children of one `yield [...]` form a "batch" (same parentId +
//     same spawnedAt — that's literally what an array yield is). Batch
//     siblings stack in adjacent rows directly below the parent.
//   - Sequential batches under the same parent reuse those rows
//     (they can't overlap — the runtime is one yield at a time).
//   - Real nesting (a sibling that itself yields a batch) goes one
//     row-block deeper; depth shows up as visual depth.

import {
  Diagram,
  Scene,
  align,
  circle,
  computed,
  css,
  easeOut,
  fadeIn,
  fadeOut,
  fadeUp,
  fadeUpOut,
  forEach,
  label,
  pt,
  rect,
  signal,
  spinIn,
  zoomOut,
  type Span,
} from "../../minim";

const W = 600;
const TOP_H = 110;
const PAD = 16;
const HEADER_Y = TOP_H + 22;
const ROWS_Y = HEADER_Y + 14;
const ROW_H = 14;
const ROW_GAP = 3;
// Floor for the time→pixel scale so early frames don't squish.
const SCALE_MIN = 3;
// Reserved lane budget. Per-parent subtree allocation means concurrent
// subtrees stack rather than share, so depth × max-batch is a soft
// upper bound. Current demo peaks at 9 (root + a-leaf + b-subtree-3 +
// c-subtree-4).
const MAX_LANES = 10;

const ROW_FILL = ["#1a1a1a", "#5b8def", "#7aa6f0"] as const;

/** Layout pass over a flat list of `Span`s. Each span gets a `lane`
 *  (row index) by recursively allocating a contiguous sub-block below
 *  each parent for that parent's entire subtree.
 *
 *  Why per-parent and not per-depth: depth-2 children of two depth-1
 *  siblings (both running concurrently — phase 1's fadeUp and spinIn)
 *  are not sequential, so they can't share lanes. Per-parent allocation
 *  guarantees a span and its descendants form a vertical block that no
 *  other concurrent subtree touches.
 *
 *  Sequential batches under the *same* parent still reuse lanes — each
 *  batch lays out fresh starting at parent.lane + 1, and they can't
 *  overlap in time (the runtime is one yield at a time). */
function layoutSpans(spans: readonly Span[]): {
  lanes: Map<number, number>;
  totalLanes: number;
  depthOf: Map<number, number>;
} {
  // Children grouped by parent, sorted by spawnedAt then id (so batches
  // come out in time order, and siblings within a batch in spawn order).
  const childrenOf = new Map<number, Span[]>();
  for (const s of spans) {
    if (s.parentId === undefined) continue;
    const arr = childrenOf.get(s.parentId);
    if (arr) arr.push(s);
    else childrenOf.set(s.parentId, [s]);
  }
  for (const arr of childrenOf.values()) {
    arr.sort((a, b) => a.spawnedAt - b.spawnedAt || a.id - b.id);
  }

  const lanes = new Map<number, number>();
  const depthOf = new Map<number, number>();

  // Place `span` at `startLane`; lay out its descendants below; return
  // the first lane *not* occupied by this subtree.
  const layoutSubtree = (span: Span, startLane: number, depth: number): number => {
    lanes.set(span.id, startLane);
    depthOf.set(span.id, depth);
    const children = childrenOf.get(span.id);
    if (!children || children.length === 0) return startLane + 1;

    // Walk children, splitting by spawnedAt — each unique time = one
    // batch (one `yield [...]` or one `yield child`).
    let maxNext = startLane + 1;
    let i = 0;
    while (i < children.length) {
      const batchT = children[i].spawnedAt;
      let siblingLane = startLane + 1;
      while (i < children.length && children[i].spawnedAt === batchT) {
        siblingLane = layoutSubtree(children[i], siblingLane, depth + 1);
        i++;
      }
      if (siblingLane > maxNext) maxNext = siblingLane;
    }
    return maxNext;
  };

  let cursor = 0;
  for (const s of spans) {
    if (s.parentId === undefined) cursor = layoutSubtree(s, cursor, 0);
  }
  return { lanes, totalLanes: cursor || 1, depthOf };
}

export class MdTraceDemo extends Diagram {
  static styles = css`
    :host {
      --scene-max-width: 640px;
    }
  `;

  protected scene(s: Scene): void {
    const H = ROWS_Y + MAX_LANES * (ROW_H + ROW_GAP) + 24;
    s.view(0, 0, W, H);

    // ── Top: three circles the demo animates ──────────────────────────
    const cy = TOP_H / 2;
    const a = s(circle(pt(W / 2 - 100, cy), 18, { fill: "#5b8def" }));
    const b = s(circle(pt(W / 2, cy), 18, { fill: "#f5a623" }));
    const c = s(circle(pt(W / 2 + 100, cy), 18, { fill: "#e25c5c" }));

    // ── Heartbeat: a "now" signal so in-flight rows grow per frame.
    //   Spawned BEFORE `trace()` so it isn't recorded in the trace.
    const now = signal(0);
    const tick = signal(0);
    this.anim.run(function* heartbeat() {
      while (true) {
        const dt: number = yield;
        now.value += dt;
        tick.value++;
      }
    });

    // ── Trace starts here. The next `run()` becomes the root span.
    const trace = this.anim.trace();

    // Four phases, varied durations, mixed nesting — picked to make the
    // structural layout show off:
    //   • phase 1: parallel intro. `a` is a leaf (fadeIn uses `yield*`
    //              internally, invisible), `b`'s fadeUp spawns 2
    //              sub-rows, `c`'s spinIn spawns 3 (rotate+scale+opacity).
    //              Durations differ so siblings don't finish in lockstep.
    //   • phase 2: a single `yield child` (not an array) — depth-1
    //              batch of size 1. Exercises the non-array spawn path.
    //   • phase 3: parallel translates with three different durations.
    //   • phase 4: parallel outro mixing leaves and nested transitions.
    this.anim.run(function* demoAnim() {
      yield [
        fadeIn(a, 0.3),
        fadeUp(b, 0.7),
        spinIn(c, 0.5),
      ];
      yield 0.2;
      yield a.translate.to({ x: -50, y: 0 }, 0.4, easeOut);
      yield [
        a.translate.to({ x: 0, y: -30 }, 0.5, easeOut),
        b.translate.to({ x: 50, y: -10 }, 0.8, easeOut),
        c.translate.to({ x: -30, y: 30 }, 0.3, easeOut),
      ];
      yield 0.3;
      yield [
        fadeUpOut(a, 0.3),
        fadeOut(b, 0.5),
        zoomOut(c, 0.6),
      ];
    });

    // ── Gantt area ────────────────────────────────────────────────────
    const GANTT_W = W - 2 * PAD;
    const SCALE = computed(() => {
      tick.value;
      return GANTT_W / Math.max(trace.duration(), SCALE_MIN);
    });

    // Layout — recomputed each tick from the current span list.
    const layout = computed(() => {
      tick.value;
      return layoutSpans(trace.spans);
    });

    s(
      label(pt(PAD, HEADER_Y), "trace", {
        size: 12,
        bold: true,
        align: align.left,
      }),
    );
    s(
      label(
        pt(W - PAD, HEADER_Y),
        computed(() => {
          tick.value;
          const d = trace.duration();
          const n = trace.spans.length;
          const lanes = layout.value.totalLanes;
          return `${n} span${n === 1 ? "" : "s"} · ${lanes} lane${lanes === 1 ? "" : "s"} · ${d.toFixed(2)}s`;
        }),
        { size: 11, opacity: 0.6, align: align.right },
      ),
    );

    // Fresh array each tick so the computed dirties (`trace.spans` is
    // mutated in place — same reference would memoize and `forEach`
    // would never see new rows).
    const spansSig = computed(() => {
      tick.value;
      return trace.spans.slice();
    });

    forEach(
      s.root,
      spansSig,
      (span: Span) => {
        const x = computed(() => PAD + span.spawnedAt * SCALE.value);
        const width = computed(() => {
          tick.value;
          const end = span.completedAt ?? now.value;
          return Math.max(2, (end - span.spawnedAt) * SCALE.value);
        });
        const y = computed(() => {
          const lane = layout.value.lanes.get(span.id) ?? 0;
          return ROWS_Y + lane * (ROW_H + ROW_GAP);
        });
        const isRunning = computed(() => {
          tick.value;
          return span.completedAt === undefined;
        });
        const fill = computed(() => {
          const d = layout.value.depthOf.get(span.id) ?? 0;
          return ROW_FILL[Math.min(d, ROW_FILL.length - 1)];
        });
        const opacity = computed(() => (isRunning.value ? 0.55 : 0.85));

        const bar = rect(x, y, width, ROW_H, {
          fill,
          opacity,
          corner: 2,
          stroke: "none",
        });
        const tag = label(
          pt(
            computed(() => x.value + 5),
            computed(() => y.value + ROW_H / 2),
          ),
          span.parentId === undefined
            ? `#${span.id} root`
            : `#${span.id} ← #${span.parentId}`,
          { size: 9, align: align.left, opacity: 0.85 },
        );
        return [bar, tag];
      },
      { key: (span) => span },
    );

    // Footer
    s(
      label(
        pt(W / 2, H - 10),
        "lanes stack one yield-array's siblings · sequential batches share lanes · nesting goes deeper",
        { size: 9, align: align.center, opacity: 0.5 },
      ),
    );
  }
}
