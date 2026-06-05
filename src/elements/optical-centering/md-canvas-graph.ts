// md-canvas-graph.ts — the GPU lens DAG, made visible.
//
// Every box is a Canvas value living entirely in GPU textures; the lines are
// the lenses. A source forks into a transform spine (brightness → blur →
// grayscale → invert), a flip, a downsample thumbnail, a luma predicate, and
// a region branch (crop → meanColor). Knobs flow down; painting any canvas,
// dragging the box-in-box crop, flipping the luma bit, or picking the mean
// colour flows up through the inverses — all on the card, no CPU pixels. The
// root can be sprung (GPU per-pixel oscillators) and the whole DAG re-derives
// each frame until the GPU settle metric drops below ε.

import {
  type Canvas,
  canvasStamp,
  effect,
  type Num,
  num,
  Spring,
  type Writable,
} from "../../minim";
import { bindPaint, blit, scene } from "./canvas-demo-util";

const SIZE = 160;
const NS = 104;
const VW = 680;
const VH = 772;
const SETTLE_EPS = 2e-6;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
const topC = (b: Box): [number, number] => [b.x + b.w / 2, b.y];
const botC = (b: Box): [number, number] => [b.x + b.w / 2, b.y + b.h];
const leftC = (b: Box): [number, number] => [b.x, b.y + b.h / 2];
const rightC = (b: Box): [number, number] => [b.x + b.w, b.y + b.h / 2];

