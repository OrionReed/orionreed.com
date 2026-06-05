// canvas-demo-util.ts — shared helpers for the GPU raster-lens demo.
//
// Pixels live in GPU textures (see minim/signals/values/gpu.ts). Painting is
// a GPU brush pass with a feedback-safe ping-pong, display is a GPU blit into
// each node's own 2D canvas — no CPU pixel loops, no readbacks.

import {
  type Canvas,
  canvas,
  canvasStamp,
  gpuBlit,
  gpuBrush,
  gpuScratch2,
  type Raster,
  type Tex,
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

/** A rich test scene (gradient, discs, fine grid, label), uploaded once to a
 *  GPU texture. `palette` shifts the hues so spring targets read distinctly. */
export function scene(size: number, label = "minim", hueShift = 0): Writable<Canvas> {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const x = c.getContext("2d")!;
  const g = x.createLinearGradient(0, 0, size, size);
  const rot = (deg: number): string => {
    const [r, gg, b] = hsv(deg + hueShift, 0.6, 0.42);
    return `rgb(${r | 0},${gg | 0},${b | 0})`;
  };
  g.addColorStop(0, rot(220));
  g.addColorStop(0.55, rot(285));
  g.addColorStop(1, rot(340));
  x.fillStyle = g;
  x.fillRect(0, 0, size, size);
  const discs: Array<[number, number, number, number]> = [
    [0.3, 0.32, 0.16, 45],
    [0.68, 0.38, 0.12, 200],
    [0.55, 0.7, 0.18, 140],
    [0.22, 0.72, 0.09, 340],
  ];
  for (const [cx, cy, r, hue] of discs) {
    const [rr, gg, bb] = hsv(hue + hueShift, 0.85, 1);
    x.beginPath();
    x.arc(cx * size, cy * size, r * size, 0, Math.PI * 2);
    x.fillStyle = `rgb(${rr | 0},${gg | 0},${bb | 0})`;
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

/** Blit a GPU raster into a 2D canvas (GPU draw + drawImage; no readback). */
export function blit(r: Raster, ctx: CanvasRenderingContext2D): void {
  gpuBlit({ tex: r.tex, w: r.w, h: r.h }, ctx);
}

export interface PaintOpts {
  /** Brush colour (0–255), evaluated once per stroke. */
  color: () => [number, number, number];
  /** Brush radius in source pixels; a function is re-read per stroke. */
  radius?: number | (() => number);
}

/** Bind pointer painting to a node canvas backed by a writable cell. Each
 *  stamp is a GPU brush pass into a feedback-safe ping-pong texture. */
export function bindPaint(
  cv: HTMLCanvasElement,
  cell: Writable<Canvas>,
  opts: PaintOpts,
): () => void {
  const radiusOf = (): number =>
    typeof opts.radius === "function" ? opts.radius() : (opts.radius ?? 14);
  const ping = gpuScratch2();
  let drawing = false;
  let color: [number, number, number] = [1, 1, 1];
  let radius = 14;
  const at = (e: PointerEvent): [number, number] => {
    const r = cv.getBoundingClientRect();
    const v = cell.value;
    return [((e.clientX - r.left) / r.width) * v.w, ((e.clientY - r.top) / r.height) * v.h];
  };
  const stroke = (e: PointerEvent): void => {
    const [px, py] = at(e);
    const v = cell.value;
    const dst = ping(v.w, v.h, v.tex) as Tex;
    gpuBrush(v.tex, dst, px, py, radius, color);
    cell.value = canvasStamp(dst.tex, v.w, v.h);
  };
  const down = (e: PointerEvent): void => {
    drawing = true;
    try {
      cv.setPointerCapture(e.pointerId);
    } catch {}
    const [r, g, b] = opts.color();
    color = [r / 255, g / 255, b / 255];
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
