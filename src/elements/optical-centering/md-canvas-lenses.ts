// md-canvas-lenses.ts — bireactive raster lenses.
//
// One source raster flows through a lens DAG:
//   source → brightness(k) → grayscale → invert
// Every panel is editable. Painting routes BACKWARD through the chain:
// drawing light on the luma view recolours the source (chroma recovered
// from the grayscale lens's complement); drawing on the inverted view
// routes two hops back. The brightness knob drives the chain FORWARD,
// touching only downstream panels. The reactive graph transports a tiny
// header per node (epoch identity) — never a pixel copy.

import {
  type Canvas,
  canvas,
  canvasStamp,
  effect,
  num,
  type Raster,
  type Writable,
} from "../../minim";

const SIZE = 200;
const BRUSH = 16;

/** HSV→RGB, all in 0–255 / degrees. */
function hsv(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = v - c;
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/** Soft round brush: blend toward `(br,bg,bb)` with quadratic falloff,
 *  returning a freshly-stamped raster (copy-on-write per stroke step —
 *  strokes are rare user events, unlike the per-frame lens passes). */
function discPaint(v: Raster, cx: number, cy: number, br: number, bg: number, bb: number): Raster {
  const data = new Uint8ClampedArray(v.data);
  const { w, h } = v;
  const x0 = Math.max(0, Math.floor(cx - BRUSH));
  const x1 = Math.min(w - 1, Math.ceil(cx + BRUSH));
  const y0 = Math.max(0, Math.floor(cy - BRUSH));
  const y1 = Math.min(h - 1, Math.ceil(cy + BRUSH));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > BRUSH) continue;
      const f = 1 - d / BRUSH;
      const a = f * f * 0.9;
      const i = (y * w + x) * 4;
      data[i] = data[i]! * (1 - a) + br * a;
      data[i + 1] = data[i + 1]! * (1 - a) + bg * a;
      data[i + 2] = data[i + 2]! * (1 - a) + bb * a;
      data[i + 3] = 255;
    }
  }
  return canvasStamp(data, w, h);
}

export class MdCanvasLenses extends HTMLElement {
  static get tagName(): string {
    return "md-canvas-lenses";
  }
  static define(): void {
    if (!customElements.get(this.tagName)) customElements.define(this.tagName, this);
  }

  private shadow: ShadowRoot;
  private disposers: Array<() => void> = [];

  // Lens DAG: source → brightness(k) → grayscale → invert.
  private bright = num(1);
  private source: Writable<Canvas> = canvas(SIZE, SIZE, (x, y) => {
    const [r, g, b] = hsv((x / SIZE) * 320, 0.85, 0.35 + 0.55 * (y / SIZE));
    return [r, g, b, 255];
  });
  private gray: Writable<Canvas>;
  private inverted: Writable<Canvas>;

  // Each fresh stroke on the source picks the next hue.
  private hueSeed = 20;

