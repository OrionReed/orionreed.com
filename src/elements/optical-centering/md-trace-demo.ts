import {
  Diagram,
  Mount,
  Anchor,
  signal,
  circle,
  clockSignal,
  easeOut,
  fadeIn,
  fadeOut,
  fadeUp,
  fadeUpOut,
  forEach,
  label,
  vec,
  rect,
  spinIn,
  zoomOut,
  computed,
} from "../../minim";
import {
  spans,
  tag,
  tagAll,
  traceTree,
  type TraceNode,
  type TraceTree,
} from "../../minim/assert";

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

/** Each subtree owns a contiguous lane block; sequential batches reuse lanes. */
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

// Tag locally so production library exports stay untagged.
const t = tagAll({ fadeIn, fadeUp, fadeOut, fadeUpOut, spinIn, zoomOut });

export class MdTraceDemo extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(W, ROWS_Y + MAX_LANES * (ROW_H + ROW_GAP) + 24);

    const row = view.top.down(TOP_H / 2);
    const a = s(circle(row.left(100), 18, { fill: "#5b8def" }));
    const b = s(circle(row, 18, { fill: "#f5a623" }));
    const c = s(circle(row.right(100), 18, { fill: "#e25c5c" }));

    // Built before `spans()` so the clock adapter doesn't appear as a span.
    const now = clockSignal(this.anim);
    const trace = spans(this.anim);

    this.anim.start(
      tag(function* demoAnim() {
        yield [t.fadeIn(a, 0.3), t.fadeUp(b, 0.7), t.spinIn(c, 0.5)];
        yield 0.2;
        yield a.translate.x.to(-50, 0.4, easeOut);
        yield [
          a.translate.to({ x: 0, y: -30 }, 0.5, easeOut),
          b.translate.to({ x: 50, y: -10 }, 0.8, easeOut),
          c.translate.to({ x: -30, y: 30 }, 0.3, easeOut),
        ];
        yield 0.3;
        yield [t.fadeUpOut(a, 0.3), t.fadeOut(b, 0.5), t.zoomOut(c, 0.6)];
      }),
    );

    // Bumps on each spawn/complete/cancel; sparse, event-paced.
    const version = signal(0);
    trace.onChange(() => {
      version.value++;
    });

    const tree = computed(() => {
      version.value;
      return traceTree(trace.spans);
    });
    const layout = computed(() => assignLanes(tree.value));

    const GANTT_W = W - 2 * PAD;
    // Depends on `now` so the gantt re-fits as in-flight time grows.
    const SCALE = computed(() => {
      now.value;
      version.value;
      return GANTT_W / Math.max(trace.duration(), SCALE_MIN);
    });

    s(
      label(vec(PAD, HEADER_Y), "trace", {
        size: 12,
        bold: true,
        align: Anchor.Left,
      }),
      label(
        vec(W - PAD, HEADER_Y),
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

    // Fresh slice per version-bump forces forEach to diff when new spans appear.
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
        const tagShape = label(bar.left.right(5), labelText, {
          size: 9,
          align: Anchor.Left,
          opacity: 0.9,
        });
        return [bar, tagShape];
      },
      { key: (span) => span },
    );

    s(
      label(
        view.bottom.up(10),
        "lanes stack one yield-array's siblings · sequential batches share lanes · nesting goes deeper",
        { size: 9, align: Anchor.Center, opacity: 0.5 },
      ),
    );
  }
}
