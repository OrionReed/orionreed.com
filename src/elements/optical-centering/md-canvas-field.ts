// Canvas demo: minim's runtime + signals + generators driving a non-SVG renderer.

import {Anim, signal, drive, effect, every, loop, num, vec, Num, Vec} from "../../minim";
import {attachRaf} from "@minim/core";

const N = 1500;
const W = 640;
const H = 360;

// Each phase returns target `(x, y)` for particle `i`; spring integration chases it.
type Phase = (
  i: number,
  t: number,
  px: number,
  py: number,
) => { x: number; y: number };

const GRID_COLS = 60;
const GRID_ROWS = Math.ceil(N / GRID_COLS);
const GRID_PAD_X = 40;
const GRID_PAD_Y = 60;
const GRID_DX = (W - GRID_PAD_X * 2) / (GRID_COLS - 1);
const GRID_DY = (H - GRID_PAD_Y * 2) / (GRID_ROWS - 1);

const grid: Phase = (i) => {
  const col = i % GRID_COLS;
  const row = (i / GRID_COLS) | 0;
  return { x: GRID_PAD_X + col * GRID_DX, y: GRID_PAD_Y + row * GRID_DY };
};

const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const phyllo: Phase = (i) => {
  const r = 5.2 * Math.sqrt(i + 1);
  const a = i * GOLDEN;
  return { x: W / 2 + r * Math.cos(a), y: H / 2 + r * Math.sin(a) };
};

const wave: Phase = (i, t) => {
  const u = i / N;
  return {
    x: 30 + u * (W - 60),
    y:
      H / 2 +
      Math.sin(u * Math.PI * 6 + t * 1.7) * 90 +
      Math.cos(u * Math.PI * 3 + t * 1.1) * 30,
  };
};

const swarm: Phase = (i, t, px, py) => {
  const angle = (i / N) * Math.PI * 6 + t * 0.6;
  const r = 30 + 110 * (((i * 1.61803) % 1));
  return {
    x: px + r * Math.cos(angle + i * 0.01),
    y: py + r * Math.sin(angle + i * 0.01),
  };
};

const PHASES: Array<{ name: string; fn: Phase }> = [
  { name: "grid", fn: grid },
  { name: "phyllotaxis", fn: phyllo },
  { name: "wave", fn: wave },
  { name: "swarm (move your cursor)", fn: swarm },
];

const STIFF = 90;
const DAMP = 13;
const DWELL = 3.5;

export class MdCanvasField extends HTMLElement {
  static get tagName(): string {
    return "md-canvas-field";
  }
  static define(): void {
    if (!customElements.get(this.tagName)) {
      customElements.define(this.tagName, this);
    }
  }

  private shadow: ShadowRoot;
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;

  private anim = new Anim();
  private disposers: Array<() => void> = [];
  #detachRaf: (() => void) | null = null;

  private phaseIdx = num(0);
  private hueBase: Num = num(210);
  private hueSpread = signal(80);
  private size = signal(2.1);
  private pointer: Vec = vec(W / 2, H / 2);
  private statusText = signal("");
  private fpsSmoothed = signal(0);

