// Motion combinators over tex shapes. Pure compositions on top of
// the existing motion stdlib (`tween`, `stagger`, signal effects);
// no per-tex animation primitives.

import { effect, signal, type Signal } from "../core/signal";
import { stagger } from "../motion/choreographers";
import { easeInOut, easeOut } from "../motion/easings";
import type { Animator, Easing } from "../core";
import { transformPoint } from "../scene/matrix";
import type { Part } from "./parts";
import type { TexShape } from "./tex";

const SVG_NS = "http://www.w3.org/2000/svg";

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
 *  pairs with `write` for round-trip reveal/hide. */
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

/** Stagger a fade-in across the named parts of a tex shape. Touches
 *  only the parts' opacity — text outside parts stays visible (use
 *  `eq.opacity` for whole-shape fades). */
export function* writeParts(
  eq: TexShape,
  dt = 0.6,
  opts: { stride?: number; ease?: Easing } = {},
): Animator {
  const parts = eq.parts;
  const ease = opts.ease ?? easeOut;
  if (parts.length === 0) {
    yield* eq.opacity.to(1, dt, ease);
    return;
  }
  for (const p of parts) p.opacity.value = 0;
  const stride =
    opts.stride ?? Math.max(0.04, dt / Math.max(2, parts.length * 1.5));
  yield* stagger(stride, parts as readonly Part[], (p) =>
    p.opacity.to(1, dt * 0.7, ease),
  );
}

/** Reverse of `writeParts` — stagger fade-out across parts. */
export function* unwriteParts(
  eq: TexShape,
  dt = 0.4,
  opts: { stride?: number; ease?: Easing } = {},
): Animator {
  const parts = eq.parts;
  const ease = opts.ease ?? easeOut;
  if (parts.length === 0) {
    yield* eq.opacity.to(0, dt, ease);
    return;
  }
  const stride =
    opts.stride ?? Math.max(0.03, dt / Math.max(2, parts.length * 1.5));
  yield* stagger(stride, parts as readonly Part[], (p) =>
    p.opacity.to(0, dt * 0.7, ease),
  );
}

// ── Morph (matched by name) ────────────────────────────────────────

interface MorphTransit {
  /** Transit foreignObject holding a clone of source's wrapper, with
   *  only the matched mrow visible. */
  fo: SVGForeignObjectElement;
  pPart: Part;
  qPart: Part;
  /** Saved part opacities so we restore whatever the author had set,
   *  not just blindly bump back to 1. */
  prevP: number;
  prevQ: number;
  /** Translate (in parent-frame user units) that places the cloned
   *  matched mrow at sourcePos. The wrapper's matched-mrow offset
   *  equals `p.bounds.tl` analytically (the clone is a deep copy of
   *  the same wrapper), so no DOM measurement is needed. */
  baseX: number;
  baseY: number;
  /** Trajectory in parent-frame user units. */
  dx: number;
  dy: number;
  offX: Signal<number>;
  offY: Signal<number>;
}

/** Walk up to the nearest `<math>` and return its parent (the wrapper
 *  div that tex.ts mounts in the foreignObject) — what we deep-clone
 *  to give the morph rider its byte-identical context. */
function findMathWrapper(matchedEl: HTMLElement): HTMLElement | null {
  let mathEl: Element | null = matchedEl.parentElement;
  while (mathEl && mathEl.tagName.toLowerCase() !== "math") {
    mathEl = mathEl.parentElement;
  }
  if (!mathEl) return null;
  const wrapper = mathEl.parentElement;
  return wrapper instanceof HTMLElement ? wrapper : null;
}

/** Build a transit foreignObject containing a deep clone of `wrapper`
 *  with only the descendant carrying `matchedClass` rendered. */
function buildTransit(
  wrapper: HTMLElement,
  matchedClass: string,
  width: number,
  height: number,
): SVGForeignObjectElement | null {
  const wrapperClone = wrapper.cloneNode(true) as HTMLElement;
  const matchedClone = wrapperClone.querySelector(
    `.${matchedClass}`,
  ) as HTMLElement | null;
  const mathClone = wrapperClone.querySelector("math") as HTMLElement | null;
  if (!matchedClone || !mathClone) return null;
  // Hide the whole math tree, then re-show just the matched mrow.
  // Visibility preserves layout, so the matched mrow lands at exactly
  // the same offset within the clone as it does in the source — the
  // surrounding glyphs are present (so layout is untouched) but
  // invisible.
  mathClone.style.visibility = "hidden";
  matchedClone.style.visibility = "visible";

  const fo = document.createElementNS(
    SVG_NS,
    "foreignObject",
  ) as SVGForeignObjectElement;
  fo.setAttribute("x", "0");
  fo.setAttribute("y", "0");
  fo.setAttribute("width", String(Math.max(width, 1)));
  fo.setAttribute("height", String(Math.max(height, 1)));
  fo.style.overflow = "visible";
  fo.style.pointerEvents = "none";
  fo.appendChild(wrapperClone);
  return fo;
}

