// md-canvas-lab.ts — forward lens gallery over one paintable source.
//
// One `Canvas` fans out into six live lens views with reactive knobs.
// Painting the source ripples to every view; turning a knob re-renders
// only the views that read it. Pure forward composition — the breadth of
// the lens family on display.

import { num } from "../../minim";
import { hsv, PANEL_CSS, panel, scene, slider } from "./canvas-demo-util";

const SIZE = 192;

export class MdCanvasLab extends HTMLElement {
  static get tagName(): string {
    return "md-canvas-lab";
  }
  static define(): void {
    if (!customElements.get(this.tagName)) customElements.define(this.tagName, this);
  }

  private shadow: ShadowRoot;
  private disposers: Array<() => void> = [];
  private radius = num(2.5);
  private levels = num(5);
  private hue = num(0);
  private source = scene(SIZE, "lens");
  private hueSeed = 30;

  constructor() {
    super();
    const d = this.disposers;
    const blurred = this.source.blur(this.radius);
    const quant = this.source.quantize(this.levels);
    const hued = this.source.hueRotate(this.hue);
    const edged = this.source.edges();
    const thumb = this.source.downsample(8);

    this.shadow = this.attachShadow({ mode: "open" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(PANEL_CSS);
    this.shadow.adoptedStyleSheets = [sheet];

    const row = document.createElement("div");
    row.className = "row";
    row.append(
      panel(this.source, "source · paint", d, {
        color: () => hsv((this.hueSeed += 47), 0.9, 0.95),
      }),
      panel(blurred, "blur(radius)", d),
      panel(quant, "quantize(levels)", d),
      panel(hued, "hueRotate(deg)", d),
      panel(edged, "edges()", d),
      panel(thumb, "downsample(8)", d),
    );

    const controls = document.createElement("div");
    controls.className = "controls";
    controls.append(
      slider("blur radius", 0, 6, 0.1, this.radius, d),
      slider("quantize levels", 2, 12, 1, this.levels, d, v => String(Math.round(v))),
      slider("hue shift", 0, 360, 1, this.hue, d, v => `${Math.round(v)}°`),
    );

    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent =
      "Six lenses over one source — geometric, photometric, spatial, multiscale. Paint the source; every view tracks. Knobs are reactive cells read inside the lenses.";

    this.shadow.append(row, controls, hint);
  }

  disconnectedCallback(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
  }
}
