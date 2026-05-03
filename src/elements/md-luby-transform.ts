import { css } from "./base-element";
import * as R from "./rand";
import { Padding, Scene, t } from "./draw";
import { pt } from "./geom";
import { SceneElement } from "./scene-element";

export class MdLubyTransform extends SceneElement {
  private edgeStates: Map<string, boolean> = new Map();
  private qrCellStates: boolean[] = [];

  static styles = css`
    :host {
      --scene-max-width: 400px;
      margin: 0;
    }
  `;

  get topCount(): number {
    return window.innerWidth < 768 ? 7 : 10;
  }

  get qrGridSize(): number {
    return 5;
  }

  private sampleSolitonApprox(): number {
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

  private randomizeQr(): void {
    const total = this.qrGridSize * this.qrGridSize;
    this.qrCellStates = Array.from({ length: total }, () => R.chance());
  }

  private setRandomEdges(count: number): void {
    this.edgeStates.clear();
    if (count <= 0) return;
    const indices = Array.from({ length: this.topCount }, (_, i) => i);
    const chosen = R.shuffle(indices).slice(0, Math.min(count, this.topCount));
    for (const i of chosen) this.edgeStates.set(`s${i}`, true);
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.anim.loop(async () => {
      this.setRandomEdges(this.sampleSolitonApprox());
      this.randomizeQr();
      this.render();
      await this.anim.wait(500);
    });
  }

  // 0 horizontal padding so sources span the full width like the original;
  // 26 vertical padding restores the original 400x200 viewBox aspect.
  protected scenePadding(): Padding {
    return { x: 0, y: 26 };
  }

  protected draw(s: Scene): void {
    const isMobile = window.innerWidth < 768;
    const W = isMobile ? 300 : 400;
    const sourceSize = 32;
    const xorR = 12;
    const qrSize = 24;
    const yTop = 24;
    const yXor = 100;
    const yQr = 160;

    const sourceCx = (i: number): number => {
      if (this.topCount <= 1) return W / 2;
      const span = W - sourceSize;
      return sourceSize / 2 + (i / (this.topCount - 1)) * span;
    };

    // Sources, drawn together with their labels.
    const sources = Array.from({ length: this.topCount }, (_, i) => {
      const r = s.rect(
        sourceCx(i) - sourceSize / 2,
        yTop,
        sourceSize,
        sourceSize,
      );
      s.label(
        r.bounds.center,
        t("S")
          .bold()
          .sub(t(String(i + 1)).italic()),
        { size: 16 },
      );
      return r;
    });

    if (this.topCount > 0) {
      const lastCx = sourceCx(this.topCount - 1);
      const dotsX = lastCx + sourceSize / 2 + 6 + sourceSize / 2;
      s.label(pt(dotsX, yTop + sourceSize / 2), t("..."), { size: 16 });
    }

    // XOR: circle + cross. Cross uses butt cap so it doesn't poke past.
    const xor = s.circle(W / 2, yXor, xorR);
    s.line(xor.bounds.left, xor.bounds.right, { cap: "butt" });
    s.line(xor.bounds.top, xor.bounds.bottom, { cap: "butt" });

    // QR: outer rect + filled cells
    const qr = s.rect(W / 2 - qrSize / 2, yQr - qrSize / 2, qrSize, qrSize);
    const cellSize = qrSize / this.qrGridSize;
    for (let row = 0; row < this.qrGridSize; row++) {
      for (let col = 0; col < this.qrGridSize; col++) {
        if (this.qrCellStates[row * this.qrGridSize + col]) {
          s.rect(
            qr.bounds.x + col * cellSize,
            qr.bounds.y + row * cellSize,
            cellSize,
            cellSize,
            { fill: true, corner: 0 },
          );
        }
      }
    }

    // Connectors clip to actual scene nodes — no separate "virtual"
    // geometry needed; nodes are Shapes too.
    for (let i = 0; i < this.topCount; i++) {
      if (!this.edgeStates.get(`s${i}`)) continue;
      s.line(sources[i].bounds.bottom, xor, { thin: true });
    }
    s.line(xor, qr, { thin: true });
  }
}
