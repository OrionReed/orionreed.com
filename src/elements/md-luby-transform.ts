import {
  Diagram,
  Scene,
  circle,
  connect,
  css,
  label,
  line,
  pt,
  rect,
  signal,
  t,
} from "../scene-v2";
import * as R from "./rand";

const QR_GRID = 5;
const SOURCE_SIZE = 32;
const XOR_R = 12;
const QR_SIZE = 24;

function sampleSolitonApprox(): number {
  const r = Math.random();
  if (r < 0.1) return 1;
  if (r < 0.6) return 2;
  if (r < 0.75) return 3;
  if (r < 0.85) return 4;
  if (r < 0.92) return 5;
  if (r < 0.96) return 6;
  if (r < 0.98) return 7;
  if (r < 0.99) return 8;
  if (r < 0.995) return 9;
  return 10;
}

export class MdLubyTransform extends Diagram {
  protected setup(s: Scene): void {
    const isMobile = window.innerWidth < 768;
    const W = isMobile ? 300 : 400;
    const topCount = isMobile ? 7 : 10;
    const yTop = 24;
    const yXor = 100;
    const yQr = 160;

    const edgeOn = signal<boolean[]>(new Array(topCount).fill(false));
    const cellOn = signal<boolean[]>(new Array(QR_GRID * QR_GRID).fill(false));

    const sourceCx = (i: number) => {
      if (topCount <= 1) return W / 2;
      const span = W - SOURCE_SIZE;
      return SOURCE_SIZE / 2 + (i / (topCount - 1)) * span;
    };

    // Sources — fixed layout, static labels.
    const sources = Array.from({ length: topCount }, (_, i) => {
      const r = s(
        rect(sourceCx(i) - SOURCE_SIZE / 2, yTop, SOURCE_SIZE, SOURCE_SIZE),
      );
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

    // Trailing dots.
    const lastCx = sourceCx(topCount - 1);
    const dotsX = lastCx + SOURCE_SIZE / 2 + 6 + SOURCE_SIZE / 2;
    s(label(pt(dotsX, yTop + SOURCE_SIZE / 2), t("..."), { size: 16 }));

    // XOR — circle plus a butt-capped cross drawn through it.
    const xor = s(circle(pt(W / 2, yXor), XOR_R));
    s(
      line(xor.bounds.left, xor.bounds.right),
      line(xor.bounds.top, xor.bounds.bottom),
    );

    // QR frame + 5×5 cells. Each cell's visibility tracks `cellOn[i]`.
    const qr = s(
      rect(W / 2 - QR_SIZE / 2, yQr - QR_SIZE / 2, QR_SIZE, QR_SIZE),
    );
    const cellSize = QR_SIZE / QR_GRID;
    for (let row = 0; row < QR_GRID; row++) {
      for (let col = 0; col < QR_GRID; col++) {
        const i = row * QR_GRID + col;
        s(
          rect(
            qr.bounds.x() + col * cellSize,
            qr.bounds.y() + row * cellSize,
            cellSize,
            cellSize,
            { fill: true, corner: 0, opacity: () => (cellOn.value[i] ? 1 : 0) },
          ),
        );
      }
    }

    // Source → XOR edges. All topCount built once; visibility tracks `edgeOn[i]`.
    for (let i = 0; i < topCount; i++) {
      s(
        connect(sources[i].bounds.bottom, xor, {
          thin: true,
          opacity: () => (edgeOn.value[i] ? 1 : 0),
        }),
      );
    }

    // XOR → QR. Always visible.
    s(connect(xor, qr, { thin: true }));

    // Animate: every 500ms, randomize edges (soliton-approx count) + QR cells.
    this.anim.loop(function* () {
      const count = sampleSolitonApprox();
      const indices = R.shuffle(
        Array.from({ length: topCount }, (_, i) => i),
      ).slice(0, Math.min(count, topCount));
      const next = new Array(topCount).fill(false);
      for (const i of indices) next[i] = true;
      edgeOn.value = next;

      cellOn.value = Array.from({ length: QR_GRID * QR_GRID }, () =>
        R.chance(),
      );

      yield 500;
    });
  }
}
