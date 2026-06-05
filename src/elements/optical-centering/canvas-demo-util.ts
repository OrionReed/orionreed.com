// canvas-demo-util.ts — shared helpers for the raster-lens demos.

import {
  type Canvas,
  canvas,
  canvasStamp,
  effect,
  type Num,
  type Raster,
  type Writable,
} from "../../minim";

/** HSV→RGB, h in degrees, s/v in 0–1, out 0–255. */
export function hsv(h: number, s: number, v: number): [number, number, number] {
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

/** A rich test scene (gradient, discs, fine grid, label) — gives blur,
 *  edges, and downsample something legible to chew on. */
export function scene(size: number, label = "minim"): Writable<Canvas> {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const x = c.getContext("2d")!;
  const g = x.createLinearGradient(0, 0, size, size);
  g.addColorStop(0, "#15294d");
  g.addColorStop(0.55, "#3a1d57");
  g.addColorStop(1, "#5c1f3a");
  x.fillStyle = g;
  x.fillRect(0, 0, size, size);
  const discs: Array<[number, number, number, string]> = [
    [0.3, 0.32, 0.16, "#ffd34e"],
    [0.68, 0.38, 0.12, "#4ec9ff"],
    [0.55, 0.7, 0.18, "#54e08a"],
    [0.22, 0.72, 0.09, "#ff6f91"],
  ];
  for (const [cx, cy, r, fill] of discs) {
    x.beginPath();
    x.arc(cx * size, cy * size, r * size, 0, Math.PI * 2);
    x.fillStyle = fill;
    x.fill();
  }
  x.strokeStyle = "rgba(255,255,255,0.10)";
  x.lineWidth = 1;
  for (let i = 1; i < 10; i++) {
    const p = (i / 10) * size;
    x.beginPath();
    x.moveTo(p, 0);
    x.lineTo(p, size);
    x.moveTo(0, p);
    x.lineTo(size, p);
    x.stroke();
  }
  x.fillStyle = "#fff";
  x.font = `bold ${Math.round(size * 0.17)}px system-ui, sans-serif`;
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.fillText(label, size / 2, size * 0.5);
  const img = x.getImageData(0, 0, size, size).data;
  return canvas(size, size, (px, py) => {
    const i = (py * size + px) * 4;
    return [img[i]!, img[i + 1]!, img[i + 2]!, img[i + 3]!];
  });
}

/** Draw a raster to a 2D canvas, resizing to match. */
export function blit(r: Raster, cv: HTMLCanvasElement, ctx: CanvasRenderingContext2D): void {
  if (cv.width !== r.w || cv.height !== r.h) {
    cv.width = r.w;
    cv.height = r.h;
  }
  const img = ctx.createImageData(r.w, r.h);
  img.data.set(r.data);
  ctx.putImageData(img, 0, 0);
}

/** Soft round brush blending toward `(br,bg,bb)`; copy-on-write per step. */
export function discPaint(
  v: Raster,
  cx: number,
  cy: number,
  radius: number,
  br: number,
  bg: number,
  bb: number,
): Raster {
  const data = new Uint8ClampedArray(v.data);
  const { w, h } = v;
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(w - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(h - 1, Math.ceil(cy + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > radius) continue;
      const f = 1 - d / radius;
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

export interface PaintOpts {
  /** Brush colour, evaluated once per stroke. */
  color: () => [number, number, number];
  /** Brush radius in source pixels; a function is re-read per stroke. */
  radius?: number | (() => number);
}

/** Bind pointer painting to a 2D canvas backed by a writable cell. */
export function bindPaint(
  cv: HTMLCanvasElement,
  cell: Writable<Canvas>,
  opts: PaintOpts,
): () => void {
  const radiusOf = (): number =>
    typeof opts.radius === "function" ? opts.radius() : (opts.radius ?? 14);
  let drawing = false;
  let color: [number, number, number] = [255, 255, 255];
  let radius = 14;
  const at = (e: PointerEvent): [number, number] => {
    const r = cv.getBoundingClientRect();
    const v = cell.value;
    return [((e.clientX - r.left) / r.width) * v.w, ((e.clientY - r.top) / r.height) * v.h];
  };
  const stroke = (e: PointerEvent): void => {
    const [x, y] = at(e);
    cell.value = discPaint(cell.value, x, y, radius, color[0], color[1], color[2]);
  };
  const down = (e: PointerEvent): void => {
    drawing = true;
    try {
      cv.setPointerCapture(e.pointerId);
    } catch {}
    color = opts.color();
    radius = radiusOf();
    stroke(e);
  };
  const move = (e: PointerEvent): void => {
    if (drawing) stroke(e);
  };
  const up = (): void => {
    drawing = false;
  };
  cv.addEventListener("pointerdown", down);
  cv.addEventListener("pointermove", move);
  cv.addEventListener("pointerup", up);
  cv.addEventListener("pointercancel", up);
  return () => {
    cv.removeEventListener("pointerdown", down);
    cv.removeEventListener("pointermove", move);
    cv.removeEventListener("pointerup", up);
    cv.removeEventListener("pointercancel", up);
  };
}

/** A labeled panel rendering `cell` reactively; optional painting. */
export function panel(
  cell: Canvas | Writable<Canvas>,
  caption: string,
  disposers: Array<() => void>,
  paint?: PaintOpts,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "panel";
  const cv = document.createElement("canvas");
  const ctx = cv.getContext("2d", { alpha: true })!;
  const cap = document.createElement("div");
  cap.className = "cap";
  cap.textContent = caption;
  wrap.append(cv, cap);
  disposers.push(
    effect(() => {
      blit((cell as Canvas).value, cv, ctx);
    }),
  );
  if (paint) disposers.push(bindPaint(cv, cell as Writable<Canvas>, paint));
  return wrap;
}

/** Labelled range slider bound to a writable `Num`. */
export function slider(
  labelText: string,
  min: number,
  max: number,
  step: number,
  cell: Writable<Num>,
  disposers: Array<() => void>,
  fmt: (v: number) => string = v => v.toFixed(2),
): HTMLElement {
  const label = document.createElement("label");
  const name = document.createElement("span");
  name.textContent = labelText;
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(cell.peek());
  const val = document.createElement("span");
  val.className = "val";
  input.addEventListener("input", () => {
    cell.value = Number(input.value);
  });
  disposers.push(
    effect(() => {
      val.textContent = fmt((cell as Num).value);
    }),
  );
  label.append(name, input, val);
  return label;
}

/** Shared CSS for the demo elements. */
export const PANEL_CSS = `
  :host { display: block; margin: 1.25rem auto; max-width: 700px; }
  .row { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
  .panel { flex: 1 1 150px; max-width: 200px; }
  canvas {
    display: block; width: 100%; aspect-ratio: 1; border-radius: 6px;
    background: #0001; cursor: crosshair; touch-action: none;
  }
  .cap {
    margin-top: 6px; font: 11px/1.3 var(--font, system-ui);
    color: var(--text-color); opacity: 0.62; text-align: center;
  }
  .controls {
    display: flex; align-items: center; gap: 10px; justify-content: center;
    flex-wrap: wrap; margin: 14px auto 4px; font: 12px var(--font, system-ui);
    color: var(--text-color);
  }
  .controls label { display: inline-flex; align-items: center; gap: 6px; }
  .controls input[type=range] { width: 130px; }
  .controls .val { font-variant-numeric: tabular-nums; opacity: 0.7; min-width: 3ch; }
  button {
    font: 12px var(--font, system-ui); padding: 3px 10px; border-radius: 5px;
    border: 1px solid var(--text-color); background: transparent;
    color: var(--text-color); cursor: pointer; opacity: 0.8;
  }
  button:hover { opacity: 1; }
  .hint {
    text-align: center; margin: 10px auto 0; max-width: 92%;
    font: 10px/1.5 var(--font, system-ui); color: var(--text-color); opacity: 0.45;
  }
`;