/** Animate from `from` to `to`, matching parts by name.
 *
 *  Strategy ("single source-context rider"):
 *    1. Each matched part's mrow is stabilized at construction time
 *       (`math-shift: normal` in tex.ts), so it renders with the same
 *       glyph offsets in *any* ambient context — top-level, inside an
 *       `<msqrt>`, inside an `<mfrac>` denominator, etc.
 *    2. For each match we clone the source's `<math>` wrapper into a
 *       transit `<foreignObject>` and use CSS visibility to render
 *       only the matched mrow. Because the clone is a deep copy of
 *       the source tree, the matched mrow's offset within the wrapper
 *       equals `p.bounds.tl` analytically — no DOM measurement.
 *    3. The transit translates from sourcePos to destPos in the
 *       parent's local frame. The originals (`p.el`, `q.el`) hold
 *       their slots at `opacity: 0` (preserving source/dest layout
 *       so the surrounding glyphs don't reflow), and `from.opacity` /
 *       `to.opacity` cross-fade the structural background.
 *    4. At t=0 the rider matches `p.el` byte-for-byte (it *is* a clone
 *       of the same tree); at t=1 it matches `q.el` byte-for-byte
 *       because the stabilization removed the only context-dependent
 *       layout knob. Both handoffs are pixel-perfect; no ghosting.
 *
 *  Parts whose content *differs* (e.g. `c^2` ↔ `c`) aren't ridden —
 *  they cross-fade with their parent shapes at their natural source
 *  and dest positions.
 *
 *  Assumptions: both shapes share a parent whose frame is
 *  translate-only relative to screen (no rotation or non-uniform
 *  scale). After completion, `from.opacity` is 0 and `to.opacity`
 *  is 1.
 */
export function* morph(
  from: TexShape,
  to: TexShape,
  dt = 0.6,
  ease: Easing = easeInOut,
): Animator {
  const parent = from.parent;
  const fallback = (): [Animator, Animator] => {
    if (to.opacity.peek() < 1) to.opacity.value = 0;
    return [from.opacity.to(0, dt, ease), to.opacity.to(1, dt, ease)];
  };

  if (!parent || from.parent !== to.parent) {
    yield fallback();
    return;
  }

  // Compose source/dest positions in the parent's local frame
  // analytically — `Part.bounds` is in each TexShape's local frame,
  // and `Shape.transform` lifts that into the parent frame. No
  // `getBoundingClientRect` needed; we read pure signal state.
  const fromMat = from.transform.value;
  const toMat = to.transform.value;

  interface Plan {
    pPart: Part;
    qPart: Part;
    pEl: HTMLElement;
    qEl: HTMLElement;
    sPos: { x: number; y: number };
    dPos: { x: number; y: number };
    pBoundsTL: { x: number; y: number };
    width: number;
    height: number;
  }

  const plans: Plan[] = [];
  for (const p of from.parts) {
    const q = (to.parts as Record<string, Part>)[p.name];
    if (!q) continue;
    if (p.content !== q.content) continue;
    if (!p.el || !q.el) continue;

    const pb = p.bounds.value;
    const qb = q.bounds.value;
    if (pb.w === 0 || qb.w === 0) continue;

    plans.push({
      pPart: p,
      qPart: q,
      pEl: p.el,
      qEl: q.el,
      sPos: transformPoint(fromMat, { x: pb.x, y: pb.y }),
      dPos: transformPoint(toMat, { x: qb.x, y: qb.y }),
      pBoundsTL: { x: pb.x, y: pb.y },
      width: pb.w,
      height: pb.h,
    });
  }

  const transits: MorphTransit[] = [];
  const stops: Array<() => void> = [];

  for (const pl of plans) {
    const wrapper = findMathWrapper(pl.pEl);
    if (!wrapper) continue;
    const matchedClass = `minim-part-${pl.pPart.name}`;
    // Generous transit canvas so the surrounding (invisible) glyphs
    // have room to lay out without clipping the visible mrow.
    const fo = buildTransit(
      wrapper,
      matchedClass,
      Math.max(pl.width * 8 + 16, 64),
      Math.max(pl.height * 4 + 8, 32),
    );
    if (!fo) continue;

    // Place the foreignObject so its content's matched-mrow lands at
    // sourcePos. Matched-mrow offset within the wrapper equals
    // `p.bounds.tl` (the wrapper is a deep clone of the same DOM
    // tree); foreignObject TL = sourcePos − boundsTL.
    const baseX = pl.sPos.x - pl.pBoundsTL.x;
    const baseY = pl.sPos.y - pl.pBoundsTL.y;
    fo.setAttribute("transform", `translate(${baseX} ${baseY})`);
    parent.el.appendChild(fo);

    const prevP = pl.pPart.opacity.peek();
    const prevQ = pl.qPart.opacity.peek();
    pl.pPart.opacity.value = 0;
    pl.qPart.opacity.value = 0;

    const transit: MorphTransit = {
      fo,
      pPart: pl.pPart,
      qPart: pl.qPart,
      prevP,
      prevQ,
      baseX,
      baseY,
      dx: pl.dPos.x - pl.sPos.x,
      dy: pl.dPos.y - pl.sPos.y,
      offX: signal(0) as Signal<number>,
      offY: signal(0) as Signal<number>,
    };
    transits.push(transit);

    stops.push(
      effect(() => {
        transit.fo.setAttribute(
          "transform",
          `translate(${transit.baseX + transit.offX.value} ${transit.baseY + transit.offY.value})`,
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
      t.pPart.opacity.value = t.prevP;
      t.qPart.opacity.value = t.prevQ;
      t.fo.remove();
    }
    from.opacity.value = 0;
    to.opacity.value = 1;
  }
}

/** Sugar for `morph(from, to, dt)` — semantically: replace `from`
 *  with `to`, with matched parts carrying their identity across. */
export const substitute = morph;
