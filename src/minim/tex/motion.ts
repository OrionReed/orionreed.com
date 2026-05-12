// Motion combinators over tex shapes. Pure compositions on top of
// the existing motion stdlib (`tween`, `stagger`, signal effects);
// no per-tex animation primitives.
//
// `pluck` is the foundational primitive: it lifts a `Part` out of its
// parent TexShape into a free-standing Shape (a `Plucked`) you can
// translate / scale / rotate independently. Disposing the Plucked
// (directly or via `unpluck`) restores the source's pre-pluck
// opacity. `morph` is then a thin combinator over pluck/unpluck —
// there's no separate "rider" / "transit" concept, just a Plucked
// that may or may not be animated by `unpluck`.
//
// For per-part stagger (the common "reveal each named part in turn"
// recipe), use minim's existing `stagger` directly:
//
//      for (const p of eq.parts) p.opacity.value = 0;
//      yield* stagger(0.05, eq.parts, p => p.opacity.to(1, 0.3));
//
// Composes with any per-part animation (`fadeIn`, `slideIn`, custom).

import { effect, signal } from "../core/signal";
import { easeInOut, easeOut } from "../motion/easings";
import type { Animator, Easing } from "../core";
import { Shape } from "../scene/shape";
import { aabb } from "../scene/box";
import { Part, type PartMarker } from "./parts";
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
 *  formula appears as if being written from the left margin.
 *
 *  We clip the inner HTML wrapper inside the foreignObject — *not*
 *  the outer `<g>` — because CSS clip-path on an SVG element doesn't
 *  reliably invalidate composite layers for foreignObject HTML
 *  content (Chromium especially), causing visible tearing and
 *  end-of-tween snap-pops. HTML elements honor clip-path
 *  consistently. */
export function* write(
  eq: AnyTex,
  dt = 0.6,
  ease: Easing = easeOut,
): Animator {
  const target = clipTarget(eq);
  const progress = signal(0);
  const stop = effect(() => {
    target.style.clipPath = `inset(0 ${(1 - progress.value) * 100}% 0 0)`;
  });
  try {
    yield* progress.to(1, dt, ease);
  } finally {
    target.style.clipPath = "";
    stop();
  }
}

/** Reverse of `write` — sweep back from right to left. After
 *  completion the formula is fully hidden (`opacity: 0`) and
 *  clip-path is cleared, so the eq is in a clean state for a future
 *  `write` (which will start from full clip and sweep open). Pairs
 *  with `write` for round-trip reveal/hide. */
export function* writeOut(
  eq: AnyTex,
  dt = 0.4,
  ease: Easing = easeOut,
): Animator {
  const target = clipTarget(eq);
  const progress = signal(1);
  const stop = effect(() => {
    target.style.clipPath = `inset(0 ${(1 - progress.value) * 100}% 0 0)`;
  });
  try {
    yield* progress.to(0, dt, ease);
  } finally {
    stop();
    // Hide via opacity (so future shows are a single `eq.opacity = 1`)
    // and clear the clip-path inline style so the next `write` starts
    // from its own initial clip rather than this one's residue.
    eq.opacity.value = 0;
    target.style.clipPath = "";
  }
}

/** The inner wrapper div inside the foreignObject — the HTML element
 *  that hosts the rendered `<math>`. Falls back to the outer `<g>`
 *  if for some reason the wrapper isn't there yet (defensive). */
