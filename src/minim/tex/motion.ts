// Motion combinators over tex shapes. Pure compositions on top of
// the existing motion stdlib (`tween`, `stagger`, `fadeIn`/`fadeOut`,
// effects on signals); zero new runtime mechanism.

import { effect, signal, type Signal } from "../core/signal";
import { stagger } from "../motion/choreographers";
import { easeInOut, easeOut } from "../motion/easings";
import type { Animator, Easing } from "../core";
import type { Part } from "./parts";
import type { TexShape } from "./tex";

// ── Highlight ───────────────────────────────────────────────────────

/** Pulse a part's `highlighted` signal — true for `dt` seconds, then
 *  back to false. The default highlight visual (subtle background
 *  tint) is wired by the parent TexShape. */
export function* highlight(part: Part, dt = 0.6): Animator {
  part.highlighted.value = true;
  try {
    yield dt;
  } finally {
    part.highlighted.value = false;
  }
}

// ── Reveal sweep — clip-path sweep across the wrapper ──────────────

/** Reveal a tex shape left-to-right via a clip-path sweep. The whole
 *  formula appears as if being written from the left margin. */
export function* write(
  eq: TexShape,
  dt = 0.6,
  ease: Easing = easeOut,
): Animator {
  const progress = signal(0);
  const stop = effect(() => {
    eq.el.style.clipPath = `inset(0 ${(1 - progress.value) * 100}% 0 0)`;
  });
  try {
    yield* progress.to(1, dt, ease);
  } finally {
    eq.el.style.clipPath = "";
    stop();
  }
}

/** Reverse of `write` — sweep back from right to left. After natural
 *  completion the formula is fully clipped (visually hidden); this
 *  pairs with `write` for round-trip reveal/hide. The caller can drop
 *  the clip-path explicitly via `eq.el.style.clipPath = ""` if they
 *  want it back without another `write`. */
export function* writeOut(
  eq: TexShape,
  dt = 0.4,
  ease: Easing = easeOut,
): Animator {
  const progress = signal(1);
  const stop = effect(() => {
    eq.el.style.clipPath = `inset(0 ${(1 - progress.value) * 100}% 0 0)`;
  });
  try {
    yield* progress.to(0, dt, ease);
  } finally {
    stop();
  }
}

// ── Per-part stagger ───────────────────────────────────────────────

function* fadePart(
  p: Part,
  target: number,
  dt: number,
  ease: Easing,
): Animator {
  if (!p.el) {
    yield dt;
    return;
  }
  const a = signal(target === 1 ? 0 : 1);
  const el = p.el;
  const stop = effect(() => {
    el.style.opacity = String(a.value);
  });
  try {
    yield* a.to(target, dt, ease);
  } finally {
    stop();
    el.style.opacity = "";
  }
}

/** Stagger a fade-in across the named parts of a tex shape. Touches
 *  only the parts' opacity — text outside parts stays visible (use
 *  `eq.opacity` for whole-shape fades). */
export function* writeParts(
  eq: TexShape,
  dt = 0.6,
  opts: { stride?: number; ease?: Easing } = {},
): Animator {
  const parts = eq.parts;
  if (parts.length === 0) {
    yield* eq.opacity.to(1, dt, opts.ease ?? easeOut);
    return;
  }
  for (const p of parts) {
    if (p.el) p.el.style.opacity = "0";
  }
  const stride =
    opts.stride ?? Math.max(0.04, dt / Math.max(2, parts.length * 1.5));
  const ease = opts.ease ?? easeOut;
  yield* stagger(stride, parts as readonly Part[], (p) =>
    fadePart(p, 1, dt * 0.7, ease),
  );
}

/** Reverse of `writeParts` — stagger fade-out across parts. */
export function* unwriteParts(
  eq: TexShape,
  dt = 0.4,
  opts: { stride?: number; ease?: Easing } = {},
): Animator {
  const parts = eq.parts;
  if (parts.length === 0) {
    yield* eq.opacity.to(0, dt, opts.ease ?? easeOut);
    return;
  }
  const stride =
    opts.stride ?? Math.max(0.03, dt / Math.max(2, parts.length * 1.5));
  const ease = opts.ease ?? easeOut;
  yield* stagger(stride, parts as readonly Part[], (p) =>
    fadePart(p, 0, dt * 0.7, ease),
  );
}

// ── Morph (matched by name) ────────────────────────────────────────

const SVG_NS = "http://www.w3.org/2000/svg";
const MML_NS = "http://www.w3.org/1998/Math/MathML";

/** Move `node` under `parent`, preferring `Element.moveBefore` when
 *  present (preserves animation, focus, iframe, custom-element state
 *  across the move). Falls back to `insertBefore` otherwise. */
function moveNode(parent: Node, node: Node, before: Node | null): void {
  const p = parent as Node & {
    moveBefore?: (n: Node, b: Node | null) => void;
  };
  if (typeof p.moveBefore === "function") {
    try {
      p.moveBefore(node, before);
      return;
    } catch {
      // Some browsers throw if move would change containing-block etc.;
      // fall through to plain insertBefore in that case.
    }
  }
  parent.insertBefore(node, before);
}

