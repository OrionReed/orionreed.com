// Motion combinators over tex shapes. Pure compositions on top of
// the existing motion stdlib (`tween`, `stagger`, signal effects);
// no per-tex animation primitives.
//
// `pluck` is the foundational primitive: it lifts a `Part` out of its
// parent TexShape into a free-standing Shape (a `Plucked`) you can
// translate / scale / rotate independently. Disposing the Plucked
// (directly or via `unpluck`) restores the source's pre-pluck
// opacity. `morph` and `swap` are then thin combinators over
// pluck/unpluck — there's no separate "rider" / "transit" concept,
// just a Plucked that may or may not be animated by `unpluck`.

import { effect, signal } from "../core/signal";
import { stagger, swap as swapPositions } from "../motion/choreographers";
import { easeInOut, easeOut } from "../motion/easings";
import { all } from "../core/compose";
import type { Animator, Easing } from "../core";
import { Shape, type Writable } from "../scene/shape";
import { aabb } from "../scene/box";
import { Part } from "./parts";
import type { TexShape } from "./tex";

/** Wildcard `TexShape` that accepts any `Names` union. Used in
 *  signatures so a `TexShape<"a"|"b">` and `TexShape<"f"|"x">` flow
 *  into the same function — necessary for cross-cycle morphs and for
 *  combinators that don't care which names a TexShape carries. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTex = TexShape<any>;

const SVG_NS = "http://www.w3.org/2000/svg";

// ── Highlight ───────────────────────────────────────────────────────

/** Pulse a part's `highlighted` signal — true for `dt` seconds, then
 *  back to false. The default highlight visual (subtle background
 *  tint) is wired by Part itself when its el is bound. */
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
  eq: AnyTex,
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
 *  completion the formula is fully clipped (visually hidden); pairs
 *  with `write` for round-trip reveal/hide. */
