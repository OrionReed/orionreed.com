// md-canvas-pick.ts — cross-type lenses (Canvas ↔ Color).
//
// `pixel(x,y)` is a writable `Color` at a reactive coordinate (raster
// analog of `Vec.x`); it tracks the cursor as a live swatch. `meanColor()`
// is a writable `Color` whose RGB field-lenses drive sliders — writing one
// rigidly shifts every pixel. A lens of a lens: Color's `.r` field over
// Canvas's mean.

import { effect, num } from "../../minim";
import { hsv, PANEL_CSS, panel, scene, slider } from "./canvas-demo-util";

const SIZE = 200;

export class MdCanvasPick extends HTMLElement {
  static get tagName(): string {
    return "md-canvas-pick";
  }
  static define(): void {
    if (!customElements.get(this.tagName)) customElements.define(this.tagName, this);
  }

  private shadow: ShadowRoot;
  private disposers: Array<() => void> = [];
  private source = scene(SIZE, "pick");
  private px = num(SIZE / 2);
  private py = num(SIZE / 2);
  private hueSeed = 140;

  constructor() {
    super();
    const d = this.disposers;
    const mean = this.source.meanColor();
    const pixel = this.source.pixel(this.px, this.py);

    this.shadow = this.attachShadow({ mode: "open" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`${PANEL_CSS}
      .panel { max-width: 220px; }
      .swatches { display: flex; flex-direction: column; gap: 10px; justify-content: center; }
      .swatch { width: 64px; height: 40px; border-radius: 6px; border: 1px solid #0003; }
      .sw-wrap { display: flex; align-items: center; gap: 10px; font: 11px var(--font, system-ui); color: var(--text-color); }
      .sliders { display: flex; flex-direction: column; gap: 4px; }
    `);
    this.shadow.adoptedStyleSheets = [sheet];

    const row = document.createElement("div");
    row.className = "row";
    const srcPanel = panel(this.source, "source · paint · hover to pick", d, {
      color: () => hsv((this.hueSeed += 59), 0.9, 0.95),
    });
    const cv = srcPanel.querySelector("canvas")!;
    const onMove = (e: PointerEvent): void => {
      const r = cv.getBoundingClientRect();
      this.px.value = ((e.clientX - r.left) / r.width) * SIZE;
      this.py.value = ((e.clientY - r.top) / r.height) * SIZE;
    };
    cv.addEventListener("pointermove", onMove);
    d.push(() => cv.removeEventListener("pointermove", onMove));

    const css = (c: { r: number; g: number; b: number }): string =>
      `rgb(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)})`;

    const swatches = document.createElement("div");
    swatches.className = "swatches";
    const pixSw = document.createElement("div");
    pixSw.className = "swatch";
    const pixWrap = document.createElement("div");
    pixWrap.className = "sw-wrap";
    pixWrap.append(
      pixSw,
      Object.assign(document.createElement("span"), { textContent: "pixel(x,y)" }),
    );
    const meanSw = document.createElement("div");
    meanSw.className = "swatch";
    const meanWrap = document.createElement("div");
    meanWrap.className = "sw-wrap";
    meanWrap.append(
      meanSw,
      Object.assign(document.createElement("span"), { textContent: "meanColor()" }),
    );
    const sliders = document.createElement("div");
    sliders.className = "sliders controls";
    sliders.append(
      slider("R", 0, 1, 0.01, mean.r, d),
      slider("G", 0, 1, 0.01, mean.g, d),
      slider("B", 0, 1, 0.01, mean.b, d),
    );
    swatches.append(pixWrap, meanWrap, sliders);

    d.push(
      effect(() => {
        pixSw.style.background = css(pixel.value);
      }),
      effect(() => {
        meanSw.style.background = css(mean.value);
      }),
    );

    row.append(srcPanel, swatches);

    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent =
      "Hover the source to read pixel(x,y) as a Color. Drag the R/G/B sliders — they are Color field-lenses over meanColor(), so each write rigidly shifts every pixel to move the image's average. Cross-type lenses both ways.";

    this.shadow.append(row, hint);
  }

  disconnectedCallback(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
  }
}
