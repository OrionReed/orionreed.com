import {
  Diagram,
  Scene,
  circle,
  clipPath,
  computed,
  connect,
  group,
  label,
  line,
  rect,
  t,
  useViewport,
} from "../minim";
import * as R from "./rand";

const QR_GRID = 5;
const SIZE = 32;

export class MdLubyTransform extends Diagram {
  protected rebuildOn(): boolean {
    return useViewport().value.w < 768;
  }

  protected setup(s: Scene): void {
    const isMobile = window.innerWidth < 768;
    const W = isMobile ? 300 : 400;
    const N = isMobile ? 7 : 10;
    const view = s.view(0, 0, W, 200);

    const tick = this.anim.pulse(500);
    const cells = computed(() => {
      tick.value;
      return R.bools(QR_GRID * QR_GRID);
    });
    const edges = computed(() => {
      tick.value;
      return R.bools(N, 0.3, 1);
    });

    // Sources — N evenly-spaced squares spanning W along the top row.
    const stride = (W - SIZE) / (N - 1);
    const sources = Array.from({ length: N }, (_, i) => {
      const r = s(rect(i * stride, 24, SIZE, SIZE));
      s(
        label(
          r.bounds.center,
          t("S")
            .bold()
            .sub(t(String(i + 1)).italic()),
          { size: 16 },
        ),
      );
      return r;
    });

    s(
      label(sources[N - 1].bounds.right.right(SIZE / 2 + 6), t("..."), {
        size: 16,
        aside: true,
      }),
    );

    // XOR — circle centered on the view, with butt-capped cross.
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

    sources.forEach((src, i) =>
      s(
        connect(src.bounds.bottom, xor, {
          thin: true,
          opacity: () => (edges.value[i] ? 1 : 0),
        }),
      ),
    );
  }
}
