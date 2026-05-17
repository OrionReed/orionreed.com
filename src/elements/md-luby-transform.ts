import {Diagram, Mount, signal, circle, clipPath, connect, computed, every, forEach, grid, group, label, line, num, vec, rect, t, viewport, when} from "../minim";
import * as R from "./rand";

const QR_GRID = 5;
const SIZE = 32;

export class MdLubyTransform extends Diagram {
  protected scene(s: Mount): void {
    // Reactive layout: viewport breakpoint drives both signal count and
    // viewBox width. Surviving cells keep their animation state across
    // breakpoint flips — no rebuild.
    const isMobile = computed(() => viewport().value.w < 768);
    const W = computed(() => ((m: boolean) => (m ? 300 : 400))(isMobile.value));
    const N = computed(() => ((m: boolean) => (m ? 7 : 10))(isMobile.value));
    const stride = computed(() => (W.value - SIZE) / (N.value - 1));
    const indices = computed(() => ((n: number) =>
      Array.from({ length: n }, (_, i) => i)
    )(N.value));

    const view = this.view(W, 200);

    // Re-roll the signal pattern and source-edge gating each tick.
    const tick = num(0);
    this.anim.start(every(0.5, () => { tick.value++; }));
    const cells = computed(() => { void tick.value; return R.bools(QR_GRID * QR_GRID); });
    const edges = computed(() => { void tick.value; return R.bools(N.value, 0.3, 1); });

    // ── Sources (top row) — reactive list. `sources.at(i)` exposes
    //    the i-th rect for the connection layer to anchor against.
    const sourcesLayer = s(group());
    const sources = forEach(sourcesLayer, indices, (i) => {
      const r = rect(() => i * stride.value, 24, SIZE, SIZE);
      const lbl = label(
        r.center,
        t("S").bold().sub(t(String(i + 1)).italic()),
        { size: 16 },
      );
      return [r, lbl];
    });

    // "..." trailing the last source — anchored to the last rect's
    // right edge via `sources.at(N - 1)`, so it tracks N reactively.
    s(label(
      vec(
        () => (sources.at(N.value - 1)?.right.x.value ?? 0) + 14,
        24 + SIZE / 2,
      ),
      t("..."),
      { size: 16, aside: true },
    ));

    // ── XOR & QR (static) ─────────────────────────────────────────────
    const xor = s(circle(view.center, 12));
    const qr = s(rect(view.center.down(60), SIZE, SIZE));

    s(
      line(xor.left, xor.right),
      line(xor.top, xor.bottom),
      connect(xor, qr, { thin: true }),
    );

    const cellsLayer = s(group());
    cellsLayer.attr("clip-path", clipPath(qr), "wrapper");
    grid(qr, QR_GRID, QR_GRID).flat().forEach((cellB, i) =>
      cellsLayer.add(rect(cellB, {
        fill: true,
        corner: 0,
        strokeWidth: 0.1,
        opacity: () => (cells.value[i]) ? 1 : 0,
      })),
    );

    // ── Source → XOR connections — reactive list, drawn last (on top).
    //    Anchors come from `sources.at(i)`'s rect bounds.
    const connectionsLayer = s(group());
    forEach(connectionsLayer, indices, (i) => {
      const src = sources.at(i);
      if (!src) return [];
      return connect(src.bottom, xor, {
        thin: true,
        opacity: () => (edges.value[i]) ? 1 : 0,
      });
    });
  }
}
