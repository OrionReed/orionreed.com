import {
  circle,
  clipPath,
  connect,
  derive,
  Diagram,
  every,
  forEach,
  grid,
  group,
  label,
  line,
  Mount,
  num,
  rect,
  t,
  Vec,
  vec,
  viewport,
} from "../minim";
import * as R from "./rand";

const QR_GRID = 5;
const SIZE = 32;

export class MdLubyTransform extends Diagram {
  protected scene(s: Mount): void {
    const isMobile = derive(() => viewport().value.w < 768);
    const W = derive(() => ((m: boolean) => (m ? 300 : 400))(isMobile.value));
    const N = derive(() => ((m: boolean) => (m ? 7 : 10))(isMobile.value));
    const stride = derive(() => (W.value - SIZE) / (N.value - 1));
    const indices = derive(() =>
      ((n: number) => Array.from({ length: n }, (_, i) => i))(N.value),
    );

    const view = this.view(W, 200);

    const tick = num(0);
    this.anim.start(
      every(0.5, () => {
        tick.value++;
      }),
    );
    const cells = derive(() => {
      void tick.value;
      return R.bools(QR_GRID * QR_GRID);
    });
    const edges = derive(() => {
      void tick.value;
      return R.bools(N.value, 0.3, 1);
    });

    const sourcesLayer = s(group());
    const sources = forEach(sourcesLayer, indices, i => {
      const r = rect(derive(() => i * stride.value), 24, SIZE, SIZE);
      const lbl = label(
        r.center,
        t("S")
          .bold()
          .sub(t(String(i + 1)).italic()),
        { size: 16 },
      );
      return [r, lbl];
    });

    s(
      label(
        Vec.derive(() => ({
          x: (sources.at(N.value - 1)?.right.x.value ?? 0) + 14,
          y: 24 + SIZE / 2,
        })),
        t("..."),
        { size: 16, aside: true },
      ),
    );

    const xor = s(circle(view.center, 12));
    const qr = s(rect(view.center.down(60), SIZE, SIZE));

    s(line(xor.left, xor.right), line(xor.top, xor.bottom), connect(xor, qr, { thin: true }));

    const cellsLayer = s(group());
    cellsLayer.attr("clip-path", clipPath(qr), "wrapper");
    grid(qr.box, QR_GRID, QR_GRID)
      .flat()
      .forEach((cellB, i) =>
        cellsLayer.add(
          rect(cellB, {
            fill: true,
            corner: 0,
            strokeWidth: 0.1,
            opacity: derive(() => (cells.value[i] ? 1 : 0)),
          }),
        ),
      );

    const connectionsLayer = s(group());
    forEach(connectionsLayer, indices, i => {
      const src = sources.at(i);
      if (!src) return [];
      return connect(src.bottom, xor, {
        thin: true,
        opacity: derive(() => (edges.value[i] ? 1 : 0)),
      });
    });
  }
}
