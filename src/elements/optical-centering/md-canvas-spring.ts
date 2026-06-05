// md-canvas-spring.ts — GPU pixel-space spring (flagship GPU demo).
//
// Per-pixel spring state lives in float textures and never leaves the
// card; each pixel chases the target image as an independent damped
// oscillator. Stiffness/damping are reactive cells pushed into the
// integrator; retargeting swaps the target texture. The reactive graph
// only ever sees scalars — the pixels stay resident, exactly the
// "value changed → GPU re-renders" loop, inverted to "knob changed →
// GPU re-reads."

import { canvasStamp, effect, GpuSpring, num, type Raster } from "../../minim";
import { PANEL_CSS, slider } from "./canvas-demo-util";

const SIZE = 224;

/** A set of visually distinct targets to spring between. */
function targets(size: number): Raster[] {
  const out: Raster[] = [];
  const mk = (draw: (x: CanvasRenderingContext2D) => void): Raster => {
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const x = c.getContext("2d")!;
    draw(x);
    const data = x.getImageData(0, 0, size, size).data;
    return canvasStamp(new Uint8ClampedArray(data), size, size);
  };
  // radial rainbow
  out.push(
    mk(x => {
      for (let i = 0; i < 360; i += 2) {
        x.beginPath();
        x.moveTo(size / 2, size / 2);
        x.arc(size / 2, size / 2, size, ((i - 1) * Math.PI) / 180, ((i + 1) * Math.PI) / 180);
        x.closePath();
        x.fillStyle = `hsl(${i} 80% 55%)`;
        x.fill();
      }
    }),
  );
  // concentric rings
  out.push(
    mk(x => {
      x.fillStyle = "#101020";
      x.fillRect(0, 0, size, size);
      for (let r = size * 0.5; r > 0; r -= size * 0.07) {
        x.beginPath();
        x.arc(size / 2, size / 2, r, 0, Math.PI * 2);
        x.fillStyle = `hsl(${(r * 4) % 360} 70% ${r < size * 0.2 ? 70 : 50}%)`;
        x.fill();
      }
    }),
  );
  // hue checker
  out.push(
    mk(x => {
      const n = 8;
      const s = size / n;
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          x.fillStyle = `hsl(${((i + j) * 40) % 360} 75% ${(i + j) % 2 ? 60 : 38}%)`;
          x.fillRect(i * s, j * s, s + 1, s + 1);
        }
    }),
  );
  // label
  out.push(
    mk(x => {
      const g = x.createLinearGradient(0, 0, size, size);
      g.addColorStop(0, "#1d3b6e");
      g.addColorStop(1, "#6e1d52");
      x.fillStyle = g;
      x.fillRect(0, 0, size, size);
      x.fillStyle = "#ffe";
      x.font = `bold ${Math.round(size * 0.26)}px system-ui, sans-serif`;
      x.textAlign = "center";
      x.textBaseline = "middle";
      x.fillText("spring", size / 2, size / 2);
    }),
  );
  return out;
}

export class MdCanvasSpring extends HTMLElement {
  static get tagName(): string {
    return "md-canvas-spring";
  }
  static define(): void {
    if (!customElements.get(this.tagName)) customElements.define(this.tagName, this);
  }

  private shadow: ShadowRoot;
  private disposers: Array<() => void> = [];
  private raf = 0;
  private gpu: GpuSpring | null = null;
  private stiff = num(120);
  private damp = num(16);
  private settled = num(0);

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: "open" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`${PANEL_CSS}
      .stage { display: flex; justify-content: center; }
      canvas.gl { width: ${SIZE}px; max-width: 100%; aspect-ratio: 1; border-radius: 8px; cursor: default; }
      .thumbs { display: flex; gap: 8px; justify-content: center; margin-top: 12px; flex-wrap: wrap; }
      .thumbs canvas { width: 46px; height: 46px; border-radius: 5px; cursor: pointer; border: 2px solid transparent; }
      .thumbs canvas.on { border-color: #4ec9ff; }
      .state { text-align: center; font: 11px var(--font, system-ui); color: var(--text-color); opacity: 0.6; margin-top: 8px; }
      .fallback { text-align: center; color: var(--text-color); opacity: 0.7; font: 13px var(--font, system-ui); padding: 2rem; }
    `);
    this.shadow.adoptedStyleSheets = [sheet];
  }

  connectedCallback(): void {
    const d = this.disposers;
    const imgs = targets(SIZE);
    const gl = document.createElement("canvas");
    gl.width = SIZE;
    gl.height = SIZE;
    gl.className = "gl";

    let gpu: GpuSpring;
    try {
      gpu = new GpuSpring(gl, SIZE, SIZE, {
        stiffness: this.stiff.peek(),
        damping: this.damp.peek(),
      });
    } catch (err) {
      const fb = document.createElement("div");
      fb.className = "fallback";
      fb.textContent = `GPU spring needs WebGL2 + float render targets (${(err as Error).message}).`;
      this.shadow.append(fb);
      return;
    }
    this.gpu = gpu;
    gpu.setImage(imgs[0]!);
    gpu.setTarget(imgs[1]!);

    const stage = document.createElement("div");
    stage.className = "stage";
    stage.append(gl);

    const thumbs = document.createElement("div");
    thumbs.className = "thumbs";
    let active = 1;
    const thumbEls: HTMLCanvasElement[] = [];
    imgs.forEach((r, i) => {
      const t = document.createElement("canvas");
      t.width = SIZE;
      t.height = SIZE;
      t.getContext("2d")!.putImageData(
        new ImageData(new Uint8ClampedArray(r.data), r.w, r.h),
        0,
        0,
      );
      if (i === active) t.classList.add("on");
      t.addEventListener("click", () => {
        active = i;
        gpu.setTarget(r);
        for (const e of thumbEls) e.classList.toggle("on", e === t);
      });
      thumbEls.push(t);
      thumbs.append(t);
    });

    const controls = document.createElement("div");
    controls.className = "controls";
    controls.append(
      slider("stiffness", 20, 300, 1, this.stiff, d, v => String(Math.round(v))),
      slider("damping", 2, 40, 0.5, this.damp, d, v => v.toFixed(1)),
    );

    const state = document.createElement("div");
    state.className = "state";

    d.push(
      effect(() => {
        gpu.stiffness = this.stiff.value;
      }),
      effect(() => {
        gpu.damping = this.damp.value;
      }),
      effect(() => {
        state.textContent =
          this.settled.value > 0 ? "settled — pixels at rest on the GPU" : "springing…";
      }),
    );

    this.shadow.append(stage, thumbs, controls, state);

    let last = performance.now();
    let frame = 0;
    const tick = (now: number): void => {
      const dt = Math.min((now - last) / 1000, 1 / 30);
      last = now;
      // A few substeps keep stiff springs stable without a CPU readback.
      for (let s = 0; s < 3; s++) gpu.step(dt / 3);
      gpu.render();
      if (++frame % 20 === 0) {
        this.settled.value = gpu.energy() < 1e-5 ? 1 : 0;
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  disconnectedCallback(): void {
    cancelAnimationFrame(this.raf);
    for (const d of this.disposers) d();
    this.disposers = [];
    this.gpu?.dispose();
    this.gpu = null;
  }
}
