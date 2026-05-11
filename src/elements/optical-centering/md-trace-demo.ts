// Self-rendering trace demo. A small animation up top; below it, every
// generator the runtime spawns becomes a live Gantt row. Built on
// `spans(anim)` + `counter` + `traceTree` + `tag`/`tagAll` +
// `anim.clock` (the reactive logical-time signal).
//
// Layout: per-parent subtree blocks. A span plus its descendants form
// one contiguous block; concurrent siblings stack into separate
// blocks; sequential batches under one parent reuse lanes.

import {
  Diagram,
  Scene,
  Anchor,
  circle,
  computed,
  counter,
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
  spans,
  spinIn,
  tag,
  tagAll,
  traceTree,
  zoomOut,
  type TraceNode,
  type TraceTree,
} from "../../minim";

const W = 600;
const TOP_H = 110;
const PAD = 16;
const HEADER_Y = TOP_H + 22;
const ROWS_Y = HEADER_Y + 14;
const ROW_H = 14;
const ROW_GAP = 3;
const SCALE_MIN = 3;
const MAX_LANES = 10;

const ROW_FILL = ["#1a1a1a", "#5b8def", "#7aa6f0", "#a5c2f5"] as const;

/** Lane assignment. Each subtree owns a contiguous block of lanes
 *  below its root; sequential batches reuse lanes. */
function assignLanes(tree: TraceTree): {
  lanes: Map<number, number>;
  total: number;
} {
  const lanes = new Map<number, number>();
  const layout = (n: TraceNode, startLane: number): number => {
    lanes.set(n.span.id, startLane);
    let maxNext = startLane + 1;
    for (const batch of n.batches) {
      let sib = startLane + 1;
      for (const m of batch.members) sib = layout(m, sib);
      if (sib > maxNext) maxNext = sib;
    }
    return maxNext;
  };
  let cursor = 0;
  for (const r of tree.roots) cursor = layout(r, cursor);
  return { lanes, total: cursor || 1 };
}

// Tag library factories locally — library exports stay untagged so
// production code pays nothing.
const t = tagAll({ fadeIn, fadeUp, fadeOut, fadeUpOut, spinIn, zoomOut });

export class MdTraceDemo extends Diagram {
  static styles = css`
    :host {
      --scene-max-width: 640px;
    }
  `;

  protected scene(s: Scene): void {
    const H = ROWS_Y + MAX_LANES * (ROW_H + ROW_GAP) + 24;
    s.view(0, 0, W, H);

    // ── Top: three circles the demo animates ───────────────────────
    const cy = TOP_H / 2;
    const a = s(circle(pt(W / 2 - 100, cy), 18, { fill: "#5b8def" }));
    const b = s(circle(pt(W / 2, cy), 18, { fill: "#f5a623" }));
    const c = s(circle(pt(W / 2 + 100, cy), 18, { fill: "#e25c5c" }));

    // `anim.clock` is the reactive logical-time signal — read it
    // before `spans()` so we don't pull any loop into the trace.
    const now = this.anim.clock;
    const trace = spans(this.anim);

    this.anim.run(
      tag(function* demoAnim() {
        yield [t.fadeIn(a, 0.3), t.fadeUp(b, 0.7), t.spinIn(c, 0.5)];
        yield 0.2;
        // Single-axis tween via the lens.
        yield a.translate.x.to(-50, 0.4, easeOut);
        yield [
          a.translate.to({ x: 0, y: -30 }, 0.5, easeOut),
          b.translate.to({ x: 50, y: -10 }, 0.8, easeOut),
          c.translate.to({ x: -30, y: 30 }, 0.3, easeOut),
        ];
        yield 0.3;
        yield [
          t.fadeUpOut(a, 0.3),
          t.fadeOut(b, 0.5),
          t.zoomOut(c, 0.6),
        ];
      }),
    );

    // ── Reactive derivations ───────────────────────────────────────
    // Bumps on each spawn/complete/cancel. Sparse, event-paced — tree
    // and layout only recompute when structure changes.
    const version = counter(trace.onChange);

    const tree = computed(() => {
      version.value;
      return traceTree(trace.spans);
    });
    const layout = computed(() => assignLanes(tree.value));

    const GANTT_W = W - 2 * PAD;
    // SCALE depends on `now` so the gantt re-fits as in-flight time grows.
    const SCALE = computed(() => {
      now.value;
      version.value;
      return GANTT_W / Math.max(trace.duration(), SCALE_MIN);
    });

    // ── Header ─────────────────────────────────────────────────────
    s(
      label(pt(PAD, HEADER_Y), "trace", {
        size: 12,
        bold: true,
        align: Anchor.Left,
      }),
    );
    s(
      label(
        pt(W - PAD, HEADER_Y),
        computed(() => {
          version.value;
          now.value;
          const n = tree.value.size;
          const lanes = layout.value.total;
          return `${n} span${n === 1 ? "" : "s"} · ${lanes} lane${lanes === 1 ? "" : "s"} · ${trace.duration().toFixed(2)}s`;
        }),
        { size: 11, opacity: 0.6, align: Anchor.Right },
      ),
    );

    // ── Rows ───────────────────────────────────────────────────────
    // A fresh slice per version-bump forces forEach to diff when new
    // spans appear; per-frame growth flows through per-row computeds.
    const spansSig = computed(() => {
      version.value;
      return trace.spans.slice();
    });

    forEach(
      s.root,
      spansSig,
      (span) => {
        const x = computed(() => PAD + span.spawnedAt * SCALE.value);
        const width = computed(() => {
          const end = span.completedAt ?? now.value;
          return Math.max(2, (end - span.spawnedAt) * SCALE.value);
        });
        const y = computed(() => {
          const lane = layout.value.lanes.get(span.id) ?? 0;
          return ROWS_Y + lane * (ROW_H + ROW_GAP);
        });
        const isRunning = computed(() => {
          version.value;
          return span.completedAt === undefined;
        });
        const fill = computed(() => {
          const d = tree.value.byId.get(span.id)?.depth ?? 0;
          return ROW_FILL[Math.min(d, ROW_FILL.length - 1)];
        });
        const opacity = computed(() => (isRunning.value ? 0.55 : 0.85));

        const bar = rect(x, y, width, ROW_H, {
          fill,
          opacity,
          corner: 2,
          stroke: "none",
        });
        const labelText = span.tag
          ? `${span.tag} · #${span.id}`
          : span.parentId === undefined
            ? `#${span.id} root`
            : `#${span.id} ← #${span.parentId}`;
        const tagShape = label(
          pt(x, y).offset(5, ROW_H / 2),
          labelText,
          { size: 9, align: Anchor.Left, opacity: 0.9 },
        );
        return [bar, tagShape];
      },
      { key: (span) => span },
    );

    // ── Footer ─────────────────────────────────────────────────────
    s(
      label(
        pt(W / 2, H - 10),
        "lanes stack one yield-array's siblings · sequential batches share lanes · nesting goes deeper",
        { size: 9, align: Anchor.Center, opacity: 0.5 },
      ),
    );
  }
}