function curve(from: [number, number], to: [number, number], horizontal: boolean): string {
  const [x1, y1] = from;
  const [x2, y2] = to;
  if (horizontal) {
    const mx = (x1 + x2) / 2;
    return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
  }
  const my = (y1 + y2) / 2;
  return `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
}

const hex2 = (n: number): string =>
  Math.round(Math.max(0, Math.min(255, n)))
    .toString(16)
    .padStart(2, "0");
const rgbToHex = (r: number, g: number, b: number): string => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
const hexToRgb = (hex: string): [number, number, number] => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];

export class MdCanvasGraph extends HTMLElement {
  static get tagName(): string {
    return "md-canvas-graph";
  }
  static define(): void {
    if (!customElements.get(this.tagName)) customElements.define(this.tagName, this);
  }

  private shadow: ShadowRoot;
  private disposers: Array<() => void> = [];
  private ro: ResizeObserver | null = null;
  private raf = 0;
  private springDriver: Spring | null = null;

  private k = num(1);
  private radius = num(2);
  private cropX = num(44);
  private cropY = num(44);
  private cropW = num(72);
  private source = scene(SIZE, "DAG", 0);
  private brush = { color: "#ffd34e", size: 9 };

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: "open" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      :host { display: block; margin: 1.25rem auto; max-width: ${VW}px; }
      .toolbar {
        display: flex; align-items: center; gap: 12px; justify-content: center; flex-wrap: wrap;
        margin: 0 auto 8px; font: 11px var(--font, system-ui); color: var(--text-color); opacity: 0.85;
      }
      .toolbar .grp { display: inline-flex; align-items: center; gap: 6px; }
      .toolbar .sep { width: 1px; height: 18px; background: color-mix(in srgb, var(--text-color) 25%, transparent); }
      .toolbar .swatch-round { width: 22px; height: 22px; padding: 0; border: none; background: none; cursor: pointer; }
      .toolbar .swatch-round::-webkit-color-swatch { border: 1px solid #fff4; border-radius: 50%; }
      .toolbar .swatch-round::-webkit-color-swatch-wrapper { padding: 0; }
      .toolbar input[type=range] { width: 78px; accent-color: var(--text-color); }
      .toolbar button {
        font: 11px var(--font, system-ui); padding: 3px 9px; border-radius: 5px;
        border: 1px solid var(--text-color); background: transparent; color: var(--text-color);
        cursor: pointer; opacity: 0.8;
      }
      .toolbar button:hover { opacity: 1; }
      .toolbar .settled { width: 9px; height: 9px; border-radius: 50%; background: #5be08a; box-shadow: 0 0 6px #5be08a; }
      .toolbar .settled.busy { background: #e0a33c; box-shadow: 0 0 6px #e0a33c; }
      .frame { position: relative; width: 100%; }
      .stage { position: absolute; top: 0; left: 0; width: ${VW}px; height: ${VH}px; transform-origin: top left; }
      svg.edges { position: absolute; inset: 0; width: ${VW}px; height: ${VH}px; pointer-events: none; overflow: visible; color: var(--text-color); }
      .node { position: absolute; }
      .node canvas { width: ${NS}px; height: ${NS}px; display: block; border-radius: 6px; background: #0002; cursor: crosshair; touch-action: none; box-shadow: 0 0 0 1px #fff2; }
      .nlabel { margin-top: 4px; font: 10.5px var(--font, system-ui); color: var(--text-color); opacity: 0.66; text-align: center; }
      /* slim param card */
      .param { background: color-mix(in srgb, var(--text-color) 6%, transparent); border: 1px solid #fff2; border-radius: 6px; padding: 3px 7px 4px; }
      .param label { display: flex; flex-direction: column; gap: 1px; font: 9.5px var(--font, system-ui); color: var(--text-color); }
      .param .top { display: flex; justify-content: space-between; opacity: 0.7; }
      .param input[type=range] { width: 100%; height: 10px; margin: 1px 0 0; accent-color: var(--text-color); }
      .param .val { font-variant-numeric: tabular-nums; opacity: 0.6; }
      .swatch { width: 100%; height: 38px; border: none; border-radius: 6px; background: none; cursor: pointer; padding: 0; }
      .swatch::-webkit-color-swatch { border: 1px solid #fff3; border-radius: 6px; }
      .swatch::-webkit-color-swatch-wrapper { padding: 0; }
      .cropframe { position: relative; }
      .cropframe canvas { width: 100%; height: 100%; display: block; border-radius: 6px; box-shadow: 0 0 0 1px #fff2; opacity: 0.85; }
      .croprect { position: absolute; border: 1.5px solid #fff; box-shadow: 0 0 0 1px #0008; cursor: move; border-radius: 2px; }
      .crophandle { position: absolute; right: -4px; bottom: -4px; width: 9px; height: 9px; background: #fff; border-radius: 50%; cursor: nwse-resize; box-shadow: 0 0 0 1px #0008; }
      .readout { position: absolute; border: 1px dashed #fff8; pointer-events: none; border-radius: 1px; }
      .bool { display: flex; align-items: center; gap: 8px; padding: 0 6px; height: 100%; cursor: pointer; user-select: none; }
      .bool .led { width: 16px; height: 16px; border-radius: 50%; background: #444; box-shadow: inset 0 0 0 1px #fff3; transition: background 0.15s, box-shadow 0.15s; flex: 0 0 auto; }
      .bool .led.on { background: #5be08a; box-shadow: 0 0 8px #5be08a, inset 0 0 0 1px #fff6; }
      .bool .btxt { font: 10.5px var(--font, system-ui); color: var(--text-color); opacity: 0.72; }
      .hint { position: relative; text-align: center; margin: 8px auto 0; max-width: 92%; font: 10px/1.5 var(--font, system-ui); color: var(--text-color); opacity: 0.45; }
    `);
    this.shadow.adoptedStyleSheets = [sheet];
  }

  connectedCallback(): void {
    const d = this.disposers;
    const src = this.source;
    const bright = src.brightness(this.k);
    const blurred = bright.blur(this.radius, 1);
    const gray = blurred.grayscale();
    const inv = gray.invert();
    const flipped = src.flipH();
    const down = src.downsample(4);
    const crop = src.crop(this.cropX, this.cropY, this.cropW, this.cropW);
    const mean = crop.meanColor();
    const lit = gray.brighterThan(num(0.5));

    const spineX = 138;
    const boxes: Record<string, Box> = {
      S: { x: 328, y: 8, w: NS, h: NS },
      B: { x: spineX, y: 150, w: NS, h: NS },
      Bl: { x: spineX, y: 300, w: NS, h: NS },
      G: { x: spineX, y: 450, w: NS, h: NS },
      I: { x: spineX, y: 600, w: NS, h: NS },
      Lu: { x: 6, y: 470, w: 108, h: 46 },
      F: { x: 263, y: 172, w: NS, h: NS },
      Ds: { x: 388, y: 172, w: NS, h: NS },
      CB: { x: 513, y: 30, w: NS, h: NS },
      Cr: { x: 513, y: 176, w: NS, h: NS },
      Mc: { x: 513, y: 344, w: NS, h: 58 },
      K: { x: 6, y: 172, w: 96, h: 40 },
      R: { x: 6, y: 322, w: 96, h: 40 },
    };

    const toolbar = this.buildToolbar(src);
    const frame = document.createElement("div");
    frame.className = "frame";
    const stage = document.createElement("div");
    stage.className = "stage";
    frame.append(stage);

    // edges
    const SVGNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("class", "edges");
    svg.setAttribute("viewBox", `0 0 ${VW} ${VH}`);
    stage.append(svg);
    const edge = (from: [number, number], to: [number, number], horizontal: boolean): void => {
      const p = document.createElementNS(SVGNS, "path");
      p.setAttribute("d", curve(from, to, horizontal));
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", "currentColor");
      p.setAttribute("stroke-width", "2");
      p.setAttribute("stroke-linecap", "round");
      svg.append(p);
    };
    edge(botC(boxes.S!), topC(boxes.B!), false);
    edge(botC(boxes.S!), topC(boxes.F!), false);
    edge(botC(boxes.S!), topC(boxes.Ds!), false);
    edge(rightC(boxes.S!), topC(boxes.Cr!), false);
    edge(botC(boxes.B!), topC(boxes.Bl!), false);
    edge(botC(boxes.Bl!), topC(boxes.G!), false);
    edge(botC(boxes.G!), topC(boxes.I!), false);
    edge(leftC(boxes.G!), topC(boxes.Lu!), false);
    edge(botC(boxes.CB!), topC(boxes.Cr!), false);
    edge(botC(boxes.Cr!), topC(boxes.Mc!), false);
    edge(rightC(boxes.K!), leftC(boxes.B!), true);
    edge(rightC(boxes.R!), leftC(boxes.Bl!), true);

    const place = (el: HTMLElement, b: Box): void => {
      el.style.left = `${b.x}px`;
      el.style.top = `${b.y}px`;
      el.style.width = `${b.w}px`;
    };
    const brushColor = (): [number, number, number] => hexToRgb(this.brush.color);
    const brushSize = (): number => this.brush.size;

    const canvasNode = (
      b: Box,
      label: string,
      cell: Canvas | Writable<Canvas>,
      paint: boolean,
    ): HTMLCanvasElement => {
      const n = document.createElement("div");
      n.className = "node";
      place(n, b);
      const cv = document.createElement("canvas");
      const ctx = cv.getContext("2d", { alpha: true })!;
      const cap = document.createElement("div");
      cap.className = "nlabel";
      cap.textContent = label;
      n.append(cv, cap);
      stage.append(n);
      d.push(effect(() => blit((cell as Canvas).value, ctx)));
      if (paint)
        d.push(bindPaint(cv, cell as Writable<Canvas>, { color: brushColor, radius: brushSize }));
      return cv;
    };

    const srcCv = canvasNode(boxes.S!, "source", src, true);
    canvasNode(boxes.B!, "brightness(k)", bright, true);
    canvasNode(boxes.Bl!, "blur(r) · paint = deconv", blurred, true);
    canvasNode(boxes.G!, "grayscale", gray, true);
    canvasNode(boxes.I!, "invert", inv, true);
    canvasNode(boxes.F!, "flipH", flipped, true);
    canvasNode(boxes.Ds!, "downsample", down, true);
    canvasNode(boxes.Cr!, "crop", crop, true);

    // crop readout on the source (non-interactive)
    const readout = document.createElement("div");
    readout.className = "readout";
    srcCv.parentElement!.append(readout);
    const srcScale = NS / SIZE;
    d.push(
      effect(() => {
        readout.style.left = `${this.cropX.value * srcScale}px`;
        readout.style.top = `${this.cropY.value * srcScale}px`;
        readout.style.width = `${this.cropW.value * srcScale}px`;
        readout.style.height = `${this.cropW.value * srcScale}px`;
      }),
    );

    this.buildCropParam(stage, boxes.CB!, src, d);

    // meanColor node (native picker, bidirectional)
    const mcNode = document.createElement("div");
    mcNode.className = "node";
    place(mcNode, boxes.Mc!);
    const picker = document.createElement("input");
    picker.type = "color";
    picker.className = "swatch";
    const mcCap = document.createElement("div");
    mcCap.className = "nlabel";
    mcCap.textContent = "meanColor ⇄ pick";
    mcNode.append(picker, mcCap);
    stage.append(mcNode);
    d.push(
      effect(() => {
        const c = mean.value;
        picker.value = rgbToHex(c.r * 255, c.g * 255, c.b * 255);
      }),
    );
    picker.addEventListener("input", () => {
      const [r, g, b] = hexToRgb(picker.value);
      mean.value = { r: r / 255, g: g / 255, b: b / 255, a: 1 };
    });

    // luma bool node (top-entry, left column)
    const boNode = document.createElement("div");
    boNode.className = "node param";
    place(boNode, boxes.Lu!);
    boNode.style.height = `${boxes.Lu!.h}px`;
    const boInner = document.createElement("div");
    boInner.className = "bool";
    const led = document.createElement("div");
    led.className = "led";
    const btxt = document.createElement("div");
    btxt.className = "btxt";
    btxt.textContent = "luma ≥ 50%?";
    boInner.append(led, btxt);
    boNode.append(boInner);
    stage.append(boNode);
    d.push(
      effect(() => {
        led.classList.toggle("on", lit.value);
      }),
    );
    boInner.addEventListener("click", () => {
      lit.value = !lit.value;
    });

    this.sliderNode(stage, boxes.K!, "k", 0.3, 2, 0.01, this.k, d, v => `${v.toFixed(2)}×`);
    this.sliderNode(stage, boxes.R!, "blur r", 0, 6, 0.1, this.radius, d, v => v.toFixed(1));

    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent =
      "All pixels live in GPU textures. Knobs flow down; painting any canvas, dragging the box-in-box crop, flipping the luma bit, or picking the mean colour flows up through the inverses. Spring the root and the whole DAG re-derives each frame until it settles.";

    this.shadow.append(toolbar, frame, hint);

    const fit = (): void => {
      const s = frame.clientWidth / VW;
      stage.style.transform = `scale(${s})`;
      frame.style.height = `${VH * s}px`;
    };
    fit();
    this.ro = new ResizeObserver(fit);
    this.ro.observe(frame);
  }

  /** Top toolbar: global brush + spring controls on the root. */
  private buildToolbar(src: Writable<Canvas>): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "toolbar";

    const brushGrp = document.createElement("div");
    brushGrp.className = "grp";
    const bSwatch = document.createElement("input");
    bSwatch.type = "color";
    bSwatch.className = "swatch-round";
    bSwatch.value = this.brush.color;
    bSwatch.addEventListener("input", () => {
      this.brush.color = bSwatch.value;
    });
    const bSize = document.createElement("input");
    bSize.type = "range";
    bSize.min = "2";
    bSize.max = "22";
    bSize.value = String(this.brush.size);
    bSize.addEventListener("input", () => {
      this.brush.size = Number(bSize.value);
    });
    const bLabel = document.createElement("span");
    bLabel.textContent = "brush";
    brushGrp.append(bLabel, bSwatch, bSize);

    const sep = document.createElement("div");
    sep.className = "sep";

    // spring on the root
    const spring = new Spring(SIZE, SIZE, { stiffness: 100, damping: 2 });
    this.springDriver = spring;
    const targets = [scene(SIZE, "GPU", 150), scene(SIZE, "✦", 270), scene(SIZE, "DAG", 0)];
    let ti = 0;
    let last = 0;

    const springGrp = document.createElement("div");
    springGrp.className = "grp";
    const settled = document.createElement("div");
    settled.className = "settled";
    const btn = document.createElement("button");
    btn.textContent = "spring root ⟳";
    const stiff = document.createElement("input");
    stiff.type = "range";
    stiff.min = "10";
    stiff.max = "300";
    stiff.value = "100";
    stiff.addEventListener("input", () => {
      spring.stiffness = Number(stiff.value);
    });
    const damp = document.createElement("input");
    damp.type = "range";
    damp.min = "0.5";
    damp.max = "20";
    damp.step = "0.5";
    damp.value = "2";
    damp.addEventListener("input", () => {
      spring.damping = Number(damp.value);
    });
    const sLabel = document.createElement("span");
    sLabel.textContent = "stiff/damp";
    springGrp.append(settled, btn, sLabel, stiff, damp);

    const tick = (t: number): void => {
      const dt = last ? Math.min((t - last) / 1000, 1 / 30) : 1 / 60;
      last = t;
      spring.step(dt);
      src.value = canvasStamp(spring.current().tex, SIZE, SIZE);
      if (spring.energy() > SETTLE_EPS) {
        this.raf = requestAnimationFrame(tick);
      } else {
        this.raf = 0;
        last = 0;
        settled.classList.remove("busy");
      }
    };
    btn.addEventListener("click", () => {
      spring.seed(src.value.tex);
      const target = targets[ti % targets.length]!;
      ti++;
      spring.setTarget(target.value.tex);
      settled.classList.add("busy");
      if (!this.raf) this.raf = requestAnimationFrame(tick);
    });

    bar.append(brushGrp, sep, springGrp);
    return bar;
  }

  /** Box-in-box crop editor driving `cropX/Y/W`. */
  private buildCropParam(stage: HTMLElement, b: Box, src: Canvas, d: Array<() => void>): void {
    const node = document.createElement("div");
    node.className = "node";
    node.style.left = `${b.x}px`;
    node.style.top = `${b.y}px`;
    node.style.width = `${b.w}px`;
    const fr = document.createElement("div");
    fr.className = "cropframe";
    fr.style.width = `${b.w}px`;
    fr.style.height = `${b.h}px`;
    const cv = document.createElement("canvas");
    const ctx = cv.getContext("2d", { alpha: true })!;
    const rect = document.createElement("div");
    rect.className = "croprect";
    const handle = document.createElement("div");
    handle.className = "crophandle";
    rect.append(handle);
    fr.append(cv, rect);
    const cap = document.createElement("div");
    cap.className = "nlabel";
    cap.textContent = "crop region";
    node.append(fr, cap);
    stage.append(node);

    d.push(effect(() => blit((src as Canvas).value, ctx)));
    const scale = b.w / SIZE;
    d.push(
      effect(() => {
        rect.style.left = `${this.cropX.value * scale}px`;
        rect.style.top = `${this.cropY.value * scale}px`;
        rect.style.width = `${this.cropW.value * scale}px`;
        rect.style.height = `${this.cropW.value * scale}px`;
      }),
    );

    let mode: "move" | "size" | null = null;
    let px = 0;
    let py = 0;
    const perData = (): number => cv.getBoundingClientRect().width / SIZE;
    const start =
      (m: "move" | "size") =>
      (e: PointerEvent): void => {
        mode = m;
        px = e.clientX;
        py = e.clientY;
        e.stopPropagation();
        e.preventDefault();
        try {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        } catch {}
      };
    const move = (e: PointerEvent): void => {
      if (!mode) return;
      const pd = perData();
      const dx = (e.clientX - px) / pd;
      const dy = (e.clientY - py) / pd;
      px = e.clientX;
      py = e.clientY;
      if (mode === "move") {
        const w = this.cropW.peek();
        this.cropX.value = Math.max(0, Math.min(SIZE - w, this.cropX.peek() + dx));
        this.cropY.value = Math.max(0, Math.min(SIZE - w, this.cropY.peek() + dy));
      } else {
        const grow = (dx + dy) / 2;
        const w = Math.max(
          20,
          Math.min(SIZE - this.cropX.peek(), SIZE - this.cropY.peek(), this.cropW.peek() + grow),
        );
        this.cropW.value = w;
      }
    };
    const end = (): void => {
      mode = null;
    };
    rect.addEventListener("pointerdown", start("move"));
    handle.addEventListener("pointerdown", start("size"));
    rect.addEventListener("pointermove", move);
    handle.addEventListener("pointermove", move);
    rect.addEventListener("pointerup", end);
    handle.addEventListener("pointerup", end);
    d.push(() => {
      rect.removeEventListener("pointermove", move);
      handle.removeEventListener("pointermove", move);
    });
  }

  /** Slim range-slider param node bound to a writable `Num`. */
  private sliderNode(
    stage: HTMLElement,
    b: Box,
    name: string,
    min: number,
    max: number,
    step: number,
    cell: Writable<Num>,
    d: Array<() => void>,
    fmt: (v: number) => string,
  ): void {
    const n = document.createElement("div");
    n.className = "node param";
    n.style.left = `${b.x}px`;
    n.style.top = `${b.y}px`;
    n.style.width = `${b.w}px`;
    const label = document.createElement("label");
    const top = document.createElement("div");
    top.className = "top";
    const nm = document.createElement("span");
    nm.textContent = name;
    const val = document.createElement("span");
    val.className = "val";
    top.append(nm, val);
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(cell.peek());
    input.addEventListener("input", () => {
      cell.value = Number(input.value);
    });
    d.push(
      effect(() => {
        val.textContent = fmt((cell as Num).value);
      }),
    );
    label.append(top, input);
    n.append(label);
    stage.append(n);
  }

  disconnectedCallback(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.springDriver?.dispose();
    this.springDriver = null;
    this.ro?.disconnect();
    this.ro = null;
    for (const x of this.disposers) x();
    this.disposers = [];
  }
}
