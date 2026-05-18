// Token-level snapshot-diff morph for CodeShape — the Code Hike pattern.
//
//   1. Snapshot every token element's (key, offsetLeft, offsetTop)
//      BEFORE the source swap. `key = type:text:occurrenceIndex` so
//      duplicate identifiers (e.g. two `t`s) stay distinct.
//   2. Swap the source, re-tokenize, re-render — new HTML, new layout.
//   3. Diff snapshots by key:
//        - MATCHED  → new element WAAPI-translates from (old−new) to (0,0)
//        - ADDED    → new element fades in
//        - REMOVED  → clone of old element absolutely-positioned into the
//                     wrapper at its old offset, fades out, removed on end
//   4. All animations run in parallel and yield as one Animator. Cancel
//      mid-flight tears down clones via `finally`.
//
// Coordinate frame: we use `el.offsetLeft` / `el.offsetTop` (relative
// to the positioned wrapper) for snapshots. WAAPI's `transform: translate(Xpx, …)`
// operates in the same CSS-pixel local frame, so the deltas apply
// without any SVG-scale correction.

import {type Animator, type Easing} from "@minim/core";
import {native} from "@minim/ext";
import {TOKEN_CLASS, type CodeShape} from "./code";

interface Snap {
  el: HTMLElement;
  key: string;
  x: number;
  y: number;
}

/** Walk the wrapper's token spans in document order, assigning each a
 *  composite key. Occurrences disambiguate duplicates: the second `t`
 *  identifier in a function body is a different key from the first. */
function snapshot(wrapper: HTMLElement): Snap[] {
  const counts = new Map<string, number>();
  const out: Snap[] = [];
  const els = wrapper.querySelectorAll<HTMLElement>(`.${TOKEN_CLASS}`);
  for (const el of els) {
    const base = el.dataset.tokKey ?? `?:${el.textContent ?? ""}`;
    const occ = counts.get(base) ?? 0;
    counts.set(base, occ + 1);
    out.push({el, key: `${base}:${occ}`, x: el.offsetLeft, y: el.offsetTop});
  }
  return out;
}

/** A WAAPI easing string approximating a few common minim Easings.
 *  WAAPI takes CSS strings, not number→number functions, so we map.
 *  Custom Easings degrade to `ease-in-out`, which is the right default
 *  for token morphs (slower at the endpoints reads as "settle"). */
function easingFor(_e: Easing | undefined): string {
  // The point of code morph is feel, not numeric fidelity — every token
  // animates over the same window, so a single string is enough.
  return "ease-in-out";
}

/** Diff old → new and run the token-level morph. Yields when every
 *  per-token WAAPI animation has completed. Cancel-safe: ghosts for
 *  removed tokens are torn down in `finally`. */
export function* morph(
  code: CodeShape,
  target: string,
  dur: number,
  ease?: Easing,
): Animator<void> {
  const before = snapshot(code.wrapper);
  code._setSourceAndRender(target);
  const after = snapshot(code.wrapper);

  const beforeByKey = new Map(before.map((s) => [s.key, s]));
  const matched: {from: Snap; to: Snap}[] = [];
  const added: Snap[] = [];
  for (const a of after) {
    const b = beforeByKey.get(a.key);
    if (b) {
      matched.push({from: b, to: a});
      beforeByKey.delete(a.key);
    } else {
      added.push(a);
    }
  }
  const removed = [...beforeByKey.values()];

  const durMs = Math.max(0, dur * 1000);
  const easing = easingFor(ease);
  const anims: Animator<void>[] = [];

  // Matched: start at (dx, dy) translate, settle to identity.
  // Skip the WAAPI roundtrip when the token didn't actually move.
  for (const {from, to} of matched) {
    const dx = from.x - to.x;
    const dy = from.y - to.y;
    if (dx === 0 && dy === 0) continue;
    anims.push(
      native(
        to.el,
        [
          {transform: `translate(${dx}px, ${dy}px)`},
          {transform: "translate(0, 0)"},
        ],
        {duration: durMs, easing, fill: "both"},
      ),
    );
  }

  // Added: fade in. Tokens that drift in from a different position
  // would be handled by `matched`; bare adds get an opacity ramp.
  for (const a of added) {
    anims.push(
      native(
        a.el,
        [{opacity: "0"}, {opacity: "1"}],
        {duration: durMs, easing, fill: "both"},
      ),
    );
  }

  // Removed: clone the old element into the wrapper at its old offset
  // so it lives in the same coord frame, then fade it out. The new
  // DOM doesn't reference these elements; they're ghosts.
  const ghosts: HTMLElement[] = [];
  for (const r of removed) {
    const g = r.el.cloneNode(true) as HTMLElement;
    g.style.position = "absolute";
    g.style.left = `${r.x}px`;
    g.style.top = `${r.y}px`;
    g.style.pointerEvents = "none";
    code.wrapper.appendChild(g);
    ghosts.push(g);
    anims.push(
      native(
        g,
        [{opacity: "1"}, {opacity: "0"}],
        {duration: durMs, easing, fill: "both"},
      ),
    );
  }

  try {
    // Run every per-token animation concurrently. The cast to
    // `readonly Yieldable[]` is needed because Animator<void>[] is more
    // specific than the array shape `yield` consumes; the engine just
    // sees a list of yieldables either way.
    yield anims;
  } finally {
    for (const g of ghosts) g.remove();
  }
}
