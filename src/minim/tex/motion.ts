// Motion combinators over tex shapes. Pure compositions on top of
// the existing motion stdlib (`tween`, `stagger`, signal effects);
// no per-tex animation primitives.

import { effect, signal, type Signal } from "../core/signal";
import { stagger } from "../motion/choreographers";
import { easeInOut, easeOut } from "../motion/easings";
import type { Animator, Easing } from "../core";
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
  /** SVG `<g>` wrapping the transit. We use a CSS transform on the
   *  `<g>` (matching Shape's own pattern) rather than an SVG-attribute
   *  transform on the inner `<foreignObject>` — different transform
   *  paths can rasterize the same fractional position to slightly
   *  different pixels, and the source/dest TexShapes both use the CSS
   *  transform path (`shape.el.style.transform`), so we want the
   *  rider on the same path. */
  g: SVGGElement;
  fo: SVGForeignObjectElement;
  pPart: Part;
  qPart: Part;
  /** Saved part opacities so we restore whatever the author had set,
   *  not just blindly bump back to 1. */
  prevP: number;
  prevQ: number;
  /** Source matched-mrow position in parent's local frame
   *  (`from.translate + p.aabb.tl`) — captured at morph start. */
  sx: number;
  sy: number;
  /** Trajectory delta in parent's local frame (`dPos − sPos`). */
  dx: number;
  dy: number;
  /** Matched-mrow offset within the cloned wrapper, equal to
   *  `p.aabb.tl` (the clone is a deep-copy with identical structure,
   *  so its matched mrow lands at the same offset within the wrapper
   *  as in the source). Used to anchor scale around the part. */
  natX: number;
  natY: number;
  /** dest / source size ratios, X and Y measured independently. ≠ 1
   *  when the part changes scriptlevel between source and dest (e.g.
   *  top-level → inside `<mfrac>` numerator), since MathML scales
   *  content inside fractions/scripts via the OpenType MATH table.
   *  After `stabilizePart` (`math-shift: normal; math-style: normal`)
   *  the rendered aspect ratio is context-independent, so in theory
   *  `rx ≈ ry`. Measuring both axes independently absorbs any
   *  residual anisotropy from line-box leading or font hinting at
   *  different sizes. */
  rx: number;
  ry: number;
  /** Single progress signal driving translate and scale together. */
  progress: Signal<number>;
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

/** Build a transit (`<g>` + `<foreignObject>`) containing a deep clone
 *  of `wrapper` with only the descendant carrying `matchedClass`
 *  rendered. The outer `<g>` is what the morph translates via CSS
 *  transform (matching Shape's own transform path for byte-identical
 *  rasterization). */
function buildTransit(
  wrapper: HTMLElement,
  matchedClass: string,
  width: number,
  height: number,
): { g: SVGGElement; fo: SVGForeignObjectElement } | null {
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

  const g = document.createElementNS(SVG_NS, "g") as SVGGElement;
  g.style.transformOrigin = "0 0";
  g.appendChild(fo);
  return { g, fo };
}

