// Canvas renderer demo — proves minim's runtime + signals + structs +
// generators are renderer-agnostic. No `Diagram`, no `Shape`, no SVG;
// just a custom element that owns a `<canvas>` and pushes pixels each
// frame. The minim stdlib does the time, the reactivity, and the
// orchestration; rendering is a per-frame for-loop with Canvas2D
// calls.
//
// Every non-rendering piece comes straight from minim:
//
//   - `Anim` is the runtime — same instance type, same per-Active
//     time scaling, same cancellation, just no SVG attached.
//   - `drive((dt, t) => ...)` is the per-frame substrate. The
//     integration + render path is one closure, no manual yield loop.
//   - `every(sec, fn)` is a Play factory that loops the side
//     effect at a fixed interval on the same clock.
//   - `num(...)` / `cell(...)` carry reactive knobs (phase index,
//     hue base, particle size). `Num.signal.to(...)` works here
//     exactly as on a shape's `opacity` — same engine.
//   - `vec(...)` builds the pointer as a reactive Point. It behaves
//     identically to one feeding an SVG shape's `translate`; input →
//     value-type doesn't care what's rendering.
//   - Generators (`loop(...)`) drive the phase progression with the
//     same `yield N` / `yield* sig.to(...)` vocabulary as the SVG
//     demos.
//
// Per-particle position/velocity lives in typed arrays (1500
// reactives would be silly). Reactivity is in the knobs that *shape*
// the particles, not in each particle.

import {
  Anim,
  cell,
  drive,
  effect,
  every,
  loop,
  num,
  vec,
  type N,
  type Point,
} from "../../minim";

const N = 1500;
const W = 640;
const H = 360;

// ── Phases ──────────────────────────────────────────────────────────
//
// Each phase is a pure function `(i, t, px, py) => {x, y}` returning
// the target position for particle `i` given clock `t` and current
// pointer `(px, py)`. Spring integration chases the target; phase
// transitions happen by swapping the function — particles ease into
// the new layout without any per-particle tween orchestration.

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

// Phyllotactic spiral — golden-angle placement.
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const phyllo: Phase = (i) => {
  const r = 5.2 * Math.sqrt(i + 1);
  const a = i * GOLDEN;
  return { x: W / 2 + r * Math.cos(a), y: H / 2 + r * Math.sin(a) };
};

// Flowing sinusoidal band — animates within the phase via clock `t`.
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

// Orbital swarm centered on the pointer (or canvas center if not in).
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

const STIFF = 90;   // spring stiffness pulling each particle to its target
const DAMP = 13;    // velocity damping (critically-damped-ish)
const DWELL = 3.5;  // seconds per phase

// ── Custom element ──────────────────────────────────────────────────

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

  // Reactive knobs — the *renderer-agnostic* state.
  private phaseIdx = num(0);
  private hueBase: N = num(210);
  private hueSpread = cell(80);
  private size = cell(2.1);
  private pointer: Point = vec(W / 2, H / 2);
  private statusText = cell("");
  // Rolling-average fps, refreshed every 0.5s via `every(...)`.
  private fpsSmoothed = cell(0);

  // Per-particle state — typed arrays. 1500 reactives would be
  // wasteful; reactivity lives in the knobs that *shape* the particles.
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

    // Bind reactive text via `effect` — the only `effect`s in the
    // demo. Everything else reads peek()'d snapshots inside the
    // per-frame hot loop.
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
  }

  disconnectedCallback(): void {
    this.anim.stop();
    for (const d of this.disposers) d();
    this.disposers = [];
  }

  // ── Setup ─────────────────────────────────────────────────────────

  private setupCanvasSize(): void {
    const apply = (): void => {
      const rect = this.canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
      this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
      // Map (W, H) user-units to physical pixels; absorbs both DPR
      // and CSS size in one transform.
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
    // Scatter once. The first phase springs them into place from
    // wherever they happen to land.
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

  // ── Animation ─────────────────────────────────────────────────────
  //
  // Three minim primitives, none of them SVG-aware:
  //
  //   - `drive((dt, t) => ...)` — the per-frame substrate. Integrate
  //     + render, no manual `while (true) { yield }` bookkeeping.
  //   - `loop(function* () { ... })` — Play factory, run as a
  //     top-level child via `anim.run(loop(...))`. Phase cycler with
  //     `yield DWELL` / `yield* hueBase.to(...)`, same vocabulary as
  //     the SVG demos.
  //   - `every(0.5, fn)` — Play factory, fixed-interval fps emit
  //     on the same clock everything else uses.
  //
  // All three share `anim.clockMs`, and any `.at(scale)` scope
  // applied to the parent generator scales them in lockstep.

  private startLoops(): void {
    const self = this;

    // Hot loop — drive yields `dt` each frame; `t` is elapsed since
    // start (used as the wave-phase clock). Never returns.
    this.anim.run(
      drive((dt, t) => {
        self.integrate(dt, t);
        self.render();
        self.fpsAccum += dt;
        self.fpsFrames += 1;
      }),
    );

    // Phase cycler.
    this.anim.run(loop(function* () {
      self.statusText.value = `phase: ${PHASES[self.phaseIdx.peek()].name}`;
      yield DWELL;
      self.phaseIdx.value = (self.phaseIdx.peek() + 1) % PHASES.length;
      // `hueBase` is a `Num.signal`, so `.to(...)` works via the
      // per-struct prototype install — same engine that drives
      // Vec/Box/Color tweens. No SVG, no Shape, same engine.
      yield* self.hueBase.to((self.hueBase.peek() + 70) % 360, 0.9);
    }));

    // Fps emit — averages over the last 0.5s window of frames.
    this.anim.run(every(0.5, () => {
      if (self.fpsFrames > 0) {
        self.fpsSmoothed.value = self.fpsFrames / self.fpsAccum;
      }
      self.fpsAccum = 0;
      self.fpsFrames = 0;
    }));
  }

  // ── Per-frame ─────────────────────────────────────────────────────

  private integrate(dt: number, clock: number): void {
    if (dt <= 0) return;
    // Snapshot the reactive knobs once per frame — reading inside
    // the inner loop would track-on-read on every particle.
    const phaseFn = PHASES[this.phaseIdx.peek()].fn;
    const p = this.pointer.peek();

    const px = this.px,
      py = this.py,
      pvx = this.pvx,
      pvy = this.pvy;
    const stiff = STIFF;
    const damp = DAMP;

    // Semi-implicit Euler: integrate velocity first using current
    // displacement, then update position. Stable at large dt.
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

  // Index ranges → hue bins. Particles are indexed 0..N and hue
  // depends on i, so contiguous index ranges share a fillStyle —
  // one beginPath / many arcs / one fill per bin. Twelve bins is
  // a good compromise between visible color gradient and number of
  // fillStyle changes.
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
        // moveTo before arc avoids a connecting line from the
        // previous arc's endpoint — the canvas path treats it as a
        // continuous stroke otherwise.
        ctx.moveTo(px[i] + size, py[i]);
        ctx.arc(px[i], py[i], size, 0, TAU);
      }
      ctx.fill();
    }
  }

  // Fps accumulator state — touched by the drive callback, drained
  // by the `every(...)` tick.
  private fpsAccum = 0;
  private fpsFrames = 0;
}
