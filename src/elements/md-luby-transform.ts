import { BaseElement, css } from "./base-element";
import * as R from "./rand";
import { Scene, circleShape, rectShape, t } from "./draw";
import { pt } from "./geom";

export class MdLubyTransform extends BaseElement {
  private edgeStates: Map<string, boolean> = new Map();
  private qrCellStates: boolean[] = [];

  static styles = css`
    :host {
      display: block;
      margin: 0;
    }

    .container {
      padding: 1rem;
      display: flex;
      justify-content: center;
      align-items: center;
    }

    .vis {
      width: 100%;
      max-width: 400px;
    }

    svg {
      width: 100%;
      height: auto;
      overflow: visible;
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

  protected render(): void {
    const isMobile = window.innerWidth < 768;
    const W = isMobile ? 300 : 400;
    const sourceSize = 32;
    const xorR = 12;
    const qrSize = 24;
    // yTop is the TOP of the source rects. y=24 matches the original
    // layout where source center was at y=40 (40 - sourceSize/2).
    const yTop = 24;
    const yXor = 100;
    const yQr = 160;

    // 0 horizontal padding so sources span the full width like the original;
    // 26 vertical padding restores the original 400x200 viewBox aspect.
    const s = new Scene({ padding: { x: 0, y: 26 } });

    // Source positions (center x of each source rect)
    const sourceCx = (i: number): number => {
      if (this.topCount <= 1) return W / 2;
      const span = W - sourceSize;
      return sourceSize / 2 + (i / (this.topCount - 1)) * span;
    };

    const xorCenter = pt(W / 2, yXor);
    const qrCenter = pt(W / 2, yQr);
    const qrX = qrCenter.x - qrSize / 2;
    const qrY = qrCenter.y - qrSize / 2;

    // Virtual shapes used for clipping before the real shapes exist.
    const xorVirtual = circleShape(xorCenter.x, xorCenter.y, xorR);
    const qrVirtual = rectShape({ x: qrX, y: qrY, w: qrSize, h: qrSize });
    const sourceVirtuals = Array.from({ length: this.topCount }, (_, i) => {
      const cx = sourceCx(i);
      return rectShape({
        x: cx - sourceSize / 2,
        y: yTop,
        w: sourceSize,
        h: sourceSize,
      });
    });

    // ALL connectors first so the actual nodes render ON TOP. This means
    // shape strokes hide line endpoints — no T-junction smudges anywhere.
    for (let i = 0; i < this.topCount; i++) {
      if (!this.edgeStates.get(`s${i}`)) continue;
      s.line(sourceVirtuals[i].edge("bottom"), xorVirtual, { thin: true });
    }
    s.line(xorVirtual, qrVirtual, { thin: true });

    // Source nodes
    for (let i = 0; i < this.topCount; i++) {
      const b = sourceVirtuals[i].bounds;
      s.rect(b.x, b.y, b.w, b.h);
      s.label(
        pt(b.x + b.w / 2, b.y + b.h / 2),
        t("S").bold().sub(t(String(i + 1)).italic()),
        { size: 16 }
      );
    }

    // Dots — aside
    if (this.topCount > 0) {
      const lastCx = sourceCx(this.topCount - 1);
      const dotsX = lastCx + sourceSize / 2 + 6 + sourceSize / 2;
      s.label(pt(dotsX, yTop + sourceSize / 2), t("..."), { size: 16 });
    }

    // XOR: circle + cross. Cross uses butt cap so it doesn't poke past.
    s.circle(xorCenter.x, xorCenter.y, xorR);
    s.line(
      pt(xorCenter.x - xorR, xorCenter.y),
      pt(xorCenter.x + xorR, xorCenter.y),
      { cap: "butt" }
    );
    s.line(
      pt(xorCenter.x, xorCenter.y - xorR),
      pt(xorCenter.x, xorCenter.y + xorR),
      { cap: "butt" }
    );

    // QR: outer rect + filled cells
    s.rect(qrX, qrY, qrSize, qrSize);
    const cellSize = qrSize / this.qrGridSize;
    for (let row = 0; row < this.qrGridSize; row++) {
      for (let col = 0; col < this.qrGridSize; col++) {
        if (this.qrCellStates[row * this.qrGridSize + col]) {
          s.rect(
            qrX + col * cellSize,
            qrY + row * cellSize,
            cellSize,
            cellSize,
            { solid: true, corner: 0 }
          );
        }
      }
    }

    this.shadow.innerHTML = `
      <div class="container">
        <div class="vis"><svg></svg></div>
      </div>
    `;
    s.render(this.shadow.querySelector("svg") as SVGSVGElement);
  }
}
