// md-canvas-pyramid.ts — bireactive multiscale lens.
//
// `downsample(f)` projects to a thumbnail; its complement is the Laplacian
// residual `source − up(down(source))`. Paint the blocky thumbnail and the
// edit writes back at full resolution with the original fine detail (grid,
// label, disc edges) reconstructed on top — edit coarse structure, fine
// texture rides along. The image twin of `str.sortedUnique`.

import { hsv, PANEL_CSS, panel, scene } from "./canvas-demo-util";

const SIZE = 192;
const FACTOR = 12;

export class MdCanvasPyramid extends HTMLElement {
  static get tagName(): string {
    return "md-canvas-pyramid";
  }
  static define(): void {
    if (!customElements.get(this.tagName)) customElements.define(this.tagName, this);
  }

  private shadow: ShadowRoot;
  private disposers: Array<() => void> = [];
  private source = scene(SIZE, "scale");
  private hueSeed = 90;

  constructor() {
    super();
    const d = this.disposers;
    const thumb = this.source.downsample(FACTOR);

    this.shadow = this.attachShadow({ mode: "open" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(
      `${PANEL_CSS}\n.panel.big { max-width: 260px; }\ncanvas.thumb { image-rendering: pixelated; }`,
    );
    this.shadow.adoptedStyleSheets = [sheet];

    const row = document.createElement("div");
    row.className = "row";
    const srcPanel = panel(this.source, "source · full detail", d, {
      color: () => hsv((this.hueSeed += 53), 0.9, 0.95),
    });
    srcPanel.classList.add("big");
    const thumbPanel = panel(thumb, `thumbnail ${SIZE / FACTOR}² · paint here`, d, {
      color: () => hsv((this.hueSeed += 53), 0.95, 0.95),
      radius: 1.4,
    });
    thumbPanel.classList.add("big");
    thumbPanel.querySelector("canvas")?.classList.add("thumb");
    row.append(srcPanel, thumbPanel);

    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent =
      "Paint the coarse thumbnail (right). The edit routes back through downsample's Laplacian complement, so the source (left) keeps its full-resolution detail under your strokes. Box-down ∘ nearest-up = identity, so it round-trips exactly.";

    this.shadow.append(row, hint);
  }

  disconnectedCallback(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
  }
}