interface MorphTransit {
  fo: SVGForeignObjectElement;
  pEl: HTMLElement;
  qEl: HTMLElement;
  origParent: Node;
  origNext: Node | null;
  prevMathStyle: string;
  prevMathDepth: string;
  prevQVisibility: string;
  offX: Signal<number>;
  offY: Signal<number>;
  baseX: number;
  baseY: number;
  dx: number;
  dy: number;
}

/** Animate from `from` to `to`, matching parts by name.
 *
 *  Strategy ("morphable MathML via context-replicated transits"):
 *  for each matched part with identical content, we lift the *live*
 *  source DOM node out of `from` into a transit `<foreignObject>`
 *  that's a sibling of `from` and `to`. The transit replicates the
 *  surrounding MathML rendering context (font-family/size/weight/
 *  style, color, plus the MathML Core CSS properties `math-style`
 *  and `math-depth`) so the lifted node renders pixel-identically to
 *  its original placement. We then translate the transit from the
 *  source's screen position to the dest's, while crossfading
 *  `from.opacity` and `to.opacity` as wholes — the matched parts
 *  no longer live inside `from`, so they don't fade with it. After
 *  the tween we move the lifted node back to its original slot
 *  (preferring `Element.moveBefore`).
 *
 *  Why this works where naïve crossfades don't: MathML renders the
 *  same content with subtly different metrics in different ambient
 *  contexts (scriptlevel cascades, displaystyle, mathvariant). A
 *  source-and-dest crossfade therefore juxtaposes two slightly
 *  different renderings of "the same" sub-formula and produces a
 *  visible pop at the handoff. By rendering the matched part exactly
 *  once (in its source context, frozen via inline `math-depth` /
 *  `math-style` on the node itself) we eliminate the cross-context
 *  rendering disagreement entirely.
 *
 *  Parts whose content *differs* (e.g. `c^2` ↔ `c`) aren't ridden —
 *  they crossfade with their parent shapes at their natural source
 *  and dest positions.
 *
 *  Assumptions: both shapes share a parent and that parent's user
 *  frame is translate-only relative to screen (no rotation or
 *  non-uniform scale). After completion, `from.opacity` is 0 and
 *  `to.opacity` is 1. */
