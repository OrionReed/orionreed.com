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
    const W = computed(() => (isMobile.value ? 300 : 400));
    const N = computed(() => (isMobile.value ? 7 : 10));
    const stride = computed(() => (W.value - SIZE) / (N.value - 1));
    const indices = computed(() => Array.from({ length: N.value }, (_, i) => i));

    const view = s.view(0, 0, W, 200);

    const tick = this.anim.pulse(0.5);
    const cells = computed(() => {
      tick.value;
      return R.bools(QR_GRID * QR_GRID);
    });
    const edges = computed(() => {
      tick.value;
      // Re-rolled per tick; sized to current N.
      return R.bools(N.value, 0.3, 1);
    });

    // ── Sources (top row) — reactive list ─────────────────────────────
    const sourcesLayer = s(group());
    forEach(sourcesLayer, indices, (i) => {
      const r = rect(() => i * stride.value, 24, SIZE, SIZE);
      const lbl = label(
        r.bounds.center,
        t("S").bold().sub(t(String(i + 1)).italic()),
        { size: 16 },
      );
      return [r, lbl];
    });

    // "..." label trailing the last source — position from math, not
    // from a shape reference (forEach owns those).
    s(
      label(
        pt(() => (N.value - 1) * stride.value + SIZE + 14, 24 + SIZE / 2),
        t("..."),
        { size: 16, aside: true },
      ),
    );

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
    qr.bounds
      .grid(QR_GRID, QR_GRID)
      .flat()
      .forEach((cellB, i) =>
        cellsLayer.add(
          rect(cellB, {
            fill: true,
            corner: 0,
            strokeWidth: 0.1,
            opacity: () => (cells.value[i] ? 1 : 0),
          }),
        ),
      );

    // ── Source → XOR connections — reactive list, drawn last (on top) ──
    const connectionsLayer = s(group());
    forEach(connectionsLayer, indices, (i) => {
      // Bottom-center of source rect at index `i` — derived from math,
      // not a shape reference, so the connection survives forEach
      // boundaries.
      const sourceBottom = pt(
        () => i * stride.value + SIZE / 2,
        24 + SIZE,
      );
      return connect(sourceBottom, xor, {
        thin: true,
        opacity: () => (edges.value[i] ? 1 : 0),
      });
    });
  }
}
