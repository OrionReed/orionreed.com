// Motion combinators over tex shapes. `pluck` is the primitive: it
// lifts a Part into a free-standing Plucked Shape. `morph` composes
// on top, branching by identity-cardinality (1↔1, 1↔N, N↔1) using
// `marker.group` chains. Per-part stagger uses minim's existing
// `stagger` directly:
//
//      for (const p of eq.parts) p.opacity.value = 0;
//      yield* stagger(0.05, eq.parts, p => p.opacity.to(1, 0.3));

import { effect, signal } from "../core/signal";
import { easeInOut, easeOut } from "../motion/easings";
import type { Animator, Easing } from "../core";
import { Shape } from "../scene/shape";
import { aabb } from "../scene/box";
import { Part, type PartMarker } from "./parts";
import type { TexShape } from "./tex";

/** Wildcard TexShape — accepts any `Names` union, so cross-cycle
 *  morphs (`TexShape<"a"|"b">` ↔ `TexShape<"f"|"x">`) typecheck. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTex = TexShape<any>;

/** Pulse a part's `highlighted` signal for `dt` seconds. */
export function* highlight(part: Part, dt = 0.6): Animator {
  part.highlighted.value = true;
  try {
    yield dt;
  } finally {
    part.highlighted.value = false;
  }
}

/** Reveal an eq left-to-right via a clip-path sweep. Clip-path is
 *  applied to the inner HTML wrapper, not the outer `<g>` —
 *  Chromium drops composite invalidation for foreignObject content
 *  under animated clip-path on `<g>`, causing tearing. */
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

/** Reverse of `write`. After completion the eq is hidden
 *  (`opacity: 0`) and clip-path is cleared, ready for a future `write`. */
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
    eq.opacity.value = 0;
    target.style.clipPath = "";
  }
}

/** Inner wrapper div (HTML) inside the foreignObject; falls back to
 *  the outer `<g>` if not yet mounted. */
const clipTarget = (eq: AnyTex): HTMLElement | SVGGElement => {
  const fo = eq.intrinsic as SVGForeignObjectElement | undefined;
  const wrapper = fo?.firstElementChild;
  return wrapper instanceof HTMLElement ? wrapper : eq.el;
};

const findMathWrapper = (matchedEl: HTMLElement): HTMLElement | null => {
  let cur: Element | null = matchedEl.parentElement;
  while (cur && cur.tagName.toLowerCase() !== "math") {
    cur = cur.parentElement;
  }
  if (!cur) return null;
  const wrapper = cur.parentElement;
  return wrapper instanceof HTMLElement ? wrapper : null;
};

/** Part's matched-mrow position in parent-frame coords. */
const partPose = (part: Part): { x: number; y: number } => {
  const tr = part.host.translate.value;
  const a = part.aabb.value;
  return { x: tr.x + a.x, y: tr.y + a.y };
};

/** A Part lifted out of its TexShape into a free Shape. `translate`
 *  is the matched mrow's TL in parent coords (the cloned wrapper is
 *  CSS-shifted so the mrow lands at our local (0,0)); `scale` pivots
 *  around the same TL. Source's opacity is zeroed for the Plucked's
 *  lifetime; `dispose()` restores it. */
export class Plucked extends Shape {
  readonly source: Part;
  readonly #sourcePrevOpacity: number;

  constructor(source: Part) {
    const a = source.aabb.peek();
    const local = aabb(0, 0, a.w, a.h);
    super("foreignObject", () => local);
    this.source = source;
    this.#sourcePrevOpacity = source.opacity.peek();
    source.opacity.value = 0;
  }

  dispose(): void {
    this.source.opacity.value = this.#sourcePrevOpacity;
    super.dispose();
  }
}