/** Animate from `from` to `to`, matching parts by name.
 *
 *  Strategy ("single source-context rider, analytically anchored"):
 *    1. Each matched part's mrow is stabilized at construction time
 *       (`math-shift: normal; math-style: normal` in tex.ts), so its
 *       *internal* layout — script elevation, bar gaps, etc. — is
 *       context-independent. Only its overall *size* changes with
 *       scriptlevel (top-level vs inside `<msqrt>` vs inside an
 *       `<mfrac>` numerator).
 *    2. For each match we clone the source's `<math>` wrapper into a
 *       transit and use CSS visibility to render only the matched
 *       mrow. The transit's outer `<g>` carries a CSS transform —
 *       same path Shape uses, so rasterization snaps to pixels the
 *       same way as `from.el` and `to.el`.
 *    3. Source / dest / clone-natural positions are derived
 *       analytically from `shape.translate.value + part.aabb.tl`
 *       (matched-mrow position in the parent's local frame). The
 *       clone is a deep-copy of the source wrapper, so its matched
 *       mrow lands at the same offset within the wrapper as in the
 *       source — i.e. `naturalPos = p.aabb.tl`. No DOM measurement
 *       in the morph hot path: zero `getBoundingClientRect` reads.
 *       This relies on (1): without stabilization the live render
 *       can drift from the (also stabilized) measurement performed
 *       at `tex.ts` construction time, and the analytical answer
 *       would no longer match what the user sees.
 *    4. The rider's CSS transform is `translate(...) scale(sx, sy)`
 *       driven by a single `progress` signal. `sx` tweens 1 → rx,
 *       `sy` tweens 1 → ry where `rx = q.aabb.w / p.aabb.w`,
 *       `ry = q.aabb.h / p.aabb.h`, so a part moving between
 *       contexts at different scriptlevels (e.g. top-level → inside
 *       `<mfrac>` numerator) smoothly resizes with its slide instead
 *       of popping size at the hand-off. With (1) in place `rx ≈ ry`,
 *       but measuring both axes independently absorbs any residual
 *       anisotropy from line-box leading or font hinting at different
 *       sizes. Scale is anchored at the matched mrow's local TL —
 *       see the effect below.
 *    5. At t=0 the rider lands exactly on `p.el`'s rendered position;
 *       at t=1 it lands exactly on `q.el`'s. Combined with the
 *       stabilization (1), the handoffs are pixel-perfect.
 *
 *  Parts whose content *differs* (e.g. `c^2` ↔ `c`) aren't ridden —
 *  they cross-fade with their parent shapes at their natural source
 *  and dest positions.
 *
 *  Assumptions: both shapes share a parent and have translate-only
 *  transforms relative to that parent (no per-shape scale or
 *  rotation). After completion, `from.opacity` is 0 and `to.opacity`
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

  const fromTr = from.translate.value;
  const toTr = to.translate.value;

  const transits: MorphTransit[] = [];
  const stops: Array<() => void> = [];

  // Size the transit foreignObject to comfortably contain the *full*
  // source wrapper — the clone holds the entire eq tree (just
  // visibility-hidden except for the matched mrow), so it needs the
  // eq's natural width/height plus headroom to avoid the wrapper
  // reflowing inside a too-narrow foreignObject.
  const transitW = Math.max(from.width.value, to.width.value) + 32;
  const transitH = Math.max(from.height.value, to.height.value) + 16;

  for (const p of from.parts) {
    const q = (to.parts as Record<string, Part>)[p.name];
    if (!q) continue;
    if (p.content !== q.content) continue;
    if (!p.el || !q.el) continue;

    const pa = p.aabb.value;
    const qa = q.aabb.value;
    if (pa.w === 0 || qa.w === 0 || pa.h === 0 || qa.h === 0) continue;

    const wrapper = findMathWrapper(p.el);
    if (!wrapper) continue;
    const matchedClass = `minim-part-${p.name}`;
    const built = buildTransit(wrapper, matchedClass, transitW, transitH);
    if (!built) continue;

    // sPos = fromTr + pa.tl  (matched mrow in parent frame, source).
    // dPos = toTr   + qa.tl  (matched mrow in parent frame, dest).
    // naturalPos = pa.tl     (clone is a deep-copy of source wrapper,
    // so its matched mrow lands at the same offset within the wrapper
    // as in the source).
    const sx = fromTr.x + pa.x;
    const sy = fromTr.y + pa.y;
    const dx = toTr.x + qa.x - sx;
    const dy = toTr.y + qa.y - sy;
    const natX = pa.x;
    const natY = pa.y;
    const rx = qa.w / pa.w;
    const ry = qa.h / pa.h;

    // Position the rider exactly where the source matched mrow sits
    // in parent coords, then mount. No measurement needed: the
    // formula below at p=0 produces transform = `translate(fromTr.x,
    // fromTr.y) scale(1, 1)`, which is precisely the source's own
    // position.
    built.g.style.transform = `translate(${fromTr.x}px, ${fromTr.y}px) scale(1, 1)`;
    parent.el.appendChild(built.g);

    const prevP = p.opacity.peek();
    const prevQ = q.opacity.peek();
    p.opacity.value = 0;
    q.opacity.value = 0;

    const transit: MorphTransit = {
      g: built.g,
      fo: built.fo,
      pPart: p,
      qPart: q,
      prevP,
      prevQ,
      sx,
      sy,
      dx,
      dy,
      natX,
      natY,
      rx,
      ry,
      progress: signal(0) as Signal<number>,
    };
    transits.push(transit);

    stops.push(
      effect(() => {
        // Anchor scale around the matched mrow's local TL so the
        // part stays glued to its trajectory while it resizes.
        // Per axis:
        //   matchedMrow_parent.x = tx + s · natX = curX
        //   ⇒ tx = curX − s · natX   (same for y).
        const t = transit.progress.value;
        const s_x = 1 + t * (transit.rx - 1);
        const s_y = 1 + t * (transit.ry - 1);
        const cx = transit.sx + t * transit.dx;
        const cy = transit.sy + t * transit.dy;
        const tx = cx - s_x * transit.natX;
        const ty = cy - s_y * transit.natY;
        transit.g.style.transform = `translate(${tx}px, ${ty}px) scale(${s_x}, ${s_y})`;
      }),
    );
  }

  try {
    yield [
      from.opacity.to(0, dt, ease),
      to.opacity.to(1, dt, ease),
      ...transits.map((t) => t.progress.to(1, dt, ease)),
    ];
  } finally {
    for (const s of stops) s();
    for (const t of transits) {
      t.pPart.opacity.value = t.prevP;
      t.qPart.opacity.value = t.prevQ;
      t.g.remove();
    }
    from.opacity.value = 0;
    to.opacity.value = 1;
  }
}

/** Sugar for `morph(from, to, dt)` — semantically: replace `from`
 *  with `to`, with matched parts carrying their identity across. */
export const substitute = morph;