  constructor() {
    super();
    const brightened = this.source.brightness(this.bright);
    this.gray = brightened.grayscale();
    this.inverted = this.gray.invert();

    this.shadow = this.attachShadow({ mode: "open" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      :host { display: block; margin: 1.25rem auto; max-width: 680px; }
      .row { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
      .panel { flex: 1 1 180px; max-width: 200px; }
      canvas {
        display: block; width: 100%; aspect-ratio: 1; border-radius: 6px;
        background: #0001; cursor: crosshair; touch-action: none;
        image-rendering: auto;
      }
      .cap {
        margin-top: 6px; font: 11px/1.3 var(--font, system-ui);
        color: var(--text-color); opacity: 0.62; text-align: center;
      }
      .controls {
        display: flex; align-items: center; gap: 10px; justify-content: center;
        margin: 14px auto 4px; font: 12px var(--font, system-ui);
        color: var(--text-color);
      }
      .controls input { width: 200px; }
      .controls .val { font-variant-numeric: tabular-nums; opacity: 0.7; min-width: 3ch; }
      .hint {
        text-align: center; margin-top: 10px; max-width: 90%;
        margin-left: auto; margin-right: auto;
        font: 10px/1.5 var(--font, system-ui); color: var(--text-color); opacity: 0.45;
      }
    `);
    this.shadow.adoptedStyleSheets = [sheet];

    const row = document.createElement("div");
    row.className = "row";
    row.append(
      this.panel(this.source, "source · paint colour", "color"),
      this.panel(this.gray, "luma view · paint light", "light"),
      this.panel(this.inverted, "inverted · paint light", "light"),
    );

    const controls = document.createElement("div");
    controls.className = "controls";
    const label = document.createElement("span");
    label.textContent = "brightness k";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0.3";
    slider.max = "2";
    slider.step = "0.01";
    slider.value = "1";
    const val = document.createElement("span");
    val.className = "val";
    slider.addEventListener("input", () => {
      this.bright.value = Number(slider.value);
    });
    this.disposers.push(
      effect(() => {
        val.textContent = `${this.bright.value.toFixed(2)}×`;
      }),
    );
    controls.append(label, slider, val);

    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent =
      "Draw on any panel — edits route backward through the lens chain (chroma recovered from the grayscale lens's complement). The knob drives the chain forward. No pixels cross the reactive graph: only a per-node epoch header.";

    this.shadow.append(row, controls, hint);
  }

  disconnectedCallback(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
  }

  private panel(cell: Writable<Canvas>, caption: string, brush: "color" | "light"): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "panel";
    const cv = document.createElement("canvas");
    cv.width = SIZE;
    cv.height = SIZE;
    const ctx = cv.getContext("2d", { alpha: true })!;
    const cap = document.createElement("div");
    cap.className = "cap";
    cap.textContent = caption;
    wrap.append(cv, cap);

    this.disposers.push(
      effect(() => {
        const v = cell.value;
        if (cv.width !== v.w || cv.height !== v.h) {
          cv.width = v.w;
          cv.height = v.h;
        }
        const img = ctx.createImageData(v.w, v.h);
        img.data.set(v.data);
        ctx.putImageData(img, 0, 0);
      }),
    );

    this.bindPaint(cv, cell, brush);
    return wrap;
  }

  private bindPaint(cv: HTMLCanvasElement, cell: Writable<Canvas>, brush: "color" | "light"): void {
    let drawing = false;
    let color: [number, number, number] = [255, 255, 255];

    const at = (e: PointerEvent): { x: number; y: number } => {
      const r = cv.getBoundingClientRect();
      const v = cell.value;
      return {
        x: ((e.clientX - r.left) / r.width) * v.w,
        y: ((e.clientY - r.top) / r.height) * v.h,
      };
    };
    const stroke = (e: PointerEvent): void => {
      const { x, y } = at(e);
      cell.value = discPaint(cell.value, x, y, color[0], color[1], color[2]);
    };
    const down = (e: PointerEvent): void => {
      drawing = true;
      try {
        cv.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic / already-released pointers can't be captured; ignore.
      }
      color = brush === "color" ? hsv((this.hueSeed += 47), 0.9, 0.95) : [245, 245, 245];
      stroke(e);
    };
    const move = (e: PointerEvent): void => {
      if (drawing) stroke(e);
    };
    const up = (e: PointerEvent): void => {
      drawing = false;
      if (cv.hasPointerCapture(e.pointerId)) cv.releasePointerCapture(e.pointerId);
    };
    cv.addEventListener("pointerdown", down);
    cv.addEventListener("pointermove", move);
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", up);
    this.disposers.push(() => {
      cv.removeEventListener("pointerdown", down);
      cv.removeEventListener("pointermove", move);
      cv.removeEventListener("pointerup", up);
      cv.removeEventListener("pointercancel", up);
    });
  }
}
