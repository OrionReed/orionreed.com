// Custom-element scaffold. Subclasses override `scene(s)`; signals drive
// updates. Owns the SVG, the viewBox (`view`/`fit`), and host CSS sizing
// (`--d-w`/`--d-h`).
//
// Visibility-gated rAF: the per-instance Anim ticks only while near the
// viewport (IntersectionObserver). Signal-driven updates keep working —
// only the animator clock pauses and resumes, so `anim.clock` tracks
// on-screen time. Opt out via `always-animate`; eager-attach when
// IntersectionObserver is absent (SSR/tests).

import { Anim } from "@minim/core";
import { ensureArrowMarker, type Mount, mount, Shape, SVG_NS } from "@minim/shapes";
import { Box, effect, Num, type Val } from "@minim/signals";
import type { Marker } from "@minim/tex";
import { observedAttributesOf, syncAttrSignal } from "./attr";
import { attachRaf } from "./raf";

export const css = String.raw;

export type Padding = number | { top?: number; right?: number; bottom?: number; left?: number };

function resolvePadding(p?: Padding) {
  if (p === undefined || p === 0) return { top: 0, right: 0, bottom: 0, left: 0 };
  if (typeof p === "number") return { top: p, right: p, bottom: p, left: p };
  return {
    top: p.top ?? 0,
    right: p.right ?? 0,
    bottom: p.bottom ?? 0,
    left: p.left ?? 0,
  };
}

export class Diagram extends HTMLElement {
  static get observedAttributes(): string[] {
    return observedAttributesOf(this);
  }

  attributeChangedCallback(name: string, oldVal: string | null, newVal: string | null): void {
    if (oldVal === newVal) return;
    syncAttrSignal(this, name, newVal);
  }

  protected shadow: ShadowRoot;
  protected anim = new Anim();
  #detachRaf: (() => void) | null = null;
  #io: IntersectionObserver | null = null;
  protected svg!: SVGSVGElement;
  /** Scene-graph root. All user-mounted shapes are children of this. */
  protected root!: Shape;
  /** Callable mount handle for `scene(s)`; `s(shape)` adds to root. */
  protected s!: Mount;

  // Per-instance marker registry; recleared each connectedCallback so
  // `<md-tex for="id">` always sees fresh markers.
  #markers = new Map<string, Marker>();

  /** Register a marker for this instance; call in `scene()` so
   *  `<… for="this-id">` can resolve it. */
  registerMarker(id: string, m: Marker): void {
    this.#markers.set(id, m);
  }

  /** Look up a marker registered on this instance. */
  getMarker(id: string): Marker | undefined {
    return this.#markers.get(id);
  }

  // `#viewSet` flips on the first `view()`/`fit()`; `connectedCallback`
  // auto-fits if still false.
  #viewSet = false;
  #viewSig = signal0Box();
  #viewBox = Box.derive(() => this.#viewSig.value);