/** Lift `part` out of its TexShape, mount under the same parent,
 *  return the Plucked. Restore via `plucked.dispose()` or `unpluck`. */
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

  // Deep-clone the wrapper, then hide-via-visibility everything
  // except the matched mrow. `visibility: hidden` (not `display:
  // none`) preserves layout, so the mrow lands at exactly the same
  // intra-clone offset as in the source.
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
  // CSS-shift the wrapper so the matched mrow lands at (0, 0) of
  // our local frame — combined with `Plucked.aabb = (0,0,w,h)`, this
  // makes `plucked.translate` semantically equal to "matched mrow TL
  // in parent coords."
  clonedWrapper.style.transform = `translate(${-aabbLocal.x}px, ${-aabbLocal.y}px)`;
  clonedWrapper.style.transformOrigin = "0 0";

  const plucked = new Plucked(part);
  const fo = plucked.intrinsic as SVGForeignObjectElement;
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
 *  source if no target is given), then dispose. Translates only —
 *  the Plucked keeps its source's natural size. For morph-style
 *  fit-into-target sizing, animate `scale` yourself alongside this. */
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

/** Animate `from` → `to`, matching Parts by marker identity (same
 *  marker reference, or markers sharing a `group` root). Branches
 *  by cardinality of each identity:
 *
 *    1↔1 same content → single rider, scaled to dest
 *    1↔1 different    → dual rider, source fades out, dest fades in
 *    1↔N              → N riders emerge from source, fan to dests
 *    N↔1              → N riders converge to dest, fade out
 *    N↔M              → pair by index; extras parent-crossfade
 *
 *  Unmatched parts cross-fade with the parent. Assumes both shapes
 *  share a parent and have translate-only transforms. */
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

  // Hide `to` so riders supply visible content during the flight.
  if (to.opacity.peek() !== 0) to.opacity.value = 0;

  const animators: Animator[] = [
    from.opacity.to(0, dt, ease),
    to.opacity.to(1, dt, ease),
  ];
  const cleanups: Array<() => void> = [];

  const fromByRoot = groupByRoot(from.parts);
  const toByRoot = groupByRoot(to.parts);

  for (const root of new Set([...fromByRoot.keys(), ...toByRoot.keys()])) {
    const fps = fromByRoot.get(root) ?? [];
    const tps = toByRoot.get(root) ?? [];
    if (fps.length === 0 || tps.length === 0) continue;

    if (fps.length === 1 && tps.length === 1) {
      ride(fps[0], tps[0], dt, ease, animators, cleanups);
    } else if (fps.length === 1 && tps.length > 1) {
      fanOut(fps[0], tps, dt, ease, animators, cleanups);
    } else if (fps.length > 1 && tps.length === 1) {
      fanIn(fps, tps[0], dt, ease, animators, cleanups);
    } else {
      // N↔M: pair by index; extras parent-crossfade.
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

/** Topmost marker in a `marker.group` chain — two markers share
 *  identity for morph iff they share a root. */
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

/** 1↔1 ride. Same content: single source clone, scaled to dest.
 *  Different content: dual clone on the same trajectory, crossfade. */
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
    // Source rider IS the right content; just hide q during flight.
    const prevQ = q.opacity.peek();
    q.opacity.value = 0;
    cleanups.push(() => {
      q.opacity.value = prevQ;
    });
  } else {
    // Dest rider starts at p's pose, scaled to p's footprint, faded
    // out — then rides to q's pose at full size, fading in.
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

/** 1→N. Source rider fades out in place; N dest riders emerge from
 *  source's pose and fan out to their respective slots. */
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

  const src = pluck(p);
  animators.push(src.opacity.to(0, dt, ease));
  cleanups.push(() => src.dispose());

  for (const q of qs) {
    const qa = q.aabb.value;
    const dst = pluck(q);
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

/** N→1. N source riders converge to dest's slot, fading out;
 *  dest fades in there. */
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

  // Dest rider fades in at q's pos so q is visible during the
  // parent's partial crossfade.
  const dst = pluck(q);
  dst.opacity.value = 0;
  animators.push(dst.opacity.to(1, dt, ease));
  cleanups.push(() => dst.dispose());
};

// Note: no part-level `swap`. To swap two parts visually, morph
// between two equations holding them in opposite slots:
// `morph(tex`${a}${b}`, tex`${b}${a}`)`. The morph machinery
// exchanges them correctly, and the post-state is right because
// the destination equation actually exists. See md-tex-demo.