export function* morph(
  from: TexShape,
  to: TexShape,
  dt = 0.6,
  ease: Easing = easeInOut,
): Animator {
  const parent = from.parent;

  if (!parent || from.parent !== to.parent) {
    if (to.opacity.peek() < 1) to.opacity.value = 0;
    yield [from.opacity.to(0, dt, ease), to.opacity.to(1, dt, ease)];
    return;
  }

  // Force fresh layout — opacity:0 doesn't suppress layout, so part
  // bounding rects are valid regardless of current visibility.
  to.el.getBoundingClientRect();
  from.el.getBoundingClientRect();

  const sgEl = parent.el as unknown as SVGGraphicsElement;
  const ctm = sgEl.getScreenCTM?.();
  if (!ctm) {
    if (to.opacity.peek() < 1) to.opacity.value = 0;
    yield [from.opacity.to(0, dt, ease), to.opacity.to(1, dt, ease)];
    return;
  }
  const inv = ctm.inverse();

  interface Plan {
    p: Part;
    q: Part;
    pEl: HTMLElement;
    qEl: HTMLElement;
    sPosX: number;
    sPosY: number;
    dPosX: number;
    dPosY: number;
    widthLocal: number;
    heightLocal: number;
    fontSize: string;
    fontFamily: string;
    color: string;
    fontWeight: string;
    fontStyle: string;
    mathDepth: string;
    mathStyle: string;
  }

  // Pass 1 — measure every match before mutating either tree. Mutations
  // (moving p.el out of `from`) reflow surrounding operators and would
  // shift later measurements if interleaved with reads.
  const plans: Plan[] = [];
  for (const p of from.parts) {
    const q = (to.parts as Record<string, Part>)[p.name];
    if (!q) continue;
    if (p.content !== q.content) continue;
    if (!p.el || !q.el) continue;

    const sRect = p.el.getBoundingClientRect();
    const dRect = q.el.getBoundingClientRect();
    if (sRect.width === 0 || dRect.width === 0) continue;

    const cs = getComputedStyle(p.el);
    plans.push({
      p,
      q,
      pEl: p.el,
      qEl: q.el,
      sPosX: sRect.left * inv.a + sRect.top * inv.c + inv.e,
      sPosY: sRect.left * inv.b + sRect.top * inv.d + inv.f,
      dPosX: dRect.left * inv.a + dRect.top * inv.c + inv.e,
      dPosY: dRect.left * inv.b + dRect.top * inv.d + inv.f,
      widthLocal: sRect.width * Math.abs(inv.a),
      heightLocal: sRect.height * Math.abs(inv.d),
      fontSize: cs.fontSize,
      fontFamily: cs.fontFamily,
      color: cs.color,
      fontWeight: cs.fontWeight,
      fontStyle: cs.fontStyle,
      mathDepth: cs.getPropertyValue("math-depth").trim(),
      mathStyle: cs.getPropertyValue("math-style").trim(),
    });
  }

  const transits: MorphTransit[] = [];

  // Pass 2 — build transits, lift each `p.el` out of `from` into its
  // transit. Done in plan order; subsequent iterations don't read from
  // `from`'s layout, so reflow there is harmless.
  for (const pl of plans) {
    const fo = document.createElementNS(
      SVG_NS,
      "foreignObject",
    ) as SVGForeignObjectElement;
    fo.setAttribute("x", "0");
    fo.setAttribute("y", "0");
    fo.setAttribute("width", String(Math.max(pl.widthLocal, 1)));
    fo.setAttribute("height", String(Math.max(pl.heightLocal, 1)));
    fo.style.overflow = "visible";
    fo.style.pointerEvents = "none";

    const wrapper = document.createElement("div");
    wrapper.style.cssText = [
      `font-family:${pl.fontFamily}`,
      `font-size:${pl.fontSize}`,
      `color:${pl.color}`,
      `font-weight:${pl.fontWeight}`,
      `font-style:${pl.fontStyle}`,
      "line-height:1",
      "white-space:nowrap",
      "display:inline-block",
      "padding:0",
      "margin:0",
    ].join(";");

    const mathEl = document.createElementNS(MML_NS, "math") as Element &
      ElementCSSInlineStyle;
    mathEl.setAttribute("display", "inline");
    // Browsers (Chromium especially) don't reliably inherit font-family
    // for MathML rendering — the surd glyph & vinculum thickness come
    // from the OpenType MATH table of the *element's own* font. So we
    // re-apply every style that affects intrinsic rendering directly
    // on the `<math>` element, mirroring `styleMathRoot` in tex.ts.
    mathEl.style.fontFamily = pl.fontFamily;
    mathEl.style.fontSize = pl.fontSize;
    mathEl.style.color = pl.color;
    mathEl.style.fontWeight = pl.fontWeight;
    mathEl.style.fontStyle = pl.fontStyle;
    mathEl.style.lineHeight = "1";
    if (pl.mathStyle) mathEl.style.setProperty("math-style", pl.mathStyle);
    if (pl.mathDepth) mathEl.style.setProperty("math-depth", pl.mathDepth);

    wrapper.appendChild(mathEl);
    fo.appendChild(wrapper);

    // Freeze the matched part's MathML context onto itself so its
    // rendering doesn't shift when its ancestor chain changes from
    // `from`'s tree to the transit's `<math>`.
    const prevMathStyle = pl.pEl.style.getPropertyValue("math-style");
    const prevMathDepth = pl.pEl.style.getPropertyValue("math-depth");
    if (pl.mathStyle) pl.pEl.style.setProperty("math-style", pl.mathStyle);
    if (pl.mathDepth) pl.pEl.style.setProperty("math-depth", pl.mathDepth);

    parent.el.appendChild(fo);
    const origParent = pl.pEl.parentNode!;
    const origNext = pl.pEl.nextSibling;
    moveNode(mathEl, pl.pEl, null);

    const prevQVisibility = pl.qEl.style.visibility;
    pl.qEl.style.visibility = "hidden";

    transits.push({
      fo,
      pEl: pl.pEl,
      qEl: pl.qEl,
      origParent,
      origNext,
      prevMathStyle,
      prevMathDepth,
      prevQVisibility,
      offX: signal(0) as Signal<number>,
      offY: signal(0) as Signal<number>,
      baseX: pl.sPosX,
      baseY: pl.sPosY,
      dx: pl.dPosX - pl.sPosX,
      dy: pl.dPosY - pl.sPosY,
    });
  }

  const stops: Array<() => void> = [];
  for (const t of transits) {
    stops.push(
      effect(() => {
        t.fo.setAttribute(
          "transform",
          `translate(${t.baseX + t.offX.value} ${t.baseY + t.offY.value})`,
        );
      }),
    );
  }

  try {
    yield [
      from.opacity.to(0, dt, ease),
      to.opacity.to(1, dt, ease),
      ...transits.flatMap((t) => [
        t.offX.to(t.dx, dt, ease),
        t.offY.to(t.dy, dt, ease),
      ]),
    ];
  } finally {
    for (const s of stops) s();
    for (const t of transits) {
      moveNode(t.origParent, t.pEl, t.origNext);
      if (t.prevMathStyle) {
        t.pEl.style.setProperty("math-style", t.prevMathStyle);
      } else {
        t.pEl.style.removeProperty("math-style");
      }
      if (t.prevMathDepth) {
        t.pEl.style.setProperty("math-depth", t.prevMathDepth);
      } else {
        t.pEl.style.removeProperty("math-depth");
      }
      t.qEl.style.visibility = t.prevQVisibility;
      t.fo.remove();
    }
    from.opacity.value = 0;
    to.opacity.value = 1;
  }
}

/** Sugar for `morph(from, to, dt)` — semantically: replace `from`
 *  with `to`, with matched parts carrying their identity across. */
export const substitute = morph;
