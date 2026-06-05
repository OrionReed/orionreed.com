// md-canvas-deblur.ts — editing the blurred output (approximate deconv).
//
// `blur(radius)` is a writable lens: its backward injects the
// high-frequency difference `target − blur(source)` (gain λ) into the
// source — a Van-Cittert/unsharp step. Paint on the blurred view and the
// source sharpens to explain your edit. PutGet, not exact GetPut: the
// forward genuinely discards detail, so it recovers a *plausible* source.

import { num } from "../../minim";
import { hsv, PANEL_CSS, panel, scene, slider } from "./canvas-demo-util";

const SIZE = 200;

export class MdCanvasDeblur extends HTMLElement {
  static get tagName(): string {
    return "md-canvas-deblur";
  }
  static define(): void {
    if (!customElements.get(this.tagName)) customElements.define(this.tagName, this);
  }

  private shadow: ShadowRoot;
  private disposers: Array<() => void> = [];
  private radius = num(3);
  private lambda = num(1.2);
  private source = scene(SIZE, "sharp");
  private blurred: ReturnType<MdCanvasDeblur["mkBlur"]>;
  private hueSeed = 200;

  private mkBlur() {
    return this.source.blur(this.radius, this.lambda);
  }

  constructor() {
    super();
    const d = this.disposers;
    this.blurred = this.mkBlur();

    this.shadow = this.attachShadow({ mode: "open" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`${PANEL_CSS}\n.panel { max-width: 240px; }`);
    this.shadow.adoptedStyleSheets = [sheet];

    const row = document.createElement("div");
    row.className = "row";
    row.append(
      panel(this.source, "source · sharpens to match", d, {
        color: () => hsv((this.hueSeed += 61), 0.9, 0.95),
      }),
      panel(this.blurred, "blurred · paint here", d, {
        color: () => hsv((this.hueSeed += 61), 0.95, 0.98),
      }),
    );

    const controls = document.createElement("div");
    controls.className = "controls";
    controls.append(
      slider("blur radius", 0.5, 6, 0.1, this.radius, d),
      slider("deconv λ", 0, 2.5, 0.05, this.lambda, d),
    );

    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent =
      "Draw on the blurred panel; the source updates so its blur explains your stroke (gain λ). Crank radius to see the forward blur; crank λ to push the inverse harder — too high and it rings, the honest signature of deconvolution.";

    this.shadow.append(row, controls, hint);
  }

  disconnectedCallback(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
  }
}
