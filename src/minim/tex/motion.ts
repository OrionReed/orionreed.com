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

interface MorphTransit {
  fo: SVGForeignObjectElement;
  pEl: HTMLElement;
  qEl: HTMLElement;
  prevMathStyle: string;
  prevMathDepth: string;
  prevPOpacity: string;
  prevQOpacity: string;
  offX: Signal<number>;
  offY: Signal<number>;
  baseX: number;
  baseY: number;
  dx: number;
  dy: number;
}

/** Animate from `from` to `to`, matching parts by name.
 *
 *  Strategy ("morphable MathML via context-replicated cloned riders"):
 *  for each matched part with identical content, the *original*
 *  source and dest nodes (`p.el`, `q.el`) are kept in place — just
 *  rendered transparent (opacity:0) so they continue to occupy
 *  layout space without being visible. Removing them would reflow
 *  surrounding operators (the `+` shifting, the radical shrinking)
 *  and produce visible jumps. Instead, we render a *clone* of the
 *  matched part inside a transit `<foreignObject>` that's a sibling
 *  of `from`/`to`. The transit replicates the MathML rendering
 *  context (font-family/size/weight/style, color, plus MathML Core's
 *  `math-depth` and `math-style`) and we measure-and-compensate the
 *  clone's actual rendered TL within the transit so it lands at the
 *  same pixel as the original. The transit is then translated from
 *  the source position to the dest position while `from.opacity`
 *  fades to 0 and `to.opacity` fades to 1.
 *
 *  Why cloning instead of the original: keeping `p.el` in place
 *  preserves source-side layout (no `+` jump, no operator-spacing
 *  shift), and keeping `q.el` in place preserves dest-side layout
 *  (no radical-resizing, no missing-content gaps). The clone is the
 *  only animated visible copy of the matched glyphs throughout the
 *  morph.
 *
 *  Why context replication instead of trusting cascade: MathML
 *  renders the same content differently in different ambient
 *  contexts. By locking the source's resolved CSS values onto the
 *  clone (and onto its wrapping `<math>`), the clone renders
 *  pixel-identically to the original and there's no cross-context
 *  disagreement to produce a pop.
 *
 *  Parts whose content *differs* (e.g. `c^2` ↔ `c`) aren't ridden —
 *  they crossfade with their parent shapes at their natural source
 *  and dest positions.
 *
 *  Assumptions: both shapes share a parent whose frame is
 *  translate-only relative to screen (no rotation or non-uniform
 *  scale). After completion, `from.opacity` is 0 and `to.opacity`
 *  is 1. */
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

  // Pass 1 — measure every match before any DOM/style mutations. We
  // hide originals via opacity:0 in Pass 2 (preserves layout), and
  // `getComputedStyle` returns the same values regardless, so this
  // ordering is mostly defensive: it keeps reads grouped before
  // writes for clarity and to avoid forcing extra layouts.
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

  // Pass 2 — build transits with cloned riders. The original `p.el`
  // and `q.el` stay in place to preserve source/dest layout; only
  // their opacity is dropped to 0.
  for (const pl of plans) {
    // Lock the source's MathML context onto `p.el` BEFORE cloning, so
    // the clone inherits the same locked values and renders identical-
    // ly to the live source.
    const prevMathStyle = pl.pEl.style.getPropertyValue("math-style");
    const prevMathDepth = pl.pEl.style.getPropertyValue("math-depth");
    if (pl.mathStyle) pl.pEl.style.setProperty("math-style", pl.mathStyle);
    if (pl.mathDepth) pl.pEl.style.setProperty("math-depth", pl.mathDepth);

    const clone = pl.pEl.cloneNode(true) as HTMLElement;

    const fo = document.createElementNS(
      SVG_NS,
      "foreignObject",
    ) as SVGForeignObjectElement;
    fo.setAttribute("x", "0");
    fo.setAttribute("y", "0");
    fo.setAttribute("width", String(Math.max(pl.widthLocal * 2, 1)));
    fo.setAttribute("height", String(Math.max(pl.heightLocal * 2, 1)));
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

    mathEl.appendChild(clone);
    wrapper.appendChild(mathEl);
    fo.appendChild(wrapper);

    // Mount with no transform yet so we can read the clone's natural
    // rendered position within the parent frame.
    fo.setAttribute("transform", "translate(0 0)");
    parent.el.appendChild(fo);

    // Compensate for the clone's offset within the foreignObject. The
    // clone's TL inside the transit isn't necessarily at the fo's TL —
    // there's wrapper padding, math baseline alignment, etc. By
    // measuring where the clone actually rendered we can pick a
    // transit translate that places the clone's TL exactly at the
    // source position.
    const cloneRect = clone.getBoundingClientRect();
    const cloneInParentX =
      cloneRect.left * inv.a + cloneRect.top * inv.c + inv.e;
    const cloneInParentY =
      cloneRect.left * inv.b + cloneRect.top * inv.d + inv.f;
    const baseX = pl.sPosX - cloneInParentX;
    const baseY = pl.sPosY - cloneInParentY;

    // Hide originals (preserves layout, since opacity:0 doesn't affect
    // box sizing). The clone in the transit is now the only visible
    // copy of this matched part.
    const prevPOpacity = pl.pEl.style.opacity;
    const prevQOpacity = pl.qEl.style.opacity;
    pl.pEl.style.opacity = "0";
    pl.qEl.style.opacity = "0";

    transits.push({
      fo,
      pEl: pl.pEl,
      qEl: pl.qEl,
      prevMathStyle,
      prevMathDepth,
      prevPOpacity,
      prevQOpacity,
      offX: signal(0) as Signal<number>,
      offY: signal(0) as Signal<number>,
      baseX,
      baseY,
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
      // Restore opacities on the live originals.
      t.pEl.style.opacity = t.prevPOpacity;
      t.qEl.style.opacity = t.prevQOpacity;
      // Restore the locked MathML context attributes on `p.el` (we
      // set them eagerly so the clone would inherit identical
      // rendering; the originals were rendering with these values via
      // cascade anyway, but we don't want to leave inline overrides
      // hanging around).
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
      t.fo.remove();
    }
    from.opacity.value = 0;
    to.opacity.value = 1;
  }
}

/** Sugar for `morph(from, to, dt)` — semantically: replace `from`
 *  with `to`, with matched parts carrying their identity across. */
export const substitute = morph;