  // Typed arrays: 1500 reactives would be wasteful — reactivity lives in the knobs.
  private px = new Float32Array(N);
  private py = new Float32Array(N);
  private pvx = new Float32Array(N);
  private pvy = new Float32Array(N);

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: "open" });

    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      :host {
        display: block;
        margin: 1rem auto;
        width: 100%;
        max-width: ${W}px;
      }
      .wrap {
        position: relative;
        width: 100%;
        aspect-ratio: ${W} / ${H};
      }
      canvas {
        display: block;
        width: 100%;
        height: 100%;
        background: transparent;
        touch-action: none;
        cursor: crosshair;
      }
      .status, .fps {
        position: absolute;
        font: 11px/1 var(--font, system-ui);
        color: var(--text-color);
        opacity: 0.55;
        pointer-events: none;
      }
      .status { left: 12px; top: 10px; }
      .fps { right: 12px; top: 10px; font-variant-numeric: tabular-nums; }
      .caption {
        position: absolute;
        left: 50%;
        bottom: 8px;
        transform: translateX(-50%);
        font: 10px/1.4 var(--font, system-ui);
        color: var(--text-color);
        opacity: 0.4;
        pointer-events: none;
        max-width: 90%;
        text-align: center;
      }
    `);
    this.shadow.adoptedStyleSheets = [sheet];

    const wrap = document.createElement("div");
    wrap.className = "wrap";
    this.canvas = document.createElement("canvas");
    wrap.appendChild(this.canvas);

    const statusEl = document.createElement("div");
    statusEl.className = "status";
    wrap.appendChild(statusEl);

    const fpsEl = document.createElement("div");
    fpsEl.className = "fps";
    wrap.appendChild(fpsEl);

    const caption = document.createElement("div");
    caption.className = "caption";
    caption.textContent = `${N} particles on Canvas — minim's Anim, signals, struct value types, and generators driving a non-SVG renderer.`;
    wrap.appendChild(caption);

    this.shadow.appendChild(wrap);

    this.disposers.push(
      effect(() => {
        statusEl.textContent = this.statusText.value;
      }),
      effect(() => {
        const f = this.fpsSmoothed.value;
        fpsEl.textContent = f > 0 ? `${f.toFixed(0)} fps` : "";
      }),
    );
  }

  connectedCallback(): void {
    this.ctx = this.canvas.getContext("2d", { alpha: true })!;
    this.setupCanvasSize();
    this.initParticles();
    this.bindPointer();
    this.startLoops();
    this.#detachRaf = attachRaf(this.anim);
  }

  disconnectedCallback(): void {
    this.#detachRaf?.();
    this.#detachRaf = null;
    this.anim.stop();
    for (const d of this.disposers) d();
    this.disposers = [];
  }

  private setupCanvasSize(): void {
    const apply = (): void => {
      const rect = this.canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
      this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
      // Map (W, H) user-units → physical pixels; absorbs DPR + CSS size.
      const sx = this.canvas.width / W;
      const sy = this.canvas.height / H;
      this.ctx.setTransform(sx, 0, 0, sy, 0, 0);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(this.canvas);
    this.disposers.push(() => ro.disconnect());
  }

  private initParticles(): void {
    for (let i = 0; i < N; i++) {
      this.px[i] = Math.random() * W;
      this.py[i] = Math.random() * H;
    }
  }

  private bindPointer(): void {
    const localize = (e: PointerEvent): { x: number; y: number } => {
      const r = this.canvas.getBoundingClientRect();
      return {
        x: ((e.clientX - r.left) / r.width) * W,
        y: ((e.clientY - r.top) / r.height) * H,
      };
    };
    const onMove = (e: PointerEvent): void => {
      this.pointer.value = localize(e);
    };
    const onLeave = (): void => {
      this.pointer.value = { x: W / 2, y: H / 2 };
    };
    this.canvas.addEventListener("pointermove", onMove);
    this.canvas.addEventListener("pointerleave", onLeave);
    this.disposers.push(() => {
      this.canvas.removeEventListener("pointermove", onMove);
      this.canvas.removeEventListener("pointerleave", onLeave);
    });
  }

  private startLoops(): void {
    const self = this;

    this.anim.start(
      drive((dt, t) => {
        self.integrate(dt, t);
        self.render();
        self.fpsAccum += dt;
        self.fpsFrames += 1;
      }),
    );

    this.anim.start(loop(function* () {
      self.statusText.value = `phase: ${PHASES[self.phaseIdx.peek()].name}`;
      yield DWELL;
      self.phaseIdx.value = (self.phaseIdx.peek() + 1) % PHASES.length;
      yield* self.hueBase.to((self.hueBase.peek() + 70) % 360, 0.9);
    }));

    this.anim.start(every(0.5, () => {
      if (self.fpsFrames > 0) {
        self.fpsSmoothed.value = self.fpsFrames / self.fpsAccum;
      }
      self.fpsAccum = 0;
      self.fpsFrames = 0;
    }));
  }

  private integrate(dt: number, clock: number): void {
    if (dt <= 0) return;
    // Snapshot once per frame — reading inside the loop would track-on-read per particle.
    const phaseFn = PHASES[this.phaseIdx.peek()].fn;
    const p = this.pointer.peek();

    const px = this.px,
      py = this.py,
      pvx = this.pvx,
      pvy = this.pvy;
    const stiff = STIFF;
    const damp = DAMP;

    // Semi-implicit Euler: velocity first, then position. Stable at large dt.
    for (let i = 0; i < N; i++) {
      const t = phaseFn(i, clock, p.x, p.y);
      const dx = t.x - px[i];
      const dy = t.y - py[i];
      pvx[i] += (dx * stiff - pvx[i] * damp) * dt;
      pvy[i] += (dy * stiff - pvy[i] * damp) * dt;
      px[i] += pvx[i] * dt;
      py[i] += pvy[i] * dt;
    }
  }

  // Contiguous index ranges share a fillStyle → one beginPath/fill per bin.
  private static readonly BINS = 12;

  private render(): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, W, H);

    const size = this.size.peek();
    const hueBase = this.hueBase.peek();
    const hueSpread = this.hueSpread.peek();
    const BINS = MdCanvasField.BINS;

    const px = this.px,
      py = this.py;
    const TAU = Math.PI * 2;

    for (let b = 0; b < BINS; b++) {
      const hue = (hueBase + (b / BINS) * hueSpread) % 360;
      ctx.fillStyle = `hsl(${hue.toFixed(0)}, 70%, 58%)`;
      ctx.beginPath();
      const start = ((b * N) / BINS) | 0;
      const end = (((b + 1) * N) / BINS) | 0;
      for (let i = start; i < end; i++) {
        // moveTo before arc — otherwise canvas connects from prev arc's endpoint.
        ctx.moveTo(px[i] + size, py[i]);
        ctx.arc(px[i], py[i], size, 0, TAU);
      }
      ctx.fill();
    }
  }

  private fpsAccum = 0;
  private fpsFrames = 0;
}