  private static styleSheets = new Map<string, CSSStyleSheet>();
  static styles = css`
    :host {
      display: block;
      margin: 1rem auto;
      width: 100%;
      max-width: calc(var(--d-w, 600) * 1px);
    }
    svg {
      display: block;
      width: 100%;
      height: auto;
      overflow: visible;
    }
    ::slotted(details.diagram-source) {
      margin-top: 0.5rem;
      font-size: 0.85em;
      min-width: 90ch;
      margin: 0 auto;
      color: var(--text-secondary, #888);
    }
  `;

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: "open" });
    this.initializeStyles();
  }

  /** Build the scene graph. Runs once per connect; override in subclasses. */
  protected scene(_s: Mount): void {}

  connectedCallback(): void {
    if (!this.svg) this.mountSvg();
    this.#detachRaf?.();
    this.#io?.disconnect();
    this.#io = null;
    this.anim.stop();
    this.root?.dispose();
    this.#viewSet = false;
    this.#markers.clear();
    this.root = new Shape();
    this.svg.replaceChildren(this.root.el);
    ensureArrowMarker(this.svg);
    this.s = mount(this.root);
    this.scene(this.s);
    if (!this.#viewSet) this.fit();
    this.#ensureSourcePanel();
    this.#startRaf();
  }

  disconnectedCallback(): void {
    this.#detachRaf?.();
    this.#detachRaf = null;
    this.#io?.disconnect();
    this.#io = null;
    this.anim.stop();
    this.root?.dispose();
  }

  // Gate rAF on viewport intersection; `rootMargin: "200px 0px"` warms
  // the loop before visible so the first frame isn't a cold start.
  #startRaf(): void {
    if (this.hasAttribute("always-animate") || typeof IntersectionObserver === "undefined") {
      this.#detachRaf = attachRaf(this.anim);
      return;
    }
    this.#io = new IntersectionObserver(
      entries => {
        const inView = entries[entries.length - 1].isIntersecting;
        if (inView && !this.#detachRaf) this.#detachRaf = attachRaf(this.anim);
        else if (!inView && this.#detachRaf) {
          this.#detachRaf();
          this.#detachRaf = null;
        }
      },
      { rootMargin: "200px 0px" },
    );
    this.#io.observe(this);
  }

  /** Set the viewBox to `(0, 0, w, h)` (reactive inputs). First call
   *  wins; returns a reactive `Box` for layout. */
  view(w: Val<number>, h: Val<number>): Box {
    if (this.#viewSet) return this.#viewBox;
    const ws = Num.from(w);
    const hs = Num.from(h);
    effect(() => this.setViewBox(0, 0, ws.value, hs.value));
    this.#viewSet = true;
    return this.#viewBox;
  }

  /** Fit viewBox to the root's bounds + padding (auto-called after
   *  `scene()` if `view()` wasn't). */
  fit(padding?: Padding): Box {
    if (this.#viewSet) return this.#viewBox;
    const p = resolvePadding(padding);
    const b = this.root.box.value;
    this.setViewBox(b.x - p.left, b.y - p.top, b.w + p.left + p.right, b.h + p.top + p.bottom);
    this.#viewSet = true;
    return this.#viewBox;
  }

  static get tagName(): string {
    return this.name
      .replace(/([A-Z])/g, "-$1")
      .toLowerCase()
      .slice(1);
  }

  static define(): void {
    customElements.define(this.tagName, this);
  }

  private setViewBox(x: number, y: number, w: number, h: number): void {
    this.#viewSig.value = { x, y, w, h };
    this.svg.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
    this.svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    this.svg.setAttribute("width", String(w));
    this.svg.setAttribute("height", String(h));
    // `:host` reads `--d-w` for max-width; override via `style="--d-w: N"`.
    this.style.setProperty("--d-w", String(w));
    this.style.setProperty("--d-h", String(h));
  }

  private mountSvg(): void {
    this.svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
    this.shadow.appendChild(this.svg);
    // Named slot projects the source panel without picking up incidental
    // light-DOM children that use `textContent` as data, not display.
    const slot = document.createElement("slot");
    slot.name = "source";
    this.shadow.appendChild(slot);
  }

  /** Append a `<details>` with the subclass's `scene()` source, projected
   *  through `slot[name=source]`. No-op for the base class / `[no-source]`
   *  / already-added. */
  #ensureSourcePanel(): void {
    if (this.hasAttribute("no-source")) return;
    if (this.querySelector(":scope > details[slot='source']")) return;
    const ctor = this.constructor as typeof Diagram;
    if (ctor.prototype.scene === Diagram.prototype.scene) return;

    const src = dedent(this.scene.toString());

    const details = document.createElement("details");
    details.slot = "source";
    details.className = "diagram-source";

    const summary = document.createElement("summary");
    summary.textContent = "source";

    const code = document.createElement("md-syntax") as HTMLElement & { update?(): void };
    code.setAttribute("lang", "ts");
    code.textContent = src;

    details.append(summary, code);

    // `md-syntax.paint()` reads `innerText`, empty while hidden in a
    // closed `<details>` in some UAs; repaint on first open.
    let painted = false;
    details.addEventListener("toggle", () => {
      if (details.open && !painted) {
        code.update?.();
        painted = true;
      }
    });

    this.appendChild(details);
  }

  /** Combine base + subclass styles. Cached per subclass. */
  private initializeStyles(): void {
    const ctor = this.constructor as typeof Diagram;
    const cacheKey = ctor.name;
    if (!Diagram.styleSheets.has(cacheKey)) {
      const baseStyles = Diagram.styles ?? "";
      const ownStyles = ctor === Diagram ? "" : (ctor.styles ?? "");
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(`${baseStyles}\n${ownStyles}`);
      Diagram.styleSheets.set(cacheKey, sheet);
    }
    this.shadow.adoptedStyleSheets = [Diagram.styleSheets.get(cacheKey)!];
  }
}

// A fresh writable Box signal seeded with the zero box.
function signal0Box() {
  return new Box({ x: 0, y: 0, w: 0, h: 0 }) as unknown as import("@minim/signals").Writable<Box>;
}

// Strip the common leading indent that `Function.prototype.toString()`
// leaves on a class method's body (line 0 has none).
function dedent(s: string): string {
  const lines = s.split("\n");
  const indents = lines
    .slice(1)
    .filter(l => l.trim().length > 0)
    .map(l => (l.match(/^ */) ?? [""])[0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l, i) => (i === 0 ? l : l.slice(min))).join("\n");
}
