import {
  Diagram,
  Scene,
  circle,
  clipPath,
  computed,
  connect,
  forEach,
  group,
  label,
  line,
  pt,
  rect,
  t,
  viewport,
  when,
} from "../minim";
import * as R from "./rand";

const QR_GRID = 5;
const SIZE = 32;

export class MdLubyTransform extends Diagram {
  protected scene(s: Scene): void {
    // Reactive layout: viewport breakpoint drives both cell count and
    // viewBox width. Surviving cells keep their animation state across
    // breakpoint flips — no rebuild.
    const isMobile = computed(() => viewport().value.w < 768);
    const W = isMobile.map((m) => (m ? 300 : 400));
    const N = isMobile.map((m) => (m ? 7 : 10));
    const stride = computed(() => (W.value - SIZE) / (N.value - 1));
    const indices = N.map((n) => Array.from({ length: n }, (_, i) => i));

    const view = s.view(0, 0, W, 200);

    // Re-roll the cell pattern and source-edge gating each tick.
    const tick = this.anim.pulse(0.5);
    const cells = tick.map(() => R.bools(QR_GRID * QR_GRID));
    const edges = tick.map(() => R.bools(N.value, 0.3, 1));

    // ── Sources (top row) — reactive list. `sources.at(i)` exposes
    //    the i-th rect for the connection layer to anchor against.
    const sourcesLayer = s(group());
    const sources = forEach(sourcesLayer, indices, (i) => {
      const r = rect(() => i * stride.value, 24, SIZE, SIZE);
      const lbl = label(
        r.bounds.center,
        t("S").bold().sub(t(String(i + 1)).italic()),
        { size: 16 },
      );
      return [r, lbl];
    });

    // "..." trailing the last source — anchored to the last rect's
    // right edge via `sources.at(N - 1)`, so it tracks N reactively.
    s(label(
      pt(
        () => (sources.at(N.value - 1)?.bounds.right.x.value ?? 0) + 14,
        24 + SIZE / 2,
      ),
      t("..."),
      { size: 16, aside: true },
    ));

    // ── XOR & QR (static) ─────────────────────────────────────────────
    const xor = s(circle(view.center, 12));
    const qr = s(rect(view.center.down(60), SIZE, SIZE));

    s(
      line(xor.bounds.left, xor.bounds.right),
      line(xor.bounds.top, xor.bounds.bottom),
      connect(xor, qr, { thin: true }),
    );

    const cellsLayer = s(group());
    cellsLayer.attr("clip-path", clipPath(s, qr), "wrapper");
    qr.bounds.grid(QR_GRID, QR_GRID).flat().forEach((cellB, i) =>
      cellsLayer.add(rect(cellB, {
        fill: true,
        corner: 0,
        strokeWidth: 0.1,
        opacity: when(() => cells.value[i]),
      })),
    );

    // ── Source → XOR connections — reactive list, drawn last (on top).
    //    Anchors come from `sources.at(i)`'s rect bounds.
    const connectionsLayer = s(group());
    forEach(connectionsLayer, indices, (i) => {
      const src = sources.at(i);
      if (!src) return [];
      return connect(src.bounds.bottom, xor, {
        thin: true,
        opacity: when(() => edges.value[i]),
      });
    });
  }
}