export function* writeOut(
  eq: AnyTex,
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
  eq: AnyTex,
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
  eq: AnyTex,
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

// ── pluck / unpluck — the "rider" primitive ────────────────────────

/** Walk up to the nearest `<math>` and return its parent (the wrapper
 *  div that tex.ts mounts in the foreignObject) — what we deep-clone
 *  to give a Plucked its byte-identical context. */
const findMathWrapper = (matchedEl: HTMLElement): HTMLElement | null => {
  let cur: Element | null = matchedEl.parentElement;
  while (cur && cur.tagName.toLowerCase() !== "math") {
    cur = cur.parentElement;
  }
  if (!cur) return null;
  const wrapper = cur.parentElement;
  return wrapper instanceof HTMLElement ? wrapper : null;
};

/** Matched-mrow position (parent-frame, top-left) for `part` at this
 *  instant — `host.translate + part.aabb.tl`. */
const partPose = (part: Part): { x: number; y: number } => {
  const tr = part._host.translate.value;
  const a = part.aabb.value;
  return { x: tr.x + a.x, y: tr.y + a.y };
};

/** A part lifted out of its TexShape. A regular Shape (transform,
 *  opacity, decorations all work). `translate` is the matched mrow's
 *  TL position in parent coords — animate it directly to fly the
 *  part around. `scale` pivots around the same TL.
 *
 *  Created by `pluck(part)`. The source part is hidden (opacity 0)
 *  for the Plucked's lifetime; `dispose()` restores it. `unpluck`
 *  is sugar that animates a tween into a target pose then disposes. */
export class Plucked extends Shape {
  readonly source: Part;
  readonly #sourcePrevOpacity: number;

  constructor(source: Part) {
    // The cloned wrapper is shifted (in CSS) so the matched mrow
    // lands at (0, 0) of our local frame — see `pluck`. So our local
    // AABB is just the mrow's footprint at the origin. Combined with
    // origin=(0,0), this makes `plucked.translate` semantically
    // equal to "matched mrow TL in parent coords".
    const a = source.aabb.peek();
    const local = aabb(0, 0, a.w, a.h);
    super("foreignObject", () => local);
    this.source = source;
    this.#sourcePrevOpacity = source.opacity.peek();
    source.opacity.value = 0;
  }

  /** Restore the source part's pre-pluck opacity and remove the
   *  Plucked's DOM — reverses everything `pluck` did. */
  dispose(): void {
    this.source.opacity.value = this.#sourcePrevOpacity;
    super.dispose();
  }
}

/** Lift `part` out of its TexShape into a free `Plucked` Shape and
 *  mount it under the same parent. Source part is hidden (opacity 0)
 *  for the Plucked's lifetime; restore by calling `plucked.dispose()`
 *  or `unpluck(plucked, ...)`. */
export function pluck(part: Part): Plucked {
  const liveEl = part.el;
  const host = part._host;
  if (!liveEl || !host?.parent) {
    throw new Error(
      "pluck: part has no live element or its TexShape isn't mounted",
    );
  }
  const wrapper = findMathWrapper(liveEl);
  if (!wrapper) throw new Error("pluck: cannot find <math> wrapper");

  const aabbLocal = part.aabb.value;
  const pose = partPose(part);

  // Clone the wrapper, hide everything except the matched mrow.
  // `visibility: hidden` preserves layout so the mrow lands at the
  // same offset within the clone as in the source.
  const clonedWrapper = wrapper.cloneNode(true) as HTMLElement;
  const matchedClone = clonedWrapper.querySelector<HTMLElement>(
    `.minim-part-${part.name}`,
  );
  const mathClone = clonedWrapper.querySelector("math") as HTMLElement | null;
  if (!matchedClone || !mathClone) {
    throw new Error("pluck: cloned wrapper lost its matched mrow");
  }
  mathClone.style.visibility = "hidden";
  matchedClone.style.visibility = "visible";
  // Shift the wrapper so the matched mrow lands at (0, 0) of the
  // foreignObject's local frame. Combined with the Plucked's
  // aabb=(0,0,w,h), `plucked.translate` == matched mrow's parent-
  // frame TL position — animate translate, mrow follows directly.
  clonedWrapper.style.transform = `translate(${-aabbLocal.x}px, ${-aabbLocal.y}px)`;
  clonedWrapper.style.transformOrigin = "0 0";

  const plucked = new Plucked(part);
  const fo = plucked.intrinsic as SVGForeignObjectElement;
  // Size to comfortably contain the full clone (which carries the
  // whole eq tree, just visibility-hidden except for the matched
  // mrow). Generous padding absorbs any fractional growth from
  // font-hinting.
  fo.setAttribute("x", "0");
  fo.setAttribute("y", "0");
  fo.setAttribute("width", String(Math.max(host.width.value + 32, 1)));
  fo.setAttribute("height", String(Math.max(host.height.value + 16, 1)));
  fo.style.overflow = "visible";
  fo.style.pointerEvents = "none";
  fo.appendChild(clonedWrapper);

  // Land the matched mrow exactly where the source one is right now.
  plucked.translate.value = pose;

  host.parent.add(plucked);
  return plucked;
}

/** Sugar: animate `plucked` into `target`'s pose (or back to its own
 *  source if no target is given), then dispose. Disposal restores
 *  the *source*'s opacity automatically — `unpluck` deliberately
 *  doesn't touch the destination's opacity, so callers can compose
 *  parallel pluck/unpluck pairs without races.
 *
 *  Translates only, no automatic scale. The Plucked keeps its source's
 *  natural size — important when target is a *different* Part (e.g.
 *  the two letters in a `swap(a, b)`): the rider showing "a" should
 *  visit b's *position* without morphing into b's glyph metrics, or
 *  the user sees an unwanted vertical stretch as it travels. If you
 *  want morph-style fit-into-target sizing, animate `scale` yourself
 *  alongside this — that's what `morph` does. */
export function* unpluck(
  plucked: Plucked,
  target?: Part,
  dt = 0.5,
  ease: Easing = easeInOut,
): Animator {
  const dest = target ?? plucked.source;
  try {
    yield* plucked.translate.to(partPose(dest), dt, ease);
  } finally {
    plucked.dispose();
  }
}

// ── Morph (matched by name, auto rewrite) ──────────────────────────

/** Animate from `from` to `to`, matching parts by name.
 *
 *  For each name shared between `from` and `to`:
 *
 *    • If the part's content matches, a single `Plucked` rides the
 *      source content from `from`'s slot to `to`'s slot, scaling
 *      along the way to absorb scriptlevel changes.
 *
 *    • If the content *differs* (a "rewrite": `f'(x)` vs `Df`), two
 *      Plucked's ride the same trajectory — source-content fades
 *      out, dest-content fades in. Auto, no flag.
 *
 *  Parts with no counterpart on the other side cross-fade with their
 *  parent's whole-shape opacity envelope.
 *
 *  Assumes both shapes share a parent and have translate-only
 *  transforms relative to that parent. Heterogeneous name unions are
 *  fine: `morph(m1, d1)` where neither side's names overlap falls
 *  through to a clean parent crossfade. */
export function* morph(
  from: AnyTex,
  to: AnyTex,
  dt = 0.6,
  ease: Easing = easeInOut,
): Animator {
  const parent = from.parent;
  if (!parent || from.parent !== to.parent) {
    if (to.opacity.peek() < 1) to.opacity.value = 0;
    yield [from.opacity.to(0, dt, ease), to.opacity.to(1, dt, ease)];
    return;
  }

  // Make sure `to` starts hidden — riders supply visible content for
  // matched parts during the flight, parent crossfade handles the
  // rest. (No-op if already 0.)
  if (to.opacity.peek() !== 0) to.opacity.value = 0;

  const animators: Animator[] = [
    from.opacity.to(0, dt, ease),
    to.opacity.to(1, dt, ease),
  ];
  /** Each rider — and the q.opacity hide for the same-content case —
   *  registers a teardown here. Run on the morph's `finally` so the
   *  cleanup happens even if interrupted. */
  const cleanups: Array<() => void> = [];

  for (const p of from.parts) {
    const q = (to.parts as Record<string, Part>)[p.name];
    if (!q) continue;
    if (!p.el || !q.el) continue;
    const pa = p.aabb.value;
    const qa = q.aabb.value;
    if (pa.w === 0 || qa.w === 0 || pa.h === 0 || qa.h === 0) continue;

    const sameContent = p.content.peek() === q.content.peek();
    const destPose = partPose(q);

    // Source rider: travels from p's pose (at scale 1) to q's pose
    // (scaled to match q's size). Same logic for both branches; the
    // rewrite branch additionally fades it out.
    const srcRider = pluck(p);
    animators.push(
      srcRider.translate.to(destPose, dt, ease),
      srcRider.scale.to({ x: qa.w / pa.w, y: qa.h / pa.h }, dt, ease),
    );
    cleanups.push(() => srcRider.dispose());

    if (sameContent) {
      // Source clone *is* the right content; keep visible end-to-end.
      // Hide q during the flight; restore at the end. (q.opacity is
      // restored to whatever the author had set, not blindly to 1.)
      const prevQ = q.opacity.peek();
      q.opacity.value = 0;
      cleanups.push(() => {
        q.opacity.value = prevQ;
      });
    } else {
      // Rewrite: pluck q too and ride it on the same trajectory,
      // crossfading from src→dest. Initial pose: at p's location,
      // scaled down so the visible footprint matches src at t=0.
      const destRider = pluck(q);
      destRider.translate.value = partPose(p);
      destRider.scale.value = { x: pa.w / qa.w, y: pa.h / qa.h };
      destRider.opacity.value = 0;
      animators.push(
        srcRider.opacity.to(0, dt, ease),
        destRider.translate.to(destPose, dt, ease),
        destRider.scale.to({ x: 1, y: 1 }, dt, ease),
        destRider.opacity.to(1, dt, ease),
      );
      cleanups.push(() => destRider.dispose());
    }
  }

  try {
    yield animators;
  } finally {
    for (const c of cleanups) c();
    from.opacity.value = 0;
    to.opacity.value = 1;
  }
}

/** Sugar for `morph(from, to, dt)` — semantically: replace `from`
 *  with `to`, with matched parts carrying their identity across. */
export const substitute = morph;

// ── Swap — exchange two things' positions ─────────────────────────

/** Exchange two things' positions over `dt` seconds. Two flavors,
 *  dispatched on `instanceof Part`:
 *
 *    • `swap(p1: Part, p2: Part)` — pluck both parts, animate each
 *      into the other's slot, dispose. Visual swap is transient: at
 *      the end both parts are restored at their original template
 *      positions (the demo value is in the choreography, not in
 *      permanent reassignment).
 *
 *    • `swap(s1, s2)` for any two shapes with writable `translate` —
 *      tweens their `translate` values to each other (the original
 *      motion-stdlib swap, kept here so a single name covers both
 *      Part and Shape callers). */
export function swap(a: Part, b: Part, dt?: number, ease?: Easing): Animator;
export function swap(
  a: Writable<"translate">,
  b: Writable<"translate">,
  dt?: number,
  ease?: Easing,
): Animator;
export function swap(
  a: Part | Writable<"translate">,
  b: Part | Writable<"translate">,
  dt = 0.5,
  ease?: Easing,
): Animator {
  if (a instanceof Part && b instanceof Part)
    return swapPartsImpl(a, b, dt, ease ?? easeInOut);
  return swapPositions(
    a as Writable<"translate">,
    b as Writable<"translate">,
    dt,
    ease,
  );
}

function* swapPartsImpl(
  a: Part,
  b: Part,
  dt: number,
  ease: Easing,
): Animator {
  const ah = pluck(a);
  const bh = pluck(b);
  yield all(unpluck(ah, b, dt, ease), unpluck(bh, a, dt, ease));
}