const clipTarget = (eq: AnyTex): HTMLElement | SVGGElement => {
  const fo = eq.intrinsic as SVGForeignObjectElement | undefined;
  const wrapper = fo?.firstElementChild;
  return wrapper instanceof HTMLElement ? wrapper : eq.el;
};

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
  const tr = part.host.translate.value;
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
  const host = part.host;
  if (!liveEl || !host.parent) {
    throw new Error(
      "pluck: TexShape isn't mounted yet — `s(eq)` it before plucking",
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

/** Animate from `from` to `to`, matching parts by *marker identity*.
 *
 *  Two parts share identity when they were instantiated from the
 *  same `PartMarker` reference (typically by sharing the markers
 *  produced by a single `parts({...})` call across multiple
 *  templates), or when one's marker is the `group` of the other —
 *  i.e. it's a `derived` component (see `PartMarker.derived`).
 *
 *  Group both sides by identity root (`marker.group ?? marker`) and
 *  branch by cardinality:
 *
 *    • 1↔1, same content      ride a single source-content clone
 *                             from `from`'s slot to `to`'s slot.
 *    • 1↔1, different content same trajectory; source-content fades
 *                             out, dest-content fades in (rewrite).
 *    • 1↔N (fan-out)          source fades in place; N riders
 *                             *emerge* from source's slot and slide
 *                             to their respective dest slots, fading
 *                             in. e.g. `\vec{v}` → `(v_x, v_y, v_z)`.
 *    • N↔1 (fan-in)           N source riders converge to dest's
 *                             slot, fading out; dest fades in there.
 *    • N↔M (rare)             pair by index; extras get the
 *                             whole-parent crossfade.
 *
 *  Parts with no counterpart on the other side cross-fade with their
 *  parent's whole-shape opacity envelope.
 *
 *  Assumes both shapes share a parent and have translate-only
 *  transforms relative to that parent. */
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
  /** Each rider registers its dispose here. Run in the morph's
   *  `finally` so cleanup happens even if interrupted. */
  const cleanups: Array<() => void> = [];

  // Group both sides by identity root. `groupRoot(marker)` returns
  // the topmost marker in a `marker → marker.group → …` chain — two
  // parts share identity for morph iff they share a root.
  const fromByRoot = groupByRoot(from.parts);
  const toByRoot = groupByRoot(to.parts);

  for (const root of new Set([...fromByRoot.keys(), ...toByRoot.keys()])) {
    const fps = fromByRoot.get(root) ?? [];
    const tps = toByRoot.get(root) ?? [];
    if (fps.length === 0 || tps.length === 0) continue; // parent crossfade

    if (fps.length === 1 && tps.length === 1) {
      ride(fps[0], tps[0], dt, ease, animators, cleanups);
    } else if (fps.length === 1 && tps.length > 1) {
      fanOut(fps[0], tps, dt, ease, animators, cleanups);
    } else if (fps.length > 1 && tps.length === 1) {
      fanIn(fps, tps[0], dt, ease, animators, cleanups);
    } else {
      // N↔M: pair by index, leftovers fall through to parent crossfade.
      const n = Math.min(fps.length, tps.length);
      for (let i = 0; i < n; i++) ride(fps[i], tps[i], dt, ease, animators, cleanups);
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

/** "Identity root" — walks up the `marker.group` chain. Two markers
 *  share an identity for morph iff they share a root. */
const groupRoot = (m: PartMarker): PartMarker => {
  let r = m;
  while (r.group) r = r.group;
  return r;
};

const groupByRoot = (parts: readonly Part[]): Map<PartMarker, Part[]> => {
  const out = new Map<PartMarker, Part[]>();
  for (const p of parts) {
    if (!p.el) continue;
    const a = p.aabb.value;
    if (a.w === 0 || a.h === 0) continue;
    const r = groupRoot(p.marker);
    const list = out.get(r);
    if (list) list.push(p);
    else out.set(r, [p]);
  }
  return out;
};

/** 1↔1: ride a single source-content clone from `p`'s slot to `q`'s
 *  slot, scaled to match q's size. If contents differ, also ride a
 *  dest-content clone on the same trajectory and crossfade. */
const ride = (
  p: Part,
  q: Part,
  dt: number,
  ease: Easing,
  animators: Animator[],
  cleanups: Array<() => void>,
): void => {
  const pa = p.aabb.value;
  const qa = q.aabb.value;
  const destPose = partPose(q);
  const sameContent = p.content.peek() === q.content.peek();

  const src = pluck(p);
  animators.push(
    src.translate.to(destPose, dt, ease),
    src.scale.to({ x: qa.w / pa.w, y: qa.h / pa.h }, dt, ease),
  );
  cleanups.push(() => src.dispose());

  if (sameContent) {
    // Source IS the right content; keep visible end-to-end. Hide q
    // during the flight; restore at the end (to whatever the author
    // had set, not blindly to 1).
    const prevQ = q.opacity.peek();
    q.opacity.value = 0;
    cleanups.push(() => {
      q.opacity.value = prevQ;
    });
  } else {
    // Rewrite: pluck q too and ride on the same trajectory,
    // crossfading from src→dest. Initial pose: at p's location,
    // scaled down so the visible footprint matches src at t=0.
    const dst = pluck(q);
    dst.translate.value = partPose(p);
    dst.scale.value = { x: pa.w / qa.w, y: pa.h / qa.h };
    dst.opacity.value = 0;
    animators.push(
      src.opacity.to(0, dt, ease),
      dst.translate.to(destPose, dt, ease),
      dst.scale.to({ x: 1, y: 1 }, dt, ease),
      dst.opacity.to(1, dt, ease),
    );
    cleanups.push(() => dst.dispose());
  }
};

/** 1→N: source fades in place; N dest riders emerge from source's
 *  slot and slide to their respective dests, fading in. */
const fanOut = (
  p: Part,
  qs: readonly Part[],
  dt: number,
  ease: Easing,
  animators: Animator[],
  cleanups: Array<() => void>,
): void => {
  const pa = p.aabb.value;
  const pPose = partPose(p);

  // Source rider holds at p's pose, fading out. (Plucked source is
  // hidden by `pluck` for the duration; rider provides the visible
  // content during flight.)
  const src = pluck(p);
  animators.push(src.opacity.to(0, dt, ease));
  cleanups.push(() => src.dispose());

  for (const q of qs) {
    const qa = q.aabb.value;
    const dst = pluck(q);
    // Start at p's pose, scaled down to match p's footprint, faded
    // out. Then fly out to q's pose at full size, fading in.
    dst.translate.value = pPose;
    dst.scale.value = { x: pa.w / qa.w, y: pa.h / qa.h };
    dst.opacity.value = 0;
    animators.push(
      dst.translate.to(partPose(q), dt, ease),
      dst.scale.to({ x: 1, y: 1 }, dt, ease),
      dst.opacity.to(1, dt, ease),
    );
    cleanups.push(() => dst.dispose());
  }
};

/** N→1: N source riders converge into dest's slot, fading out as
 *  they arrive; dest fades in there. */
const fanIn = (
  ps: readonly Part[],
  q: Part,
  dt: number,
  ease: Easing,
  animators: Animator[],
  cleanups: Array<() => void>,
): void => {
  const qa = q.aabb.value;
  const qPose = partPose(q);

  for (const p of ps) {
    const pa = p.aabb.value;
    const src = pluck(p);
    animators.push(
      src.translate.to(qPose, dt, ease),
      src.scale.to({ x: qa.w / pa.w, y: qa.h / pa.h }, dt, ease),
      src.opacity.to(0, dt, ease),
    );
    cleanups.push(() => src.dispose());
  }

  // Dest rider just fades in at q's pos — supplies the visible q
  // content while parent crossfade is partway through.
  const dst = pluck(q);
  dst.opacity.value = 0;
  animators.push(dst.opacity.to(1, dt, ease));
  cleanups.push(() => dst.dispose());
};

// Note: there's deliberately no `swap(p1: Part, p2: Part)` here. To
// "swap" two parts visually, morph between two equations that hold
// them in opposite slots — `morph(tex`${a}${b}`, tex`${b}${a}`)`.
// The morph rider machinery already exchanges matched-name parts,
// and (unlike a pluck-based swap) the post-state is correct because
// the second equation actually exists. See md-tex-demo for an
// example.
